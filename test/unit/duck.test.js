"use strict";

// Duck Chess in the rules engine (src/shared/chess.js, variant 'duck'): a
// turn is a move and then the duck, to an empty square other than its own.
// The duck blocks every piece (no landing on it, no sliding through it, no
// taking it; a knight jumps it). No check: taking the king wins, and a side
// with no legal move wins. FEN writes the duck as "*", UCI as "@square".
// LorFish places the duck where it hurts the other side most.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");
const { moveFromUci, formatUci, parseUci } = require("../../src/shared/uci");

const sqOf = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
const duck = (fen) => {
  const c = new Chess().setVariant("duck");
  if (fen) c.loadFen(fen);
  else c.reset();
  return c;
};
// Play "g1f3@d5" turns.
const play = (c, ...turns) => {
  for (const t of turns) {
    const m = moveFromUci(c, t);
    assert.ok(m, `${t} in ${c.fen()}`);
    c.makeMove(m);
  }
  return c;
};
const can = (c, uci) => !!c.findMove(sqOf(uci.slice(0, 2)), sqOf(uci.slice(2, 4)));
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

describe("Duck Chess: the duck", () => {
  test("starts off the board; the first turn puts it on any empty square", () => {
    const c = duck();
    assert.equal(c.duck, null);
    const m = c.findMove(sqOf("e2"), sqOf("e4"));
    assert.equal(c.duckSquares(m).length, 32, "the 32 empty squares, e2 just left among them");
    assert.ok(c.duckSquares(m).includes(sqOf("e2")));
    play(c, "e2e4@e2");
    assert.equal(c.duck, sqOf("e2"));
  });

  test("blocks every piece: no landing, no sliding through, no taking; a knight jumps it", () => {
    // White's rook on a1, the duck on a4; a knight on b1.
    const c = duck("4k3/8/8/8/*7/8/8/RN2K3 w - - 0 1");
    assert.equal(can(c, "a1a3"), true);
    assert.equal(can(c, "a1a4"), false, "not onto it");
    assert.equal(can(c, "a1a5"), false, "not through it");
    assert.equal(can(c, "b1a3"), true, "the knight is not blocked");
    // A pawn can't step onto it, nor take it.
    const p = duck("4k3/8/8/8/3*4/4P3/8/4K3 w - - 0 1");
    assert.equal(can(p, "e3e4"), true);
    assert.equal(can(p, "e3d4"), false);
    const q = duck("4k3/8/8/8/4*3/4P3/8/4K3 w - - 0 1");
    assert.equal(can(q, "e3e4"), false);
  });

  test("must move every turn, to an empty square; it may take the square just left", () => {
    const c = play(duck(), "e2e4@d5");
    const m = c.findMove(sqOf("g8"), sqOf("f6"));
    assert.equal(c.withDuck(m, sqOf("d5")), null, "not where it is");
    assert.equal(c.withDuck(m, sqOf("e4")), null, "not onto a piece");
    assert.equal(c.withDuck(m, null), null, "not left out");
    assert.ok(c.withDuck(m, sqOf("g8")), "onto the square the knight left");
    assert.equal(moveFromUci(c, "g8f6@d5"), null);
    play(c, "g8f6@g8");
    assert.equal(c.duck, sqOf("g8"));
  });

  test("a move taking the king needs no duck, and wins", () => {
    const c = duck("4k3/8/8/8/8/8/8/4R1K1 w - - 0 1");
    play(c, "e1e8");
    assert.equal(c.isGameOver(), true);
    assert.equal(c.result(), "1-0");
    assert.equal(c.termination(), "king captured");
  });
});

describe("Duck Chess: the rules around it", () => {
  test("no check: a king may step into attack and castle through it", () => {
    const c = duck("k3r1r1/8/8/8/8/8/8/R3K2R w KQ - 0 1");
    assert.equal(c.inCheck(), false);
    assert.ok(can(c, "e1g1") || !!c.findMove(sqOf("e1"), sqOf("h1")), "castles through the rooks' files");
    assert.ok(can(c, "e1e2"), "steps onto e2, which e8 attacks");
  });

  test("the duck on the path stops castling", () => {
    const c = duck("4k3/8/8/8/8/8/8/R3K1*R w KQ - 0 1");
    assert.equal(c.legalMoves().some((m) => m.castle === "K"), false);
    assert.equal(c.legalMoves().some((m) => m.castle === "Q"), true);
  });

  test("a side with no legal move has won", () => {
    // White's king boxed in by its own blocked pieces.
    const c = duck("7k/8/8/8/p1p5/P1Pp4/PB1P4/KNB5 w - - 0 1");
    assert.deepEqual(c.legalMoves(), []);
    assert.equal(c.result(), "1-0");
    assert.equal(c.termination(), "no moves");
  });

  test("material never runs out; threefold and fifty moves draw", () => {
    const c = duck("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    assert.equal(c.isInsufficientMaterial(), false);
    assert.equal(c.isGameOver(), false);
    const fifty = duck("4k3/8/8/8/8/8/8/4K3 w - - 99 80");
    play(fifty, "e1d1@a1");
    assert.equal(fifty.termination(), "fifty-move");
  });
});

describe("Duck Chess: notation", () => {
  test("FEN writes the duck as *, and reads it back", () => {
    const c = play(duck(), "g1f3@d5");
    assert.equal(c.fen(), "rnbqkbnr/pppppppp/8/3*4/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1");
    assert.equal(duck(c.fen()).duck, sqOf("d5"));
    assert.throws(() => duck("4k3/8/8/8/**6/8/8/4K3 w - - 0 1"), /one duck/);
    assert.throws(() => new Chess().loadFen("4k3/8/8/8/*7/8/8/4K3 w - - 0 1"), /bad piece/, "only in Duck Chess");
  });

  test("UCI adds @ and the duck's square; SAN too", () => {
    const c = duck();
    assert.deepEqual(parseUci("e7e8q@a1"), { from: sqOf("e7"), to: sqOf("e8"), promo: "q", drop: null, duck: 0 });
    const m = moveFromUci(c, "g1f3@d5");
    assert.equal(formatUci(m), "g1f3@d5");
    assert.equal(c.moveToSan(m), "Nf3@d5");
    // Other variants take no duck.
    const plain = new Chess();
    plain.reset();
    assert.equal(moveFromUci(plain, "g1f3@d5"), null);
    assert.ok(moveFromUci(plain, "g1f3"));
  });

  test("the duck is part of the position", () => {
    const a = play(duck(), "g1f3@d5");
    const b = play(duck(), "g1f3@d4");
    assert.notEqual(a.positionKey(), b.positionKey());
  });

  test("in random games the duck keeps its rules, and undo puts everything back", () => {
    let s = 7;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let game = 0; game < 20; game++) {
      const c = duck();
      for (let ply = 0; ply < 80 && !c.isGameOver(); ply++) {
        const moves = c.legalMoves();
        for (const m of moves) {
          assert.notEqual(m.to, c.duck, "nothing lands on the duck");
          const target = c.squares[m.to];
          assert.ok(!target || target.c !== c.turn);
        }
        const pick = moves[Math.floor(rand() * moves.length)];
        const target = c.squares[pick.to];
        const ducks = c.duckSquares(pick);
        assert.ok(!ducks.includes(c.duck));
        const turn = target && target.t === "k" ? pick : c.withDuck(pick, ducks[Math.floor(rand() * ducks.length)]);
        const before = c.fen();
        c.makeMove(turn);
        c.undoMove();
        assert.equal(c.fen(), before);
        c.makeMove(turn);
        assert.equal(moveFromUci(duck(before), formatUci(turn)) !== null, true, formatUci(turn));
      }
    }
  });
});

describe("LorFish in Duck Chess", () => {
  test("puts the duck on a square it may go to, and blocks a threat to its king", () => {
    // Black's rook on e8 would take White's king on e1 down the open file.
    const c = duck("4r1k1/8/8/8/8/8/P7/4K3 w - - 0 1");
    const m = quiet(() => LorFish.getBestMove(c, 2, { rng: () => 0.5 }));
    assert.ok(c.withDuck({ from: m.from, to: m.to, promo: m.promo }, m.duck) || m.castle, JSON.stringify(m));
    c.makeMove(m);
    assert.equal(c.legalMoves().some((x) => c.squares[x.to] && c.squares[x.to].t === "k"), false);
  });

  test("takes a king left to be taken, with no duck after", () => {
    const c = duck("4k3/8/8/8/8/8/8/4R1K1 w - - 0 1");
    const m = quiet(() => LorFish.getBestMove(c, 2, { rng: () => 0.5 }));
    assert.equal(c.moveToSan(m), "Rxe8");
    assert.equal(m.duck, undefined);
  });
});
