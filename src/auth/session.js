"use strict";

// The session middleware, built once and exported so it can be shared between
// Express and (in M4) the Socket.IO handshake — one auth mechanism for both.

const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const db = require("../db/index");
const config = require("../config");

const sessionMiddleware = session({
  store: new SqliteStore({
    client: db,
    // Periodically purge expired rows from the sessions table.
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,           // not readable from JS — mitigates XSS theft
    sameSite: "lax",
    secure: "auto",           // secure over HTTPS (prod, via trust proxy); off on localhost HTTP
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

module.exports = sessionMiddleware;
