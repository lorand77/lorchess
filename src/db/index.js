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
// Remaining clock per side, so an in-progress game survives a restart.
addColumnIfMissing("games", "clock_w_ms", "INTEGER");
addColumnIfMissing("games", "clock_b_ms", "INTEGER");
// When the user became a member, or NULL if they never redeemed a code.
addColumnIfMissing("users", "member_since", "TEXT");
// Look & feel preferences (board colours, background colour) as a JSON blob.
addColumnIfMissing("users", "prefs", "TEXT");
// Puzzle Elo (separate from the game rating) and the daily-puzzle streak.
addColumnIfMissing("users", "puzzle_rating", `INTEGER NOT NULL DEFAULT ${config.PUZZLE_START_RATING}`);
addColumnIfMissing("users", "daily_streak", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "daily_last_date", "TEXT");
// Time the mover spent on a PvP move, in ms (NULL for AI games and for moves
// recorded before this column existed). Achievements read it.
addColumnIfMissing("moves", "think_ms", "INTEGER");
// 1 when the move was queued as a premove (see the Clairvoyant achievement).
addColumnIfMissing("moves", "premove", "INTEGER NOT NULL DEFAULT 0");

// The puzzle rating used to start at 1500. Move anyone who never attempted a
// puzzle to the current starting value; the column default on an existing
// database can't be altered, so createUser also sets it explicitly.
db.prepare(`
  UPDATE users SET puzzle_rating = ?
  WHERE puzzle_rating = 1500
    AND id NOT IN (SELECT user_id FROM puzzle_attempts)
`).run(config.PUZZLE_START_RATING);

// Seed the reserved AI account. password_hash NULL means it can never log in;
// it exists only to own the AI side of games via a real FK (uniform queries).
db.prepare(
  "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, NULL)"
).run(config.AI_USERNAME);

module.exports = db;
