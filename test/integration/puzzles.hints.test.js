"use strict";

// POST /api/puzzles/:id/hint: members only, one hint per puzzle, on the move
// the solver is on: step 1 the piece to move, step 2 its square too (not on a
// one-move puzzle). Never on a daily puzzle or one already attempted; at most
// HINTS_PER_DAY puzzles a UTC day. A hinted solve earns half the rating gain
// after step 1, a quarter after step 2; a failure costs the usual amount.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");
const puzzles = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

let srv;
let codes = 200000000;
before(async () => {
  srv = await startServer();
  for (const p of [...fixture.oneMove, ...fixture.twoMove]) {
    queries.insertPuzzle.run(p.id, p.fen, p.moves, 1500, 75, 95, 1000, p.themes || "", "", "");
  }
});
after(async () => { await srv.close(); });

async function player({ member }) {
  const { c, user } = await registerUser(srv.baseUrl, member ? "hinter" : "plain");
  if (member) {
    const code = String(codes++);
    queries.insertPromoCode.run(code);
    assert.equal((await c.post("/api/membership/redeem", { code })).status, 200);
  }
  return { c, user };
}

const sqOf = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
// A puzzle's solver moves (every other move after the setup move).
const solverMoves = (p) => p.moves.split(" ").slice(1).filter((_, i) => i % 2 === 0);
const hint = (c, id, moves, step) => c.post(`/api/puzzles/${id}/hint`, { moves, step });
// The gain a solve would bring without a hint, as recordAttempt reckons it.
function fullGain(userId) {
  const before = queries.getPuzzleUser.get(userId).puzzle_rating;
  return puzzles.eloAfter(before, 1500, true, queries.attemptStats.get(userId).rated) - before;
}

let pool = 0;
const twoMover = () => fixture.twoMove[pool++];

test("non-members see a locked hint, and are refused one", async () => {
  const { c } = await player({ member: false });
  const p = twoMover();
  const view = (await c.get(`/api/puzzles/${p.id}`)).body.hints;
  assert.deepEqual(view, { member: false, left: 0, perDay: 10, available: true, single: false, shown: null });
  const res = await hint(c, p.id, [], 1);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /member/);
});

test("the piece, then its square; asked again, the same for free; a quarter of the gain", async () => {
  const { c, user } = await player({ member: true });
  const p = twoMover();
  const [first, second] = solverMoves(p);

  let res = await hint(c, p.id, [], 1);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hint, { move: 0, step: 1, from: sqOf(first.slice(0, 2)) });
  assert.equal(res.body.hints.left, 9);
  res = await hint(c, p.id, [], 1);
  assert.equal(res.body.hints.left, 9, "the same hint again costs nothing");
  res = await hint(c, p.id, [], 2);
  assert.deepEqual(res.body.hint, { move: 0, step: 2, from: sqOf(first.slice(0, 2)), to: sqOf(first.slice(2, 4)) });
  assert.equal(res.body.hints.left, 9, "the square comes with the piece");
  // A reload shows it again.
  assert.deepEqual((await c.get(`/api/puzzles/${p.id}`)).body.hints.shown, res.body.hint);

  // On the next move, nothing more.
  assert.equal((await c.post(`/api/puzzles/${p.id}/moves`, { moves: [first] })).body.status, "ok");
  res = await hint(c, p.id, [first], 1);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /used this puzzle's hint/);

  const gain = fullGain(user.id);
  const done = (await c.post(`/api/puzzles/${p.id}/moves`, { moves: [first, second] })).body;
  assert.equal(done.status, "solved");
  assert.equal(done.rating.delta, Math.round(gain * 0.25));
  assert.equal(done.rating.hints, 2);
  assert.equal(queries.getAttempt.get(user.id, p.id).hints, 2);
  // Done: no hints now, and none on a retry.
  assert.equal((await hint(c, p.id, [], 1)).status, 409);
  assert.equal((await c.get(`/api/puzzles/${p.id}`)).body.hints.available, false);
});

test("a hint on a later move, piece only: half the gain", async () => {
  const { c, user } = await player({ member: true });
  const p = twoMover();
  const [first, second] = solverMoves(p);
  await c.post(`/api/puzzles/${p.id}/moves`, { moves: [first] });
  const res = await hint(c, p.id, [first], 1);
  assert.deepEqual(res.body.hint, { move: 1, step: 1, from: sqOf(second.slice(0, 2)) });
  const gain = fullGain(user.id);
  const done = (await c.post(`/api/puzzles/${p.id}/moves`, { moves: [first, second] })).body;
  assert.equal(done.rating.delta, Math.round(gain * 0.5));
});

test("a failure after a hint costs what any failure does", async () => {
  const { c, user } = await player({ member: true });
  const p = twoMover();
  await hint(c, p.id, [], 1);
  const before = queries.getPuzzleUser.get(user.id).puzzle_rating;
  const expected = puzzles.eloAfter(before, 1500, false, queries.attemptStats.get(user.id).rated) - before;
  const done = (await c.post(`/api/puzzles/${p.id}/giveup`)).body;
  assert.equal(done.rating.delta, expected);
  assert.ok(expected < 0);
});

test("a one-move puzzle shows the piece only", async () => {
  const { c } = await player({ member: true });
  const p = fixture.oneMove[0];
  assert.equal((await c.get(`/api/puzzles/${p.id}`)).body.hints.single, true);
  assert.equal((await hint(c, p.id, [], 1)).status, 200);
  const res = await hint(c, p.id, [], 2);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /piece only/);
});

test("refused: the daily puzzle, moves off the solution, the square before the piece, a bad request", async () => {
  const { c } = await player({ member: true });
  const daily = fixture.oneMove[1];
  queries.insertDaily.run(puzzles.todayUtc(), daily.id);
  let res = await hint(c, daily.id, [], 1);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /daily/);
  assert.equal((await c.get(`/api/puzzles/${daily.id}`)).body.hints.available, false);

  const p = twoMover();
  res = await hint(c, p.id, ["a1a2"], 1);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /aren't on the solution/);
  res = await hint(c, p.id, [], 2);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /piece first/);
  for (const body of [{ moves: [], step: 3 }, { moves: "e2e4", step: 1 }, {}]) {
    assert.equal((await c.post(`/api/puzzles/${p.id}/hint`, body)).status, 400);
  }
  assert.equal((await hint(c, "no-such-puzzle", [], 1)).status, 404);
});

test(`at most ${puzzles.HINTS_PER_DAY} puzzles a day`, async () => {
  const { c, user } = await player({ member: true });
  const used = fixture.twoMove.slice(60, 60 + puzzles.HINTS_PER_DAY);
  const insert = db.prepare("INSERT INTO puzzle_hints (user_id, puzzle_id, move, step) VALUES (?, ?, 0, 1)");
  for (const p of used) insert.run(user.id, p.id);
  const p = twoMover();
  const res = await hint(c, p.id, [], 1);
  assert.equal(res.status, 429);
  assert.equal(res.body.hints.left, 0);
  // A step already taken still shows, at no cost.
  assert.equal((await hint(c, used[0].id, [], 1)).status, 200);
});

test("a hinted solve counts for no puzzle badge", async () => {
  const { c, user } = await player({ member: true });
  const p = twoMover();
  const moves = solverMoves(p);
  await hint(c, p.id, [], 1);
  await c.post(`/api/puzzles/${p.id}/moves`, { moves: [moves[0]] });
  await c.post(`/api/puzzles/${p.id}/moves`, { moves });
  const stats = queries.attemptStats.get(user.id);
  assert.equal(stats.solved, 1);
  assert.equal(stats.unaided, 0);
});
