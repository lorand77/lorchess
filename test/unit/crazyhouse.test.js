"use strict";

// Crazyhouse position state in src/shared/chess.js: the pockets that captures
// fill, the promoted pieces that go back to a pocket as pawns, and how both
// are written in FEN and counted for repetition. (Drops come later.)

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, STANDARD_START } = require("../../src/shared/chess");
const { fromFen, sq, play } = require("../helpers/board");

const crazyhouse = () => {
  const chess = new Chess().setVariant("crazyhouse");
  chess.reset();
  return chess;
};
const pocketOf = (chess) => chess.pocketText();

describe("crazyhouse position state", () => {
  test("starts from the standard setup with empty pockets", () => {
    const chess = crazyhouse();
    assert.equal(chess.isCrazyhouse, true);
    assert.equal(chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1");
    assert.equal(chess.legalMoves().length, 20, "no drops yet, nothing to drop anyway");
  });

  test("the standard start FEN opens it too, with empty pockets", () => {
    const chess = fromFen(STANDARD_START, "crazyhouse");
    assert.equal(pocketOf(chess), "");
    assert.equal(chess.fen(), crazyhouse().fen());
  });

  test("other variants keep their FEN and refuse a pocket", () => {
    assert.equal(new Chess().fen(), STANDARD_START);
    assert.equal(new Chess().pocketText(), "");
    for (const variant of ["standard", "atomic"]) {
      assert.throws(() => fromFen("4k3/8/8/8/8/8/8/4K3[Q] w - - 0 1", variant), /bad piece char "\["/);
      assert.throws(() => fromFen("4k3/8/8/8/8/8/8/Q~3K3 w - - 0 1", variant), /bad piece char "~"/);
    }
  });

  describe("FEN", () => {
    test("reads and writes pockets and promoted pieces", () => {
      for (const fen of [
        "4k3/8/8/8/8/8/8/4K3[] w - - 0 1",
        "4k3/8/8/8/8/8/8/Q~3K3[QRBNPqrbnp] b - - 0 1",
        "r~3k2r/8/8/8/8/8/8/R3K1N~R[PPPnn] w KQkq - 3 20",
      ]) {
        assert.equal(fromFen(fen, "crazyhouse").fen(), fen);
      }
    });

    test("counts the pocket and colours it by case, whatever the order", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[pQpNq] w - - 0 1", "crazyhouse");
      assert.deepEqual(chess.pockets, {
        w: { q: 1, r: 0, b: 0, n: 1, p: 0 },
        b: { q: 1, r: 0, b: 0, n: 0, p: 2 },
      });
      assert.equal(pocketOf(chess), "QNqpp");
    });

    test("marks the promoted piece, and only it", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/Q~2QK3[] w - - 0 1", "crazyhouse");
      assert.equal(chess.squares[sq("a1")].promoted, true);
      assert.equal(chess.squares[sq("d1")].promoted, undefined);
    });

    const rejected = [
      ["a king in the pocket", "4k3/8/8/8/8/8/8/4K3[K] w - - 0 1", /bad pocket piece "K"/],
      ["an unknown pocket piece", "4k3/8/8/8/8/8/8/4K3[x] w - - 0 1", /bad pocket piece "x"/],
      ["an unclosed pocket", "4k3/8/8/8/8/8/8/4K3[Q w - - 0 1", /one \[\.\.\.\]/],
      ["two pockets", "4k3/8/8/8/8/8/8/4K3[][] w - - 0 1", /one \[\.\.\.\]/],
      ["a pocket inside the board", "4k3/8/8/8[Q]/8/8/8/4K3 w - - 0 1", /one \[\.\.\.\]/],
      ["a promoted pawn", "4k3/8/8/8/8/8/8/P~3K3 w - - 0 1", /"~" must follow/],
      ["a promoted king", "4k3/8/8/8/8/8/8/4K~3 w - - 0 1", /"~" must follow/],
      ["a mark with no piece", "4k3/8/8/8/8/8/8/~4K3 w - - 0 1", /"~" must follow/],
      ["a mark after a gap", "4k3/8/8/8/8/8/8/Q3~K3 w - - 0 1", /"~" must follow/],
      ["a doubled mark", "4k3/8/8/8/8/8/8/Q~~3K3 w - - 0 1", /"~" must follow/],
    ];
    for (const [name, fen, message] of rejected) {
      test(`rejects ${name}`, () => {
        const chess = crazyhouse();
        const before = chess.fen();
        assert.throws(() => chess.loadFen(fen), message);
        assert.equal(chess.fen(), before, "a refused FEN leaves the position alone");
      });
    }
  });

  describe("captures", () => {
    test("go into the capturer's pocket, and undo takes them out", () => {
      const chess = crazyhouse();
      play(chess, "e2e4", "d7d5", "e4d5");
      assert.equal(pocketOf(chess), "P");
      play(chess, "d8d5");
      assert.equal(pocketOf(chess), "Pp");
      assert.equal(chess.fen(), "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR[Pp] w KQkq - 0 3");
      chess.undoMove();
      assert.equal(pocketOf(chess), "P");
      chess.undoMove();
      assert.equal(pocketOf(chess), "");
    });

    test("pocket the piece's own type", () => {
      const chess = fromFen("4k3/8/8/3q1r2/8/8/8/3QK3[] w - - 0 1", "crazyhouse");
      play(chess, "d1d5");
      assert.equal(pocketOf(chess), "Q");
      play(chess, "f5d5");
      assert.equal(pocketOf(chess), "Qq");
    });

    test("en passant pockets the pawn; castling pockets nothing", () => {
      const ep = fromFen("4k3/8/8/3pP3/8/8/8/4K3[] w - d6 0 1", "crazyhouse");
      play(ep, "e5d6");
      assert.equal(pocketOf(ep), "P");
      const castle = fromFen("4k3/8/8/8/8/8/8/R3K2R[] w KQ - 0 1", "crazyhouse");
      play(castle, "e1h1");
      assert.equal(pocketOf(castle), "");
    });

    test("a promotion is marked, keeps its mark as it moves, and loses it on undo", () => {
      const chess = fromFen("6k1/1P6/8/8/8/8/8/4K3[] w - - 0 1", "crazyhouse");
      play(chess, "b7b8q");
      assert.equal(chess.squares[sq("b8")].promoted, true);
      assert.equal(chess.fen(), "1Q~4k1/8/8/8/8/8/8/4K3[] b - - 0 1");
      play(chess, "g8g7", "b8b2");
      assert.equal(chess.squares[sq("b2")].promoted, true);
      chess.undoMove();
      chess.undoMove();
      chess.undoMove();
      assert.deepEqual(chess.squares[sq("b7")], { t: "p", c: "w" });
    });

    test("a promoted piece goes back to the pocket as a pawn", () => {
      const chess = fromFen("4k3/8/8/3Q~1r2/8/8/8/4K3[] b - - 0 1", "crazyhouse");
      play(chess, "f5d5");
      assert.equal(pocketOf(chess), "p");
      chess.undoMove();
      assert.equal(chess.squares[sq("d5")].promoted, true, "and comes back marked on undo");
      assert.equal(pocketOf(chess), "");
    });

    test("standard chess pockets nothing", () => {
      const chess = play(new Chess(), "e2e4", "d7d5", "e4d5");
      assert.equal(chess.pockets, null);
      assert.equal(chess.fen().split(" ")[0], "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR");
    });
  });

  describe("repetition", () => {
    test("the pockets and promoted pieces are part of the position", () => {
      const key = (fen) => fromFen(fen, "crazyhouse").positionKey();
      const bare = "4k3/8/8/8/8/8/8/Q3K3[] w - - 0 1";
      assert.notEqual(key(bare), key("4k3/8/8/8/8/8/8/Q3K3[N] w - - 0 1"));
      assert.notEqual(key("4k3/8/8/8/8/8/8/Q3K3[N] w - - 0 1"), key("4k3/8/8/8/8/8/8/Q3K3[n] w - - 0 1"));
      assert.notEqual(key(bare), key("4k3/8/8/8/8/8/8/Q~3K3[] w - - 0 1"));
      assert.equal(key(bare), key("4k3/8/8/8/8/8/8/Q3K3 w - - 0 1"));
    });

    test("a standard position's key is as it was", () => {
      const board = "RNBQKBNR" + "PPPPPPPP" + ".".repeat(32) + "pppppppp" + "rnbqkbnr";
      assert.equal(new Chess().positionKey(), board + "|w|KQkq|-");
    });

    test("threefold repetition still counts from the start position", () => {
      const chess = crazyhouse();
      for (let i = 0; i < 2; i++) play(chess, "g1f3", "g8f6", "f3g1", "f6g8");
      assert.equal(chess.isThreefoldRepetition(), true);
    });
  });
});
