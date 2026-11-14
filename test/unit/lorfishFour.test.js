"use strict";

// LorFish for four-player chess (src/shared/lorfishFour.js): a two-sided
// search over a game of four, since the teams take turns. What it must get
// right that two-player LorFish never meets: the second opponent's capture
// (a piece left where Green can take it is lost, though Blue moves first), a
// mate that only counts on the mated player's turn, a king left to be taken,
// and an evaluation the same from every seat.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { LorFishFour } = require("../../src/shared/lorfishFour");
const { position, KINGS, turned } = require("../helpers/fourPlayer");
const { seeded } = require("../helpers/random");

const best = (g, depth) => LorFishFour.analyse(g, depth);
// A game played at random from the start, `plies` long: a position with
// pieces loose all over the board.
function randomGame(plies, seed) {
  const rng = seeded(seed);
  const g = new FourPlayer();
  for (let i = 0; i < plies && !g.isGameOver(); i++) {
    const ms = g.legalMoves();
    g.makeMove(ms[Math.floor(rng() * ms.length)]);
  }
  return g;
}

describe("LorFish in four-player chess", () => {
  test("the evaluation is the same from every seat, and level at the start", () => {
    assert.equal(LorFishFour.evaluate(new FourPlayer()), 0);
    for (let seed = 1; seed <= 12; seed++) {
      let g = randomGame(40, seed);
      const score = LorFishFour.evaluate(g);
      for (let k = 0; k < 3; k++) {
        g = turned(g);
        assert.equal(LorFishFour.evaluate(g), score, `seed ${seed}, turned ${k + 1}`);
      }
    }
  });

  test("takes a queen left loose", () => {
    const g = position("r", { ...KINGS, j4: "rR", j9: "bQ" });
    for (const depth of [1, 2]) assert.equal(best(g, depth).san, "Rj4xj9", `depth ${depth}`);
  });

  test("sees the second opponent: no queen for a pawn that Green, not Blue, defends", () => {
    // Red's queen can take Blue's pawn on j8. Unguarded, the pawn is as good
    // as Red's (now or next round: nobody can save it). Guarded by Green's
    // bishop on l10 — Blue moves, then Yellow, then Green takes back — it
    // costs the queen, and LorFish sees that at either depth.
    const loose = { ...KINGS, j3: "rQ", j8: "bP", d4: "rN" };
    const take = (g, depth) => {
      const { evals } = LorFishFour.searchRoot(g, depth, {});
      const top = Math.max(...evals.map((e) => e.raw));
      return top - evals.find((e) => e.san.startsWith("Qj3xj8")).raw;
    };
    assert.ok(take(position("r", loose), 1) <= 10, "unguarded: as good as any move");
    const guarded = position("r", { ...loose, l10: "gB" });
    for (const depth of [1, 2]) {
      assert.ok(take(guarded, depth) > 500, `depth ${depth}: the queen is lost`);
      assert.ok(!best(guarded, depth).san.startsWith("Qj3xj8"), `depth ${depth}`);
    }
  });

  test("mates on the mated player's turn, after the others have moved", () => {
    // Red's rook to n11 checks Green, whose pawns hem the king in; Blue can't
    // help, Yellow moves, and Green, to move, is mated.
    const g = position("r", { ...KINGS, m7: "gP", m8: "gP", m9: "gP", n7: "gP", e11: "rR" });
    const r = best(g, 2);
    assert.equal(r.san, "Re11-n11+");
    assert.ok(r.score > LorFishFour.MATE - 10, String(r.score));
  });

  test("takes a king left to be taken", () => {
    const g = position("r", { ...KINGS, n11: "rR" });
    const r = best(g, 1);
    assert.equal(r.san, "Rn11xn8");
    assert.equal(r.score, LorFishFour.MATE - 1);
  });

  test("leaves the position as it found it, and has nothing to say when the game is over", () => {
    const g = randomGame(30, 5);
    const fen = g.fen(), plies = g.history.length;
    best(g, 2);
    assert.deepEqual([g.fen(), g.history.length], [fen, plies]);
    const over = position("r", { ...KINGS, n11: "rR" });
    over.makeMove(over.findMove("n11", "n8"));   // Green's king taken
    assert.equal(over.isGameOver(), true);
    assert.equal(best(over, 2), null);
    assert.equal(LorFishFour.getBestMove(over, 2), null);
  });

  test("keeps within its node budget on a board of loose pieces", () => {
    for (const seed of [3, 9]) {
      const g = randomGame(44, seed);
      if (g.isGameOver()) continue;
      best(g, 2);
      assert.ok(LorFishFour.nodes < 2 * LorFishFour.NODE_BUDGET, `seed ${seed}: ${LorFishFour.nodes} nodes`);
    }
  });

  test("searches deeper, with killer moves to order the quiet ones", () => {
    const g = new FourPlayer();
    const m = LorFishFour.getBestMove(g, 3, { rng: seeded(2) });
    assert.ok(g.findMove(m.from, m.to, m.promo), "a legal move");
    assert.ok(LorFishFour.killers.some((k) => k && k.length), "killers kept");
  });

  test("plays at a temperature by LorFish's sampling, and the same rng the same move", () => {
    const g = new FourPlayer();
    const a = LorFishFour.getBestMove(g, 1, { temperature: 200, rng: seeded(4) });
    const b = LorFishFour.getBestMove(g, 1, { temperature: 200, rng: seeded(4) });
    assert.deepEqual(FourPlayer.moveText(a), FourPlayer.moveText(b));
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(FourPlayer.moveText(LorFishFour.getBestMove(g, 1, { temperature: 200, rng: seeded(i) })));
    assert.ok(seen.size > 3, "varied: " + [...seen].join(" "));
  });
});
