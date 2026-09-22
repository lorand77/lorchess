"use strict";

// Achievements API.
//   GET /api/achievements/me          my earned list (evaluating time-based ones first)
//   GET /api/achievements/user/:id    someone else's earned list
// The catalogue itself is static and served at /js/achievements.js.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const svc = require("./service");

const router = express.Router();
router.use(requireAuth);

function listFor(userId) {
  const user = queries.getUserById.get(userId);
  if (!user) return null;
  return {
    user: { id: user.id, username: user.username, created_at: user.created_at },
    earned: queries.listAchievements.all(userId),
  };
}

router.get("/me", (req, res) => {
  const uid = req.session.userId;
  const fresh = svc.onVisit(uid);
  const out = listFor(uid);
  if (!out) return res.status(401).json({ error: "Authentication required." });
  out.fresh = fresh;
  res.json(out);
});

router.get("/user/:id", (req, res) => {
  const out = listFor(Number(req.params.id));
  if (!out) return res.status(404).json({ error: "No such user." });
  res.json(out);
});

module.exports = router;
