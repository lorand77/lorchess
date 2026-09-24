"use strict";

// GET /api/leaderboard?sort=<column>&dir=<asc|desc> — human accounts with
// their record in finished rated PvP games, top 100 by the chosen column.
// Sorting happens in SQL (see queries.leaderboard), not in the browser, so the
// top 100 by puzzle rating really are the top 100, not a re-sort of the top 100
// by game rating. Unknown values fall back to the default: rating, descending.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const config = require("../config");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  let sort = String(req.query.sort || "rating");
  if (!queries.leaderboard[`${sort}:desc`]) sort = "rating";
  // Names read A→Z first; every number reads biggest first.
  const dir = req.query.dir === "asc" || req.query.dir === "desc"
    ? req.query.dir
    : sort === "player" ? "asc" : "desc";
  res.json(queries.leaderboard[`${sort}:${dir}`].all(config.AI_USERNAME));
});

module.exports = router;
