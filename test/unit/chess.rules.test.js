"use strict";

// Game-end detection, castling and en passant rules, and undo in
// src/shared/chess.js. Move generation itself is covered by the perft tests.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { START_FEN, fromFen, sq, uci, moveOf, play } = require("../helpers/board");

// Knights out and back: the start position recurs after every four plies.
const SHUFFLE = ["g1f3", "g8f6", "f3g1", "f6g8"];

describe("game end", () => {
  test("a fresh game is not over", () => {
    const chess = new Chess();
    assert.equal(chess.inCheck(), false);
    assert.equal(chess.isGameOver(), false);
    assert.equal(chess.result(), "*");
  });

  test("checkmate: fool's mate is a black win", () => {
    const chess = play(new Chess(), "f2f3", "e7e5", "g2g4", "d8h4");
    assert.equal(chess.inCheck(), true);
    assert.equal(chess.isCheckmate(), true);
    assert.equal(chess.isStalemate(), false);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "0-1");
    assert.deepEqual(chess.legalMoves(), []);
  });

  test("checkmate: scholar's mate is a white win", () => {
    const chess = play(new Chess(), "e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7");
    assert.equal(chess.isCheckmate(), true);
    assert.equal(chess.result(), "1-0");
  });

  test("stalemate is a draw", () => {
    const chess = fromFen("k7/8/1Q6/8/8/8/8/K7 b - - 0 1");
    assert.equal(chess.inCheck(), false);
    assert.equal(chess.isStalemate(), true);
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1/2-1/2");
  });

  describe("insufficient material", () => {
    const draws = [
      ["king vs king", "k7/8/8/8/8/8/8/K7 w - - 0 1"],
      ["king and bishop vs king", "k7/8/8/8/8/8/8/K1B5 w - - 0 1"],
      ["king and knight vs king", "k7/8/8/8/8/8/8/K1N5 w - - 0 1"],
      ["king vs king and knight", "kn6/8/8/8/8/8/8/K7 w - - 0 1"],
      ["bishops on the same colour", "k7/8/8/8/5b2/8/8/K1B5 w - - 0 1"],
    ];
    const notDraws = [
      ["bishops on opposite colours", "k7/8/8/5b2/8/8/8/K1B5 w - - 0 1"],
      ["knight vs knight", "kn6/8/8/8/8/8/8/K1N5 w - - 0 1"],
      ["two knights vs king", "k7/8/8/8/8/8/8/K1NN4 w - - 0 1"],
      ["rook vs king", "k7/8/8/8/8/8/8/K1R5 w - - 0 1"],
      ["a single pawn", "k7/8/8/8/8/8/P7/K7 w - - 0 1"],
    ];
    for (const [name, fen] of draws) {
      test(`${name} is a draw`, () => {
        const chess = fromFen(fen);
        assert.equal(chess.isInsufficientMaterial(), true);
        assert.equal(chess.isGameOver(), true);
        assert.equal(chess.result(), "1/2-1/2");
      });
    }
    for (const [name, fen] of notDraws) {
      test(`${name} is not a draw`, () => {
        const chess = fromFen(fen);
        assert.equal(chess.isInsufficientMaterial(), false);
        assert.equal(chess.isGameOver(), false);
      });
    }
  });

  test("the halfmove clock counts quiet moves and resets on pawn moves and captures", () => {
    const chess = fromFen("k7/7p/8/8/8/8/8/K6R w - - 12 30");
    play(chess, "h1h2");
    assert.equal(chess.halfmove, 13);
    play(chess, "h7h5");
    assert.equal(chess.halfmove, 0, "pawn move");
    play(chess, "h2h5");
    assert.equal(chess.halfmove, 0, "capture");
    play(chess, "a8b8");
    assert.equal(chess.halfmove, 1);
  });

  test("fifty-move rule: the game is drawn at a hundred halfmoves", () => {
    const chess = fromFen("k7/8/8/8/8/8/8/K6R w - - 99 80");
    assert.equal(chess.isGameOver(), false);
    play(chess, "h1h2");
    assert.equal(chess.halfmove, 100);
    assert.equal(chess.isGameOver(), true);
    assert.equal(chess.result(), "1/2-1/2");
  });

  test("checkmate on the hundredth halfmove is still a win", () => {
    const chess = fromFen("k7/8/1K6/8/8/8/8/7R w - - 99 80");
    play(chess, "h1h8");
    assert.equal(chess.halfmove, 100);
    assert.equal(chess.isCheckmate(), true);
    assert.equal(chess.result(), "1-0");
  });

  describe("repetition", () => {
    test("threefold once the same position has occurred three times", () => {
      const chess = new Chess();
      play(chess, SHUFFLE);
      assert.equal(chess.isThreefoldRepetition(), false, "second occurrence");
      play(chess, SHUFFLE.slice(0, 3));
      assert.equal(chess.isThreefoldRepetition(), false, "one ply short");
      play(chess, SHUFFLE[3]);
      assert.equal(chess.isThreefoldRepetition(), true);
      assert.equal(chess.isFivefoldRepetition(), false);
      assert.equal(chess.isGameOver(), true);
      assert.equal(chess.result(), "1/2-1/2");
    });

    test("fivefold once it has occurred five times", () => {
      const chess = new Chess();
      play(chess, SHUFFLE, SHUFFLE, SHUFFLE);
      assert.equal(chess.isFivefoldRepetition(), false, "fourth occurrence");
      play(chess, SHUFFLE);
      assert.equal(chess.isFivefoldRepetition(), true);
    });

    test("positions that differ only in castling rights are not repetitions", () => {
      const chess = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
      const cycle = ["a1b1", "a8b8", "b1a1", "b8a8"];
      play(chess, cycle);
      // Same squares, but the queenside rights are spent: a new position.
      assert.equal(chess.fen(), "r3k2r/8/8/8/8/8/8/R3K2R w Kk - 4 3");
      play(chess, cycle);
      assert.equal(chess.isThreefoldRepetition(), false);
      play(chess, cycle);
      assert.equal(chess.isThreefoldRepetition(), true);
    });

    test("an uncapturable en passant target does not change repetition", () => {
      const chess = fromFen("k7/8/8/8/8/8/P7/K7 w - - 0 1");
      play(chess, "a2a4");
      const cycle = ["a8b8", "a1b1", "b8a8", "b1a1"];
      play(chess, cycle, cycle);
      assert.equal(chess.isThreefoldRepetition(), true);
    });

    test("the position after e4 counts toward the third occurrence", () => {
      const chess = new Chess();
      play(chess, "e2e4", "g8f6", "g1f3", "f6g8", "f3g1", "g8f6", "g1f3", "f6g8", "f3g1");
      assert.equal(chess.isThreefoldRepetition(), true);
      chess.undoMove();
      assert.equal(chess.isThreefoldRepetition(), false);
      play(chess, "f3g1");
      assert.equal(chess.result(), "1/2-1/2");
    });

    test("only legal en passant changes the key, without changing board or history", () => {
      for (const [fen, legal] of [
        ["k7/8/8/3pP3/8/8/8/4K3 w - d6 0 1", true],
        ["k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", false],
        ["k7/8/8/r4pPK/8/8/8/8 w - f6 0 1", false],
      ]) {
        const chess = fromFen(fen);
        const counts = [...chess.positionCounts];
        const key = chess.positionKey();
        const withoutEp = fromFen(fen.replace(/ [a-h][36] /, " - ")).positionKey();
        assert.equal(key !== withoutEp, legal, fen);
        assert.equal(chess.fen(), fen);
        assert.equal(chess.history.length, 0);
        assert.deepEqual([...chess.positionCounts], counts);
      }
    });
  });
});

describe("check and pins", () => {
  test("in check, only evasions are legal and castling is off", () => {
    const chess = fromFen("4k3/8/8/8/8/8/4r3/4K2R w K - 0 1");
    assert.equal(chess.inCheck(), true);
    assert.deepEqual(chess.legalMoves().map(uci).sort(), ["e1d1", "e1e2", "e1f1"]);
  });

  test("a pinned piece may only move along the line of the pin", () => {
    const chess = fromFen("4k3/4r3/8/8/8/8/4R3/4K3 w - - 0 1");
    const rookMoves = chess.legalMoves().filter((m) => m.from === sq("e2")).map(uci).sort();
    assert.deepEqual(rookMoves, ["e2e3", "e2e4", "e2e5", "e2e6", "e2e7"]);
  });
});

describe("castling", () => {
  const BOTH = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const castles = (fen) =>
    fromFen(fen).legalMoves().filter((m) => m.castle).map((m) => m.castle).sort();

  test("moves both pieces and spends the rights", () => {
    const chess = fromFen(BOTH);
    play(chess, "e1g1");
    assert.equal(chess.fen(), "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
    play(chess, "e8c8");
    assert.equal(chess.fen(), "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2");
  });

  test("is found by king-to-rook as well as king-to-destination", () => {
    const chess = fromFen(BOTH);
    assert.equal(moveOf(chess, "e1g1").castle, "K");
    assert.equal(moveOf(chess, "e1h1").castle, "K");
    assert.equal(moveOf(chess, "e1c1").castle, "Q");
    assert.equal(moveOf(chess, "e1a1").castle, "Q");
  });

  test("a king move spends both rights", () => {
    const chess = play(fromFen(BOTH), "e1e2");
    assert.equal(chess.fen().split(" ")[2], "kq");
  });

  test("a rook move spends that side's right, and coming back does not restore it", () => {
    const chess = play(fromFen(BOTH), "h1h2", "a8a7", "h2h1", "a7a8");
    assert.equal(chess.fen().split(" ")[2], "Qk");
    assert.equal(moveOf(chess, "e1g1"), null);
    assert.equal(moveOf(chess, "e8c8"), null);
  });

  test("capturing a rook on its home square spends the opponent's right", () => {
    const chess = play(fromFen(BOTH), "h1h8");
    assert.equal(chess.fen(), "r3k2R/8/8/8/8/8/8/R3K3 b Qq - 0 1");
  });

  test("is blocked by pieces in the way", () => {
    assert.deepEqual(castles("r3k2r/8/8/8/8/8/8/RN2K1NR w KQkq - 0 1"), []);
  });

  test("is not allowed out of check", () => {
    assert.deepEqual(castles("4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1"), []);
  });

  test("is not allowed through or into an attacked square", () => {
    assert.deepEqual(castles("5rk1/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["Q"], "f1 attacked");
    assert.deepEqual(castles("6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["Q"], "g1 attacked");
    assert.deepEqual(castles("3r3k/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["K"], "d1 attacked");
    assert.deepEqual(castles("2r4k/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["K"], "c1 attacked");
  });

  test("only the king's path matters: the rook may pass an attacked square", () => {
    assert.deepEqual(castles("1r5k/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["K", "Q"]);
  });
});

describe("en passant", () => {
  test("is available only on the move immediately after the double push", () => {
    const chess = play(new Chess(), "e2e4", "a7a6", "e4e5", "d7d5");
    assert.equal(moveOf(chess, "e5d6").enpassant, true);
    play(chess, "g1f3", "a6a5");
    assert.equal(moveOf(chess, "e5d6"), null);
  });

  test("removes the pawn that just moved", () => {
    const chess = play(new Chess(), "e2e4", "a7a6", "e4e5", "d7d5", "e5d6");
    assert.equal(chess.fen(), "rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3");
  });

  test("is illegal when it would expose the king", () => {
    const chess = fromFen("3k4/8/8/K1Pp3r/8/8/8/8 w - d6 0 1");
    assert.equal(moveOf(chess, "c5d6"), null);
    assert.ok(moveOf(chess, "c5c6"), "the plain push is still fine");
  });
});

describe("undo", () => {
  test("restores the exact position after every kind of move", () => {
    const chess = fromFen("r3k2r/1P4p1/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1");
    // en passant, castle, capture-promotion, double push, queenside castle
    const moves = ["e5d6", "e8g8", "b7a8q", "g7g5", "e1c1"];
    const fens = [chess.fen()];
    for (const m of moves) {
      play(chess, m);
      fens.push(chess.fen());
    }
    for (let i = moves.length; i > 0; i--) {
      assert.equal(chess.fen(), fens[i]);
      chess.undoMove();
      assert.equal(chess.fen(), fens[i - 1], `after undoing ${moves[i - 1]}`);
    }
    assert.equal(chess.history.length, 0);
  });

  test("restores the repetition counts", () => {
    const chess = play(new Chess(), SHUFFLE, SHUFFLE);
    assert.equal(chess.isThreefoldRepetition(), true);
    chess.undoMove();
    assert.equal(chess.isThreefoldRepetition(), false);
    while (chess.history.length) chess.undoMove();
    assert.deepEqual(chess.positionCounts, new Chess().positionCounts);
    assert.equal(chess.fen(), START_FEN);
  });

  test("with tracking off never touches the repetition counts", () => {
    const chess = new Chess();
    const before = new Map(chess.positionCounts);
    chess.makeMove(moveOf(chess, "e2e4"), false);
    assert.deepEqual(chess.positionCounts, before);
    chess.undoMove();
    assert.deepEqual(chess.positionCounts, before);
    assert.equal(chess.fen(), START_FEN);
  });

  test("on an empty history is a no-op", () => {
    const chess = new Chess();
    chess.undoMove();
    assert.equal(chess.fen(), START_FEN);
  });
});
