"use strict";

// Three-check in src/shared/chess.js, by Lichess's rules: ordinary chess, and
// giving check a third time wins. Mate still wins (and names the ending when
// the third check mates), the usual draws apply, and only bare kings are dead
// material. The checks are part of the position: counted on every move, taken
// back with it, compared for repetition, and written in FEN as the checks each
// side has left to give, "3+3", after the en passant square.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, STANDARD_START } = require("../../src/shared/chess");
const { perft } = require("../helpers/perft");
const { fromFen, play } = require("../helpers/board");

const three = (fen = STANDARD_START) => fromFen(fen, "threecheck");
// Bc4xf7+, Qh5+ and Qxg6+: three checks in five moves.
const HAT_TRICK = ["e2e4", "e7e5", "f1c4", "a7a6", "c4f7", "e8f7", "d1h5", "g7g6", "h5g6"];

describe("Three-check", () => {
  test("moves as in standard chess: the checks change no move", () => {
    for (let depth = 1; depth <= 3; depth++) {
      assert.equal(perft(three(), depth), perft(fromFen(STANDARD_START), depth), `depth ${depth}`);
    }
  });

  test("counts every check, and the third wins", () => {
    const chess = three();
    play(chess, ...HAT_TRICK.slice(0, 6));
    assert.deepEqual(chess.checks, { w: 1, b: 0 });
    play(chess, "d1h5", "g7g6");
    assert.deepEqual(chess.checks, { w: 2, b: 0 });
    assert.equal(chess.isGameOver(), false);
    const last = chess.findMove(39, 46);   // h5xg6
    assert.equal(chess.moveToSan(last), "Qxg6+", "a check, not a mate: the game is won another way");
    chess.makeMove(last);
    assert.deepEqual(chess.checks, { w: 3, b: 0 });
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1-0");
    assert.equal(chess.termination(), "three checks");
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isStalemate(), false);
    assert.deepEqual(chess.legalMoves(), [], "nothing more to play");
  });

  test("a third check that mates is a mate", () => {
    // White has given two checks; Qd8 is mate, and the third.
    const chess = three("6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 1+3 0 30");
    const mate = chess.findMove(3, 59);   // Qd1-d8
    assert.equal(chess.moveToSan(mate), "Qd8#");
    chess.makeMove(mate);
    assert.equal(chess.termination(), "checkmate");
    assert.equal(chess.result(), "1-0");
  });

  test("taking a move back takes its check back", () => {
    const chess = three();
    play(chess, ...HAT_TRICK);
    chess.undoMove();
    assert.deepEqual(chess.checks, { w: 2, b: 0 });
    assert.equal(chess.isGameOver(), false);
    assert.ok(chess.legalMoves().length > 0);
  });

  test("FEN writes the checks left to give, and reads them back", () => {
    const chess = three();
    assert.equal(chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1");
    play(chess, ...HAT_TRICK.slice(0, 8));
    assert.equal(chess.fen(), "rnbq1bnr/1ppp1k1p/p5p1/4p2Q/4P3/8/PPPP1PPP/RNB1K1NR w KQ - 1+3 0 5");
    const again = three(chess.fen());
    assert.deepEqual(again.checks, { w: 2, b: 0 });
    assert.equal(again.halfmove, 0);
    assert.equal(again.fullmove, 5);
    assert.deepEqual(three(STANDARD_START).checks, { w: 0, b: 0 }, "no field: none given yet");
    assert.throws(() => three("4k3/8/8/8/8/8/8/4K2R w - - 4+3 0 1"), /bad check count/);
    assert.equal(three("4k3/8/8/8/8/8/8/4K2R b - - 0+2 0 1").result(), "1-0", "a position already won");
    assert.equal(fromFen(STANDARD_START).fen(), STANDARD_START, "other variants write no such field");
  });

  test("the checks given are part of the position, for repetition", () => {
    const a = three("4k3/8/8/8/8/8/8/R3K3 w - - 3+3 0 1");
    const b = three("4k3/8/8/8/8/8/8/R3K3 w - - 2+3 0 1");
    assert.notEqual(a.positionKey(), b.positionKey());
  });

  test("only bare kings are dead: any other piece can give check", () => {
    assert.equal(three("4k3/8/8/8/8/8/8/4K3 w - - 3+3 0 1").isInsufficientMaterial(), true);
    const knight = three("4k3/8/8/8/8/8/8/4KN2 w - - 3+3 0 1");
    assert.equal(knight.isInsufficientMaterial(), false, "a lone knight can't mate, but it can check");
    assert.equal(fromFen("4k3/8/8/8/8/8/8/4KN2 w - - 0 1").isInsufficientMaterial(), true, "unlike standard chess");
    assert.equal(knight.hasMatingMaterial("w"), true);
    assert.equal(knight.hasMatingMaterial("b"), false, "a bare king can't win on a flag");
  });

  test("mate and the usual draws still end it", () => {
    assert.equal(three("4R1k1/5ppp/8/8/8/8/8/K7 b - - 3+3 0 1").termination(), "checkmate");
    assert.equal(three("7k/5Q2/6K1/8/8/8/8/8 b - - 3+3 0 1").termination(), "stalemate");
    assert.equal(new Chess().setVariant("threecheck").variant, "threecheck");
  });
});
