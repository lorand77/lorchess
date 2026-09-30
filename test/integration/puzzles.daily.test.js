"use strict";

// The daily puzzle over HTTP: "done" and the streak agree, whichever way the
// puzzle was first attempted, and a retry never moves the streak. Daily puzzles
// are unrated — today's, and any earlier one — and the rated stream skips them.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const queries = require("../../src/db/queries");
const svc = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

const ONE = fixture.oneMove[0];

function insert(p) {
  queries.insertPuzzle.run(
    p.id, p.fen, p.moves, p.rating, 75, 95, 1000, p.themes ?? "", p.game_url ?? "", ""
  );
  return queries.getPuzzle.get(p.id);
}

let srv, me, user;
before(async () => {
  srv = await startServer();
  ({ c: me, user } = await registerUser(srv.baseUrl, "solver"));
});
after(async () => { await srv.close(); });

describe("the puzzle of the day", () => {
  test("solved earlier through the rated stream: done, credited on view, and a retry changes nothing", async () => {
    const today = svc.todayUtc();
    const puzzle = insert({ ...ONE, id: "daily_seen", rating: 1500 });
    queries.insertDaily.run(today, puzzle.id);
    // Yesterday, say, it came up in the rated stream and was solved.
    queries.insertAttempt.run(user.id, puzzle.id, 1, 1200, 1216, 1);

    // A retry (giving up here) is unrated and does not touch the streak.
    const retry = await me.post(`/api/puzzles/${puzzle.id}/giveup`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.rating, null);
    assert.equal(retry.body.streak, 0);

    // Viewing today's puzzle says it is done — and the streak agrees.
    const daily = await me.get("/api/puzzles/daily");
    assert.equal(daily.status, 200);
    assert.equal(daily.body.puzzle.id, puzzle.id);
    assert.equal(daily.body.done, true);
    assert.equal(daily.body.solved, true);
    assert.equal(daily.body.streak, 1);
    assert.equal(queries.getPuzzleUser.get(user.id).daily_last_date, today);

    // Still one after another look, and after another retry.
    assert.equal((await me.get("/api/puzzles/daily")).body.streak, 1);
    assert.equal((await me.post(`/api/puzzles/${puzzle.id}/giveup`)).body.streak, 1);
  });
});

describe("daily puzzles are unrated", () => {
  const ratingOf = (id) => queries.getPuzzleUser.get(id).puzzle_rating;

  test("today's: solving it keeps the rating but is done, streaked and counted", async () => {
    const { c, user: u } = await registerUser(srv.baseUrl, "dailyfresh");
    const daily = await c.get("/api/puzzles/daily");
    assert.equal(daily.body.done, false);
    const before = ratingOf(u.id);

    const res = await c.post(`/api/puzzles/${daily.body.puzzle.id}/moves`, {
      moves: [ONE.moves.split(" ")[1]],
    });
    assert.equal(res.body.status, "solved");
    assert.equal(res.body.rating, null);
    assert.equal(res.body.daily, true);
    assert.equal(res.body.streak, 1);
    assert.equal(ratingOf(u.id), before);
    assert.deepEqual(queries.attemptStats.get(u.id), { attempts: 1, solved: 1, rated: 0 });

    const again = await c.get("/api/puzzles/daily");
    assert.equal(again.body.done, true);
    assert.equal(again.body.solved, true);
    const stats = await c.get("/api/stats");
    assert.equal(stats.body.puzzles.solved, 1);
    assert.deepEqual(stats.body.puzzles.history, [], "not a point on the rating chart");
  });

  test("an earlier day's, opened by id: flagged, and failing it costs nothing", async () => {
    const { c, user: u } = await registerUser(srv.baseUrl, "dailyold");
    const old = insert({ ...ONE, id: "daily_old", rating: 1500 });
    queries.insertDaily.run(svc.addDays(svc.todayUtc(), -3), old.id);
    const before = ratingOf(u.id);

    const view = await c.get(`/api/puzzles/${old.id}`);
    assert.equal(view.body.daily, true);
    assert.equal(view.body.held, false);
    const res = await c.post(`/api/puzzles/${old.id}/giveup`);
    assert.equal(res.body.rating, null);
    assert.equal(res.body.daily, true);
    assert.equal(res.body.streak, undefined, "not today's, so no streak");
    assert.equal(ratingOf(u.id), before);
  });

  test("the rated stream never hands one out, and lets go of one it held", () => {
    const u = user; // "solver": has already attempted today's
    const rated = insert({ ...ONE, id: "stream_rated", rating: 1500 });
    const held = insert({ ...ONE, id: "stream_held", rating: 1500 });
    queries.setCurrentPuzzle.run(held.id, u.id);
    assert.equal(svc.nextForUser(u.id, 1500).puzzle.id, held.id, "held while it is not a daily");

    queries.insertDaily.run(svc.addDays(svc.todayUtc(), -10), held.id);
    for (let i = 0; i < 20; i++) {
      const pick = svc.pickForUser(u.id, 1500);
      assert.ok(pick && !svc.isDaily(pick.puzzle.id), `picked ${pick && pick.puzzle.id}`);
    }
    assert.equal(svc.isHeld(u.id, held.id), false);
    const next = svc.nextForUser(u.id, 1500);
    assert.equal(next.puzzle.id, rated.id);
    assert.equal(next.resumed, false);
  });
});
