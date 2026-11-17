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
      const regex = new RegExp(search, "i");
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
