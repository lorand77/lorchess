"use strict";

// The Elo update in src/game/elo.js. `scoreWhite` is 1 for a White win,
// 0.5 for a draw, 0 for a Black win; the server passes config.ELO_K.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { elo } = require("../../src/game/elo");

describe("elo", () => {
  test("equal ratings: the winner takes half of K", () => {
    assert.deepEqual(elo(1200, 1200, 1, 32), { newWhite: 1216, newBlack: 1184 });
    assert.deepEqual(elo(1200, 1200, 0, 32), { newWhite: 1184, newBlack: 1216 });
    assert.deepEqual(elo(1200, 1200, 0.5, 32), { newWhite: 1200, newBlack: 1200 });
  });

  test("the favourite gains little for winning and loses much for losing", () => {
    assert.deepEqual(elo(1400, 1200, 1, 32), { newWhite: 1408, newBlack: 1192 });
    assert.deepEqual(elo(1400, 1200, 0, 32), { newWhite: 1376, newBlack: 1224 });
    // A draw still moves points from the favourite to the underdog.
    assert.deepEqual(elo(1400, 1200, 0.5, 32), { newWhite: 1392, newBlack: 1208 });
  });

  test("an overwhelming favourite gains nothing at all", () => {
    assert.deepEqual(elo(2400, 1200, 1, 32), { newWhite: 2400, newBlack: 1200 });
  });

  test("K scales the change and defaults to 32", () => {
    assert.deepEqual(elo(1200, 1200, 1, 16), { newWhite: 1208, newBlack: 1192 });
    assert.deepEqual(elo(1200, 1200, 1), { newWhite: 1216, newBlack: 1184 });
  });

  test("results are integers and the exchange is zero-sum up to rounding", () => {
    const cases = [
      [1200, 1200, 1], [1500, 1300, 0], [1000, 1900, 1], [1750, 1740, 0.5],
      [2200, 1800, 0], [1234, 1567, 1], [1600, 1600, 0.5],
    ];
    for (const [w, b, s] of cases) {
      for (const k of [16, 32, 40]) {
        const { newWhite, newBlack } = elo(w, b, s, k);
        assert.ok(Number.isInteger(newWhite) && Number.isInteger(newBlack), `${w} ${b} ${s} K${k}`);
        const drift = (newWhite - w) + (newBlack - b);
        assert.ok(Math.abs(drift) <= 1, `${w} vs ${b}, score ${s}, K ${k}: drift ${drift}`);
      }
    }
  });

  test("a win never lowers the winner or raises the loser", () => {
    for (let w = 800; w <= 2400; w += 200) {
      for (let b = 800; b <= 2400; b += 200) {
        const win = elo(w, b, 1, 32);
        assert.ok(win.newWhite >= w && win.newBlack <= b, `${w} beats ${b}`);
        const loss = elo(w, b, 0, 32);
        assert.ok(loss.newWhite <= w && loss.newBlack >= b, `${w} loses to ${b}`);
      }
    }
  });
});
