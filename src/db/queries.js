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

  // --- games ---
  createGame: db.prepare(`
    INSERT INTO games (white_id, black_id, mode, ai_color, ai_depth,
                       start_fen, current_fen, turn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  // A user's games, newest first (they may be on either side).
  listGamesForUser: db.prepare(`
    SELECT * FROM games
    WHERE white_id = ? OR black_id = ?
    ORDER BY id DESC
  `),
  updateGamePosition: db.prepare(
    "UPDATE games SET current_fen = ?, turn = ? WHERE id = ?"
  ),
  finishGame: db.prepare(`
    UPDATE games
    SET status = 'finished', result = ?, termination = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `),

  // --- moves ---
  insertMove: db.prepare(`
    INSERT INTO moves (game_id, ply, san, uci, fen_after, by_user)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getMovesForGame: db.prepare(
    "SELECT ply, san, uci, fen_after, by_user, created_at FROM moves WHERE game_id = ? ORDER BY ply"
  ),
  // Used by undo: drop everything after the new last ply.
  deleteMovesAfter: db.prepare(
    "DELETE FROM moves WHERE game_id = ? AND ply > ?"
  ),
};
