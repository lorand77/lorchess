"use strict";

// Chess960 start positions (src/shared/chess960.js) and the engine's castling
// from arbitrary king and rook squares (deriveCastlingLayout in chess.js).

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const {
  PIECES, isValidBackRank, randomBackRank, fenFor, randomFen, isStartFen,
} = require("../../src/shared/chess960");
const { START_FEN, fromFen, moveOf, play } = require("../helpers/board");
const { seeded } = require("../helpers/random");

const STANDARD = ["r", "n", "b", "q", "k", "b", "n", "r"];
const castles = (fen) =>
  fromFen(fen).legalMoves().filter((m) => m.castle).map((m) => m.castle).sort();

describe("Chess960 back ranks", () => {
  test("the standard arrangement is one of the 960", () => {
    assert.equal(isValidBackRank(STANDARD), true);
  });

  test("rejects the wrong shape or piece set", () => {
    const bad = [
      null, "rnbqkbnr", [], STANDARD.slice(0, 7), [...STANDARD, "r"],
      ["r", "n", "b", "q", "q", "b", "n", "r"],
      ["r", "n", "q", "q", "k", "b", "n", "r"],
    ];
    for (const rank of bad) assert.equal(isValidBackRank(rank), false, JSON.stringify(rank));
  });

  test("rejects bishops on the same colour", () => {
    assert.equal(isValidBackRank(["b", "r", "b", "n", "q", "k", "n", "r"]), false);
    assert.equal(isValidBackRank(["r", "n", "b", "q", "k", "n", "b", "r"]), false);
  });

  test("rejects a king outside the rooks", () => {
    assert.equal(isValidBackRank(["k", "r", "b", "n", "q", "b", "n", "r"]), false);
    assert.equal(isValidBackRank(["r", "b", "n", "q", "b", "n", "r", "k"]), false);
  });

  test("random ranks are always valid and vary", () => {
    const rnd = seeded(2024);
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const rank = randomBackRank(rnd);
      assert.equal(isValidBackRank(rank), true, rank.join(""));
      seen.add(rank.join(""));
    }
    assert.ok(seen.size > 200, `only ${seen.size} distinct arrangements in 500 draws`);
    assert.deepEqual(PIECES, STANDARD, "the template list is never mutated");
  });

  test("the same seed gives the same rank", () => {
    assert.deepEqual(randomBackRank(seeded(7)), randomBackRank(seeded(7)));
  });
});

describe("Chess960 start FENs", () => {
  test("fenFor mirrors the rank for Black and claims all four castling rights", () => {
    assert.equal(fenFor(STANDARD), START_FEN);
    assert.equal(
      fenFor(["b", "b", "q", "n", "n", "r", "k", "r"]),
      "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"
    );
  });

  test("isStartFen accepts any 960 start and nothing else", () => {
    assert.equal(isStartFen(START_FEN), true);
    const rnd = seeded(1);
    for (let i = 0; i < 50; i++) assert.equal(isStartFen(randomFen(rnd)), true);
    assert.equal(isStartFen(fenFor(["r", "n", "b", "q", "k", "n", "b", "r"])), false, "same-colour bishops");
    assert.equal(
      isStartFen("bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
      false, "black does not mirror white"
    );
    assert.equal(isStartFen(play(new Chess(), "e2e4").fen()), false, "a move has been played");
    assert.equal(isStartFen("k7/8/8/8/8/8/8/K7 w - - 0 1"), false);
    assert.equal(isStartFen(42), false);
    assert.equal(isStartFen(undefined), false);
  });

  test("random starts load into the engine, round-trip, and resolve their castling rooks", () => {
    const rnd = seeded(99);
    for (let i = 0; i < 50; i++) {
      const fen = randomFen(rnd);
      const chess = fromFen(fen);
      assert.equal(chess.fen(), fen);
      // 16 pawn moves, up to 4 knight moves, and castling when the king and
      // a rook already stand on the squares castling would put them on.
      const n = chess.legalMoves().length;
      assert.ok(n >= 16 && n <= 21, `${n} legal moves from ${fen}`);
      const rank = fen.split("/")[0].split("");
      assert.equal(chess.kingHomeFile.w, rank.indexOf("k"), fen);
      assert.equal(chess.castleRook.Q, rank.indexOf("r"), fen);
      assert.equal(chess.castleRook.K, rank.lastIndexOf("r"), fen);
    }
  });
});

describe("Chess960 castling", () => {
  // White: rook a1, king b1, rook h1. Black: king b8, rook h8.
  const SHIFTED = "1k5r/8/8/8/8/8/8/RK5R w KQkq - 0 1";

  test("rights are resolved against the rooks actually present", () => {
    assert.equal(fromFen(SHIFTED).fen(), "1k5r/8/8/8/8/8/8/RK5R w KQk - 0 1", "black has no queenside rook");
    assert.deepEqual(castles(SHIFTED), ["K", "Q"]);
  });

  test("the king and rook finish on the standard squares wherever they started", () => {
    const long = play(fromFen(SHIFTED), "b1a1");
    assert.equal(long.fen(), "1k5r/8/8/8/8/8/8/2KR3R b k - 1 1");
    const short = play(fromFen(SHIFTED), "b1h1");
    assert.equal(short.fen(), "1k5r/8/8/8/8/8/8/R4RK1 b k - 1 1");
  });

  test("castling can leave the king where it stands", () => {
    const chess = fromFen("k7/8/8/8/8/8/8/6KR w K - 0 1");
    assert.equal(moveOf(chess, "g1h1").castle, "K");
    assert.equal(moveOf(chess, "g1f1").castle, undefined, "an ordinary king step is not castling");
    play(chess, "g1h1");
    assert.equal(chess.fen(), "k7/8/8/8/8/8/8/5RK1 b - - 1 1");
  });

  test("with the king on f and a rook on g, castling is legal on move one", () => {
    const chess = fromFen("brnbnkrq/pppppppp/8/8/8/8/PPPPPPPP/BRNBNKRQ w KQkq - 0 1");
    assert.deepEqual(chess.legalMoves().filter((m) => m.castle).map((m) => m.castle), ["K"]);
    play(chess, "f1g1");
    assert.equal(chess.fen(), "brnbnkrq/pppppppp/8/8/8/8/PPPPPPPP/BRNBNRKQ b kq - 1 1");
  });

  test("an explicit rook file picks which rook castles", () => {
    assert.deepEqual(castles("k7/8/8/8/8/8/8/RR2K3 w Q - 0 1"), [], "the outer rook is blocked by the inner one");
    const chess = fromFen("k7/8/8/8/8/8/8/RR2K3 w B - 0 1");
    assert.deepEqual(chess.legalMoves().filter((m) => m.castle).map((m) => m.castle), ["Q"]);
    play(chess, "e1b1");
    assert.equal(chess.fen(), "k7/8/8/8/8/8/8/R1KR4 b - - 1 1");
  });

  test("rights written as rook files still print as KQkq", () => {
    assert.equal(
      fromFen("r3k2r/8/8/8/8/8/8/R3K2R w HAha - 0 1").fen(),
      "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
    );
  });
});
