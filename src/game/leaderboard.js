"use strict";

// GET /api/leaderboard — human accounts ranked by rating with their record in
// finished rated PvP games. Read-only; the ranking is computed in SQL (see
// queries.leaderboard) so this stays a one-liner.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const config = require("../config");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  res.json(queries.leaderboard.all(config.AI_USERNAME));
});

module.exports = router;
