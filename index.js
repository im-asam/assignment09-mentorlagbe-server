require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const {
  verifyToken,
  verifyStudent,
  verifyTutor,
  verifyAdmin,
} = require("./middleware/auth");

const app = express();

// CORS: allow the client origin if configured, otherwise allow all (dev).
app.use(
  cors({
    origin: process.env.CLIENT_URL || true,
    credentials: true,
  })
);

// Stripe webhook needs the RAW body for signature verification, so it is
// registered before express.json() (see routes below).
app.use("/webhooks/stripe", express.raw({ type: "application/json" }));
app.use(express.json());

// Health check — must NOT touch the DB, so it works even without a valid MONGODB_URI.
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "MentorLagbe server is running" });
});

// ---------- Tuitions (public) ----------

// GET /tuitions — public. Only approved + active. Server-side search
// (title OR subject), filters (subject, classLevel, mode) and pagination
// with .skip()/.limit(). Default limit 9; limit=6 serves the home page.
app.get("/tuitions", async (req, res, next) => {
  try {
    const { search, subject, classLevel, mode } = req.query;
    const query = { approvalStatus: "approved", isActive: true };
    if (search) {
      // Escape regex metacharacters so a search like "(" cannot throw.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      query.$or = [{ title: regex }, { subject: regex }];
    }
    if (subject) query.subject = subject;
    if (classLevel) query.classLevel = classLevel;
    if (mode) query.mode = mode;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 9);
    const db = await getDb();
    const coll = db.collection("tuitions");
    const total = await coll.countDocuments(query);
    const tuitions = await coll
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    res.json({
      tuitions,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// GET /tuitions/mine — tutor's own tuitions. Defined BEFORE /tuitions/:id
// so "mine" is not treated as an id (Express matches in registration order).
app.get("/tuitions/mine", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    const db = await getDb();
    const tuitions = await db
      .collection("tuitions")
      .find({ tutorEmail: req.userEmail })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(tuitions);
  } catch (err) {
    next(err);
  }
});

// GET /tuitions/:id — public. Returns the tuition by id (any status) or 404.
app.get("/tuitions/:id", async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid tuition id" });
    }
    const db = await getDb();
    const tuition = await db
      .collection("tuitions")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!tuition) {
      return res.status(404).json({ error: "Tuition not found" });
    }
    res.json(tuition);
  } catch (err) {
    next(err);
  }
});

// ---------- Tuitions (tutor) ----------

// POST /tuitions — tutor only. Free-plan tutors max 2 tuitions; pro unlimited.
app.post("/tuitions", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    const {
      title,
      subject,
      classLevel,
      mode,
      location,
      monthlyFee,
      daysPerWeek,
      bannerImage,
      description,
    } = req.body || {};
    if (
      !title ||
      !subject ||
      !classLevel ||
      !mode ||
      !location ||
      monthlyFee === undefined ||
      monthlyFee === null ||
      daysPerWeek === undefined ||
      daysPerWeek === null ||
      !bannerImage ||
      !description
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!["Online", "Offline"].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "Online" or "Offline"' });
    }
    const fee = Number(monthlyFee);
    const days = Number(daysPerWeek);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ error: "monthlyFee must be a valid number" });
    }
    if (!Number.isFinite(days) || days < 1 || days > 7) {
      return res.status(400).json({ error: "daysPerWeek must be a number between 1 and 7" });
    }

    const db = await getDb();
    const coll = db.collection("tuitions");

    // Free-plan limit: at most 2 tuition posts per tutor.
    if (req.user?.plan !== "pro") {
      const count = await coll.countDocuments({ tutorEmail: req.userEmail });
      if (count >= 2) {
        return res.status(403).json({
          error:
            "Free plan allows up to 2 tuition posts. Upgrade to Pro to post unlimited tuitions.",
        });
      }
    }

    const tuition = {
      title,
      subject,
      classLevel,
      mode,
      location,
      monthlyFee: fee,
      daysPerWeek: days,
      bannerImage,
      description,
      tutorName: req.user?.name || "",
      tutorEmail: req.userEmail,
      approvalStatus: "pending",
      isActive: true,
      createdAt: new Date(),
    };
    const result = await coll.insertOne(tuition);
    res.status(201).json({ _id: result.insertedId, ...tuition });
  } catch (err) {
    next(err);
  }
});

// PATCH /tuitions/:id — tutor only, owner only. Does NOT reset approvalStatus.
app.patch("/tuitions/:id", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid tuition id" });
    }
    const db = await getDb();
    const coll = db.collection("tuitions");
    const tuition = await coll.findOne({ _id: new ObjectId(req.params.id) });
    if (!tuition) {
      return res.status(404).json({ error: "Tuition not found" });
    }
    if (tuition.tutorEmail !== req.userEmail) {
      return res.status(403).json({ error: "Forbidden: only the owner can edit this tuition" });
    }

    const allowed = [
      "title",
      "subject",
      "classLevel",
      "mode",
      "location",
      "monthlyFee",
      "daysPerWeek",
      "bannerImage",
      "description",
      "isActive",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body && req.body[key] !== undefined) {
        updates[key] =
          key === "monthlyFee" || key === "daysPerWeek"
            ? Number(req.body[key])
            : req.body[key];
      }
    }
    if (
      updates.mode !== undefined &&
      !["Online", "Offline"].includes(updates.mode)
    ) {
      return res.status(400).json({ error: 'mode must be "Online" or "Offline"' });
    }
    if (
      updates.monthlyFee !== undefined &&
      (!Number.isFinite(updates.monthlyFee) || updates.monthlyFee < 0)
    ) {
      return res.status(400).json({ error: "monthlyFee must be a valid number" });
    }
    if (
      updates.daysPerWeek !== undefined &&
      (!Number.isFinite(updates.daysPerWeek) ||
        updates.daysPerWeek < 1 ||
        updates.daysPerWeek > 7)
    ) {
      return res.status(400).json({ error: "daysPerWeek must be a number between 1 and 7" });
    }

    await coll.updateOne({ _id: tuition._id }, { $set: updates });
    const updated = await coll.findOne({ _id: tuition._id });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /tuitions/:id — tutor only, owner only. Also deletes its applications.
app.delete("/tuitions/:id", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid tuition id" });
    }
    const db = await getDb();
    const coll = db.collection("tuitions");
    const tuition = await coll.findOne({ _id: new ObjectId(req.params.id) });
    if (!tuition) {
      return res.status(404).json({ error: "Tuition not found" });
    }
    if (tuition.tutorEmail !== req.userEmail) {
      return res.status(403).json({ error: "Forbidden: only the owner can delete this tuition" });
    }
    await coll.deleteOne({ _id: tuition._id });
    await db.collection("applications").deleteMany({ tuitionId: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: tuitions ----------

// GET /admin/tuitions — admin only. All tuitions, newest first.
app.get("/admin/tuitions", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const tuitions = await db
      .collection("tuitions")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json(tuitions);
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/tuitions/:id/status — admin only. Approve or reject a tuition.
app.patch(
  "/admin/tuitions/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid tuition id" });
      }
      const { approvalStatus } = req.body || {};
      if (!["approved", "rejected"].includes(approvalStatus)) {
        return res
          .status(400)
          .json({ error: 'approvalStatus must be "approved" or "rejected"' });
      }
      const db = await getDb();
      const coll = db.collection("tuitions");
      const result = await coll.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { approvalStatus } },
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Tuition not found" });
      }
      const updated = await coll.findOne({ _id: new ObjectId(req.params.id) });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Applications ----------

// POST /applications — student only. Blocks duplicate applications.
app.post("/applications", verifyToken, verifyStudent, async (req, res, next) => {
  try {
    const { tuitionId, studentPhone, preferredSchedule, studentNote } =
      req.body || {};
    if (!tuitionId || !studentPhone || !preferredSchedule) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!ObjectId.isValid(tuitionId)) {
      return res.status(400).json({ error: "Invalid tuition id" });
    }
    const db = await getDb();
    const tuition = await db
      .collection("tuitions")
      .findOne({ _id: new ObjectId(tuitionId) });
    if (!tuition || tuition.approvalStatus !== "approved" || !tuition.isActive) {
      return res
        .status(400)
        .json({ error: "Tuition is not available for applications" });
    }
    const coll = db.collection("applications");
    const existing = await coll.findOne({
      tuitionId,
      studentEmail: req.userEmail,
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: "You have already applied for this tuition" });
    }
    const application = {
      tuitionId,
      tuitionTitle: tuition.title,
      subject: tuition.subject,
      monthlyFee: tuition.monthlyFee,
      tutorEmail: tuition.tutorEmail,
      studentName: req.user?.name || "",
      studentEmail: req.userEmail,
      studentPhone,
      preferredSchedule,
      studentNote: studentNote || "",
      status: "pending",
      appliedAt: new Date(),
    };
    const result = await coll.insertOne(application);
    res.status(201).json({ _id: result.insertedId, ...application });
  } catch (err) {
    next(err);
  }
});

// GET /applications/mine — student's own applications, newest first.
app.get("/applications/mine", verifyToken, verifyStudent, async (req, res, next) => {
  try {
    const db = await getDb();
    const applications = await db
      .collection("applications")
      .find({ studentEmail: req.userEmail })
      .sort({ appliedAt: -1 })
      .toArray();
    res.json(applications);
  } catch (err) {
    next(err);
  }
});

// DELETE /applications/:id — student only, owner only, only while pending.
app.delete("/applications/:id", verifyToken, verifyStudent, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid application id" });
    }
    const db = await getDb();
    const coll = db.collection("applications");
    const application = await coll.findOne({ _id: new ObjectId(req.params.id) });
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }
    if (application.studentEmail !== req.userEmail) {
      return res
        .status(403)
        .json({ error: "Forbidden: this application is not yours" });
    }
    if (application.status !== "pending") {
      return res
        .status(400)
        .json({ error: "Only pending applications can be cancelled" });
    }
    await coll.deleteOne({ _id: application._id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /applications/tutor — applications on the tutor's own tuitions.
app.get("/applications/tutor", verifyToken, verifyTutor, async (req, res, next) => {
  try {
    const db = await getDb();
    const applications = await db
      .collection("applications")
      .find({ tutorEmail: req.userEmail })
      .sort({ appliedAt: -1 })
      .toArray();
    res.json(applications);
  } catch (err) {
    next(err);
  }
});

// PATCH /applications/:id/status — tutor only, for their own tuitions.
app.patch(
  "/applications/:id/status",
  verifyToken,
  verifyTutor,
  async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid application id" });
      }
      const { status } = req.body || {};
      if (!["accepted", "rejected"].includes(status)) {
        return res
          .status(400)
          .json({ error: 'status must be "accepted" or "rejected"' });
      }
      const db = await getDb();
      const coll = db.collection("applications");
      const application = await coll.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      if (application.tutorEmail !== req.userEmail) {
        return res.status(403).json({
          error: "Forbidden: this application is not for your tuition",
        });
      }
      await coll.updateOne(
        { _id: application._id },
        { $set: { status } },
      );
      const updated = await coll.findOne({ _id: application._id });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Users ----------

// The users collection is BetterAuth's user model (modelName "users");
// fall back to the default "user" collection if a doc is only there.
async function findUserCollection(db, query) {
  for (const name of ["users", "user"]) {
    const doc = await db.collection(name).findOne(query);
    if (doc) return { collection: db.collection(name), doc };
  }
  return { collection: db.collection("users"), doc: null };
}

// GET /users/me — logged-in user's profile.
app.get("/users/me", verifyToken, async (req, res, next) => {
  try {
    const db = await getDb();
    const { doc } = await findUserCollection(db, { email: req.userEmail });
    if (!doc) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      name: doc.name,
      email: doc.email,
      image: doc.image || null,
      role: doc.role || "student",
      phone: doc.phone || "",
      bio: doc.bio || "",
      plan: doc.plan || "free",
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /users/me — update own profile (whitelisted fields only).
app.patch("/users/me", verifyToken, async (req, res, next) => {
  try {
    const allowed = ["name", "phone", "bio", "image"];
    const updates = {};
    for (const key of allowed) {
      if (req.body && req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    const db = await getDb();
    const { collection, doc } = await findUserCollection(db, {
      email: req.userEmail,
    });
    if (!doc) {
      return res.status(404).json({ error: "User not found" });
    }
    await collection.updateOne({ _id: doc._id }, { $set: updates });
    const updated = await collection.findOne({ _id: doc._id });
    res.json({
      name: updated.name,
      email: updated.email,
      image: updated.image || null,
      role: updated.role || "student",
      phone: updated.phone || "",
      bio: updated.bio || "",
      plan: updated.plan || "free",
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: users, stats, transactions ----------

// GET /admin/users — admin only. All users.
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const users = await db
      .collection("users")
      .find({})
      .project({ name: 1, email: 1, image: 1, role: 1, phone: 1, bio: 1, plan: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id/role — admin only. Change a user's role.
app.patch(
  "/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res, next) => {
    try {
      const { role } = req.body || {};
      if (!["student", "tutor", "admin"].includes(role)) {
        return res
          .status(400)
          .json({ error: 'role must be "student", "tutor" or "admin"' });
      }
      const db = await getDb();
      const id = req.params.id;
      // Try ObjectId first, then the raw string id (BetterAuth uses string ids).
      let found = await findUserCollection(
        db,
        ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id },
      );
      if (!found.doc && ObjectId.isValid(id)) {
        found = await findUserCollection(db, { _id: id });
      }
      const { collection, doc } = found;
      if (!doc) {
        return res.status(404).json({ error: "User not found" });
      }
      await collection.updateOne({ _id: doc._id }, { $set: { role } });
      const updated = await collection.findOne({ _id: doc._id });
      res.json({
        _id: updated._id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        plan: updated.plan || "free",
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/stats — admin only. Platform statistics.
app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const users = db.collection("users");
    const tuitions = db.collection("tuitions");
    const payments = db.collection("payments");
    const [
      totalUsers,
      totalTutors,
      totalStudents,
      pendingTuitions,
      approvedTuitions,
      totalPayments,
      revenueAgg,
    ] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: "tutor" }),
      users.countDocuments({ role: "student" }),
      tuitions.countDocuments({ approvalStatus: "pending" }),
      tuitions.countDocuments({ approvalStatus: "approved" }),
      payments.countDocuments({}),
      payments
        .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
        .toArray(),
    ]);
    res.json({
      totalUsers,
      totalTutors,
      totalStudents,
      pendingTuitions,
      approvedTuitions,
      totalRevenue: revenueAgg[0]?.total || 0,
      totalPayments,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/transactions — admin only. All payments, newest first.
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const payments = await db
      .collection("payments")
      .find({})
      .sort({ paidAt: -1 })
      .toArray();
    res.json(payments);
  } catch (err) {
    next(err);
  }
});

// ---------- Payments (Stripe, TEST mode) ----------

// Stripe is optional at deploy time: if STRIPE_SECRET_KEY is unset, the
// checkout endpoints return a clean 503 instead of crashing.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const PLANS = {
  "tutor-pro": { name: "Tutor Pro", amountCents: 1500 },
  "student-pro": { name: "Student Pro", amountCents: 1000 },
};

function getClientUrl() {
  return (
    process.env.CLIENT_URL ||
    "https://assignment09-mentorlagbe-client.vercel.app"
  ).replace(/\/$/, "");
}

// POST /payments/create-checkout-session — start a Pro plan checkout.
app.post(
  "/payments/create-checkout-session",
  verifyToken,
  async (req, res, next) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Stripe is not configured yet" });
      }
      const { plan } = req.body || {};
      const planDef = PLANS[plan];
      if (!planDef) {
        return res.status(400).json({
          error: 'plan must be "tutor-pro" or "student-pro"',
        });
      }
      const clientUrl = getClientUrl();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        currency: "usd",
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: planDef.amountCents,
              product_data: { name: `MentorLagbe ${planDef.name} Plan` },
            },
            quantity: 1,
          },
        ],
        metadata: {
          userEmail: req.userEmail,
          userName: req.user?.name || "",
          userRole: req.user?.role || "",
          planName: planDef.name,
        },
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel`,
      });
      res.json({ url: session.url });
    } catch (err) {
      next(err);
    }
  },
);

// Records a paid checkout session (idempotent by stripeSessionId) and
// upgrades the user's plan to "pro". Shared by verify-session + webhook.
async function recordPaidSession(session) {
  const db = await getDb();
  const meta = session.metadata || {};
  const payment = {
    userEmail: meta.userEmail || session.customer_details?.email || "",
    userName: meta.userName || "",
    userRole: meta.userRole || "",
    planName: meta.planName || "",
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || "usd",
    transactionId: session.payment_intent || "",
    stripeSessionId: session.id,
    paymentStatus: "paid",
    paidAt: new Date(),
  };
  await db.collection("payments").updateOne(
    { stripeSessionId: session.id },
    { $setOnInsert: payment },
    { upsert: true },
  );
  if (payment.userEmail) {
    // Upgrade the plan in whichever user collection holds the doc.
    for (const name of ["users", "user"]) {
      const result = await db
        .collection(name)
        .updateOne({ email: payment.userEmail }, { $set: { plan: "pro" } });
      if (result.matchedCount > 0) break;
    }
  }
  return db.collection("payments").findOne({ stripeSessionId: session.id });
}

// POST /payments/verify-session — confirm a checkout after redirect.
app.post("/payments/verify-session", verifyToken, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe is not configured yet" });
    }
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment is not completed yet" });
    }
    const payment = await recordPaidSession(session);
    res.json(payment);
  } catch (err) {
    next(err);
  }
});

// POST /webhooks/stripe — Stripe webhook (raw body; registered before
// express.json() at the top of this file). Always responds 200 quickly.
app.post("/webhooks/stripe", async (req, res) => {
  let event;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (stripe && webhookSecret) {
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        webhookSecret,
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid webhook signature" });
    }
  } else {
    if (!webhookSecret) {
      console.warn("STRIPE_WEBHOOK_SECRET is not set; skipping signature verification (test mode)");
    }
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }
  }

  try {
    if (event.type === "checkout.session.completed") {
      await recordPaidSession(event.data.object);
    }
  } catch (err) {
    console.error("Stripe webhook handler failed:", err.message);
    // Still return 200 so Stripe does not retry a DB-side failure forever.
  }
  res.json({ received: true });
});

// 404 for unknown routes.
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Central error handler — always return JSON, never crash the process.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// Only listen when run directly; Vercel serverless imports the app without listening.
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`MentorLagbe server is running on port ${PORT}`);
  });
}

module.exports = app;
