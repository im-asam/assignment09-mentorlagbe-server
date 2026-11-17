// Vercel serverless adapter — exports the Express app.
// Do NOT call listen() here; Vercel handles the HTTP layer.
module.exports = require("../index.js");
