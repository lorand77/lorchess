"use strict";

// LorFish for four-player free-for-all (src/shared/lorfishFfa.js): a
// best-reply search, LorFish's own moves against the strongest single reply
// of any of its three opponents. What it must get right that the Teams search
// never meets: every other player is an opponent, the third to move as much
// as the first; points, the engine's, as well as pieces; an opponent mated is
// out, its army worth nothing; LorFish itself out is the worst there is; and
// an evaluation the same from every seat.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { LorFishFfa } = require("../../src/shared/lorfishFfa");
const { position, KINGS, turned } = require("../helpers/fourPlayer");
const { seeded } = require("../helpers/random");

const ffa = (turn, pieces, opts = {}) => position(turn, pieces, Object.assign({ mode: "ffa" }, opts));
const best = (g, depth) => LorFishFfa.analyse(g, depth);
const NEXT = { r: "b", b: "y", y: "g", g: "r" };
// A free-for-all game played at random from the start, `plies` long.
function randomGame(plies, seed) {
  const rng = seeded(seed);
  const g = new FourPlayer("ffa");
  for (let i = 0; i < plies && !g.isGameOver(); i++) {
    const ms = g.legalMoves();
    g.makeMove(ms[Math.floor(rng() * ms.length)]);
  }
  return g;
}
// How much worse than the best root move the one starting `san` scored.
function cost(g, depth, san) {
  const { evals } = LorFishFfa.searchRoot(g, depth, {});
  const top = Math.max(...evals.map((e) => e.raw));
  return top - evals.find((e) => e.san.startsWith(san)).raw;
}
// A Green king hemmed in by its own pawns on the n-file.
const BOXED = { h1: "rK", a7: "bK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP" };

describe("LorFish in four-player free-for-all", () => {
  test("the evaluation is the same from every seat, and level at the start", () => {
    for (const c of FourPlayer.COLORS) assert.equal(LorFishFfa.evaluate(new FourPlayer("ffa"), c), 0);
    for (let seed = 1; seed <= 12; seed++) {
      let g = randomGame(40 + seed * 10, seed);
      // Some with a player out, their army dead.
      if (seed % 3 === 0) g.eliminate(g.active().find((c) => c !== g.turn), "resign");
      let me = g.turn;
      const score = LorFishFfa.evaluate(g, me);
      for (let k = 0; k < 3; k++) {
        g = turned(g);
        me = NEXT[me];
        assert.equal(LorFishFfa.evaluate(g, me), score, `seed ${seed}, turned ${k + 1}`);
      }
    }
  });

  test("points count as well as pieces, and a dead army counts for nothing", () => {
    const base = ffa("r", KINGS);
    const ahead = ffa("r", KINGS, { points: { r: 10 } });
    assert.equal(LorFishFfa.evaluate(ahead, "r") - LorFishFfa.evaluate(base, "r"), 10 * LorFishFfa.POINT);
    const alive = ffa("r", { ...KINGS, f10: "yQ" });
    const dead = ffa("r", { ...KINGS, f10: "yQ" }, { out: "y" });
    assert.ok(LorFishFfa.evaluate(dead, "r") > LorFishFfa.evaluate(alive, "r"));
  });

  test("takes a queen left loose, whoever's it is", () => {
    for (const c of ["b", "y", "g"]) {
      const g = ffa("r", { ...KINGS, j4: "rR", j9: c + "Q" });
      for (const depth of [1, 2]) assert.equal(best(g, depth).san, "Rj4xj9", `${c}, depth ${depth}`);
    }
  });

  test("sees the last opponent: no queen for a pawn that Green, moving third, defends", () => {
    const loose = { ...KINGS, e5: "rQ", e10: "yP" };
    assert.equal(cost(ffa("r", loose), 1, "Qe5xe10"), 0, "unguarded: the best move");
    const guarded = ffa("r", { ...loose, g11: "gN" });
    for (const depth of [1, 2]) {
      assert.ok(cost(guarded, depth, "Qe5xe10") > 500, `depth ${depth}: the queen is lost`);
      assert.ok(!best(guarded, depth).san.startsWith("Qe5xe10"), `depth ${depth}`);
    }
  });

  test("moves a piece out of any opponent's reach", () => {
    // Yellow's pawn on e9 attacks Red's queen on f8.
    const g = ffa("r", { ...KINGS, f8: "rQ", e9: "yP", j12: "yR" });
    const m = best(g, 2).move;
    g.makeMove(m);
    const q = g.squares.findIndex((p) => p && p.t === "q" && p.c === "r");
    assert.ok(q !== -1 && !g.attackedBy(q, g.hostile("r")), FourPlayer.nameOf(q));
  });

  test("mates on the mated player's turn, two players later", () => {
    // Red's rook to n11 checks Green; Blue and Yellow move, and Green is mated.
    const g = ffa("r", { ...BOXED, k11: "rR" });
    for (const depth of [1, 2]) assert.equal(best(g, depth).san, "Rk11-n11+", `depth ${depth}`);
    // And it leaves the board as it found it: the mate it played out is undone.
    assert.deepEqual([g.active().length, g.points.r, g.history.length], [4, 0, 0]);
  });

  test("takes a king left to be taken", () => {
    // Blue's rook checks Red's king; Green's knight takes it.
    const g = ffa("g", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", h9: "bR", g3: "gN" });
    assert.equal(best(g, 2).san, "Ng3xh1");
  });

  test("its own end is the worst there is", () => {
    // Blue threatens Qe1, mate along the first rank with the rook on d2
    // covering the second. Nearly every Red move allows it; taking the rook,
    // or checking Blue's king so Blue must answer that, doesn't.
    const g = ffa("r", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", d4: "rR", e2: "bQ", d2: "bR" });
    const { evals } = LorFishFfa.searchRoot(g, 2, {});
    const raw = (san) => evals.find((e) => e.san === san).raw;
    assert.equal(raw("Kh1-i1"), -(LorFishFfa.MATE - 2), "mated two plies on");
    assert.equal(raw("Rd4-d3"), -(LorFishFfa.MATE - 2));
    assert.ok(raw("Rd4xd2") > -1000 && raw("Rd4-a4+") > -1000);
    assert.ok(["Rd4xd2", "Rd4-a4+"].includes(best(g, 2).san));
  });

  test("leaves the position as it found it, and has nothing to say when the game is over", () => {
    const g = randomGame(90, 5);
    const fen = g.fen(), points = { ...g.points }, out = { ...g.out }, plies = g.history.length;
    best(g, 2);
    assert.deepEqual([g.fen(), g.points, g.out, g.history.length], [fen, points, out, plies]);
    const over = ffa("r", KINGS, { out: "yg", points: { r: 30 } });
    over.claimWin("r");
    assert.equal(over.isGameOver(), true);
    assert.equal(best(over, 2), null);
    assert.equal(LorFishFfa.getBestMove(over, 2), null);
  });

  test("cuts its capture search short past its node budget", () => {
    // The budget is rarely reached at the levels' depths; a small one shows
    // it working: fewer nodes, and the capture search cut short.
    const budget = LorFishFfa.NODE_BUDGET;
    try {
      const g = randomGame(60, 9);
      LorFishFfa.NODE_BUDGET = 1e9;
      best(g, 1);
      const free = [LorFishFfa.nodes, LorFishFfa.maxQ];
      LorFishFfa.NODE_BUDGET = 500;
      best(g, 1);
      assert.ok(LorFishFfa.nodes < free[0] / 2, `${LorFishFfa.nodes} nodes, ${free[0]} without a budget`);
      assert.ok(LorFishFfa.maxQ < free[1], `${LorFishFfa.maxQ} deep, ${free[1]} without a budget`);
    } finally {
      LorFishFfa.NODE_BUDGET = budget;
    }
  });

  test("searches deeper, with killer moves to order the quiet ones", () => {
    const g = new FourPlayer("ffa");
    const m = LorFishFfa.getBestMove(g, 3, { rng: seeded(2) });
    assert.ok(g.findMove(m.from, m.to, m.promo), "a legal move");
    assert.ok(LorFishFfa.killers.some((k) => k && k.length), "killers kept");
  });

  test("plays at a temperature by LorFish's sampling, and the same rng the same move", () => {
    const g = new FourPlayer("ffa");
    const a = LorFishFfa.getBestMove(g, 1, { temperature: 200, rng: seeded(4) });
    const b = LorFishFfa.getBestMove(g, 1, { temperature: 200, rng: seeded(4) });
    assert.deepEqual(FourPlayer.moveText(a), FourPlayer.moveText(b));
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(FourPlayer.moveText(LorFishFfa.getBestMove(g, 1, { temperature: 200, rng: seeded(i) })));
    assert.ok(seen.size > 3, "varied: " + [...seen].join(" "));
  });
});
