"use strict";

// GET /api/puzzles/next holds on to the rated puzzle it hands out until the
// user finishes it — solving it, or failing it by a wrong move or giving up.
// Reloading, closing the tab or peeking via the lobby card is not a skip.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const queries = require("../../src/db/queries");
const puzzles = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

let srv;
before(async () => {
  srv = await startServer();
  // Plenty of puzzles, all in the window around the starting rating, so a
  // fresh pick is (almost) never the same one by chance.
  for (const p of [...fixture.oneMove, ...fixture.twoMove]) {
    queries.insertPuzzle.run(p.id, p.fen, p.moves, 1500, 75, 95, 1000, p.themes || "", "", "");
  }
});
after(async () => { await srv.close(); });

async function fresh() {
  const { c } = await registerUser(srv.baseUrl, "solver");
  return c;
}

// The player's moves of the stored solution.
function solutionOf(id) {
  return puzzles.setup(queries.getPuzzle.get(id)).solution.filter((_, i) => i % 2 === 0);
}

test("asking again returns the same puzzle, flagged as resumed", async () => {
  const c = await fresh();
  const first = await c.get("/api/puzzles/next");
  assert.equal(first.status, 200);
  assert.equal(first.body.resumed, false);

  for (let i = 0; i < 3; i++) {
    const again = await c.get("/api/puzzles/next");
    assert.equal(again.body.puzzle.id, first.body.puzzle.id);
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.repeat, false);
  }
});

test("a correct move that isn't the last one keeps the hold", async () => {
  const c = await fresh();
  // Ask until we're holding a puzzle with more than one move to find.
  let held = (await c.get("/api/puzzles/next")).body.puzzle;
  while (solutionOf(held.id).length < 2) {
    await c.post(`/api/puzzles/${held.id}/giveup`);
    held = (await c.get("/api/puzzles/next")).body.puzzle;
  }
  const ok = await c.post(`/api/puzzles/${held.id}/moves`, { moves: solutionOf(held.id).slice(0, 1) });
  assert.equal(ok.body.status, "ok");
  assert.equal((await c.get("/api/puzzles/next")).body.puzzle.id, held.id);
});

test("giving up releases it, and costs rating", async () => {
  const c = await fresh();
  const held = (await c.get("/api/puzzles/next")).body;
  const res = await c.post(`/api/puzzles/${held.puzzle.id}/giveup`);
  assert.equal(res.status, 200);
  assert.ok(res.body.rating.delta < 0);

  const next = (await c.get("/api/puzzles/next")).body;
  assert.notEqual(next.puzzle.id, held.puzzle.id);
  assert.equal(next.resumed, false);
});

test("solving it releases it", async () => {
  const c = await fresh();
  const held = (await c.get("/api/puzzles/next")).body.puzzle;
  const res = await c.post(`/api/puzzles/${held.id}/moves`, { moves: solutionOf(held.id) });
  assert.equal(res.body.status, "solved");

  const next = (await c.get("/api/puzzles/next")).body;
  assert.notEqual(next.puzzle.id, held.id);
  assert.equal(next.resumed, false);
});

test("a wrong move releases it, and costs rating", async () => {
  const c = await fresh();
  const held = (await c.get("/api/puzzles/next")).body.puzzle;
  const res = await c.post(`/api/puzzles/${held.id}/moves`, { moves: ["a1a1"] });
  assert.equal(res.body.status, "wrong");
  assert.ok(res.body.rating.delta < 0);
  assert.notEqual((await c.get("/api/puzzles/next")).body.puzzle.id, held.id);
});

test("finishing the held puzzle through its pinned link releases it too", async () => {
  const c = await fresh();
  const held = (await c.get("/api/puzzles/next")).body.puzzle;
  // The lobby card links to /puzzles.html?id=…, which loads it by id.
  const pinned = await c.get(`/api/puzzles/${held.id}`);
  assert.equal(pinned.body.repeat, false);
  await c.post(`/api/puzzles/${held.id}/giveup`);
  assert.notEqual((await c.get("/api/puzzles/next")).body.puzzle.id, held.id);
});

test("one user's hold is not another's", async () => {
  const a = await fresh();
  const b = await fresh();
  const heldA = (await a.get("/api/puzzles/next")).body.puzzle;
  const firstB = await b.get("/api/puzzles/next");
  assert.equal(firstB.body.resumed, false);
  await b.post(`/api/puzzles/${firstB.body.puzzle.id}/giveup`);
  assert.equal((await a.get("/api/puzzles/next")).body.puzzle.id, heldA.id);
});
