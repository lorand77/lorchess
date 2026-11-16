"use strict";

// LorFish's normal pace in a team game's seats (src/game/botPace.js): an even
// share of its clock, plus most of the increment, varied at random; a forced
// move or a recapture quickly; never under half a second or over twenty, and
// short of time never more than a tenth of what is left.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { thinkTime, MOVES_LEFT, MIN_MS, MAX_MS, MAX_SHARE } = require("../../src/game/botPace");

const at = (r) => () => r;   // an rng that always returns r

test("an even share of the clock, from half to one and a half times it", () => {
  const share = 300000 / MOVES_LEFT;   // 5+0, at the start: 6 s
  assert.equal(thinkTime({ clockMs: 300000, choices: 20, rng: at(0) }), share * 0.5);
  assert.equal(thinkTime({ clockMs: 300000, choices: 20, rng: at(0.5) }), share);
  assert.equal(thinkTime({ clockMs: 300000, choices: 20, rng: at(0.999) }), Math.round(share * 1.499));
});

test("most of the increment on top", () => {
  assert.equal(thinkTime({ clockMs: 60000, incrementMs: 2000, choices: 20, rng: at(0.5) }), 60000 / MOVES_LEFT + 1600);
});

test("a forced move or a recapture comes quickly", () => {
  for (const opts of [{ choices: 1 }, { choices: 30, recapture: true }]) {
    const ms = thinkTime({ clockMs: 600000, rng: at(0.5), ...opts });
    assert.equal(ms, MIN_MS * 1.5, JSON.stringify(opts));
  }
});

test("never under the minimum or over the maximum", () => {
  assert.equal(thinkTime({ clockMs: 20000, choices: 20, rng: at(0) }), MIN_MS);
  assert.equal(thinkTime({ clockMs: 60 * 60000, choices: 20, rng: at(0.999) }), MAX_MS);
});

test("short of time it hurries: never more than a tenth of what is left", () => {
  assert.equal(thinkTime({ clockMs: 3000, choices: 20, rng: at(0.999) }), 3000 * MAX_SHARE);
  assert.equal(thinkTime({ clockMs: 2000, choices: 1, rng: at(0.999) }), 200, "below the minimum, even when forced");
  assert.equal(thinkTime({ clockMs: 0, choices: 20 }), 0);
});

test("varies from move to move with the default rng", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(thinkTime({ clockMs: 300000, choices: 20 }));
  assert.ok(seen.size > 10, [...seen].join(" "));
});
