"use strict";

// The rating fit behind scripts/lorfishLevels.js fit: given games between
// players and a few pinned ratings, it should hand back the ratings the games
// were played at, and intervals that cover them.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { expectedScore, fitRatings, bootstrapIntervals } = require("../../scripts/eloFit");
const { seeded } = require("../helpers/random");

// What n games score on average between players of these ratings.
const exact = (truth, a, b, n) => ({ a, b, n, score: n * expectedScore(truth[a] - truth[b]) });

describe("eloFit", () => {
  test("expectedScore is the Elo curve", () => {
    assert.equal(expectedScore(0), 0.5);
    assert.ok(Math.abs(expectedScore(400) - 10 / 11) < 1e-12);
    assert.ok(Math.abs(expectedScore(-400) - 1 / 11) < 1e-12);
  });

  test("recovers the ratings the games were scored at, chained players included", () => {
    const truth = { sf1320: 1320, sf1700: 1700, casual: 1200, mid: 1550, r1: 1000, beginner: 800 };
    const pinned = new Map([["sf1320", 1320], ["sf1700", 1700]]);
    const pairings = [
      exact(truth, "casual", "sf1320", 1e6),
      exact(truth, "mid", "sf1320", 1e6),
      exact(truth, "mid", "sf1700", 1e6),
      exact(truth, "casual", "r1", 1e6),
      exact(truth, "beginner", "r1", 1e6),
    ];
    const fit = fitRatings(pairings, pinned);
    for (const [player, rating] of Object.entries(truth)) {
      assert.ok(Math.abs(fit.get(player) - rating) < 0.5, `${player}: ${fit.get(player)}, not ${rating}`);
    }
  });

  test("pinned players keep their ratings", () => {
    const pinned = new Map([["sf1500", 1500], ["sf1900", 1900]]);
    const fit = fitRatings([{ a: "x", b: "sf1500", n: 10, score: 9 }, { a: "x", b: "sf1900", n: 10, score: 1 }], pinned);
    assert.equal(fit.get("sf1500"), 1500);
    assert.equal(fit.get("sf1900"), 1900);
  });

  test("a clean sweep gives a finite rating, well above the opponent", () => {
    const fit = fitRatings([{ a: "x", b: "sf1500", n: 20, score: 20 }], new Map([["sf1500", 1500]]));
    assert.ok(Number.isFinite(fit.get("x")));
    assert.ok(fit.get("x") > 1900);
  });

  test("a player with no games leading to a pin is an error", () => {
    const pairings = [{ a: "x", b: "sf1500", n: 10, score: 5 }, { a: "y", b: "z", n: 10, score: 5 }];
    assert.throws(() => fitRatings(pairings, new Map([["sf1500", 1500]])), /no games link y, z/);
    assert.throws(() => fitRatings(pairings, new Map()), /no pinned ratings/);
  });

  test("bootstrap intervals cover the truth and grow along a chain", () => {
    const rng = seeded(7);
    const truth = { sf1320: 1320, casual: 1200, r1: 1000, beginner: 800 };
    // 400 simulated games a link, in units of two that share an opening.
    const play = (a, b) => {
      const e = expectedScore(truth[a] - truth[b]);
      const units = Array.from({ length: 200 }, () => {
        const score = (rng() < e ? 1 : 0) + (rng() < e ? 1 : 0);
        return { n: 2, score };
      });
      return { a, b, units };
    };
    const groups = [play("casual", "sf1320"), play("casual", "r1"), play("beginner", "r1")];
    const pinned = new Map([["sf1320", 1320]]);
    const ci = bootstrapIntervals(groups, pinned, { samples: 200, rng });
    for (const player of ["casual", "r1", "beginner"]) {
      const { lo, hi } = ci.get(player);
      assert.ok(lo < truth[player] && truth[player] < hi, `${player}: ${lo}–${hi}`);
    }
    const width = (p) => ci.get(p).hi - ci.get(p).lo;
    // About ±35 for one link of 400 games, wider at each step from the pin.
    assert.ok(width("casual") > 40 && width("casual") < 120, `casual: ±${width("casual") / 2}`);
    assert.ok(width("beginner") > width("casual"));
    assert.equal(ci.get("sf1320").lo, 1320);
    assert.equal(ci.get("sf1320").hi, 1320);
  });
});
