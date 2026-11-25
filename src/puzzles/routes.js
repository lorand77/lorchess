"use strict";

// Puzzle API. The server holds the solutions; the client sends the moves it
// has played so far and learns only whether it's still on track.
//
//   GET  /api/puzzles/next            a puzzle near your rating — the same one
//                                     until you solve it or give up (resumed: true)
//   GET  /api/puzzles/daily           today's shared puzzle (+ your result if done);
//                                     unrated, like every puzzle that has been a daily
//   POST /api/puzzles/:id/moves       { moves: [uci, ...] } -> ok | solved | miss | wrong
//   POST /api/puzzles/:id/giveup      counts as a failed attempt, reveals the solution
//
// A daily puzzle allows svc.DAILY_TRIES wrong moves: until they run out a wrong
// move answers `miss` with `triesLeft` and reveals nothing, and the client takes
// it back. /daily and /:id say `triesLeft` while that applies (null otherwise).
// Only a solved daily extends the streak.
//   POST /api/puzzles/:id/skip        members: drop the held puzzle unrated and get the
//                                     next one; SKIPS_PER_DAY per UTC day
//   POST /api/puzzles/:id/hint        members: { moves, step: 1 | 2 } -> { hint, hints }:
//                                     the piece to move (step 1), then its square
//                                     (step 2), on the move the solver is on; one
//                                     per puzzle, HINTS_PER_DAY puzzles a UTC day,
//                                     none on a daily; a hinted solve earns less
//
// /next, /:id and /:id/skip also carry `held` (this is the puzzle you're held
// to), `skip: { member, left, perDay }` for the page's Skip button, and
// `hints: { member, left, perDay, available, single, shown }` for its Hint
// button (`shown`: the hint already taken on this puzzle, to show again). /:id and
// the finishing replies say `daily: true` for a puzzle that has been a daily,
// which is why their `rating` is null.

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

// The Hint button's state for a puzzle: whether hints apply to it at all (not
// a daily, not attempted yet), whether it is a single move, and the hint taken.
function hintsView(uid, puzzle) {
  const member = isMember(uid);
  return {
    member,
    left: member ? svc.hintsLeft(uid) : 0,
    perDay: svc.HINTS_PER_DAY,
    available: !svc.isDaily(puzzle.id) && !queries.getAttempt.get(uid, puzzle.id),
    single: svc.solverMoves(puzzle) === 1,
    shown: member ? svc.hintShown(uid, puzzle) : null,
  };
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
    hints: hintsView(uid, pick.puzzle),
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
  // Today's puzzle may have been solved before it was today's, through the
  // rated stream. It is done either way, and a solve counts for the streak — so
  // credit it here, or "solved" and the streak would disagree. Idempotent per day.
  const streak = attempt && attempt.solved
    ? svc.bumpStreak(uid, today)
    : svc.currentStreak(uid, today);
  const out = {
    date: today,
    puzzle: svc.publicView(puzzle),
    done: !!attempt,
    solved: attempt ? !!attempt.solved : null,
    triesLeft: svc.triesLeft(uid, puzzle.id),
    streak,
    rating: user.puzzle_rating,
  };
  if (attempt) Object.assign(out, svc.revealView(puzzle), { misses: attempt.misses });
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
    daily: svc.isDaily(puzzle.id),
    triesLeft: svc.triesLeft(uid, puzzle.id),
    rating: user.puzzle_rating,
    held: svc.isHeld(uid, puzzle.id),
    skip: skipView(uid),
    hints: hintsView(uid, puzzle),
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

// Wrap up a finished attempt: record it (first time only; rated unless it's a
// daily puzzle), bump the streak if it solved today's daily, and reveal the
// solution.
function finish(uid, puzzle, solved) {
  const misses = svc.missesOf(uid, puzzle.id);
  const first = svc.recordAttempt(uid, puzzle, solved);
  const today = svc.todayUtc();
  const todays = queries.getDaily.get(today);
  const isToday = !!todays && todays.puzzle_id === puzzle.id;
  const out = {
    rating: first && first.rated ? first : null,
    daily: svc.isDaily(puzzle.id),
    ...svc.revealView(puzzle),
  };
  if (first) out.misses = misses;
  // Retries count for nothing — not for the streak either; only a first
  // attempt that solves it can earn. Anything else reports the streak as it is.
  if (isToday) {
    out.streak = first && solved
      ? svc.bumpStreak(uid, today)
      : svc.currentStreak(uid, today);
  }
  out.achievements = first ? achievements.onPuzzleFinished(uid, puzzle) : [];
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
  // A daily with tries to spare: count the miss and keep the solution back.
  if (result.status === "wrong" && svc.triesLeft(uid, puzzle.id) !== null) {
    const triesLeft = svc.miss(uid, puzzle.id);
    if (triesLeft > 0) return res.json({ status: "miss", triesLeft });
  }
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

const HINT_ERRORS = {
  daily: [409, "No hints on the daily puzzle."],
  done: [409, "Hints are for a puzzle you haven't finished."],
  off: [409, "Those moves aren't on the solution."],
  used: [409, "You've used this puzzle's hint."],
  first: [409, "Ask for the piece first."],
  single: [409, "A one-move puzzle's hint shows the piece only."],
  limit: [429, `You've used all ${svc.HINTS_PER_DAY} hints for today.`],
};

router.post("/:id/hint", (req, res) => {
  const puzzle = loadPuzzle(req, res);
  if (!puzzle) return;
  const uid = req.session.userId;
  if (!isMember(uid)) return res.status(403).json({ error: "Puzzle hints are a member perk." });
  const moves = req.body && req.body.moves;
  const step = req.body && req.body.step;
  if (!Array.isArray(moves) || moves.some((m) => typeof m !== "string") || (step !== 1 && step !== 2)) {
    return res.status(400).json({ error: "Send the moves so far and step 1 or 2." });
  }
  const out = svc.takeHint(uid, puzzle, moves, step);
  if (out.error) {
    const [status, error] = HINT_ERRORS[out.error];
    return res.status(status).json({ error, hints: hintsView(uid, puzzle) });
  }
  res.json({ hint: out.hint, hints: hintsView(uid, puzzle) });
});

module.exports = router;
