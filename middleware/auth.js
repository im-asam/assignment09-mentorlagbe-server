const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

// The client app's BetterAuth JWT plugin signs tokens with EdDSA (Ed25519)
// using a key pair it manages itself — NOT with BETTER_AUTH_SECRET. The
// public key is published at the client's /api/auth/jwks endpoint, so this
// server verifies tokens against that JWKS (cached in memory, refreshed
// when a token's `kid` is unknown, e.g. after key rotation).
// As a fallback, HS256 tokens signed with the shared BETTER_AUTH_SECRET
// are also accepted, so either client configuration keeps working.

// JWKS URL derives from the client origin (CLIENT_URL env var).
const CLIENT_URL =
  process.env.CLIENT_URL ||
  "https://assignment09-mentorlagbe-client.vercel.app";
const JWKS_URL = `${CLIENT_URL.replace(/\/$/, "")}/api/auth/jwks`;
const JWKS_TTL_MS = 10 * 60 * 1000;

let jwksCache = null; // { keys: [...], fetchedAt: number }

async function fetchJwks() {
  let res;
  try {
    res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.error("JWKS fetch error:", err.message);
    throw new Error(`JWKS fetch failed: ${err.message}`);
  }
  if (!res.ok) {
    console.error(`JWKS fetch HTTP ${res.status}`);
    throw new Error(`JWKS fetch failed (${res.status})`);
  }
  const data = await res.json();
  jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function getJwksKeys(forceRefresh = false) {
  const stale =
    !jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (forceRefresh || stale) {
    return fetchJwks();
  }
  return jwksCache.keys;
}

// Verifies an EdDSA (Ed25519) JWT signature with Node's built-in crypto.
// NOTE: jsonwebtoken 9.x cannot verify EdDSA tokens at all — its key
// validator has no 'ed25519' entry and throws `Unknown key type "ed25519"`
// for both KeyObject and PEM keys. So EdDSA verification is done here
// directly (signature + exp/nbf checks); jsonwebtoken is only used for
// the HS256 fallback below.
function verifyEdDSA(token, publicKey) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const data = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64url");
  let valid;
  try {
    valid = crypto.verify(null, data, publicKey, signature);
  } catch (err) {
    console.error("EdDSA verify failed:", err.message);
    throw new Error(`EdDSA verify failed: ${err.message}`);
  }
  if (!valid) {
    throw new Error("Invalid signature");
  }
  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  );
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) {
    throw new Error("Token expired");
  }
  if (payload.nbf && now < payload.nbf) {
    throw new Error("Token not yet valid");
  }
  return payload;
}

function verifyWithJwks(token, kid) {
  return getJwksKeys()
    .then(async (keys) => {
      let jwk = keys.find((k) => k.kid === kid);
      if (!jwk) {
        // Unknown kid — the client may have rotated keys; refresh once.
        jwk = (await getJwksKeys(true)).find((k) => k.kid === kid);
      }
      if (!jwk) {
        console.error(`JWKS has no key for kid ${kid}`);
        throw new Error("No matching key in JWKS");
      }
      const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
      return verifyEdDSA(token, publicKey);
    });
}

// Verifies a BetterAuth JWT and returns its decoded claims.
// Throws on any verification failure.
async function verifyJwt(token) {
  const header = jwt.decode(token, { complete: true })?.header;

  // Asymmetric token (what the JWT plugin issues): verify via JWKS.
  if (header && header.alg && header.alg !== "HS256") {
    return verifyWithJwks(token, header.kid);
  }

  // Symmetric token: verify with the shared secret.
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) {
    try {
      return jwt.verify(token, secret, { algorithms: ["HS256"] });
    } catch (err) {
      // Fall through to the JWKS attempt (e.g. HS256 header on a
      // misconfigured client); if that fails too, the token is rejected.
    }
  }
  if (header && header.kid) {
    return verifyWithJwks(token, header.kid);
  }
  throw new Error("JWT verification failed");
}

// The client sets BetterAuth's user model name to "users", but if that
// ever fails the adapter falls back to its default "user" collection.
// Look in `users` first, then `user`, so either layout works.
async function findUserByIdOrEmail(db, sub, email) {
  for (const name of ["users", "user"]) {
    const coll = db.collection(name);
    if (sub && ObjectId.isValid(sub)) {
      const byId = await coll.findOne({ _id: new ObjectId(sub) });
      if (byId) return byId;
    }
    if (sub) {
      const byStringId = await coll.findOne({ _id: sub });
      if (byStringId) return byStringId;
    }
    if (email) {
      const byEmail = await coll.findOne({ email });
      if (byEmail) return byEmail;
    }
  }
  return null;
}

// Verifies the BetterAuth JWT (issued by the client app's JWT plugin).
// Token's `sub` claim is the user's id. Resolves the full user doc
// (role + plan) from `users` (then `user`) and attaches it as req.user.
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let decoded;
  try {
    decoded = await verifyJwt(token);
  } catch (err) {
    console.error("JWT verify failed:", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = decoded.sub || null;
  req.userEmail = decoded.email || null;
  req.user = null;

  // Resolve the full user doc (role + plan) from the DB.
  try {
    const db = await getDb();
    const user = await findUserByIdOrEmail(db, decoded.sub, decoded.email);
    if (user) {
      req.user = user;
      if (user.email) req.userEmail = user.email;
    }
  } catch (err) {
    // DB lookup failure must not reject an otherwise valid token.
    console.error("User lookup failed:", err.message);
  }

  // Last resort identity: email claim, else the sub itself.
  if (!req.userEmail) {
    req.userEmail = decoded.sub || null;
  }

  next();
}

// Role guards — run after verifyToken; each sends 403 on a role mismatch.
function verifyStudent(req, res, next) {
  if (req.user?.role !== "student") {
    return res.status(403).json({ error: "Forbidden: student role required" });
  }
  next();
}

function verifyTutor(req, res, next) {
  if (req.user?.role !== "tutor") {
    return res.status(403).json({ error: "Forbidden: tutor role required" });
  }
  next();
}

function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin role required" });
  }
  next();
}

module.exports = { verifyToken, verifyStudent, verifyTutor, verifyAdmin, verifyJwt };
