"use strict";

// Reading stored moves (src/shared/uci.js): the squares and promotion of a UCI
// string, or the piece and square of a Crazyhouse drop, and the legal move it
// names in a position.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, sqIdx, algOf } = require("../../src/shared/chess");
const { parseUci, moveFromUci } = require("../../src/shared/uci");
const { fromFen, sq } = require("../helpers/board");

describe("parseUci", () => {
  test("reads the squares, numbered as chess.js numbers them", () => {
    assert.deepEqual(parseUci("e2e4"), { from: sq("e2"), to: sq("e4"), promo: null, drop: null });
    assert.deepEqual(parseUci("a1h8"), { from: 0, to: 63, promo: null, drop: null });
    for (let i = 0; i < 64; i++) {
      assert.equal(parseUci(algOf(i) + "a1").from, i, algOf(i));
      assert.equal(parseUci("a1" + algOf(i)).to, i, algOf(i));
    }
    assert.equal(parseUci("h1a8").from, sqIdx(7, 0));
  });

  test("reads a promotion", () => {
    assert.deepEqual(parseUci("e7e8q"), { from: sq("e7"), to: sq("e8"), promo: "q", drop: null });
    assert.equal(parseUci("b2a1n").promo, "n");
  });

  test("reads a drop: the piece in lower case, and no square it comes from", () => {
    assert.deepEqual(parseUci("N@e4"), { from: null, to: sq("e4"), promo: null, drop: "n" });
    assert.equal(parseUci("P@a8").drop, "p", "where a pawn may land is the engine's business");
    for (const t of "QRBNP") assert.equal(parseUci(t + "@h1").drop, t.toLowerCase());
  });

  test("returns null for anything that is not a well-formed move", () => {
    for (const bad of [
      undefined, null, 42, {}, ["e2e4"], "", "e2", "e2e", "e2e4e5",
      "i2e4", "e0e4", "e2e9", "E2E4", "e7e8Q", "e7e8k", "e7e8x", " e2e4", "e2e4 ",
      "n@e4", "K@e4", "N@e9", "N@i4", "@e4", "N@", "N@e4q", "Ne4", "N@@e4",
    ]) {
      assert.equal(parseUci(bad), null, JSON.stringify(bad));
    }
  });
});

describe("moveFromUci", () => {
  test("finds the legal move a string names", () => {
    const m = moveFromUci(new Chess(), "g1f3");
    assert.equal(m.from, sq("g1"));
    assert.equal(m.to, sq("f3"));
  });

  test("takes castling spelled by the rook's square or the king's destination", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    assert.equal(moveFromUci(fromFen(fen), "e1h1").castle, "K");
    assert.equal(moveFromUci(fromFen(fen), "e1g1").castle, "K");
    assert.equal(moveFromUci(fromFen(fen), "e1a1").castle, "Q");
  });

  test("matches a promotion only with its piece", () => {
    const chess = fromFen("8/4P3/8/8/8/8/8/k6K w - - 0 1");
    assert.equal(moveFromUci(chess, "e7e8r").promo, "r");
    assert.equal(moveFromUci(chess, "e7e8"), null);
  });

  test("finds a legal drop, and nothing for one that is not", () => {
    const chess = fromFen("4k3/8/8/8/8/8/8/4K3[Np] w - - 0 1", "crazyhouse");
    const m = moveFromUci(chess, "N@e4");
    assert.equal(m.drop, "n");
    assert.equal(m.to, sq("e4"));
    assert.equal(moveFromUci(chess, "P@e4"), null, "the pawn is Black's");
    assert.equal(moveFromUci(chess, "N@e1"), null, "the square is taken");
    assert.equal(moveFromUci(new Chess(), "N@e4"), null, "no drops in standard chess");
  });

  test("is null for an illegal or malformed move", () => {
    const chess = new Chess();
    assert.equal(moveFromUci(chess, "e2e5"), null);
    assert.equal(moveFromUci(chess, "e7e5"), null, "not White's piece");
    assert.equal(moveFromUci(chess, "e2"), null);
    assert.equal(moveFromUci(chess, undefined), null);
  });
});
