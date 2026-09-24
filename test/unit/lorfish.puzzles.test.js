"use strict";

// Tactical regression test: LorFish against Lichess puzzles from
// test/fixtures/puzzles.json (see scripts/extractPuzzleFixture.js).
//
// By default every puzzle the engine solved when the fixture was generated
// must still be solved: a known-solvable set, so any miss is a regression.
// Two-move puzzles at depth 2 are slow, so only the twenty quickest run.
//
//   PUZZLES=all npm test
//
// also runs every puzzle at depth 2, the app's default, and checks the
// overall two-move solve rate against the recorded baseline.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../fixtures/puzzles.json");
const { solvePuzzle, link } = require("../helpers/puzzles");

const ALL = process.env.PUZZLES === "all";
const oneMove = fixture.oneMove.filter((p) => p.solvedAtDepth1);
const twoMove = fixture.twoMove.filter((p) => p.solvedAtDepth2 && p.msAtDepth2 <= 400).slice(0, 20);

const explain = (p, r) =>
  `${link(p)} (rating ${p.rating}; ${p.themes}): move ${r.ply} got ${r.got}, wanted ${r.want}`;

describe(`puzzles: ${oneMove.length} one-move at depth 1`, () => {
  for (const p of oneMove) {
    test(`${p.id} rating ${p.rating}`, () => {
      const r = solvePuzzle(p, 1);
      assert.ok(r.ok, explain(p, r));
    });
  }
});

describe(`puzzles: ${twoMove.length} two-move at depth 2`, () => {
  for (const p of twoMove) {
    test(`${p.id} rating ${p.rating}`, () => {
      const r = solvePuzzle(p, 2);
      assert.ok(r.ok, explain(p, r));
    });
  }
});

describe("puzzles: full sample at depth 2", { skip: !ALL && "set PUZZLES=all" }, () => {
  test(`every one-move puzzle (${fixture.oneMove.length})`, (t) => {
    const misses = fixture.oneMove.map((p) => [p, solvePuzzle(p, 2)]).filter(([, r]) => !r.ok);
    for (const [p, r] of misses) t.diagnostic("miss " + explain(p, r));
    assert.equal(misses.length, 0, `${misses.length} one-move puzzles missed at depth 2`);
  });

  test(`two-move solve rate stays near the ${fixture.twoMoveBaseline}% baseline`, (t) => {
    let solved = 0;
    for (const p of fixture.twoMove) {
      const r = solvePuzzle(p, 2);
      if (r.ok) solved++;
      else t.diagnostic("miss " + explain(p, r));
    }
    const rate = Math.round((100 * solved) / fixture.twoMove.length);
    t.diagnostic(`solved ${solved}/${fixture.twoMove.length} (${rate}%), baseline ${fixture.twoMoveBaseline}%`);
    assert.ok(rate >= fixture.twoMoveBaseline - 5, `${rate}% is more than 5 points below the ${fixture.twoMoveBaseline}% baseline`);
  });
});
