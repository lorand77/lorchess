"use strict";

// Stored moves (src/shared/uci.js): reading the squares and promotion of a UCI
// string, or the piece and square of a Crazyhouse drop, finding the legal move
// it names in a position, and writing a move back the way it is stored.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, sqIdx, algOf } = require("../../src/shared/chess");
const { parseUci, moveFromUci, formatUci } = require("../../src/shared/uci");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
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
    assert.equal(parseUci("e7e8k").promo, "k", "an Antichess pawn may become a king");
  });

  test("reads a drop: the piece in lower case, and no square it comes from", () => {
    assert.deepEqual(parseUci("N@e4"), { from: null, to: sq("e4"), promo: null, drop: "n" });
    assert.equal(parseUci("P@a8").drop, "p", "where a pawn may land is the engine's business");
    for (const t of "QRBNP") assert.equal(parseUci(t + "@h1").drop, t.toLowerCase());
  });

  test("returns null for anything that is not a well-formed move", () => {
    for (const bad of [
      undefined, null, 42, {}, ["e2e4"], "", "e2", "e2e", "e2e4e5",
      "i2e4", "e0e4", "e2e9", "E2E4", "e7e8Q", "e7e8K", "e7e8x", " e2e4", "e2e4 ",
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

describe("formatUci", () => {
  test("writes moves, promotions and drops as they are stored", () => {
    assert.equal(formatUci({ from: sq("e2"), to: sq("e4") }), "e2e4");
    assert.equal(formatUci({ from: sq("b7"), to: sq("a8"), promo: "n" }), "b7a8n");
    assert.equal(formatUci({ from: null, to: sq("e4"), drop: "p" }), "P@e4");
  });

  test("spells castling by the rook's square, however it was read", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    assert.equal(formatUci(moveFromUci(fromFen(fen), "e1g1")), "e1h1");
    assert.equal(formatUci(moveFromUci(fromFen(fen), "e1a1")), "e1a1");
  });

  test("is what parseUci reads back, for every legal move of a busy position", () => {
    const chess = fromFen("r3k2r/1P6/8/8/8/8/8/R3K2R[NPq] w KQkq - 0 1", "crazyhouse");
    const moves = chess.legalMoves();
    assert.ok(moves.some((m) => m.drop) && moves.some((m) => m.promo) && moves.some((m) => m.castle));
    for (const m of moves) assert.deepEqual(moveFromUci(chess, formatUci(m)), m, formatUci(m));
  });
});

describe("infinite-chess moves (ICN)", () => {
  const icn = (text) => {
    const inf = new InfiniteChess();
    inf.loadFen(text);
    return inf;
  };

  test("reads coordinates, negative ones included, and whose promotion it is", () => {
    assert.deepEqual(parseUci("5,2>5,4"), { from: { x: 5, y: 2 }, to: { x: 5, y: 4 }, promo: null, drop: null });
    assert.deepEqual(parseUci("-12,0>-12,-1000000").to, { x: -12, y: -1000000 });
    assert.deepEqual(parseUci("4,7>4,8Q"), {
      from: { x: 4, y: 7 }, to: { x: 4, y: 8 }, promo: "q", drop: null, promoColor: "w",
    });
    assert.equal(parseUci("4,2>4,1n").promoColor, "b");
    for (const bad of ["5,2>5", "5,2-5,4", "5,2>5,4K", "5,2>5,4x", "-0,1>0,2", "01,2>1,3", "5, 2>5,4", "5,2>5,4 ", "a,2>5,4"]) {
      assert.equal(parseUci(bad), null, bad);
    }
  });

  test("finds the move in an infinite position, and nothing in an ordinary one", () => {
    const inf = new InfiniteChess();
    assert.equal(moveFromUci(inf, "7,1>6,3").piece, "n");
    assert.equal(moveFromUci(inf, "e2e4"), null, "squares numbered 0-63 mean nothing here");
    assert.equal(moveFromUci(new Chess(), "5,2>5,4"), null, "nor coordinates in ordinary chess");
    const promote = icn("w 0/100 1 (8|1) checkmate K-10,1|k10,8|P1,7");
    assert.equal(moveFromUci(promote, "1,7>1,8Q").promo, "q");
    assert.equal(moveFromUci(promote, "1,7>1,8q"), null, "a black queen for White's pawn");
  });

  test("writes every legal move of a busy position so it reads back as the same move", () => {
    const inf = icn("w 0/100 1 (8|1) checkmate K5,1+|R8,1+|R-100,1+|P2,7|P3,2+|N4,4|Q10,10|k5,8|b3,8|p4,5");
    const moves = [];
    for (const p of [...inf.board.values()]) {
      if (p.c !== "w") continue;
      for (let x = -101; x <= 12; x++) {
        for (let y = -2; y <= 12; y++) {
          for (const promo of p.t === "p" ? [null, "q", "r", "b", "n"] : [null]) {
            const m = inf.findMove({ x: p.x, y: p.y }, { x, y }, promo);
            if (m) moves.push(m);
          }
        }
      }
    }
    assert.ok(moves.some((m) => m.castle) && moves.some((m) => m.promo) && moves.some((m) => m.capture));
    for (const m of moves) assert.deepEqual(moveFromUci(inf, formatUci(m)), m, formatUci(m));
    const black = icn("b 0/100 1 (8|1) checkmate K-10,1|k10,8|p1,2");
    assert.equal(formatUci(black.findMove({ x: 1, y: 2 }, { x: 1, y: 1 }, "r")), "1,2>1,1r");
  });
});

