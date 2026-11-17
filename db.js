const { MongoClient } = require("mongodb");

// Lazy, cached MongoClient — connects on first use and reuses the same
// client across calls (serverless-safe: survives warm invocations).
let client = null;
let clientPromise = null;

function getClient() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set");
  }
  if (!clientPromise) {
    client = new MongoClient(process.env.MONGODB_URI);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

async function getDb() {
  const connectedClient = await getClient();
  return connectedClient.db("mentorlagbe");
}

module.exports = { getDb };
