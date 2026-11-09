"use strict";

// Antichess in src/shared/chess.js, by Lichess's rules: captures are
// compulsory, the king is an ordinary piece, pawns may promote to a king, there
// is no castling, and the side to move wins with no piece or no move left.
// The perft counts are Lichess's own (scalachess, test-kit antichess.perft).

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, ANTICHESS_START, STANDARD_START, algOf } = require("../../src/shared/chess");
const { perft } = require("../helpers/perft");
const { fromFen, sq, play } = require("../helpers/board");

const budget = process.env.PERFT_MAX_NODES;
const MAX_NODES = budget === "all" ? Infinity : Number(budget) || 1_000_000;

const anti = (fen = ANTICHESS_START) => fromFen(fen, "antichess");
const movesOf = (chess) => chess.legalMoves().map((m) => algOf(m.from) + algOf(m.to) + (m.promo || "")).sort();

describe("Antichess", () => {
  describe("perft (Lichess's counts)", () => {
    const positions = [
      ["the start", ANTICHESS_START, [20, 400, 8067, 153299]],
      ["a-pawn against b-pawn", "8/1p6/8/8/8/8/P7/8 w - - 0 1", [2, 4, 4, 3, 1, 0]],
      ["a-pawn against c-pawn", "8/2p5/8/8/8/8/P7/8 w - - 0 1",
        [2, 4, 4, 4, 4, 4, 4, 4, 12, 36, 312, 2557, 30873]],
    ];
    for (const [name, fen, counts] of positions) {
      counts.forEach((expected, i) => {
        const skip = expected > MAX_NODES && `${expected} leaves exceeds PERFT_MAX_NODES`;
        test(`${name}, depth ${i + 1} = ${expected}`, { skip }, () => {
          const chess = anti(fen);
          assert.equal(perft(chess, i + 1), expected);
          assert.equal(chess.fen(), anti(fen).fen(), "make and undo leave the position as it was");
        });
      });
    }
  });

  describe("the rules", () => {
    test("starts from the ordinary setup with no castling rights", () => {
      const chess = new Chess().setVariant("antichess");
      chess.reset();
      assert.equal(chess.isAntichess, true);
      assert.equal(chess.fen(), ANTICHESS_START);
      assert.equal(chess.legalMoves().length, 20);
    });

    test("never castles, whatever the FEN claims", () => {
      const chess = anti("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
      assert.equal(chess.fen(), "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1");
      assert.ok(!chess.legalMoves().some((m) => m.castle));
      assert.equal(chess.findMove(sq("e1"), sq("h1")), null);
    });

    test("allows any number of kings, none included", () => {
      assert.doesNotThrow(() => anti("8/8/8/8/8/8/P7/8 w - - 0 1"));
      assert.doesNotThrow(() => anti("k6k/8/8/8/8/8/8/KKK5 w - - 0 1"));
      assert.throws(() => fromFen("8/8/8/8/8/8/P7/8 w - - 0 1"), /exactly one king/, "standard chess still refuses");
    });

    test("a capture is compulsory, but you choose which", () => {
      const chess = play(anti(), "e2e4", "d7d5");
      assert.deepEqual(movesOf(chess), ["e4d5"]);
      play(chess, "e4d5", "d8d5");
      // White's queen can't take, nothing else can: a free choice of quiet moves.
      assert.ok(chess.legalMoves().length > 1);
      const two = anti("8/8/8/2p1p3/3B4/8/8/8 w - - 0 1");
      assert.deepEqual(movesOf(two), ["d4c5", "d4e5"]);
    });

    test("en passant counts as a capture, and so is forced", () => {
      const chess = anti("8/8/8/3pP3/8/8/8/8 w - d6 0 1");
      assert.deepEqual(movesOf(chess), ["e5d6"]);
    });

    test("the king is a piece like any other: no check, and it can be taken", () => {
      const chess = anti("4k3/8/8/8/8/8/8/4R3 w - - 0 1");
      assert.equal(chess.inCheck("b"), false, "a rook on its file is no check");
      assert.equal(chess.moveToSan(chess.findMove(sq("e1"), sq("e8"))), "Rxe8");
      play(chess, "e1e8");
      assert.equal(chess.squares[sq("e8")].t, "r");
      const step = anti("8/8/8/8/8/8/3r4/4K3 w - - 0 1");
      assert.deepEqual(movesOf(step), ["e1d2"], "and must take when it can");
      assert.equal(anti("8/8/8/8/8/8/8/r3K3 w - - 0 1").legalMoves().length, 5, "and may stand where it is attacked");
    });

    test("a pawn may promote to a king, written e8=K", () => {
      const chess = anti("8/4P3/8/8/8/8/8/8 w - - 0 1");
      assert.deepEqual(movesOf(chess), ["e7e8b", "e7e8k", "e7e8n", "e7e8q", "e7e8r"]);
      const king = chess.findMove(sq("e7"), sq("e8"), "k");
      assert.equal(chess.moveToSan(king), "e8=K");
      chess.makeMove(king);
      assert.deepEqual(chess.squares[sq("e8")], { t: "k", c: "w" });
      chess.undoMove();
      assert.deepEqual(chess.squares[sq("e7")], { t: "p", c: "w" });
      assert.equal(fromFen("4k3/4P3/8/8/8/8/8/4K3 w - - 0 1").findMove(sq("e7"), sq("e8"), "k"), null,
        "not in standard chess");
    });

    test("SAN never marks check or mate", () => {
      const chess = anti("k7/8/8/8/8/8/8/1R6 w - - 0 1");
      assert.equal(chess.moveToSan(chess.findMove(sq("b1"), sq("a1"))), "Ra1");
    });
  });

  describe("the end", () => {
    test("losing every piece wins, for either side", () => {
      const white = play(anti("8/8/8/8/8/8/1p6/R7 b - - 0 1"), "b2a1q");
      assert.equal(white.pieceCount("w"), 0);
      assert.equal(white.isGameOver(), true);
      assert.equal(white.result(), "1-0");
      const black = play(anti("r7/1P6/8/8/8/8/8/8 w - - 0 1"), "b7a8q");
      assert.equal(black.pieceCount("b"), 0);
      assert.equal(black.result(), "0-1");
    });

    test("having no legal move wins too, and is neither stalemate nor mate", () => {
      const chess = anti("8/8/8/p7/P7/8/8/8 w - - 0 1");
      assert.equal(chess.legalMoves().length, 0);
      assert.equal(chess.isStalemate(), false);
      assert.equal(chess.isCheckmate(), false);
      assert.equal(chess.isGameOver(), true);
      assert.equal(chess.result(), "1-0");
      assert.equal(anti("8/8/8/p7/P7/8/8/8 b - - 0 1").result(), "0-1");
    });

    test("a game in progress is undecided", () => {
      assert.equal(anti().result(), "*");
      assert.equal(anti().isGameOver(), false);
    });

    test("the 50-move rule and threefold repetition still draw", () => {
      const fifty = anti("8/8/8/8/8/8/1N6/6n1 w - - 100 80");
      assert.equal(fifty.isGameOver(), true);
      assert.equal(fifty.result(), "1/2-1/2");
      const shuffle = anti("n7/8/8/8/8/8/8/7N w - - 0 1");
      for (let i = 0; i < 2; i++) play(shuffle, "h1g3", "a8b6", "g3h1", "b6a8");
      assert.equal(shuffle.isThreefoldRepetition(), true);
      assert.equal(shuffle.result(), "1/2-1/2");
    });

    test("having no move beats a draw rule that holds at the same time", () => {
      const chess = anti("8/8/8/p7/P7/8/8/8 w - - 100 80");
      assert.equal(chess.result(), "1-0");
    });

    test("only bishops, each side on its own colour, can never capture: a draw", () => {
      const dead = anti("8/8/8/8/4b3/8/8/B7 w - - 0 1");     // e4 light, a1 dark
      assert.equal(dead.isInsufficientMaterial(), true);
      assert.equal(dead.isGameOver(), true);
      assert.equal(dead.result(), "1/2-1/2");
      assert.equal(dead.hasMatingMaterial("w"), false, "so a flag draws");
      for (const [fen, why] of [
        ["8/8/8/8/3b4/8/8/B7 w - - 0 1", "same colour (d4, a1): they can meet"],
        ["8/8/8/8/4b3/8/B7/B7 w - - 0 1", "White has a bishop on each colour"],
        ["8/8/8/8/4b3/8/P7/B7 w - - 0 1", "a pawn is left (Lichess sometimes calls this dead; not here)"],
        ["8/8/8/8/4n3/8/8/B7 w - - 0 1", "a knight is left"],
      ]) {
        const chess = anti(fen);
        assert.equal(chess.isInsufficientMaterial(), false, why);
        assert.equal(chess.hasMatingMaterial("w"), true, why);
      }
    });

    test("standard chess is untouched: the standard start is not Antichess's", () => {
      assert.notEqual(ANTICHESS_START, STANDARD_START);
      assert.equal(new Chess().inCheck(), false);
      assert.equal(fromFen("4k3/8/8/8/8/8/8/4R1K1 b - - 0 1").inCheck(), true);
    });
  });
});
