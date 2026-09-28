"use strict";

// Account authentication and session lifecycle, shared by HTTP and sockets.

const express = require("express");
const argon2 = require("argon2");
const queries = require("../db/queries");
const { requireAuth } = require("./middleware");
const config = require("../config");
const achievements = require("../achievements/service");
const { loginFailures, registrations, acquireHashSlot } = require("./throttle");
const { usernameProblem } = require("./usernamePolicy");

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 6;
// No real password is longer; the cap keeps argon2 from being fed megabytes.
const MAX_PASSWORD = 128;

const TOO_MANY = { error: "Too many attempts. Try again later." };
const BUSY = { error: "The server is busy. Try again in a moment." };

function disconnectSessionSockets(req, sessionId) {
  req.app.get("io").in(`session:${sessionId}`).disconnectSockets(true);
}

// Establish a fresh, authenticated session. Always regenerate first to defeat
// session-fixation: the pre-login session id is discarded.
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    const oldSessionId = req.sessionID;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      disconnectSessionSockets(req, oldSessionId);
      req.session.userId = user.id;
      req.session.username = user.username;
      resolve();
    });
  });
}

router.post("/register", async (req, res) => {
  try {
    if (registrations.blocked(req.ip)) return res.status(429).json(TOO_MANY);
    const { username, password } = req.body || {};
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: "Username must be 3–20 characters: letters, digits, or underscore.",
      });
    }
    if (
      typeof password !== "string" ||
      password.length < MIN_PASSWORD ||
      password.length > MAX_PASSWORD
    ) {
      return res
        .status(400)
        .json({ error: `Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.` });
    }
    // One message for every rule, so the lists can't be probed rule by rule.
    if (usernameProblem(username)) {
      return res.status(400).json({ error: "That username isn't allowed." });
    }
    // Names that differ only in case would be indistinguishable in every list,
    // so they count as the same name (login still wants the exact spelling).
    if (queries.getUserByUsernameNoCase.get(username)) {
      return res.status(409).json({ error: "Username already taken." });
    }

    const release = acquireHashSlot();
    if (!release) return res.status(503).json(BUSY);
    registrations.hit(req.ip);
    let hash;
    try {
      hash = await argon2.hash(password);
    } finally {
      release();
    }
    const info = queries.createUser.run(username, hash, config.PUZZLE_START_RATING);
    const user = { id: Number(info.lastInsertRowid), username };
    await startSession(req, user);
    return res.status(201).json(user);
  } catch (err) {
    // Two registrations for the same name can both pass the check above while
    // the first is still hashing; the second then trips the UNIQUE constraint.
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "Username already taken." });
    }
    console.error("register failed:", err);
    return res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/login", async (req, res) => {
  try {
    if (loginFailures.blocked(req.ip)) return res.status(429).json(TOO_MANY);
    const { username, password } = req.body || {};
    const user =
      typeof username === "string" ? queries.getUserByUsername.get(username) : null;
    const candidate = String(password || "");

    // Uniform failure for "no such user", "wrong password" and a password too
    // long to be anyone's. The reserved AI account has a NULL hash, so it can
    // never authenticate here.
    let ok = false;
    if (user && user.password_hash && candidate.length <= MAX_PASSWORD) {
      const release = acquireHashSlot();
      if (!release) return res.status(503).json(BUSY);
      try {
        ok = await argon2.verify(user.password_hash, candidate);
      } finally {
        release();
      }
    }
    if (!ok) {
      loginFailures.hit(req.ip);
      return res.status(401).json({ error: "Invalid username or password." });
    }
    // Only said to someone who knows the password, so it leaks nothing.
    if (user.deactivated_at) {
      return res.status(403).json({ error: "This account has been deactivated." });
    }

    await startSession(req, user);
    try { achievements.onVisit(user.id); } catch (e) { console.error("achievements:", e); }
    return res.json({ id: user.id, username: user.username });
  } catch (err) {
    console.error("login failed:", err);
    return res.status(500).json({ error: "Login failed." });
  }
});

router.post("/logout", (req, res) => {
  const sessionId = req.sessionID;
  req.session.destroy((err) => {
    if (err) {
      console.error("logout failed:", err);
      return res.status(500).json({ error: "Logout failed." });
    }
    disconnectSessionSockets(req, sessionId);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.get("/me", requireAuth, (req, res) => {
  const user = queries.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  return res.json(user);
});

module.exports = router;
