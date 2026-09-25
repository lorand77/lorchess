"use strict";

// Player profiles: the numbers behind a username, plus the two series the page
// charts. Public to any signed-in user — the leaderboard already shows ratings
// and records, so there is nothing here that wasn't already on display.
//
//   GET /api/profile        your own
//   GET /api/profile/:id    anyone's (LorFish is not a player, so it has none)
//
// Both carry `you: true|false`, so the page can word things for the viewer.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const config = require("../config");

const router = express.Router();
router.use(requireAuth);

const AI_ID = queries.getUserByUsername.get(config.AI_USERNAME).id;

const emptyRecord = () => ({ played: 0, wins: 0, losses: 0, draws: 0 });

function rate(r) {
  // Draws count as half, the way a chess score does — otherwise a drawish
  // player looks identical to a losing one.
  return r.played ? ((r.wins + r.draws / 2) / r.played) * 100 : null;
}

function withRate(r) {
  return { ...r, winRate: r.played ? (r.wins / r.played) * 100 : null, score: rate(r) };
}

function buildStats(userId) {
  const rows = queries.profileGames.all(userId, userId);

  const modes = { pvp: emptyRecord(), ai: emptyRecord() };
  const colours = { w: emptyRecord(), b: emptyRecord() };

  for (const g of rows) {
    const asWhite = g.white_id === userId;
    // A game against LorFish has the reserved AI account on the other side.
    const mode = g.mode === "ai" || g.white_id === AI_ID || g.black_id === AI_ID ? "ai" : "pvp";
    let outcome;
    if (g.result === "1/2-1/2") outcome = "draw";
    else if (g.result === "1-0") outcome = asWhite ? "win" : "loss";
    else if (g.result === "0-1") outcome = asWhite ? "loss" : "win";
    else continue; // finished with no result recorded

    const bump = (rec) => {
      rec.played++;
      if (outcome === "win") rec.wins++;
      else if (outcome === "loss") rec.losses++;
      else rec.draws++;
    };
    bump(modes[mode]);
    if (mode === "pvp") bump(colours[asWhite ? "w" : "b"]);
  }

  return {
    pvp: withRate(modes.pvp),
    ai: withRate(modes.ai),
    white: withRate(colours.w),
    black: withRate(colours.b),
  };
}

// Rating after each rated game, from the rating_history rows applyElo writes.
// Prepending the starting point makes a first game render as a line rather than
// a lone dot with nothing to compare it to.
function buildRatingHistory(userId) {
  const rows = queries.profileRatingHistory.all(userId);
  if (!rows.length) return [];
  const points = [{ at: rows[0].created_at, value: rows[0].rating_before, delta: null }];
  for (const r of rows) {
    points.push({
      at: r.created_at,
      value: r.rating_after,
      delta: r.rating_after - r.rating_before,
    });
  }
  return points;
}

function buildPuzzles(userId) {
  const rows = queries.profilePuzzleHistory.all(userId);
  const solved = rows.filter((r) => r.solved).length;
  return {
    attempted: rows.length,
    solved,
    failed: rows.length - solved,
    successRate: rows.length ? (solved / rows.length) * 100 : null,
    history: rows.map((r) => ({ at: r.created_at, value: r.rating_after, solved: !!r.solved })),
  };
}

function profileFor(userId) {
  const user = queries.getUserById.get(userId);
  if (!user) return null;
  const extra = queries.getPuzzleUser.get(userId);
  return {
    user: {
      id: user.id,
      username: user.username,
      rating: user.rating,
      puzzleRating: extra ? extra.puzzle_rating : null,
      createdAt: user.created_at,
      member: !!user.member_since,
    },
    games: { ...buildStats(userId), ratingHistory: buildRatingHistory(userId) },
    puzzles: buildPuzzles(userId),
  };
}

router.get("/", (req, res) => res.json({ ...profileFor(req.session.userId), you: true }));

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad user id." });
  const out = id === AI_ID ? null : profileFor(id);
  if (!out) return res.status(404).json({ error: "No such player." });
  res.json({ ...out, you: id === req.session.userId });
});

module.exports = router;
