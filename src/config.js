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

  // Reserved system account that owns the AI side of games.
  AI_USERNAME: "LorFish",

  // Grace period a disconnected PvP player has to reconnect before forfeiting.
  DISCONNECT_GRACE_MS: intEnv("GRACE_MS", 45000),

  // How often the server disconnects sockets of accounts deactivated from the
  // command line (see src/game/socket.js).
  DEACTIVATION_SWEEP_MS: intEnv("DEACTIVATION_SWEEP_MS", 30000),

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

  // Brute-force and CPU limits on /api/login and /api/register (see
  // src/auth/throttle.js): failed logins and new accounts allowed per client
  // IP within the window, and how many argon2 hashes or verifies may run at
  // once — one per vCPU on the documented server. Past that cap a request is
  // turned away with 503 instead of queueing behind the others.
  AUTH_WINDOW_MS: intEnv("AUTH_WINDOW_MS", 15 * 60 * 1000),
  LOGIN_MAX_FAILURES: intEnv("LOGIN_MAX_FAILURES", 10),
  REGISTER_MAX: intEnv("REGISTER_MAX", 5),
  HASH_MAX_CONCURRENT: intEnv("HASH_MAX_CONCURRENT", 2),

  // Starting puzzle rating for a new account.
  PUZZLE_START_RATING: 1200,
};
