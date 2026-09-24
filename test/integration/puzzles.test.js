"use strict";

// The puzzle service (src/puzzles/service.js) on a throwaway database:
// solution checking, the puzzle Elo, picking, the puzzle of the day, and the
// daily streak across date boundaries.

require("../helpers/server"); // points the database at a temporary file
const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const queries = require("../../src/db/queries");
const puzzles = require("../../src/puzzles/service");
const achievements = require("../../src/achievements/service");
const { makeUser } = require("../helpers/games");
const fixture = require("../fixtures/puzzles.json");
const { Chess } = require("../../src/shared/chess");
const { moveOf } = require("../helpers/board");

// Lichess convention: `fen` is the position before the opponent's setup move,
// which is the first entry of `moves`; the solution follows.
function insert(p) {
  queries.insertPuzzle.run(
    p.id, p.fen, p.moves, p.rating, p.rating_deviation ?? 75, p.popularity ?? 95,
    p.nb_plays ?? 1000, p.themes ?? "", p.game_url ?? "", p.opening_tags ?? ""
  );
  return queries.getPuzzle.get(p.id);
}

// Black to move steps into the corner; then either rook mates on the back rank.
const TWO_MATES = {
  id: "twomates", fen: "7k/8/6K1/8/8/8/1R6/R7 b - - 0 1", moves: "h8g8 a1a8",
  rating: 1500, themes: "mate mateIn1 oneMove",
};
const ONE = fixture.oneMove[0];
const TWO = fixture.twoMove.find((p) => p.moves.split(" ").length === 4);
const ratingOf = (userId) => queries.getPuzzleUser.get(userId).puzzle_rating;

describe("with an empty puzzle table", () => {
  test("there is nothing to pick and no puzzle of the day", () => {
    const me = makeUser("me");
    assert.equal(puzzles.pickForUser(me.id, 1500), null);
    assert.equal(puzzles.dailyFor("2026-01-01"), null);
  });
});

describe("solutions", () => {
  let one, two, mates;
  before(() => {
    one = insert(ONE);
    two = insert(TWO);
    mates = insert(TWO_MATES);
  });

  test("setup plays the opponent's move and keeps the solution aside", () => {
    const { chess, firstMove, solution, playerColor } = puzzles.setup(two);
    const expected = new Chess();
    expected.loadFen(two.fen);
    expected.makeMove(moveOf(expected, two.moves.split(" ")[0]));
    assert.equal(chess.fen(), expected.fen());
    assert.equal(firstMove, two.moves.split(" ")[0]);
    assert.deepEqual(solution, two.moves.split(" ").slice(1));
    assert.equal(playerColor, expected.turn);
  });

  test("the public view never carries the solution; the reveal does", () => {
    const pub = puzzles.publicView(two);
    assert.deepEqual(Object.keys(pub).sort(), ["fen", "firstMove", "id", "playerColor", "setupFen"]);
    assert.equal(pub.setupFen, puzzles.setup(two).chess.fen());
    const reveal = puzzles.revealView(two);
    assert.deepEqual(reveal.solution, two.moves.split(" ").slice(1));
    assert.equal(reveal.puzzleRating, two.rating);
    assert.deepEqual(reveal.themes, two.themes.split(" "));
  });

  test("checking moves against a two-move solution", () => {
    const [, m1, reply, m2] = two.moves.split(" ");
    assert.deepEqual(puzzles.check(two, []), { status: "ok", reply: null });
    assert.deepEqual(puzzles.check(two, [m1]), { status: "ok", reply });
    assert.deepEqual(puzzles.check(two, [m1, m2]), { status: "solved" });
    assert.deepEqual(puzzles.check(two, [m1, m2, "a2a3"]), { status: "solved" }, "moves after the solution are ignored");
    assert.deepEqual(puzzles.check(two, ["zzzz"]), { status: "wrong" }, "not a move");
    assert.deepEqual(puzzles.check(two, "e2e4"), { status: "wrong" }, "not a list");
    const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
    const legalButWrong = puzzles.setup(two).chess.legalMoves()
      .map((m) => alg(m.from) + alg(m.to) + (m.promo || ""))
      .find((uci) => uci !== m1);
    assert.deepEqual(puzzles.check(two, [legalButWrong]), { status: "wrong" }, legalButWrong);
  });

  test("a one-move solution, and any mating move counts", () => {
    assert.deepEqual(puzzles.check(one, [one.moves.split(" ")[1]]), { status: "solved" });
    assert.deepEqual(puzzles.check(mates, ["a1a8"]), { status: "solved" }, "the stored mate");
    assert.deepEqual(puzzles.check(mates, ["b2b8"]), { status: "solved" }, "another mate");
    assert.deepEqual(puzzles.check(mates, ["a1a7"]), { status: "wrong" }, "not a mate");
  });
});

describe("rating", () => {
  test("eloAfter: a fast K for newcomers, slower once settled", () => {
    assert.equal(puzzles.eloAfter(1200, 1200, true, 0), 1220);
    assert.equal(puzzles.eloAfter(1200, 1200, false, 0), 1180);
    assert.equal(puzzles.eloAfter(1200, 1200, true, 30), 1210);
    assert.equal(puzzles.eloAfter(1200, 1600, true, 0), 1236, "beating a harder puzzle pays more");
    assert.equal(puzzles.eloAfter(1200, 1600, false, 0), 1196, "failing it costs little");
    assert.equal(puzzles.eloAfter(1600, 1200, false, 0), 1564, "failing an easy one costs a lot");
  });

  test("only the first attempt at a puzzle counts", () => {
    const me = makeUser("me");
    const p = queries.getPuzzle.get(TWO_MATES.id);
    assert.equal(ratingOf(me.id), 1200);
    assert.deepEqual(puzzles.recordAttempt(me.id, p, true), { before: 1200, after: 1234, delta: 34 });
    assert.equal(ratingOf(me.id), 1234);
    assert.deepEqual(queries.attemptStats.get(me.id), { attempts: 1, solved: 1 });
    assert.equal(puzzles.recordAttempt(me.id, p, false), null, "a retry changes nothing");
    assert.equal(ratingOf(me.id), 1234);
    assert.deepEqual(queries.attemptStats.get(me.id), { attempts: 1, solved: 1 });
    const other = queries.getPuzzle.get(ONE.id);
    const fail = puzzles.recordAttempt(me.id, other, false);
    assert.ok(fail.delta < 0, `failing lowers the rating: ${fail.delta}`);
    assert.equal(ratingOf(me.id), fail.after);
  });
});

describe("picking", () => {
  before(() => {
    for (const rating of [1000, 1500, 2000]) {
      insert({ ...TWO_MATES, id: `pick${rating}`, rating });
    }
  });

  test("prefers a puzzle near the rating that the user has not attempted", () => {
    const me = makeUser("me");
    const first = puzzles.pickForUser(me.id, 1500);
    assert.equal(first.repeat, false);
    assert.ok(Math.abs(first.puzzle.rating - 1500) <= 100, `picked ${first.puzzle.rating}`);
    puzzles.recordAttempt(me.id, first.puzzle, true);
    const second = puzzles.pickForUser(me.id, 1500);
    assert.equal(second.repeat, false);
    assert.notEqual(second.puzzle.id, first.puzzle.id, "widens the window rather than repeating");
  });

  test("falls back to a repeat only when everything has been attempted", () => {
    const me = makeUser("me");
    const all = [];
    for (;;) {
      const pick = puzzles.pickForUser(me.id, 1500);
      if (pick.repeat) break;
      all.push(pick.puzzle.id);
      puzzles.recordAttempt(me.id, pick.puzzle, true);
    }
    assert.equal(new Set(all).size, all.length, "never picked the same puzzle twice");
    assert.equal(all.length, queries.countPuzzles.get().n, "every puzzle was offered once");
    assert.equal(puzzles.pickForUser(me.id, 1500).repeat, true);
  });
});

describe("puzzle of the day", () => {
  test("is chosen once per date, from the established mid-range puzzles", () => {
    const first = puzzles.dailyFor("2026-03-01");
    assert.ok(first, "a daily puzzle exists");
    assert.ok(first.rating >= puzzles.DAILY_MIN && first.rating <= puzzles.DAILY_MAX, `rating ${first.rating}`);
    assert.equal(puzzles.dailyFor("2026-03-01").id, first.id, "pinned for the day");
    assert.equal(queries.getDaily.get("2026-03-01").puzzle_id, first.id);
    assert.ok(puzzles.dailyFor("2026-03-02"), "another day has one too");
  });
});

describe("daily streak", () => {
  test("addDays crosses month and leap-day boundaries", () => {
    assert.equal(puzzles.addDays("2026-02-28", 1), "2026-03-01");
    assert.equal(puzzles.addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(puzzles.addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(puzzles.addDays("2026-12-31", 1), "2027-01-01");
  });

  test("grows day by day, tolerates today and yesterday, and resets after a gap", () => {
    const me = makeUser("me");
    const user = () => queries.getPuzzleUser.get(me.id);
    assert.equal(puzzles.streakOf(user(), "2026-09-23"), 0);
    assert.equal(puzzles.bumpStreak(me.id, "2026-09-23"), 1);
    assert.equal(puzzles.bumpStreak(me.id, "2026-09-23"), 1, "the same day counts once");
    assert.equal(puzzles.bumpStreak(me.id, "2026-09-24"), 2);
    assert.equal(puzzles.streakOf(user(), "2026-09-24"), 2, "seen today");
    assert.equal(puzzles.streakOf(user(), "2026-09-25"), 2, "still alive the next day");
    assert.equal(puzzles.streakOf(user(), "2026-09-26"), 0, "a skipped day breaks it");
    assert.equal(puzzles.bumpStreak(me.id, "2026-09-26"), 1, "and it starts over");
    assert.equal(puzzles.bumpStreak(me.id, "2026-09-30"), 1);
    assert.equal(puzzles.bumpStreak(me.id, "2026-10-01"), 2, "across a month boundary");
    assert.equal(user().daily_last_date, "2026-10-01");
  });

  test("todayUtc is a UTC calendar date", () => {
    assert.match(puzzles.todayUtc(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(puzzles.todayUtc(), new Date().toISOString().slice(0, 10));
  });
});

describe("achievements from puzzles", () => {
  test("ten first-try solves: puzzle solver, sharpshooter, and a rating tier", () => {
    const me = makeUser("me");
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(insert({ ...TWO_MATES, id: `syn${i}`, rating: 1400 }).id);
    let earned = [];
    for (let i = 0; i < 10; i++) {
      const p = queries.getPuzzle.get(ids[i]);
      puzzles.recordAttempt(me.id, p, true);
      earned = achievements.onPuzzleFinished(me.id, p).map((a) => a.key);
      if (i < 9) assert.ok(!earned.includes("puzzles_solved"), `after ${i + 1} solves`);
    }
    assert.ok(earned.includes("puzzles_solved") && earned.includes("sharpshooter"), earned);
    const rows = Object.fromEntries(queries.listAchievements.all(me.id).map((r) => [r.key, r]));
    assert.equal(rows.puzzles_solved.tier, 1);
    assert.equal(rows.sharpshooter.tier, 1);
    assert.equal(rows.sharpshooter.puzzle_id, ids[9], "points at the puzzle that completed it");
    assert.ok(rows.puzzle_rating && rows.puzzle_rating.tier >= 1, `rating now ${ratingOf(me.id)}`);
  });
});
