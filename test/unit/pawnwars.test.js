"use strict";

// Pawn Wars in src/shared/chess.js: pawns only, no kings, no check; capture
// every enemy pawn to win.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, PAWN_WARS_START } = require("../../src/shared/chess");
const { START_FEN, fromFen, sq, uci, moveOf, play } = require("../helpers/board");

const pawnWars = (fen) => fromFen(fen, "pawnwars");

describe("Pawn Wars", () => {
  test("starts with eight pawns a side on the outer ranks and no castling", () => {
    assert.equal(PAWN_WARS_START, "pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1");
    const chess = new Chess().setVariant("pawnwars");
    chess.reset();
    assert.equal(chess.fen(), PAWN_WARS_START);
    assert.equal(pawnWars(PAWN_WARS_START).fen(), PAWN_WARS_START);
    assert.equal(chess.pawnCount("w"), 8);
    assert.equal(chess.pawnCount("b"), 8);
    assert.equal(chess.isGameOver(), false);
    assert.equal(chess.result(), "*");
  });

  test("a position with kings is rejected", () => {
    assert.throws(() => pawnWars(START_FEN), /no kings/);
  });

  test("pawns get their double step from the first rank", () => {
    const chess = pawnWars(PAWN_WARS_START);
    assert.equal(chess.legalMoves().length, 16);
    play(chess, "a1a3");
    assert.equal(chess.fen(), "pppppppp/8/8/8/8/P7/8/1PPPPPPP b - a2 0 1");
    play(chess, "h8h6");
    assert.equal(chess.fen(), "ppppppp1/8/7p/8/8/P7/8/1PPPPPPP w - h7 0 2");
  });

  test("en passant works from the shifted start ranks", () => {
    const chess = pawnWars("pppppppp/8/P7/8/8/8/8/1PPPPPPP b - - 0 1");
    play(chess, "b8b6");
    assert.equal(moveOf(chess, "a6b7").enpassant, true);
    play(chess, "a6b7");
    assert.equal(chess.fen(), "p1pppppp/1P6/8/8/8/8/8/1PPPPPPP b - - 0 2");
  });

  test("promotion happens on the far rank and the new piece moves like its kind", () => {
    const chess = pawnWars("pppppppp/P7/8/8/8/8/8/1PPPPPPP w - - 0 1");
    const promos = chess.legalMoves().filter((m) => m.from === sq("a7")).map(uci).sort();
    assert.deepEqual(promos, ["a7b8b", "a7b8n", "a7b8q", "a7b8r"]);
    play(chess, "a7b8q", "c8c6");
    assert.equal(chess.fen(), "pQ1ppppp/8/2p5/8/8/8/8/1PPPPPPP w - c7 0 2");
    assert.equal(moveOf(chess, "b8a8").capture, true, "the queen captures along the rank");
    assert.ok(moveOf(chess, "b8b5"), "and slides down the file");
  });

  test("taking the last enemy pawn wins", () => {
    const chess = pawnWars("8/8/8/8/8/2p5/1P6/8 w - - 0 1");
    play(chess, "b2c3");
    assert.equal(chess.pawnCount("b"), 0);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1-0");
    assert.deepEqual(chess.legalMoves(), []);
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isStalemate(), false);
  });

  test("promoting your last pawn loses", () => {
    const chess = pawnWars("pppppppp/P7/8/8/8/8/8/8 w - - 0 1");
    play(chess, "a7b8q");
    assert.equal(chess.pawnCount("w"), 0);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "0-1");
  });

  test("clearing both sides at once is a draw", () => {
    const chess = pawnWars("1p6/P7/8/8/8/8/8/8 w - - 0 1");
    play(chess, "a7b8q");
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1/2-1/2");
  });

  test("no legal moves with pawns still on the board is a draw", () => {
    const chess = pawnWars("8/8/8/p7/P7/8/8/8 w - - 0 1");
    assert.deepEqual(chess.legalMoves(), []);
    assert.equal(chess.isStalemate(), true);
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1/2-1/2");
  });

  test("there is no check and no insufficient material", () => {
    const chess = pawnWars("qp6/8/8/8/8/8/8/PQ6 w - - 0 1");
    assert.equal(chess.inCheck(), false);
    assert.equal(chess.isCheckmate(), false);
    assert.ok(chess.legalMoves().length > 0);
    const bare = pawnWars("p7/8/8/8/8/8/8/P7 w - - 0 1");
    assert.equal(bare.isInsufficientMaterial(), false);
    assert.equal(bare.isGameOver(), false);
  });
});
