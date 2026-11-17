# MentorLagbe — Server

Express + MongoDB API server for **MentorLagbe**, a Smart Tuition & Mentorship Platform (Programming Hero Assignment 9, B14-A9, Category 001). It connects Students looking for personalized academic guidance with qualified Tutors, while Admins moderate listings, users, and subscription payments.

- **Live server:** https://assignment09-mentorlagbe-server.vercel.app
- **Live client:** https://assignment09-mentorlagbe-client.vercel.app
- **Client repo:** https://github.com/im-asam/assignment09-mentorlagbe-client

## Test Accounts (for the examiner)

| Role | Email | Password |
| ---- | ----- | -------- |
| Admin | admin@mentorlagbe.com | Admin123! |
| Tutor | tutor@mentorlagbe.com | Tutor123! |
| Student | student@mentorlagbe.com | Student123! |

## Key Features

- **JWT verification with role-based middlewares** — verifies BetterAuth EdDSA JWTs via the client's JWKS endpoint (with an HS256 fallback), plus `verifyStudent`, `verifyTutor`, and `verifyAdmin` guards.
- **Tuitions CRUD** — tutors post, edit, and delete tuition listings; free-plan tutors are limited to 2 posts, Pro tutors post unlimited.
- **Admin moderation** — admins approve/reject tuition posts and manage user roles.
- **Student applications** — students apply to approved tuitions (duplicate applications blocked), tutors accept/reject applicants, students can cancel pending applications.
- **Server-side search, filter & pagination** — search by title/subject, filter by subject, class level, and mode, with `.skip()`/`.limit()` pagination.
- **Stripe Pro upgrades** — Tutor Pro ($15) and Student Pro ($10) checkout sessions, session verification, and a webhook that records payments and upgrades the plan to `pro`.
- **Admin stats & transactions** — user/tuition counts, total Stripe revenue, and full payment history.
- **Seed script** — 12 realistic approved tuitions across 12 subjects, 4 tutor personas, and sample applications (`npm run seed`).

## API Endpoints

| Method | Endpoint | Access | Description |
| ------ | -------- | ------ | ----------- |
| GET | `/` | Public | Health check |
| GET | `/tuitions?search&subject&classLevel&mode&page&limit` | Public | Approved + active tuitions (search, filter, pagination) |
| GET | `/tuitions/mine` | Tutor | Tutor's own tuitions |
| GET | `/tuitions/:id` | Public | Single tuition by id |
| POST | `/tuitions` | Tutor | Create a tuition (free plan: max 2) |
| PATCH | `/tuitions/:id` | Tutor (owner) | Update a tuition |
| DELETE | `/tuitions/:id` | Tutor (owner) | Delete a tuition (+ its applications) |
| GET | `/admin/tuitions` | Admin | All tuitions, newest first |
| PATCH | `/admin/tuitions/:id/status` | Admin | Approve / reject a tuition |
| POST | `/applications` | Student | Apply to a tuition (duplicate → 409) |
| GET | `/applications/mine` | Student | Own applications |
| DELETE | `/applications/:id` | Student (owner) | Cancel a pending application |
| GET | `/applications/tutor` | Tutor | Applications on own tuitions |
| PATCH | `/applications/:id/status` | Tutor | Accept / reject an application |
| GET | `/users/me` | Authenticated | Own profile |
| PATCH | `/users/me` | Authenticated | Update name, phone, bio, image |
| GET | `/admin/users` | Admin | All users |
| PATCH | `/admin/users/:id/role` | Admin | Change a user's role |
| GET | `/admin/stats` | Admin | Platform statistics |
| GET | `/admin/transactions` | Admin | All payments, newest first |
| POST | `/payments/create-checkout-session` | Authenticated | Stripe Checkout for Pro plans |
| POST | `/payments/verify-session` | Authenticated | Verify a checkout session |
| POST | `/webhooks/stripe` | Stripe | Checkout webhook (raw body) |

All errors are JSON `{ error: "..." }` with proper HTTP status codes.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Purpose |
| -------- | ------- |
| `MONGODB_URI` | MongoDB Atlas connection string (database `mentorlagbe`) |
| `BETTER_AUTH_SECRET` | Shared BetterAuth secret (must match the client) |
| `CLIENT_URL` | Client origin (CORS + Stripe redirect URLs) |
| `STRIPE_SECRET_KEY` | Stripe secret key (TEST mode; checkout returns 503 while unset) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

## Run Locally

```bash
npm install
cp .env.example .env   # fill in real values
npm start              # node index.js (port 5000)
npm run seed           # seed tuitions + test accounts
```

## npm Packages Used

- `express` — HTTP server & routing
- `cors` — cross-origin requests from the client
- `dotenv` — environment variables
- `jsonwebtoken` — JWT decoding & HS256 fallback verification
- `mongodb` — MongoDB driver (lazy, cached `MongoClient`)
- `stripe` — Stripe Checkout & webhooks
