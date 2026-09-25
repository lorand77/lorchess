"use strict";

// Puzzle API. The server holds the solutions; the client sends the moves it
// has played so far and learns only whether it's still on track.
//
//   GET  /api/puzzles/next            a puzzle near your rating — the same one
//                                     until you solve it or give up (resumed: true)
//   GET  /api/puzzles/daily           today's shared puzzle (+ your result if done)
//   POST /api/puzzles/:id/moves       { moves: [uci, ...] } -> ok | solved | wrong
//   POST /api/puzzles/:id/giveup      counts as a failed attempt, reveals the solution
//   POST /api/puzzles/:id/skip        members: drop the held puzzle unrated and get the
//                                     next one; SKIPS_PER_DAY per UTC day
//
// /next, /:id and /:id/skip also carry `held` (this is the puzzle you're held
// to) and `skip: { member, left, perDay }` for the page's Skip button.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const svc = require("./service");
const achievements = require("../achievements/service");

const router = express.Router();
router.use(requireAuth);

function noPuzzles(res) {
  return res.status(503).json({
    error: "No puzzles imported yet. Run `npm run puzzles:import` on the server.",
  });
}

const isMember = (uid) => {
  const row = queries.getMembership.get(uid);
  return !!(row && row.member_since);
};

function skipView(uid) {
  const member = isMember(uid);
  return { member, left: member ? svc.skipsLeft(uid) : 0, perDay: svc.SKIPS_PER_DAY };
}

// A puzzle from the rated stream, as /next and /:id/skip send it.
function streamView(uid, pick, rating) {
  return {
    puzzle: svc.publicView(pick.puzzle),
    repeat: pick.repeat,
    resumed: pick.resumed,
    held: !pick.repeat,
    rating,
    skip: skipView(uid),
  };
}

router.get("/next", (req, res) => {
  if (!queries.countPuzzles.get().n) return noPuzzles(res);
  const uid = req.session.userId;
  const user = queries.getPuzzleUser.get(uid);
  const pick = svc.nextForUser(uid, user.puzzle_rating);
  if (!pick) return noPuzzles(res);
  res.json(streamView(uid, pick, user.puzzle_rating));
});

router.get("/daily", (req, res) => {
  const uid = req.session.userId;
  const today = svc.todayUtc();
  const puzzle = svc.dailyFor(today);
  if (!puzzle) return noPuzzles(res);
  const user = queries.getPuzzleUser.get(uid);
  const attempt = queries.getAttempt.get(uid, puzzle.id);
  // Today's puzzle may have been attempted before it was today's, through the
  // rated stream. It is done either way, and done counts for the streak — so
  // credit it here, or "done" and the streak would disagree. Idempotent per day.
  const streak = attempt ? svc.bumpStreak(uid, today) : svc.streakOf(user, today);
  const out = {
    date: today,
    puzzle: svc.publicView(puzzle),
    done: !!attempt,
    solved: attempt ? !!attempt.solved : null,
    streak,
    rating: user.puzzle_rating,
  };
  if (attempt) Object.assign(out, svc.revealView(puzzle));
  res.json(out);
});

// GET /api/puzzles/:id — one specific puzzle, so a card that previews a board
// can hand out the same board when it is clicked instead of a fresh random one.
// Declared before the :id/* routes below, and after /next and /daily so those
// literal paths still win.
router.get("/:id", (req, res) => {
  const puzzle = queries.getPuzzle.get(String(req.params.id));
  if (!puzzle) return res.status(404).json({ error: "No such puzzle." });
  const uid = req.session.userId;
  const attempt = queries.getAttempt.get(uid, puzzle.id);
  const user = queries.getPuzzleUser.get(uid);
  const out = {
    puzzle: svc.publicView(puzzle),
    // A puzzle already attempted is replayable but never re-rated.
    repeat: !!attempt,
    rating: user.puzzle_rating,
    held: svc.isHeld(uid, puzzle.id),
    skip: skipView(uid),
  };
  if (attempt) out.solved = !!attempt.solved;
  res.json(out);
});

// Load the puzzle in :id, or 404.
function loadPuzzle(req, res) {
  const p = queries.getPuzzle.get(String(req.params.id));
  if (!p) res.status(404).json({ error: "No such puzzle." });
  return p || null;
}

// Wrap up a finished attempt: rate it (first time only), bump the streak if
// it's today's daily, and reveal the solution.
function finish(uid, puzzle, solved) {
  const rating = svc.recordAttempt(uid, puzzle, solved);
  const today = svc.todayUtc();
  const daily = queries.getDaily.get(today);
  const isDaily = !!daily && daily.puzzle_id === puzzle.id;
  const out = { rating, ...svc.revealView(puzzle) };
  // Retries are unrated and count for nothing — not for the streak either;
  // only a first attempt can earn. A retry just reports the streak as it is.
  if (isDaily) {
    out.streak = rating
      ? svc.bumpStreak(uid, today)
      : svc.streakOf(queries.getPuzzleUser.get(uid), today);
  }
  out.achievements = rating ? achievements.onPuzzleFinished(uid, puzzle) : [];
  return out;
}

router.post("/:id/moves", (req, res) => {
  const puzzle = loadPuzzle(req, res);
  if (!puzzle) return;
  const moves = req.body && req.body.moves;
  if (!Array.isArray(moves) || moves.some((m) => typeof m !== "string")) {
    return res.status(400).json({ error: "moves must be an array of UCI strings." });
  }
  const uid = req.session.userId;
  const result = svc.check(puzzle, moves);
  if (result.status === "ok") return res.json({ status: "ok", reply: result.reply });
  res.json({ status: result.status, ...finish(uid, puzzle, result.status === "solved") });
});

router.post("/:id/giveup", (req, res) => {
  const puzzle = loadPuzzle(req, res);
  if (!puzzle) return;
  res.json({ status: "wrong", ...finish(req.session.userId, puzzle, false) });
});

router.post("/:id/skip", (req, res) => {
  const puzzle = loadPuzzle(req, res);
  if (!puzzle) return;
  const uid = req.session.userId;
  if (!isMember(uid)) {
    return res.status(403).json({ error: "Skipping puzzles is a member perk." });
  }
  const user = queries.getPuzzleUser.get(uid);
  const out = svc.skip(uid, puzzle.id, user.puzzle_rating);
  if (out.error === "not-held") {
    return res.status(409).json({ error: "Only the puzzle you're on can be skipped." });
  }
  if (out.error === "limit") {
    return res.status(429).json({
      error: `You've used all ${svc.SKIPS_PER_DAY} skips for today.`, skip: skipView(uid),
    });
  }
  if (!out.next) return noPuzzles(res);
  res.json(streamView(uid, out.next, user.puzzle_rating));
});

module.exports = router;
