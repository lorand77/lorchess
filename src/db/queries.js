"use strict";

// Thin prepared-statement layer (no ORM). Statements are prepared once at load
// and reused — better-sqlite3 is synchronous, so callers use .get()/.run()/.all()
// directly. Keep all SQL here so the rest of the app stays SQL-free.

const db = require("./index");

module.exports = {
  // --- users ---
  createUser: db.prepare(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)"
  ),
  // Full row incl. password_hash — for login verification only.
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  // Safe public view (no hash) — for /api/me and general lookups.
  getUserById: db.prepare(
    "SELECT id, username, rating, created_at FROM users WHERE id = ?"
  ),
};
