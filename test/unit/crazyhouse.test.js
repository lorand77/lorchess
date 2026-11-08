"use strict";

// Crazyhouse in src/shared/chess.js: the pockets that captures fill, the
// promoted pieces that go back to a pocket as pawns, how both are written in
// FEN and counted for repetition, dropping pieces back on the board, and when
// the material is too thin for anyone to mate.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, STANDARD_START, algOf } = require("../../src/shared/chess");
const { moveFromUci } = require("../../src/shared/uci");
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
    assert.equal(chess.legalMoves().length, 20, "nothing in hand, nothing to drop");
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

  describe("drops", () => {
    const drops = (chess) => chess.legalMoves().filter((m) => m.drop);
    const dropSquares = (chess, type) =>
      drops(chess).filter((m) => m.drop === type).map((m) => algOf(m.to)).sort();

    test("a piece in hand can go on any empty square", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[N] w - - 0 1", "crazyhouse");
      assert.equal(dropSquares(chess, "n").length, 62);
      assert.deepEqual(drops(chess)[0], { from: null, to: 0, drop: "n" });
    });

    test("a pawn never on the first or last rank", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[P] w - - 0 1", "crazyhouse");
      const squares = dropSquares(chess, "p");
      assert.equal(squares.length, 48);
      assert.ok(squares.every((a) => a[1] !== "1" && a[1] !== "8"), squares.join());
    });

    test("only from the side to move's own pocket, one entry per piece type", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[NNq] w - - 0 1", "crazyhouse");
      assert.deepEqual([...new Set(drops(chess).map((m) => m.drop))], ["n"]);
      assert.equal(drops(chess).length, 62);
      play(chess, "e1d1");
      assert.deepEqual([...new Set(drops(chess).map((m) => m.drop))], ["q"]);
    });

    test("in check, only a drop that blocks it", () => {
      const rook = fromFen("k3r3/8/8/8/8/8/8/4K3[N] w - - 0 1", "crazyhouse");
      assert.deepEqual(dropSquares(rook, "n"), ["e2", "e3", "e4", "e5", "e6", "e7"]);
      const knight = fromFen("k7/8/8/8/8/3n4/8/4K3[Q] w - - 0 1", "crazyhouse");
      assert.deepEqual(drops(knight), [], "a knight's check cannot be blocked");
    });

    test("take the piece from the pocket and put it back on undo", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[NNp] w - - 7 30", "crazyhouse");
      play(chess, "N@e4");
      assert.deepEqual(chess.squares[sq("e4")], { t: "n", c: "w" });
      assert.equal(chess.fen(), "4k3/8/8/8/4N3/8/8/4K3[Np] b - - 8 30");
      play(chess, "P@d5");
      assert.equal(chess.fen(), "4k3/8/8/3p4/4N3/8/8/4K3[N] w - - 0 31", "a pawn drop resets the 50-move count");
      chess.undoMove();
      chess.undoMove();
      assert.equal(chess.fen(), "4k3/8/8/8/8/8/8/4K3[NNp] w - - 7 30");
    });

    test("a dropped piece is an ordinary one: captured, it goes back as itself", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/r3K3[N] w - - 0 1", "crazyhouse");
      play(chess, "N@d1", "a1d1");
      assert.equal(pocketOf(chess), "n");
    });

    test("can give check and mate, and are written in SAN as piece @ square", () => {
      const chess = fromFen("6rk/6pp/8/8/8/8/8/4K3[NP] w - - 0 1", "crazyhouse");
      assert.equal(chess.moveToSan(moveFromUci(chess, "P@e4")), "P@e4");
      assert.equal(chess.moveToSan(moveFromUci(chess, "N@g6")), "N@g6+");
      const mate = moveFromUci(chess, "N@f7");
      assert.equal(chess.moveToSan(mate), "N@f7#");
      chess.makeMove(mate);
      assert.equal(chess.isCheckmate(), true);
      assert.equal(chess.result(), "1-0");
    });

    test("a drop that blocks check is what saves a position from mate", () => {
      // A back-rank check: mate with nothing in hand, but a knight can block.
      const board = "6k1/8/8/8/8/8/5PPP/r5K1";
      assert.equal(fromFen(board + "[] w - - 0 1", "crazyhouse").isCheckmate(), true);
      const chess = fromFen(board + "[N] w - - 0 1", "crazyhouse");
      assert.equal(chess.isCheckmate(), false);
      assert.deepEqual(chess.legalMoves().map((m) => chess.moveToSan(m)), ["N@b1", "N@c1", "N@d1", "N@e1", "N@f1"]);
    });

    test("findDrop needs a piece type", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[N] w - - 0 1", "crazyhouse");
      assert.equal(chess.findDrop(undefined, sq("e2")), null);
      assert.equal(chess.findDrop("n", sq("e2")).drop, "n");
      assert.equal(chess.findDrop("b", sq("e2")), null);
      assert.equal(chess.findMove(null, sq("e2"), null), null, "findMove never answers with a drop");
    });

    test("a short game: capture, then drop the piece back", () => {
      const chess = crazyhouse();
      play(chess, "e2e4", "d7d5", "e4d5", "d8d5", "P@e4", "d5e4");
      assert.equal(chess.fen(), "rnb1kbnr/ppp1pppp/8/8/4q3/8/PPPP1PPP/RNBQKBNR[pp] w KQkq - 0 4");
      assert.equal(chess.inCheck(), true);
    });
  });

  describe("material", () => {
    const dead = (fen) => fromFen(fen, "crazyhouse").isInsufficientMaterial();

    test("only bare kings, or one minor piece between both sides, are dead", () => {
      assert.equal(dead("4k3/8/8/8/8/8/8/4K3[] w - - 0 1"), true);
      assert.equal(dead("4k3/8/8/8/8/8/8/4K3[n] w - - 0 1"), true);
      assert.equal(dead("4k3/8/8/8/8/8/8/2B1K3[] w - - 0 1"), true);
      assert.equal(dead("4k3/8/8/8/8/8/8/4K3[P] w - - 0 1"), false);
      assert.equal(dead("4k3/8/8/8/8/8/8/4K3[NN] w - - 0 1"), false);
      assert.equal(dead("4k3/8/8/8/8/8/8/2B1K3[n] w - - 0 1"), false);
      assert.equal(dead("4k3/8/8/8/8/8/8/1N~2K3[] w - - 0 1"), false, "a promoted knight goes back as a pawn");
      assert.equal(crazyhouse().isInsufficientMaterial(), false);
    });

    test("bare kings end the game drawn", () => {
      const chess = fromFen("4k3/8/8/8/8/8/8/4K3[] w - - 0 1", "crazyhouse");
      assert.equal(chess.isGameOver(), true);
      assert.equal(chess.result(), "1/2-1/2");
    });

    test("a bare king can still mate with what it captures, so flagging loses", () => {
      const fen = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
      assert.equal(fromFen(fen).hasMatingMaterial("b"), false, "in standard chess Black cannot");
      assert.equal(fromFen(fen, "crazyhouse").hasMatingMaterial("b"), true);
      assert.equal(fromFen("4k3/8/8/8/8/8/8/4K3[] w - - 0 1", "crazyhouse").hasMatingMaterial("w"), false);
    });
  });
});
