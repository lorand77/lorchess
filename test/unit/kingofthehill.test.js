"use strict";

// King of the Hill in src/shared/chess.js, by Lichess's rules: ordinary chess,
// and a king that reaches the centre (d4, e4, d5, e5) by a legal move wins on
// the spot. Mate still wins, the usual draws apply, and material never runs
// out, since a bare king can still walk to the centre.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, STANDARD_START, algOf } = require("../../src/shared/chess");
const { perft } = require("../helpers/perft");
const { fromFen, play } = require("../helpers/board");

const koth = (fen = STANDARD_START) => fromFen(fen, "kingofthehill");
const HILL = ["d4", "e4", "d5", "e5"];

describe("King of the Hill", () => {
  test("moves as in standard chess until a king reaches the centre", () => {
    // No king can get there within four plies of the start.
    for (let depth = 1; depth <= 3; depth++) {
      assert.equal(perft(koth(), depth), perft(fromFen(STANDARD_START), depth), `depth ${depth}`);
    }
    // A king a step away: every move onto the hill ends the game, with no reply.
    const fen = "8/8/8/8/8/3K4/8/k7 w - - 0 1";
    const standard = fromFen(fen);
    let expected = 0;
    for (const m of standard.legalMoves()) {
      standard.makeMove(m);
      if (!HILL.includes(algOf(m.to))) expected += standard.legalMoves().length;
      standard.undoMove();
    }
    assert.equal(perft(koth(fen), 2), expected);
    assert.ok(expected < perft(fromFen(fen), 2));
  });

  for (const square of HILL) {
    test(`a king on ${square} has won`, () => {
      // A pawn each, so standard chess wouldn't call it dead material.
      const white = koth(`${board(square, "K", "h8", "k", "a2", "P", "h7", "p")} b - - 0 1`);
      assert.equal(white.isGameOver(), true);
      assert.equal(white.result(), "1-0");
      assert.equal(white.termination(), "king in the centre");
      assert.deepEqual(white.legalMoves(), [], "nothing more to play");
      const black = koth(`${board(square, "k", "a1", "K", "a2", "P", "h7", "p")} w - - 0 1`);
      assert.equal(black.result(), "0-1");
      assert.equal(fromFen(`${board(square, "K", "h8", "k", "a2", "P", "h7", "p")} b - - 0 1`).isGameOver(), false, "not in standard chess");
    });
  }

  test("only by a legal move: not onto a square the enemy attacks", () => {
    const free = koth("7k/8/8/8/8/3K4/8/r7 w - - 0 1");      // the rook holds the first rank only
    const kingTo = free.legalMoves().map((m) => algOf(m.to));
    assert.ok(kingTo.includes("d4") && kingTo.includes("e4"));
    const guarded = koth("7k/8/8/8/r7/3K4/8/8 w - - 0 1");   // the rook holds the fourth rank
    const to = guarded.legalMoves().map((m) => algOf(m.to));
    assert.ok(!to.includes("d4") && !to.includes("e4"), to.join(" "));
  });

  test("the centre win comes ahead of a check it uncovers, which is no mate", () => {
    // Ke4 steps off the d-file, opening the rook on d1 onto the king on d8.
    const chess = koth("3k4/8/8/8/8/3K4/8/3R4 w - - 0 1");
    const move = chess.findMove(19, 28);
    assert.equal(chess.moveToSan(move), "Ke4+", "a check, not a mate: the game is won another way");
    chess.makeMove(move);
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isStalemate(), false);
    assert.equal(chess.termination(), "king in the centre");
    assert.equal(chess.result(), "1-0");
  });

  test("mate still wins, and the draws are the usual ones", () => {
    assert.equal(koth("4R1k1/5ppp/8/8/8/8/8/K7 b - - 0 1").termination(), "checkmate");
    assert.equal(koth("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").termination(), "stalemate");
    const knights = koth("7k/7p/8/8/8/8/P7/K5N1 w - - 0 1");
    for (let i = 0; i < 2; i++) play(knights, "g1f3", "h8g8", "f3g1", "g8h8");
    assert.equal(knights.termination(), "threefold");
  });

  test("material never runs out: a bare king can still walk to the centre", () => {
    const bare = koth("7k/8/8/8/8/8/8/K7 w - - 0 1");
    assert.equal(bare.isInsufficientMaterial(), false);
    assert.equal(bare.isGameOver(), false);
    assert.equal(bare.hasMatingMaterial("w"), true, "so a flag that falls loses");
    assert.equal(fromFen("7k/8/8/8/8/8/8/K7 w - - 0 1").isInsufficientMaterial(), true, "unlike standard chess");
  });

  test("standard chess has no centre win", () => {
    const chess = fromFen("7k/7p/8/8/4K3/8/P7/8 b - - 0 1");
    assert.equal(chess.isGameOver(), false);
    assert.equal(new Chess().setVariant("kingofthehill").variant, "kingofthehill");
  });
});

// A FEN board with the pieces given, each by square and letter.
function board(...placed) {
  const squares = new Array(64).fill(null);
  for (let i = 0; i < placed.length; i += 2) {
    const sq = placed[i];
    squares[(Number(sq[1]) - 1) * 8 + sq.charCodeAt(0) - 97] = placed[i + 1];
  }
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "", empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = squares[rank * 8 + file];
      if (!p) { empty++; continue; }
      if (empty) row += empty;
      row += p;
      empty = 0;
    }
    rows.push(row + (empty ? empty : ""));
  }
  return rows.join("/");
}
