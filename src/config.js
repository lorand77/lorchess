"use strict";

const path = require("path");

// An integer setting from the environment. Unlike `parseInt(x) || fallback`,
// this keeps an explicit 0 or a negative number, so a setting can give them a
// meaning (CHAT_RETENTION_DAYS=-1 keeps chat forever). Unset or unparseable
// values fall back to the default.
function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

// Central place for env-driven constants.
module.exports = {
  PORT: intEnv("PORT", 3000),

  // Signs the session cookie. MUST be overridden in production via env.
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",

  // Single-file SQLite database (created on first run).
  DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "data", "lorchess.sqlite"),

  // Reserved system account that owns the AI side of games (M3+).
  AI_USERNAME: "LorFish",

  // Grace period a disconnected PvP player has to reconnect before forfeiting.
  DISCONNECT_GRACE_MS: intEnv("GRACE_MS", 45000),

  // PvP time control (server-authoritative clocks). Default 10+0.
  CLOCK_INITIAL_MS: intEnv("CLOCK_MS", 10 * 60 * 1000),
  CLOCK_INCREMENT_MS: intEnv("CLOCK_INC_MS", 0),

  // How long a game left 'active' by a restart waits for a player to come
  // back before it is given up on and aborted.
  RESUME_WINDOW_MS: intEnv("RESUME_WINDOW_MS", 10 * 60 * 1000),

  // How long in-game chat is kept after a game ends. The conversation only
  // matters while the players are still there arranging a rematch; keeping it
  // for ever means every message anyone has sent lives in the database (and in
  // every backup) indefinitely. -1 disables the sweep and keeps everything.
  CHAT_RETENTION_DAYS: intEnv("CHAT_RETENTION_DAYS", 30),

  // Elo K-factor for rating updates after rated games.
  ELO_K: intEnv("ELO_K", 32),

  // Starting puzzle rating for a new account.
  PUZZLE_START_RATING: 1200,
};
