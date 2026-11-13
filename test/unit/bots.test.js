"use strict";

// The server's LorFish pool (src/game/bots.js): searches run in worker
// threads, several at once and the rest queued, and a position the engine
// refuses fails its own job without taking the pool down.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const bots = require("../../src/game/bots");
const { fromFen } = require("../helpers/board");

after(() => bots.shutdown());

test("answers with a legal move, drops included, several jobs at once", async () => {
  const fen = "6rk/6pp/8/8/8/8/8/K7[N] w - - 0 1";   // N@f7 mates
  const answers = await Promise.all([1, 2, 3, 4].map(() => bots.think({ variant: "bughouse", fen, depth: 1, temperature: 0 })));
  for (const a of answers) assert.deepEqual(a, { from: null, to: 53, promo: null, drop: "n" });
  const castle = await bots.think({ variant: "standard", fen: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", depth: 1, temperature: 0 });
  assert.ok(fromFen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1").findMove(castle.from, castle.to, castle.promo));
});

test("a position the engine refuses fails its job, and the pool carries on", async () => {
  await assert.rejects(bots.think({ variant: "bughouse", fen: "not a fen", depth: 1, temperature: 0 }), /FEN/);
  const after = await bots.think({ variant: "bughouse", fen: "6rk/6pp/8/8/8/8/8/K7[N] w - - 0 1", depth: 1, temperature: 0 });
  assert.equal(after.drop, "n");
});

test("a position with nothing to play answers null", async () => {
  assert.equal(await bots.think({ variant: "bughouse", fen: "R6k/6pp/8/8/8/8/8/K7[] b - - 0 1", depth: 1, temperature: 0 }), null);
});
