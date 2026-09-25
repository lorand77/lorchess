"use strict";

// Atomic chess in src/shared/chess.js: captures explode, kings never capture,
// and losing your king ends the game.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, algOf } = require("../../src/shared/chess");
const { fromFen, sq, uci, moveOf, play } = require("../helpers/board");
const { perft } = require("../helpers/perft");

const atomic = (fen) => fromFen(fen, "atomic");

describe("Atomic", () => {
  test("an explosion covers the square and its neighbours, clipped at the edge", () => {
    const chess = new Chess().setVariant("atomic");
    const blast = (name) => chess.explosionSquares(sq(name)).map(algOf).sort();
    assert.deepEqual(blast("e4"), ["d3", "d4", "d5", "e3", "e4", "e5", "f3", "f4", "f5"]);
    assert.deepEqual(blast("a1"), ["a1", "a2", "b1", "b2"]);
    assert.deepEqual(blast("h4"), ["g3", "g4", "g5", "h3", "h4", "h5"]);
  });

  test("a capture destroys both pieces and every neighbouring piece except pawns", () => {
    const before = "7k/8/3pqr2/4n3/5P2/8/1B6/K7 w - - 0 1";
    const chess = atomic(before);
    play(chess, "b2e5");
    assert.equal(chess.fen(), "7k/8/3p4/8/5P2/8/8/K7 b - - 0 1");
    chess.undoMove();
    assert.equal(chess.fen(), before, "undo puts everything back");
  });

  test("en passant blows up the pawn beside the blast as well", () => {
    const chess = atomic("k7/4b3/8/3pP3/8/8/8/K7 w - d6 0 1");
    play(chess, "e5d6");
    assert.equal(chess.fen(), "k7/8/8/8/8/8/8/K7 b - - 0 1");
  });

  test("the king may never capture", () => {
    const chess = atomic("k7/8/8/8/8/8/1p6/K7 w - - 0 1");
    assert.equal(chess.inCheck(), true);
    assert.deepEqual(chess.legalMoves().map(uci).sort(), ["a1a2", "a1b1"]);
  });

  test("kings may stand next to each other", () => {
    const chess = atomic("k7/1K6/8/8/8/8/8/8 w - - 0 1");
    assert.equal(chess.inCheck(), false);
    assert.deepEqual(
      chess.legalMoves().map(uci).sort(),
      ["b7a6", "b7a7", "b7b6", "b7b8", "b7c6", "b7c7", "b7c8"]
    );
  });

  test("a capture next to your own king is illegal", () => {
    const chess = atomic("7k/8/8/8/8/Q7/1n6/K7 w - - 0 1");
    assert.equal(moveOf(chess, "a3b2"), null);
    assert.ok(moveOf(chess, "a3a2"), "quiet queen moves are fine");
  });

  test("blowing up the enemy king wins on the spot", () => {
    const chess = atomic("6k1/7p/8/8/8/8/8/K6R w - - 0 1");
    play(chess, "h1h7");
    assert.equal(chess.kingMissing("b"), true);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1-0");
    assert.deepEqual(chess.legalMoves(), []);
    assert.equal(chess.isCheckmate(), true, "black, to move, has no king");
  });

  test("losing your own king loses", () => {
    const chess = atomic("r6k/8/8/8/8/8/P7/1K6 b - - 0 1");
    play(chess, "a8a2");
    assert.equal(chess.kingMissing("w"), true);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "0-1");
  });

  test("a rook that explodes takes its castling right with it", () => {
    const before = "r3k2r/6p1/8/8/8/8/1B6/R3K3 w Qkq - 0 1";
    const chess = atomic(before);
    play(chess, "b2g7");
    assert.equal(chess.fen(), "r3k3/8/8/8/8/8/8/R3K3 b Qq - 0 1");
    chess.undoMove();
    assert.equal(chess.fen(), before, "undo restores the right too");
  });

  test("a queen beside the king mates, because nothing may take it", () => {
    const fen = "k7/1Q6/8/8/8/8/8/1K6 b - - 0 1";
    assert.equal(atomic(fen).isCheckmate(), true);
    assert.equal(atomic(fen).result(), "1-0");
    assert.equal(fromFen(fen).isCheckmate(), false, "under standard rules the king just takes the queen");
  });

  test("castling out of check is illegal", () => {
    const chess = atomic("4r2k/8/8/8/8/8/8/4K2R w K - 0 1");
    assert.equal(chess.inCheck(), true);
    assert.equal(moveOf(chess, "e1g1"), null);
    assert.equal(moveOf(chess, "e1h1"), null, "nor spelled as king-takes-rook");
    // Rxh8 blows up the king, which answers the check by ending the game.
    assert.deepEqual(chess.legalMoves().map(uci).sort(), ["e1d1", "e1d2", "e1f1", "e1f2", "h1h8"]);
  });

  test("castling through an attacked square is illegal", () => {
    const chess = atomic("5r1k/8/8/8/8/8/8/4K2R w K - 0 1");
    assert.equal(chess.inCheck(), false);
    assert.equal(moveOf(chess, "e1g1"), null, "f1 is covered by the rook");
    assert.ok(moveOf(chess, "e1d1"), "the king may still step away");
    assert.ok(moveOf(atomic("7k/8/8/8/8/8/8/4K2R w K - 0 1"), "e1g1"), "with a clear path it castles");
  });

  test("castling is judged by the same connected-kings rule", () => {
    // Ra8 aims at e1, but Kd2 touches it: not check, so castling is on.
    const touching = atomic("4r3/8/8/8/8/8/3k4/4K2R w K - 0 1");
    assert.equal(touching.inCheck(), false);
    assert.ok(touching.legalMoves().some((m) => m.castle), "O-O is offered");
    // Castling onto a square beside the enemy king is as safe as stepping there.
    const beside = atomic("8/8/8/8/3b4/8/6k1/5K1R w K - 0 1");
    assert.ok(beside.legalMoves().some((m) => m.castle), "f1-g1 castling is offered although Bd4 covers g1");
  });

  test("connected kings are never in check", () => {
    // Ra8 aims at a1, but Kb2 touches it, so a1 cannot be taken.
    const chess = atomic("r7/8/8/8/8/8/1k5P/K7 w - - 0 1");
    assert.equal(chess.inCheck(), false);
    assert.deepEqual(chess.legalMoves().map(uci).sort(), ["a1a2", "a1b1", "h2h3", "h2h4"]);
    assert.equal(fromFen("r7/8/8/8/8/8/1k5P/K7 w - - 0 1").inCheck(), true, "under standard rules it is check");
  });

  test("a king may step next to the enemy king onto an attacked square, and there is no mate while they touch", () => {
    const chess = atomic("r7/8/8/8/8/8/1k6/K6r w - - 0 1");
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isGameOver(), false);
    assert.equal(chess.result(), "*");
    // a2 is covered by Ra8 and b1 by Rh1; both stay adjacent to Kb2, so both are safe.
    assert.deepEqual(chess.legalMoves().map(uci).sort(), ["a1a2", "a1b1"]);
  });

  test("make and undo stay consistent through a search with explosions", () => {
    const fen = "7k/8/3pqr2/4n3/5P2/8/1B6/K7 w - - 0 1";
    const chess = atomic(fen);
    assert.ok(perft(chess, 3) > 0);
    assert.equal(chess.fen(), fen);
  });
});
