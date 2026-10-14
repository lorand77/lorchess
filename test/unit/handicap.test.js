"use strict";

// Handicap positions in src/shared/handicap.js: validating a change map from
// the client, building the FEN, describing it, and recovering the map.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const handicap = require("../../src/shared/handicap");
const { START_FEN, fromFen, sq, play } = require("../helpers/board");

const {
  START_PIECES, WHITE_KING_SQ, BLACK_KING_SQ,
  isStartSquare, isKingSquare, isEditable, isWhiteSquare, isBackRank,
  algOfSq, isWhitePiece, pieceFor, validateSquares, buildFen, diffFromFen,
} = handicap;

// A representative set of change maps, keyed by square index.
const SAMPLES = [
  {},
  { [sq("d1")]: null },
  { [sq("a1")]: null, [sq("h8")]: null },
  { [sq("b1")]: "r", [sq("g8")]: "q" },
  { [sq("a1")]: null, [sq("h1")]: null, [sq("a8")]: null, [sq("h8")]: null },
  { [sq("d1")]: "n", [sq("c8")]: null, [sq("f7")]: null },
  { [sq("d1")]: null, [sq("d3")]: "q", [sq("c4")]: "p", [sq("f6")]: "n", [sq("h5")]: "r" },
];

describe("handicap", () => {
  describe("square helpers", () => {
    test("the starting squares hold the standard 32 pieces", () => {
      assert.equal(START_PIECES.filter(Boolean).length, 32);
      assert.equal(START_PIECES[sq("e1")], "K");
      assert.equal(START_PIECES[sq("e8")], "k");
      assert.equal(START_PIECES[sq("a1")], "R");
      assert.equal(START_PIECES[sq("h7")], "p");
      assert.equal(START_PIECES[sq("e4")], null);
      assert.equal(WHITE_KING_SQ, sq("e1"));
      assert.equal(BLACK_KING_SQ, sq("e8"));
    });

    test("classifying squares", () => {
      assert.equal(isStartSquare(sq("a2")), true);
      assert.equal(isStartSquare(sq("a3")), false);
      assert.equal(isKingSquare(sq("e1")), true);
      assert.equal(isKingSquare(sq("d1")), false);
      assert.equal(isEditable(sq("a1")), true);
      assert.equal(isEditable(sq("e1")), false);
      assert.equal(isEditable(sq("e4")), true);
      assert.equal(isEditable(sq("e5")), true);
      assert.equal(isWhiteSquare(sq("h2")), true);
      assert.equal(isWhiteSquare(sq("h4")), true);
      assert.equal(isWhiteSquare(sq("a5")), false);
      assert.equal(isWhiteSquare(sq("a7")), false);
      assert.equal(isBackRank(sq("a1")), true);
      assert.equal(isBackRank(sq("h8")), true);
      assert.equal(isBackRank(sq("a2")), false);
      assert.equal(algOfSq(0), "a1");
      assert.equal(algOfSq(63), "h8");
      assert.equal(algOfSq(sq("e4")), "e4");
    });

    test("colour comes from the square, never from the letter", () => {
      assert.equal(isWhitePiece("Q"), true);
      assert.equal(isWhitePiece("q"), false);
      assert.equal(pieceFor(sq("d1"), "q"), "Q");
      assert.equal(pieceFor(sq("d8"), "Q"), "q");
      assert.equal(pieceFor(sq("d4"), "n"), "N");
      assert.equal(pieceFor(sq("d5"), "N"), "n");
      assert.equal(pieceFor(sq("a1"), null), null);
      assert.equal(pieceFor(sq("a1"), undefined), null);
    });
  });

  describe("validateSquares", () => {
    const rejected = [
      ["nothing", undefined, /No changes/],
      ["null", null, /No changes/],
      ["an array", [], /No changes/],
      ["a string", "3", /No changes/],
      ["a square off the board", { 64: null }, /not a square/],
      ["a negative square", { "-1": null }, /not a square/],
      ["a non-numeric key", { d1: null }, /not a square/],
      ["a fractional key", { 1.5: null }, /not a square/],
      ["the white king", { [sq("e1")]: null }, /king cannot/],
      ["the black king", { [sq("e8")]: "q" }, /king cannot/],
      ["a king as the new piece", { [sq("d1")]: "k" }, /only hold a queen/],
      ["an unknown piece", { [sq("d1")]: "x" }, /only hold a queen/],
      ["a pawn on the first rank", { [sq("a1")]: "p" }, /pawn cannot stand/],
      ["a pawn on the last rank", { [sq("h8")]: "p" }, /pawn cannot stand/],
      ["no actual change", { [sq("d1")]: "q" }, /Change at least one/],
      ["no actual change in upper case", { [sq("d1")]: "Q" }, /Change at least one/],
      ["an empty object", {}, /Change at least one/],
      ["clearing a square that starts empty", { [sq("e4")]: null, [sq("e5")]: "" }, /Change at least one/],
    ];
    for (const [name, input, message] of rejected) {
      test(`rejects ${name}`, () => {
        const result = validateSquares(input);
        assert.equal(result.ok, false);
        assert.match(result.error, message);
      });
    }

    test("accepts removals and replacements and normalises them", () => {
      const result = validateSquares({
        [sq("d1")]: null, [sq("b8")]: "R", [sq("a2")]: "", [sq("h7")]: undefined,
      });
      assert.deepEqual(result, {
        ok: true,
        squares: { [sq("d1")]: null, [sq("b8")]: "r", [sq("a2")]: null, [sq("h7")]: null },
      });
    });

    test("accepts pieces placed anywhere in their own half, coloured by the half", () => {
      const result = validateSquares({
        [sq("e4")]: "Q", [sq("a3")]: "p", [sq("d5")]: "N", [sq("h6")]: "p", [sq("c4")]: null,
      });
      assert.deepEqual(result, {
        ok: true,
        squares: { [sq("e4")]: "q", [sq("a3")]: "p", [sq("d5")]: "n", [sq("h6")]: "p" },
      });
      assert.equal(
        buildFen(result.squares),
        "rnbqkbnr/pppppppp/7p/3n4/4Q3/P7/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
      );
    });

    test("drops no-op entries but keeps the rest", () => {
      assert.deepEqual(
        validateSquares({ [sq("d1")]: "q", [sq("b1")]: "r" }),
        { ok: true, squares: { [sq("b1")]: "r" } }
      );
    });
  });

  describe("buildFen", () => {
    test("no changes is the standard start", () => {
      assert.equal(buildFen(), START_FEN);
      assert.equal(buildFen({}), START_FEN);
    });

    test("removals and replacements, coloured by the square", () => {
      assert.equal(
        buildFen({ [sq("d1")]: null }),
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1"
      );
      assert.equal(
        buildFen({ [sq("d8")]: null }),
        "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
      );
      assert.equal(
        buildFen({ [sq("b1")]: "r", [sq("b7")]: "R" }),
        "rnbqkbnr/prpppppp/8/8/8/8/PPPPPPPP/RRBQKBNR w KQkq - 0 1"
      );
    });

    test("castling rights follow the corner rooks", () => {
      const rights = (changes) => buildFen(changes).split(" ")[2];
      assert.equal(rights({ [sq("a1")]: null }), "Kkq");
      assert.equal(rights({ [sq("h1")]: "n" }), "Qkq");
      assert.equal(rights({ [sq("h8")]: null, [sq("a8")]: "q" }), "KQ");
      assert.equal(rights(SAMPLES[4]), "-");
      assert.equal(rights({ [sq("a1")]: null, [sq("b1")]: "r" }), "Kkq", "a rook elsewhere creates no right");
    });

    test("every built position loads into the engine unchanged", () => {
      for (const changes of SAMPLES) {
        const fen = buildFen(changes);
        assert.equal(fromFen(fen).fen(), fen, JSON.stringify(changes));
      }
    });
  });

  describe("diffFromFen", () => {
    test("the standard start has no changes", () => {
      assert.deepEqual(diffFromFen(START_FEN), {});
    });

    test("recovers exactly what buildFen was given", () => {
      for (const changes of SAMPLES) {
        assert.deepEqual(diffFromFen(buildFen(changes)), changes, JSON.stringify(changes));
      }
    });

    test("tolerates stray whitespace around the FEN", () => {
      assert.deepEqual(diffFromFen("  " + buildFen({ [sq("d3")]: "q" }).replace(/ /g, "  ") + "\n"), { [sq("d3")]: "q" });
    });

    test("returns null for anything that is not a rearranged start", () => {
      const notHandicaps = [
        play(new Chess(), "e2e4").fen(),
        "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1",
        "k7/8/8/8/8/8/8/K7 w - - 0 1",
        // A piece in the other side's half.
        "rnbqkbnr/pppppppp/8/8/4p3/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "rnbqkbnr/pppppppp/8/4P3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        // A second king, a king off its square, a pawn on the back rank, junk.
        "rnbqkbnr/pppppppp/8/8/3K4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w kq - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/PNBQKBNR w Kkq - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w KQkq - 0 1",
        // The right pieces, but not what buildFen writes after them.
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3 7",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1",
        "rnbqkbnrr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        42,
        undefined,
      ];
      for (const fen of notHandicaps) assert.equal(diffFromFen(fen), null, String(fen));
    });
  });

  describe("describe", () => {
    test("summarises removals and swaps per side, major pieces first", () => {
      assert.equal(handicap.describe(), "");
      assert.equal(handicap.describe({}), "");
      assert.equal(handicap.describe({ [sq("d1")]: null }), "White −Q");
      assert.equal(handicap.describe({ [sq("a1")]: "q" }), "White R→Q");
      assert.equal(handicap.describe({ [sq("d8")]: null, [sq("b1")]: "r" }), "White N→R · Black −Q");
      assert.equal(handicap.describe({ [sq("g1")]: null, [sq("d1")]: null, [sq("a2")]: null }), "White −Q −N −P");
    });

    test("pieces placed on a square that starts empty read as additions", () => {
      assert.equal(handicap.describe({ [sq("d3")]: "q" }), "White +Q");
      assert.equal(handicap.describe({ [sq("d1")]: null, [sq("d3")]: "q" }), "White −Q +Q");
      assert.equal(handicap.describe({ [sq("f6")]: "n", [sq("h7")]: null, [sq("e5")]: "p" }), "Black +N +P −P");
      assert.equal(handicap.describe({ [sq("e4")]: null }), "", "clearing an empty square says nothing");
    });
  });
});

describe("handicap mirror", () => {
  test("moves every change to the other side's square, keeping the type", () => {
    assert.deepEqual(handicap.mirror({ [sq("d3")]: "q" }), { [sq("d6")]: "q" });
    assert.deepEqual(handicap.mirror({ [sq("d1")]: null }), { [sq("d8")]: null });
    assert.deepEqual(
      handicap.mirror({ [sq("b1")]: "r", [sq("g8")]: "q", [sq("f7")]: null }),
      { [sq("b8")]: "r", [sq("g1")]: "q", [sq("f2")]: null }
    );
    for (const sample of SAMPLES) assert.deepEqual(handicap.mirror(handicap.mirror(sample)), sample);
  });

  test("the mirrored position gives the same odds from the other colour", () => {
    const mirrored = handicap.mirror({ [sq("d1")]: null });
    assert.equal(buildFen(mirrored), "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    assert.equal(handicap.describe(mirrored), "Black −Q");
    assert.deepEqual(diffFromFen(buildFen(mirrored)), mirrored);
  });
});
