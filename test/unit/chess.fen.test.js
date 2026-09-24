"use strict";

// FEN parsing and serialisation in src/shared/chess.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const positions = require("../fixtures/perft.json");
const { START_FEN, fromFen, play } = require("../helpers/board");

describe("FEN", () => {
  test("a new board is the standard start position", () => {
    assert.equal(new Chess().fen(), START_FEN);
  });

  test("every reference position survives a load and emit round trip", () => {
    for (const pos of positions) {
      assert.equal(fromFen(pos.fen).fen(), pos.fen, pos.name);
    }
  });

  test("a four-field FEN gets the default move counters", () => {
    const chess = fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    assert.equal(chess.fen(), START_FEN);
  });

  test("side to move, castling rights, en passant square and counters are read back", () => {
    const fen = "r3k2r/8/8/8/3pP3/8/8/R3K2R b Kq e3 5 40";
    assert.equal(fromFen(fen).fen(), fen);
  });

  test("a double pawn push sets the en passant square and the counters advance", () => {
    const chess = new Chess();
    play(chess, "e2e4");
    assert.equal(chess.fen(), "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    play(chess, "g8f6");
    assert.equal(chess.fen(), "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2");
    play(chess, "b1c3");
    assert.equal(chess.fen(), "rnbqkb1r/pppppppp/5n2/8/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 2 2");
  });

  test("castling rights claimed for a missing rook or an absent king are dropped", () => {
    assert.equal(
      fromFen("4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1").fen(),
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
    );
    assert.equal(
      fromFen("4k3/8/8/8/8/8/4K3/R6R w KQ - 0 1").fen(),
      "4k3/8/8/8/8/8/4K3/R6R w - - 0 1"
    );
    // Only the side whose rook is missing loses its right.
    assert.equal(
      fromFen("r3k2r/8/8/8/8/8/8/R3K3 w KQkq - 0 1").fen(),
      "r3k2r/8/8/8/8/8/8/R3K3 w Qkq - 0 1"
    );
  });

  test("loading a position clears the move history and repetition counts", () => {
    const chess = new Chess();
    play(chess, "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8");
    assert.equal(chess.isThreefoldRepetition(), true);
    chess.loadFen(START_FEN);
    assert.equal(chess.history.length, 0);
    assert.equal(chess.isThreefoldRepetition(), false);
    assert.equal(chess.positionCounts.size, 1);
  });

  describe("rejects malformed input", () => {
    const bad = [
      ["too few fields", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq", /at least 4 fields/],
      ["seven ranks", "rnbqkbnr/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", /8 ranks/],
      ["a rank that is too short", "rnbqkbnr/pppppppp/7/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", /does not sum to 8/],
      ["a rank that is too long", "rnbqkbnrr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", /overflows 8 files/],
      ["an unknown piece letter", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKXNR w KQkq - 0 1", /bad piece char/],
      ["two white kings", "4k3/8/8/8/8/8/8/K3K3 w - - 0 1", /exactly one king/],
      ["no black king", "8/8/8/8/8/8/8/4K3 w - - 0 1", /exactly one king/],
      ["a bad en passant square", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq z9 0 1", /bad en-passant/],
      ["an empty string", "", /at least 4 fields/],
    ];
    for (const [name, fen, message] of bad) {
      test(name, () => assert.throws(() => fromFen(fen), message));
    }
  });

  test("a rejected FEN leaves the current position untouched", () => {
    const chess = new Chess();
    play(chess, "e2e4");
    const before = chess.fen();
    assert.throws(() => chess.loadFen("rnbqkbnr/pppppppp/7/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"));
    assert.equal(chess.fen(), before);
  });

  // Known gap: the en passant field is validated after the board has already
  // been replaced, so a bad one leaves a half-loaded position behind.
  test(
    "a rejected en passant field also leaves the position untouched",
    { todo: "loadFen replaces the board before it validates the en passant field" },
    () => {
      const chess = new Chess();
      play(chess, "e2e4");
      const before = chess.fen();
      assert.throws(() => chess.loadFen("k7/8/8/8/8/8/8/K7 w - z9 0 1"));
      assert.equal(chess.fen(), before);
    }
  );
});
