"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");

// Ensure the data/ directory exists before opening the file.
fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

const db = new Database(config.DB_PATH);

// WAL persists with the file (better concurrent reads); foreign_keys is a
// per-connection pragma, so it must be set on every open.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Apply the (idempotent) schema.
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// Seed the reserved AI account. password_hash NULL means it can never log in;
// it exists only to own the AI side of games via a real FK (uniform queries).
db.prepare(
  "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, NULL)"
).run(config.AI_USERNAME);

module.exports = db;
