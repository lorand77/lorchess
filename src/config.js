"use strict";

const path = require("path");

// Central place for env-driven constants.
module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // Signs the session cookie. MUST be overridden in production via env.
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",

  // Single-file SQLite database (created on first run).
  DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "data", "lorchess.sqlite"),

  // Reserved system account that owns the AI side of games (M3+).
  AI_USERNAME: "LorFish",

  // Grace period a disconnected PvP player has to reconnect before forfeiting.
  DISCONNECT_GRACE_MS: parseInt(process.env.GRACE_MS, 10) || 45000,

  // PvP time control (server-authoritative clocks). Default 10+0.
  CLOCK_INITIAL_MS: parseInt(process.env.CLOCK_MS, 10) || 10 * 60 * 1000,
  CLOCK_INCREMENT_MS: parseInt(process.env.CLOCK_INC_MS, 10) || 0,

  // Elo K-factor for rating updates after rated games.
  ELO_K: parseInt(process.env.ELO_K, 10) || 32,
};
