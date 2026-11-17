// MentorLagbe seed script.
// Phase 1 (DB-only): clears tuitions/applications/payments, inserts 4 seed
// tutor personas, 12 approved + active tuitions and 3 sample applications.
// Phase 2 (needs the CLIENT live): creates the 3 login-able test accounts
// via the client's BetterAuth sign-up API (idempotent — skips existing).
//
// Usage:
//   node scripts/seed.js            # both phases
//   node scripts/seed.js --phase1   # DB data only
//   node scripts/seed.js --phase2   # test accounts only
//
// Env: MONGODB_URI (required), CLIENT_URL (phase 2; defaults to the
// production client URL).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");

const CLIENT_URL = (
  process.env.CLIENT_URL ||
  "https://assignment09-mentorlagbe-client.vercel.app"
).replace(/\/$/, "");

const img = (id) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&q=80`;

const TUTORS = [
  {
    name: "Rahim Uddin",
    email: "rahim.uddin@mentorlagbe.com",
    bio: "Mathematics graduate from University of Dhaka. 6+ years teaching SSC & HSC mathematics in Chattogram.",
    image: img("photo-1507003211169-0a1dd7228f2d"),
  },
  {
    name: "Nusrat Jahan",
    email: "nusrat.jahan@mentorlagbe.com",
    bio: "Physics honours from CU. Loves making science simple with real-life examples and weekly model tests.",
    image: img("photo-1494790108377-be9c29b29330"),
  },
  {
    name: "Tanvir Ahmed",
    email: "tanvir.ahmed@mentorlagbe.com",
    bio: "CSE graduate and full-stack developer. Teaches programming and ICT with hands-on projects.",
    image: img("photo-1500648767791-00dcc994a43e"),
  },
  {
    name: "Farhana Akter",
    email: "farhana.akter@mentorlagbe.com",
    bio: "English Literature graduate, IELTS band 8.5. Helps students build fluency and exam confidence.",
    image: img("photo-1438761681033-6461ffad8d80"),
  },
];

// [tutorIndex, title, subject, classLevel, mode, location, monthlyFee, daysPerWeek, imageId, description]
const TUITION_ROWS = [
  [0, "SSC Mathematics — Complete Preparation", "Math", "SSC", "Offline", "Chattogram, GEC Circle", 4000, 3, "photo-1509228468518-180dd4864904", "Full SSC math syllabus with chapter-wise sheets, weekly model tests and board-question practice. Small batch of 8 students so every student gets individual attention."],
  [0, "HSC Higher Math 1st & 2nd Paper", "Higher Math", "HSC", "Online", "Online (Zoom)", 5000, 4, "photo-1635372722656-8e7b8e4e0e4d", "HSC Higher Math both papers with CQ + MCQ drills, admission-style problem solving and recorded classes for revision."],
  [1, "Physics for Class 9-10 (SSC)", "Physics", "Class 9", "Offline", "Dhaka, Mirpur 10", 3500, 3, "photo-1507413245164-6160d8298b31", "Concept-first physics with everyday examples, numerical practice and monthly progress reports for parents."],
  [1, "HSC Chemistry — Organic Made Easy", "Chemistry", "HSC", "Online", "Online (Google Meet)", 4500, 3, "photo-1532094349884-543bc11b234d", "Organic and inorganic chemistry with reaction maps, shortcut techniques and full MCQ bank for board + admission."],
  [1, "SSC Biology with Diagrams & Model Tests", "Biology", "SSC", "Offline", "Chattogram, Agrabad", 3000, 2, "photo-1532187863486-abf9dbad1b69", "Biology made visual — labelled diagrams, mnemonics for terminology and regular chapter tests."],
  [3, "English Grammar & Writing — Class 6-8", "English", "Class 7", "Online", "Online (Zoom)", 2500, 3, "photo-1456513080510-7bf3a84b82f8", "Grammar foundations, paragraph & essay writing, and spoken practice for junior students in a friendly batch."],
  [2, "Python Programming from Zero (Beginners)", "Programming", "University", "Online", "Online (Zoom)", 6000, 4, "photo-1461749280684-dccba630e2f6", "Learn Python by building real projects — no prior experience needed. Covers basics to OOP, with weekly coding assignments and code review."],
  [3, "IELTS Preparation — Target Band 7+", "IELTS", "IELTS Prep", "Online", "Online (Zoom)", 8000, 5, "photo-1543269865-cbf427effbad", "Complete IELTS prep: speaking mock tests, writing task feedback, reading strategies and full mock exams every week."],
  [0, "Accounting Principles — HSC Commerce", "Accounting", "HSC", "Offline", "Dhaka, Dhanmondi", 4000, 3, "photo-1554224155-6726b3ff858f", "HSC accounting 1st & 2nd paper with journal-to-final-accounts practice and board question solving."],
  [2, "ICT for SSC — Practical + Theory", "ICT", "SSC", "Online", "Online (Google Meet)", 2000, 2, "photo-1516321318423-f06f85e504b3", "SSC ICT theory plus hands-on practice — number systems, HTML basics and spreadsheet skills, all exam-focused."],
  [3, "Bangla Language & Literature — Class 9-10", "Bangla", "Class 10", "Offline", "Chattogram, Halishahar", 2800, 2, "photo-1524995997946-a1c2e315a42f", "Bangla 1st & 2nd paper with grammar drills, creative writing practice and board-question analysis."],
  [0, "HSC Economics — Micro & Macro", "Economics", "HSC", "Online", "Online (Zoom)", 12000, 3, "photo-1611974789855-9c2a0a7236a3", "1-on-1 HSC Economics mentorship with graph-based explanations, current-affairs links and admission prep for business faculties."],
];

const TEST_ACCOUNTS = [
  { name: "Admin User", email: "admin@mentorlagbe.com", password: "Admin123!", signupRole: "tutor", finalRole: "admin" },
  { name: "Test Tutor", email: "tutor@mentorlagbe.com", password: "Tutor123!", signupRole: "tutor", finalRole: "tutor" },
  { name: "Test Student", email: "student@mentorlagbe.com", password: "Student123!", signupRole: "student", finalRole: "student" },
];

async function phase1(db) {
  console.log("Phase 1: seeding database...");

  // Seed tutor personas (display only — they do not need to log in).
  for (const tutor of TUTORS) {
    await db.collection("users").updateOne(
      { email: tutor.email },
      {
        $setOnInsert: {
          name: tutor.name,
          email: tutor.email,
          image: tutor.image,
          role: "tutor",
          phone: "",
          bio: tutor.bio,
          plan: "free",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`  Upserted ${TUTORS.length} tutor personas in users`);

  await db.collection("tuitions").deleteMany({});
  await db.collection("applications").deleteMany({});
  await db.collection("payments").deleteMany({});
  console.log("  Cleared tuitions, applications, payments");

  const tuitions = TUITION_ROWS.map((row) => {
    const [tutorIdx, title, subject, classLevel, mode, location, monthlyFee, daysPerWeek, imageId, description] = row;
    const tutor = TUTORS[tutorIdx];
    return {
      title,
      subject,
      classLevel,
      mode,
      location,
      monthlyFee,
      daysPerWeek,
      bannerImage: img(imageId),
      description,
      tutorName: tutor.name,
      tutorEmail: tutor.email,
      approvalStatus: "approved",
      isActive: true,
      createdAt: new Date(),
    };
  });
  const result = await db.collection("tuitions").insertMany(tuitions);
  console.log(`  Inserted ${result.insertedCount} approved tuitions`);

  // 3 sample applications from the test student against 3 tuitions.
  const insertedIds = Object.values(result.insertedIds);
  const sampleApps = [
    { tuitionIdx: 0, status: "pending" },
    { tuitionIdx: 6, status: "accepted" },
    { tuitionIdx: 7, status: "rejected" },
  ];
  for (const { tuitionIdx, status } of sampleApps) {
    const t = tuitions[tuitionIdx];
    await db.collection("applications").insertOne({
      tuitionId: insertedIds[tuitionIdx].toString(),
      tuitionTitle: t.title,
      subject: t.subject,
      monthlyFee: t.monthlyFee,
      tutorEmail: t.tutorEmail,
      studentName: "Test Student",
      studentEmail: "student@mentorlagbe.com",
      studentPhone: "01800-000000",
      preferredSchedule: "Evening, 6-8 PM",
      studentNote: "Looking for regular guidance before my board exam.",
      status,
      appliedAt: new Date(),
    });
  }
  console.log("  Inserted 3 sample applications (pending, accepted, rejected)");
}

async function phase2(db) {
  console.log(`Phase 2: creating test accounts via ${CLIENT_URL} ...`);
  for (const account of TEST_ACCOUNTS) {
    const existing =
      (await db.collection("users").findOne({ email: account.email })) ||
      (await db.collection("user").findOne({ email: account.email }));
    if (existing) {
      // Make sure the role is what it should be (e.g. admin promotion).
      if (existing.role !== account.finalRole) {
        const collName =
          (await db.collection("users").findOne({ email: account.email }))
            ? "users"
            : "user";
        await db
          .collection(collName)
          .updateOne({ email: account.email }, { $set: { role: account.finalRole } });
        console.log(`  ${account.email}: role updated to ${account.finalRole}`);
      } else {
        console.log(`  ${account.email}: already exists, skipped`);
      }
      continue;
    }

    let res;
    try {
      res = await fetch(`${CLIENT_URL}/api/auth/sign-up/email`, {
        method: "POST",
        // BetterAuth rejects cross-site sign-ups without a matching Origin.
        headers: { "Content-Type": "application/json", Origin: CLIENT_URL },
        body: JSON.stringify({
          name: account.name,
          email: account.email,
          password: account.password,
          role: account.signupRole,
        }),
      });
    } catch (err) {
      console.error(`  ${account.email}: client unreachable (${err.message}) — run phase 2 later with: node scripts/seed.js --phase2`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`  ${account.email}: sign-up failed (${res.status}) ${text.slice(0, 200)}`);
      continue;
    }
    // Promote the admin account (signed up as tutor) via direct DB update.
    if (account.finalRole !== account.signupRole) {
      for (const name of ["users", "user"]) {
        const r = await db
          .collection(name)
          .updateOne({ email: account.email }, { $set: { role: account.finalRole } });
        if (r.matchedCount > 0) break;
      }
    }
    console.log(`  ${account.email}: created as ${account.finalRole}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const onlyPhase1 = args.includes("--phase1");
  const onlyPhase2 = args.includes("--phase2");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db("mentorlagbe");
  try {
    if (!onlyPhase2) await phase1(db);
    if (!onlyPhase1) await phase2(db);
    console.log("Seed complete.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
