"use strict";

// Gambling Chess in the rules engine (src/shared/chess.js, variant
// 'gambling'): each turn a piece type is dealt, from the types with a legal
// move, each as likely, and only that type may move. Check, mate and the draws
// are ordinary chess's; the deal is in the FEN, cleared by a move and put back
// by undoing it. LorFish, searching from a dealt position, moves only that
// type.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");

const gambling = (fen) => {
  const c = new Chess().setVariant("gambling");
  if (fen) c.loadFen(fen);
  else c.reset();
  return c;
};
const sans = (c) => c.legalMoves().map((m) => c.moveToSan(m)).sort();

describe("Gambling Chess: the deal", () => {
  test("from the start only pawns and knights can move, so only they are dealt", () => {
    const c = gambling();
    assert.equal(c.dealt, null);
    assert.equal(c.legalMoves().length, 20, "undealt, every move");
    assert.deepEqual(c.movableTypes(), ["p", "n"]);
    assert.equal(c.deal("q"), false, "the queen can't move");
    assert.equal(c.dealt, null);
    assert.equal(c.deal("n"), true);
    assert.deepEqual(sans(c), ["Na3", "Nc3", "Nf3", "Nh3"]);
  });

  test("every movable type is as likely as the others, and nothing else is dealt", () => {
    // White: king, rook, knight and a blocked pawn; the pawn can't move.
    const c = gambling("4k3/8/8/8/8/p7/P7/R3K1N1 w Q - 0 1");
    assert.deepEqual(c.movableTypes(), ["n", "r", "k"]);
    const counts = { n: 0, r: 0, k: 0 };
    for (let i = 0; i < 3000; i++) counts[c.dealRandom()]++;
    for (const t of ["n", "r", "k"]) assert.ok(counts[t] > 850 && counts[t] < 1150, JSON.stringify(counts));
    // The picker the server passes (crypto's) is asked for an index.
    const asked = [];
    assert.equal(c.dealRandom((n) => { asked.push(n); return 2; }), "k");
    assert.deepEqual(asked, [3]);
  });

  test("castling is a king move, a promotion a pawn's", () => {
    const c = gambling("4k3/1P6/8/8/8/8/8/R3K3 w Q - 0 1");
    c.deal("k");
    assert.ok(sans(c).includes("O-O-O"));
    c.deal("p");
    assert.deepEqual(sans(c), ["b8=B", "b8=N", "b8=Q+", "b8=R+"]);
  });

  test("in check, only a type that can answer it is dealt; with none it is mate, as usual", () => {
    // Black's rook checks along the first rank: the king steps up, or the
    // bishop blocks on c1; the knight on h3 can do neither.
    const check = gambling("4k3/8/8/8/8/7N/3B4/r3K3 w - - 0 1");
    assert.deepEqual(check.movableTypes(), ["b", "k"]);
    // Back-rank mate: nothing to deal, and mate whatever was dealt before.
    const mate = gambling("6k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1");
    mate.deal("r");
    mate.makeMove(mate.findMove(sqOf("d1"), sqOf("d8")));
    assert.deepEqual(mate.movableTypes(), []);
    assert.equal(mate.dealRandom(), null);
    assert.equal(mate.isCheckmate(), true);
    assert.equal(mate.result(), "1-0");
  });

  test("dealing is Gambling Chess's alone", () => {
    const c = new Chess();
    c.reset();
    assert.equal(c.deal("n"), false);
    assert.equal(c.dealRandom(), null);
    assert.equal(c.isGambling, false);
  });
});

describe("Gambling Chess: moves, history and notation", () => {
  test("a move clears the deal and undoing it puts the deal back", () => {
    const c = gambling();
    c.deal("n");
    c.makeMove(c.legalMoves()[0]);
    assert.equal(c.dealt, null);
    assert.equal(c.legalMoves().length, 20, "Black, undealt");
    c.undoMove();
    assert.equal(c.dealt, "n");
  });

  test("FEN carries the deal as a seventh field, and a deal that can't move is dropped", () => {
    const c = gambling();
    assert.equal(c.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    c.deal("p");
    const fen = c.fen();
    assert.equal(fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 p");
    assert.equal(Chess.dealtIn(fen), "p");
    assert.equal(Chess.dealtIn("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"), null);
    assert.equal(gambling(fen).dealt, "p");
    assert.equal(gambling(fen.replace(/ p$/, " q")).dealt, null, "the queen can't move: not dealt");
    // Other variants ignore the field.
    const standard = new Chess();
    standard.loadFen(fen);
    assert.equal(standard.dealt, null);
  });

  test("the deal is no part of the position: a repetition counts whatever was dealt", () => {
    const c = gambling();
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    for (let round = 0; round < 2; round++) {
      for (const uci of shuffle) {
        c.deal("n");
        c.makeMove(c.findMove(sqOf(uci.slice(0, 2)), sqOf(uci.slice(2))));
      }
    }
    c.deal("p");
    assert.equal(c.isThreefoldRepetition(), true);
    assert.equal(c.isGameOver(), true);
  });
});

describe("LorFish in Gambling Chess", () => {
  test("moves only the dealt type at its root", () => {
    // A rook is hanging on h8 for the queen on d4, but a knight is dealt.
    const c = gambling("4k2r/8/8/8/3Q4/8/8/1N2K3 w - - 0 1");
    c.deal("n");
    for (let i = 0; i < 5; i++) {
      const m = LorFish.getBestMove(c, 2, { rng: () => 0.5 });
      assert.equal(c.squares[m.from].t, "n");
    }
    c.deal("q");
    assert.equal(c.moveToSan(LorFish.getBestMove(c, 2, { rng: () => 0.5 })), "Qxh8+");
    assert.equal(c.dealt, "q", "the search leaves the deal as it found it");
  });
});

function sqOf(name) {
  return (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
}
