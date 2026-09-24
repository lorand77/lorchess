"use strict";

// Standard Algebraic Notation output (moveToSan) in src/shared/chess.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { fromFen, sq, sanOf, play, playSan } = require("../helpers/board");

describe("SAN", () => {
  test("pawn pushes, piece moves and captures", () => {
    const chess = new Chess();
    assert.deepEqual(
      playSan(chess, "e2e4", "d7d5", "e4d5", "g8f6", "b1c3", "f6d5", "c3d5"),
      ["e4", "d5", "exd5", "Nf6", "Nc3", "Nxd5", "Nxd5"]
    );
  });

  test("en passant is written as a plain pawn capture", () => {
    const chess = play(new Chess(), "e2e4", "a7a6", "e4e5", "d7d5");
    assert.equal(sanOf(chess, "e5d6"), "exd6");
  });

  test("promotion and capture-promotion, with and without check", () => {
    const chess = fromFen("3r3k/4P3/8/8/8/8/8/K7 w - - 0 1");
    assert.equal(sanOf(chess, "e7e8q"), "e8=Q+");
    assert.equal(sanOf(chess, "e7e8n"), "e8=N");
    assert.equal(sanOf(chess, "e7d8r"), "exd8=R+");
    assert.equal(sanOf(chess, "e7d8b"), "exd8=B");
  });

  test("castling, including castling with check", () => {
    const chess = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    assert.equal(sanOf(chess, "e1g1"), "O-O");
    assert.equal(sanOf(chess, "e1c1"), "O-O-O");
    assert.equal(sanOf(chess, "e1h1"), "O-O", "king-to-rook encoding");
    assert.equal(sanOf(chess, "e1a1"), "O-O-O", "king-to-rook encoding");
    assert.equal(sanOf(fromFen("5k2/8/8/8/8/8/8/4K2R w K - 0 1"), "e1g1"), "O-O+");
  });

  describe("disambiguation", () => {
    test("by file when the pieces stand on different files", () => {
      const chess = fromFen("k7/8/8/8/8/2N3N1/8/K7 w - - 0 1");
      assert.equal(sanOf(chess, "c3e4"), "Nce4");
      assert.equal(sanOf(chess, "g3e4"), "Nge4");
    });

    test("by rank when the pieces share a file", () => {
      const chess = fromFen("k7/8/3N4/8/8/8/3N4/K7 w - - 0 1");
      assert.equal(sanOf(chess, "d2e4"), "N2e4");
      assert.equal(sanOf(chess, "d6e4"), "N6e4");
    });

    test("by full square when both file and rank are shared", () => {
      const chess = fromFen("6k1/8/8/8/8/2Q5/8/Q1Q4K w - - 0 1");
      assert.equal(sanOf(chess, "c1a3"), "Qc1a3");
      assert.equal(sanOf(chess, "a1a3"), "Qaa3");
      assert.equal(sanOf(chess, "c3a3"), "Q3a3");
    });

    test("is not needed when the other piece is pinned", () => {
      const chess = fromFen("k7/8/8/b7/8/2N3N1/8/4K3 w - - 0 1");
      assert.equal(chess.findMove(sq("c3"), sq("e4")), null, "the c3 knight is pinned");
      assert.equal(sanOf(chess, "g3e4"), "Ne4");
    });

    test("pawn captures carry the file only", () => {
      const chess = fromFen("k7/8/8/4p3/3P1P2/8/8/K7 w - - 0 1");
      assert.equal(sanOf(chess, "d4e5"), "dxe5");
      assert.equal(sanOf(chess, "f4e5"), "fxe5");
    });
  });

  test("check and checkmate suffixes", () => {
    assert.equal(sanOf(fromFen("k7/8/8/8/8/8/8/K6R w - - 0 1"), "h1h8"), "Rh8+");
    assert.equal(sanOf(fromFen("k7/8/1K6/8/8/8/8/7R w - - 0 1"), "h1h8"), "Rh8#");
  });

  test("a full game: the Caro-Kann smothered knight mate", () => {
    const chess = new Chess();
    const sans = playSan(chess,
      "e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "b8d7", "d1e2", "g8f6", "e4d6"
    );
    assert.deepEqual(sans, [
      "e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Nd7", "Qe2", "Ngf6", "Nd6#",
    ]);
    assert.equal(chess.isCheckmate(), true);
  });
});
