"use strict";

// The daily puzzle's tries and its streak. Only a solved daily extends the
// streak, so giving up (with or without a move) no longer earns one. To make
// that fair, a daily allows DAILY_TRIES wrong moves: until they run out a wrong
// move is a `miss` that reveals nothing, and the server keeps the count so a
// reload cannot reset it. Rated puzzles and retries still end at the first
// wrong move.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const queries = require("../../src/db/queries");
const svc = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

const ONE = fixture.oneMove[0];
const SOLVE = ONE.moves.split(" ")[1];
// Legal in the puzzle position, and none of them mates.
const WRONG = ["h2g1", "h2g3", "h2f4", "h2e5", "h2d6"];

function insert(p) {
  queries.insertPuzzle.run(
    p.id, p.fen, p.moves, p.rating, 75, 95, 1000, p.themes ?? "", p.game_url ?? "", ""
  );
  return queries.getPuzzle.get(p.id);
}

let srv, today, daily, rated;
before(async () => {
  srv = await startServer();
  today = svc.todayUtc();
  daily = insert({ ...ONE, id: "tries_daily" });
  rated = insert({ ...ONE, id: "tries_rated" });
  queries.insertDaily.run(today, daily.id);
});
after(async () => { await srv.close(); });

// A user whose streak stood at `streak` as of yesterday.
async function solverWithStreak(name, streak) {
  const { c, user } = await registerUser(srv.baseUrl, name);
  queries.setDailyStreak.run(streak, svc.addDays(today, -1), user.id);
  return { c, id: user.id };
}

const play = (c, moves) => c.post(`/api/puzzles/${daily.id}/moves`, { moves });

test("giving up today's daily without a move earns nothing and ends the streak", async () => {
  const { c, id } = await solverWithStreak("quitter", 4);
  assert.equal((await c.get("/api/puzzles/daily")).body.streak, 4, "alive from yesterday");

  const res = await c.post(`/api/puzzles/${daily.id}/giveup`);
  assert.equal(res.body.status, "wrong");
  assert.equal(res.body.streak, 0);
  assert.equal(res.body.misses, 0);
  assert.ok(res.body.solution, "giving up shows the solution");
  assert.equal(queries.getPuzzleUser.get(id).daily_last_date, svc.addDays(today, -1), "not credited");

  const view = await c.get("/api/puzzles/daily");
  assert.equal(view.body.done, true);
  assert.equal(view.body.solved, false);
  assert.equal(view.body.streak, 0);
  assert.equal(view.body.triesLeft, null);
});

test("a wrong move costs a try, reveals nothing, and survives a reload", async () => {
  const { c, id } = await solverWithStreak("trier", 2);
  assert.equal((await c.get("/api/puzzles/daily")).body.triesLeft, svc.DAILY_TRIES);

  const missed = await play(c, [WRONG[0]]);
  assert.deepEqual(missed.body, { status: "miss", triesLeft: svc.DAILY_TRIES - 1 });
  assert.equal(queries.getAttempt.get(id, daily.id), undefined, "the attempt goes on");

  const reload = await c.get("/api/puzzles/daily");
  assert.equal(reload.body.done, false);
  assert.equal(reload.body.solution, undefined);
  assert.equal(reload.body.triesLeft, svc.DAILY_TRIES - 1);
  assert.equal((await c.get(`/api/puzzles/${daily.id}`)).body.triesLeft, svc.DAILY_TRIES - 1);

  const solved = await play(c, [SOLVE]);
  assert.equal(solved.body.status, "solved");
  assert.equal(solved.body.streak, 3);
  assert.equal(solved.body.misses, 1);
  assert.equal(queries.getAttempt.get(id, daily.id).misses, 1);
  assert.equal(queries.getPuzzleMisses.get(id, daily.id), undefined, "the count moved to the attempt");

  const view = await c.get("/api/puzzles/daily");
  assert.equal(view.body.solved, true);
  assert.equal(view.body.misses, 1);
  assert.equal(view.body.streak, 3);
});

test("the last try fails the puzzle and the streak with it", async () => {
  const { c, id } = await solverWithStreak("unlucky", 9);
  for (let i = 0; i < svc.DAILY_TRIES - 1; i++) {
    const res = await play(c, [WRONG[i]]);
    assert.equal(res.body.status, "miss");
    assert.equal(res.body.triesLeft, svc.DAILY_TRIES - 1 - i);
  }
  const last = await play(c, [WRONG[svc.DAILY_TRIES - 1]]);
  assert.equal(last.body.status, "wrong");
  assert.equal(last.body.misses, svc.DAILY_TRIES);
  assert.ok(last.body.solution);
  assert.equal(last.body.streak, 0);
  assert.equal(queries.getAttempt.get(id, daily.id).solved, 0);

  // The retry that follows is unrecorded and ends at its first wrong move.
  const retry = await play(c, [WRONG[0]]);
  assert.equal(retry.body.status, "wrong");
  assert.equal(retry.body.streak, 0);
  const solvedRetry = await play(c, [SOLVE]);
  assert.equal(solvedRetry.body.status, "solved");
  assert.equal(solvedRetry.body.streak, 0, "a retry cannot rescue the day");
});

test("rated puzzles have no tries: the first wrong move ends them", async () => {
  const { c } = await registerUser(srv.baseUrl, "ratedonly");
  assert.equal((await c.get(`/api/puzzles/${rated.id}`)).body.triesLeft, null);
  const res = await c.post(`/api/puzzles/${rated.id}/moves`, { moves: [WRONG[0]] });
  assert.equal(res.body.status, "wrong");
  assert.ok(res.body.rating, "rated");
});

test("a day credited under the old rule keeps its streak", async () => {
  const { c, user } = await registerUser(srv.baseUrl, "oldrule");
  const id = user.id;
  // Failed today's daily before only solves counted, and was credited for it.
  queries.insertAttempt.run(id, daily.id, 0, 1200, 1200, 0, 0);
  queries.setDailyStreak.run(6, today, id);
  assert.equal(svc.currentStreak(id, today), 6);
  assert.equal((await c.get("/api/puzzles/daily")).body.streak, 6);
});
