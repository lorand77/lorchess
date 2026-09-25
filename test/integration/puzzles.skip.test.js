"use strict";

// POST /api/puzzles/:id/skip — members may drop the puzzle they're held to,
// unrated, up to SKIPS_PER_DAY times per UTC day.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");
const puzzles = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

let srv;
let codes = 100000000;
before(async () => {
  srv = await startServer();
  for (const p of [...fixture.oneMove, ...fixture.twoMove]) {
    queries.insertPuzzle.run(p.id, p.fen, p.moves, 1500, 75, 95, 1000, p.themes || "", "", "");
  }
});
after(async () => { await srv.close(); });

async function player({ member }) {
  const { c, user } = await registerUser(srv.baseUrl, member ? "member" : "plain");
  if (member) {
    const code = String(codes++);
    queries.insertPromoCode.run(code);
    assert.equal((await c.post("/api/membership/redeem", { code })).status, 200);
  }
  return { c, user };
}

const next = async (c) => (await c.get("/api/puzzles/next")).body;
const skip = (c, id) => c.post(`/api/puzzles/${id}/skip`);

test("non-members can't skip, and are told how the perk works", async () => {
  const { c } = await player({ member: false });
  const held = await next(c);
  assert.deepEqual(held.skip, { member: false, left: 0, perDay: puzzles.SKIPS_PER_DAY });

  const res = await skip(c, held.puzzle.id);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /member/);
  // Still held: the refusal didn't let go of it.
  assert.equal((await next(c)).puzzle.id, held.puzzle.id);
});

test("a member's skip hands out a new puzzle with no attempt and no rating change", async () => {
  const { c, user } = await player({ member: true });
  const held = await next(c);
  assert.equal(held.held, true);
  assert.deepEqual(held.skip, { member: true, left: 10, perDay: 10 });
  const ratingBefore = queries.getPuzzleUser.get(user.id).puzzle_rating;

  const res = await skip(c, held.puzzle.id);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.puzzle.id, held.puzzle.id);
  assert.equal(res.body.held, true);
  assert.equal(res.body.resumed, false);
  assert.equal(res.body.skip.left, 9);

  assert.equal(queries.getPuzzleUser.get(user.id).puzzle_rating, ratingBefore);
  assert.equal(queries.getAttempt.get(user.id, held.puzzle.id), undefined);
  // The new one is now the held puzzle.
  const again = await next(c);
  assert.equal(again.puzzle.id, res.body.puzzle.id);
  assert.equal(again.resumed, true);
});

test("only the held puzzle can be skipped", async () => {
  const { c } = await player({ member: true });
  const held = (await next(c)).puzzle;
  const other = fixture.oneMove.map((p) => p.id).find((id) => id !== held.id);
  assert.equal((await skip(c, other)).status, 409);

  // Nor one already attempted.
  await c.post(`/api/puzzles/${held.id}/giveup`);
  assert.equal((await skip(c, held.id)).status, 409);
  assert.equal((await skip(c, "no-such-puzzle")).status, 404);
});

test("ten a day, then refused until the next UTC day", async () => {
  const { c, user } = await player({ member: true });
  let held = (await next(c)).puzzle;
  for (let i = 0; i < 10; i++) {
    const res = await skip(c, held.id);
    assert.equal(res.status, 200, `skip ${i + 1}`);
    assert.equal(res.body.skip.left, 9 - i);
    held = res.body.puzzle;
  }
  const refused = await skip(c, held.id);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.skip.left, 0);
  assert.equal((await next(c)).puzzle.id, held.id); // still held

  // Move today's skips to yesterday: the allowance is back.
  db.prepare("UPDATE puzzle_skips SET created_at = datetime('now', '-1 day') WHERE user_id = ?").run(user.id);
  assert.equal((await next(c)).skip.left, 10);
  assert.equal((await skip(c, held.id)).status, 200);
});

test("the pinned view says whether a puzzle is the held one", async () => {
  const { c } = await player({ member: true });
  const held = (await next(c)).puzzle;
  const pinned = await c.get(`/api/puzzles/${held.id}`);
  assert.equal(pinned.body.held, true);
  assert.equal(pinned.body.skip.member, true);

  const other = fixture.oneMove.map((p) => p.id).find((id) => id !== held.id);
  assert.equal((await c.get(`/api/puzzles/${other}`)).body.held, false);
});
