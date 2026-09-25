"use strict";

// Achievements API.
//   GET /api/achievements/me          my earned list (evaluating time-based ones first)
//   GET /api/achievements/user/:id    someone else's earned list
// The catalogue itself is static and served at /js/achievements.js.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const config = require("../config");
const svc = require("./service");

const router = express.Router();
router.use(requireAuth);

// LorFish is not a player: no page, no list — as every per-user route answers.
const AI_ID = queries.getUserByUsername.get(config.AI_USERNAME).id;

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
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad user id." });
  const out = id === AI_ID ? null : listFor(id);
  if (!out) return res.status(404).json({ error: "No such user." });
  // Time-based badges (an anniversary, say) are earned by the calendar, not by
  // logging in. Evaluate them for the person being looked at too, so their
  // public tab is never behind what they would see themselves.
  try {
    svc.onVisit(id);
    out.earned = queries.listAchievements.all(id);
  } catch (e) {
    console.error("achievements:", e);
  }
  res.json(out);
});

module.exports = router;
