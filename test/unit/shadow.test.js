"use strict";

// Shadow Chess in the rules engine (src/shared/chess.js, variant 'shadow'): a
// piece that moves leaves a shadow where it stood (two when castling), no
// piece may land on a shadow, sliders pass through and knights over it, and a
// shadow lasts through the other side's reply and its owner's next move.
// Check, mate and the draws are ordinary chess's, shadows counted; shadows are
// part of the position. LorFish keeps to the rule.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, W, B } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");

const sqOf = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
const shadow = (fen) => {
  const c = new Chess().setVariant("shadow");
  if (fen) c.loadFen(fen);
  else c.reset();
  return c;
};
const play = (c, ...ucis) => {
  for (const u of ucis) {
    const m = c.findMove(sqOf(u.slice(0, 2)), sqOf(u.slice(2, 4)), u[4]);
    assert.ok(m, `${u} in ${c.fen()}`);
    c.makeMove(m);
  }
  return c;
};
const can = (c, uci) => !!c.findMove(sqOf(uci.slice(0, 2)), sqOf(uci.slice(2, 4)));
const shadows = (c) => c.shadowList().map((s) => `${s.piece.c}${s.piece.t}@${s.sq}:${s.left}`).sort();

describe("Shadow Chess: shadows", () => {
  test("a move leaves one; it blocks both sides until its owner's next move, then lifts", () => {
    const c = play(shadow(), "g1f3");
    assert.deepEqual(shadows(c), [`wn@${sqOf("g1")}:2`]);
    assert.ok(!c.legalMoves(W).some((m) => m.to === sqOf("g1")), "not even White, on Black's turn");
    play(c, "g8f6");
    assert.deepEqual(shadows(c), [`bn@${sqOf("g8")}:2`, `wn@${sqOf("g1")}:1`]);
    assert.equal(can(c, "f3g1"), false, "White's own next move can't land on it either");
    assert.equal(can(c, "h1g1"), false);
    play(c, "e2e4");
    assert.deepEqual(shadows(c), [`bn@${sqOf("g8")}:1`, `wp@${sqOf("e2")}:2`], "g1 has lifted, e2 is new");
    play(c, "b8c6");
    assert.equal(can(c, "f3g1"), true);
  });

  test("sliders pass through a shadow, but can't stop on it", () => {
    const c = play(shadow("4k3/8/8/8/8/8/P7/R3K3 w - - 0 1"), "a2a4", "e8d8");
    assert.equal(can(c, "a1a3"), true, "through a2");
    assert.equal(can(c, "a1a2"), false);
  });

  test("castling leaves two shadows, and can't put its rook on one", () => {
    const c = play(shadow("r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1"), "f1d3", "a8b8");
    assert.equal(can(c, "e1g1"), false, "the rook would land on f1's shadow");
    play(c, "d3e2", "b8c8");
    play(c, "e1g1");
    assert.deepEqual(shadows(c).filter((s) => s.startsWith("w")), [`wk@${sqOf("e1")}:2`, `wr@${sqOf("h1")}:2`]);
  });

  test("a shadow can help mate: the king can't escape onto it", () => {
    // Black's king steps from g8 to h8, leaving g8 shadowed; Re8 is mate.
    const c = play(shadow("6k1/6pp/8/8/8/8/8/4R1K1 b - - 0 1"), "g8h8");
    const m = c.findMove(sqOf("e1"), sqOf("e8"));
    assert.equal(c.moveToSan(m), "Re8#");
    c.makeMove(m);
    assert.equal(c.isCheckmate(), true);
    assert.equal(c.result(), "1-0");
  });

  test("undoing a move puts the old shadows back", () => {
    const c = play(shadow(), "g1f3", "g8f6", "e2e4");
    const before = shadows(c);
    play(c, "f6g4");
    c.undoMove();
    assert.deepEqual(shadows(c), before);
    c.undoMove();
    assert.deepEqual(shadows(c), [`bn@${sqOf("g8")}:2`, `wn@${sqOf("g1")}:1`]);
  });

  test("the shadows are part of the position; a FEN has none", () => {
    // The same four knights out, in two orders: the shadows differ.
    const a = play(shadow(), "g1f3", "g8f6", "b1c3", "b8c6");
    const b = play(shadow(), "b1c3", "b8c6", "g1f3", "g8f6");
    assert.equal(a.fen().split(" ")[0], b.fen().split(" ")[0], "the same pieces");
    assert.notEqual(a.positionKey(), b.positionKey());
    assert.deepEqual(shadow(a.fen()).shadowList(), []);
  });

  test("other variants have none", () => {
    const c = new Chess();
    c.reset();
    c.makeMove(c.findMove(sqOf("g1"), sqOf("f3")));
    assert.equal(c.shadows, null);
    assert.deepEqual(c.shadowList(), []);
  });
});

describe("LorFish in Shadow Chess", () => {
  test("never lands on a shadow, over a game of its own", () => {
    const c = shadow();
    for (let ply = 0; ply < 24 && !c.isGameOver(); ply++) {
      const m = LorFish.getBestMove(c, 1, { rng: () => 0.5 });
      assert.equal(c.shadowAt(m.to), null, `${c.moveToSan(m)} at ply ${ply}`);
      c.makeMove(m);
    }
  });
});
