"use strict";

// Puzzle logic, kept free of HTTP so it's easy to test:
//   - picking a puzzle near a user's rating (never one they've attempted)
//   - the shared puzzle of the day (same for everyone, chosen once per UTC day)
//   - verifying a player's moves against the stored solution
//   - the puzzle Elo update and the daily streak

const db = require("../db/index");
const queries = require("../db/queries");
const { Chess, sqIdx } = require("../shared/chess");

const DAILY_MIN = 1200;
const DAILY_MAX = 2000;
// New solvers move fast; the K factor settles once the rating has some history.
const K_NEW = 40;
const K_SETTLED = 20;
const SETTLED_AFTER = 30;
// Successive search windows around the user's rating when picking a puzzle.
const WINDOWS = [100, 200, 400, 800, 4000];

// ---- move helpers ----

const sqFromAlg = (a) => sqIdx(a.charCodeAt(0) - 97, parseInt(a[1], 10) - 1);

function findMove(chess, uci) {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const from = sqFromAlg(uci.slice(0, 2));
  const to = sqFromAlg(uci.slice(2, 4));
  const promo = uci[4] || null;
  return (
    chess.legalMoves().find(
      (m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo)
    ) || null
  );
}

function applyUci(chess, uci) {
  const m = findMove(chess, uci);
  if (!m) throw new Error("Illegal move in puzzle data: " + uci);
  chess.makeMove(m);
  return m;
}

// Position after the setup move, plus the solution the player must find.
function setup(puzzle) {
  const chess = new Chess();
  chess.loadFen(puzzle.fen);
  const all = puzzle.moves.trim().split(/\s+/);
  applyUci(chess, all[0]);
  return { chess, firstMove: all[0], solution: all.slice(1), playerColor: chess.turn };
}

// The puzzle as sent to a client: never includes the solution. `setupFen` is
// the position AFTER the opponent's setup move — what the solver is looking at —
// so a preview can be drawn without replaying moves itself.
function publicView(puzzle) {
  const { chess, firstMove, playerColor } = setup(puzzle);
  return { id: puzzle.id, fen: puzzle.fen, firstMove, playerColor, setupFen: chess.fen() };
}

// What a client may see once the puzzle is over.
function revealView(puzzle) {
  return {
    solution: setup(puzzle).solution,
    puzzleRating: puzzle.rating,
    themes: (puzzle.themes || "").split(" ").filter(Boolean),
    gameUrl: puzzle.game_url || null,
  };
}

// Verify the player's moves so far. Returns
//   { status: "ok",     reply }        prefix correct, here's the opponent's answer
//   { status: "solved" }               the last move completed the puzzle
//   { status: "wrong" }                a move was off the solution (or illegal)
// A move that isn't the stored one but delivers checkmate counts as solved,
// matching Lichess.
function check(puzzle, playerMoves) {
  const { chess, solution } = setup(puzzle);
  const expected = solution.filter((_, i) => i % 2 === 0); // player's moves
  if (!Array.isArray(playerMoves)) return { status: "wrong" };
  if (playerMoves.length === 0) return { status: "ok", reply: null };

  for (let i = 0; i < playerMoves.length; i++) {
    const uci = playerMoves[i];
    if (i >= expected.length) return { status: "wrong" };
    if (uci !== expected[i]) {
      const m = findMove(chess, uci);
      if (!m) return { status: "wrong" };
      chess.makeMove(m);
      return chess.isCheckmate() ? { status: "solved" } : { status: "wrong" };
    }
    applyUci(chess, uci);
    const reply = solution[2 * i + 1];
    if (reply === undefined) return { status: "solved" };
    if (i === playerMoves.length - 1) return { status: "ok", reply };
    applyUci(chess, reply);
  }
  return { status: "ok", reply: null };
}

// ---- rating ----

function eloAfter(userRating, puzzleRating, solved, attemptsSoFar) {
  const k = attemptsSoFar < SETTLED_AFTER ? K_NEW : K_SETTLED;
  const expected = 1 / (1 + Math.pow(10, (puzzleRating - userRating) / 400));
  return Math.round(userRating + k * ((solved ? 1 : 0) - expected));
}

// Record the first attempt at a puzzle and move the rating. Later attempts
// (retries) return null and change nothing.
function recordAttempt(userId, puzzle, solved) {
  if (queries.getAttempt.get(userId, puzzle.id)) return null;
  return db.transaction(() => {
    const user = queries.getPuzzleUser.get(userId);
    const { attempts } = queries.attemptStats.get(userId);
    const before = user.puzzle_rating;
    const after = eloAfter(before, puzzle.rating, solved, attempts);
    queries.insertAttempt.run(userId, puzzle.id, solved ? 1 : 0, before, after);
    queries.setPuzzleRating.run(after, userId);
    return { before, after, delta: after - before };
  })();
}

// ---- picking ----

function randomInRange(lo, hi) {
  const { n } = queries.countPuzzlesInRange.get(lo, hi);
  if (!n) return null;
  return queries.puzzleInRangeAt.get(lo, hi, Math.floor(Math.random() * n));
}

// A puzzle near `rating` the user hasn't attempted, widening the window as
// needed. Falls back to a repeat (flagged) only when everything is used up.
function pickForUser(userId, rating) {
  let fallback = null;
  for (const w of WINDOWS) {
    const lo = rating - w, hi = rating + w;
    if (!queries.countPuzzlesInRange.get(lo, hi).n) continue;
    for (let tries = 0; tries < 12; tries++) {
      const p = randomInRange(lo, hi);
      if (!p) break;
      if (!queries.getAttempt.get(userId, p.id)) return { puzzle: p, repeat: false };
      fallback = fallback || p;
    }
  }
  return fallback ? { puzzle: fallback, repeat: true } : null;
}

// ---- daily ----

const todayUtc = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function pickDaily() {
  // Prefer well-established puzzles; relax if the imported set is small.
  for (const [pop, rd] of [[80, 90], [50, 120], [-100, 1000]]) {
    const { n } = queries.countDailyCandidates.get(DAILY_MIN, DAILY_MAX, pop, rd);
    if (n) return queries.dailyCandidateAt.get(DAILY_MIN, DAILY_MAX, pop, rd, Math.floor(Math.random() * n)).id;
  }
  return null;
}

// The puzzle for a date, choosing (and pinning) one on first request.
function dailyFor(date) {
  let row = queries.getDaily.get(date);
  if (!row) {
    const id = pickDaily();
    if (!id) return null;
    queries.insertDaily.run(date, id); // OR IGNORE: a concurrent pick wins harmlessly
    row = queries.getDaily.get(date);
  }
  return queries.getPuzzle.get(row.puzzle_id);
}

// Consecutive days the user has completed the daily puzzle, as of `today`.
function streakOf(user, today) {
  if (!user.daily_last_date) return 0;
  if (user.daily_last_date === today || user.daily_last_date === addDays(today, -1)) {
    return user.daily_streak;
  }
  return 0; // a day was skipped
}

// Called when the user finishes today's daily puzzle (solved or not).
function bumpStreak(userId, today) {
  const user = queries.getPuzzleUser.get(userId);
  if (user.daily_last_date === today) return user.daily_streak; // already counted
  const streak = user.daily_last_date === addDays(today, -1) ? user.daily_streak + 1 : 1;
  queries.setDailyStreak.run(streak, today, userId);
  return streak;
}

module.exports = {
  DAILY_MIN, DAILY_MAX,
  setup, check, publicView, revealView, eloAfter, recordAttempt,
  pickForUser, dailyFor, todayUtc, addDays, streakOf, bumpStreak,
};
