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

// --- migrations ---
// schema.sql only ever CREATEs, which is idempotent; adding a column to a table
// that already exists needs ALTER, which is not. Apply those here instead, so a
// database created before a column existed picks it up on the next boot.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}
addColumnIfMissing("games", "initial_ms", "INTEGER");
addColumnIfMissing("games", "increment_ms", "INTEGER");
addColumnIfMissing("games", "rated", "INTEGER NOT NULL DEFAULT 1");

// Seed the reserved AI account. password_hash NULL means it can never log in;
// it exists only to own the AI side of games via a real FK (uniform queries).
db.prepare(
  "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, NULL)"
).run(config.AI_USERNAME);

module.exports = db;
