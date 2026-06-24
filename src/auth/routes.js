"use strict";

const express = require("express");
const argon2 = require("argon2");
const queries = require("../db/queries");
const { requireAuth } = require("./middleware");
const config = require("../config");

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 6;

// Establish a fresh, authenticated session. Always regenerate first to defeat
// session-fixation: the pre-login session id is discarded.
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.username = user.username;
      resolve();
    });
  });
}

router.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: "Username must be 3–20 characters: letters, digits, or underscore.",
      });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (username.toLowerCase() === config.AI_USERNAME.toLowerCase()) {
      return res.status(400).json({ error: "That username is reserved." });
    }
    if (queries.getUserByUsername.get(username)) {
      return res.status(409).json({ error: "Username already taken." });
    }

    const hash = await argon2.hash(password);
    const info = queries.createUser.run(username, hash);
    const user = { id: Number(info.lastInsertRowid), username };
    await startSession(req, user);
    return res.status(201).json(user);
  } catch (err) {
    console.error("register failed:", err);
    return res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user =
      typeof username === "string" ? queries.getUserByUsername.get(username) : null;

    // Uniform failure for "no such user" and "wrong password". The reserved AI
    // account has a NULL hash, so it can never authenticate here.
    const ok =
      user && user.password_hash
        ? await argon2.verify(user.password_hash, String(password || ""))
        : false;
    if (!ok) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    await startSession(req, user);
    return res.json({ id: user.id, username: user.username });
  } catch (err) {
    console.error("login failed:", err);
    return res.status(500).json({ error: "Login failed." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
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
