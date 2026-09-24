"use strict";

// Perft tests for the move generator in src/shared/chess.js.
//
// Every fixture is a published reference position with its known leaf counts
// (Chess Programming Wiki "Perft Results" and the classic perftsuite.epd). A
// wrong count means a move-generation bug; the failure message includes the
// per-move breakdown so it can be compared with a known-good engine.
//
// Deep counts are slow, so by default only entries up to PERFT_MAX_NODES
// leaves are run (see below). To run everything:
//
//   PERFT_MAX_NODES=all npm test

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const positions = require("../fixtures/perft.json");
const { fromFen, perft, divide, formatDivide } = require("../helpers/perft");

const budget = process.env.PERFT_MAX_NODES;
const MAX_NODES = budget === "all" ? Infinity : Number(budget) || 1_000_000;

describe("perft", () => {
  for (const pos of positions) {
    describe(pos.name, () => {
      for (const [depthStr, expected] of Object.entries(pos.depths)) {
        const depth = Number(depthStr);
        const skip = expected > MAX_NODES && `${expected} leaves exceeds PERFT_MAX_NODES`;
        test(`depth ${depth} = ${expected}`, { skip }, () => {
          const chess = fromFen(pos.fen);
          const nodes = perft(chess, depth);
          if (nodes !== expected) {
            assert.fail(
              `perft(${depth}) of "${pos.fen}" = ${nodes}, expected ${expected}\n` +
              formatDivide(divide(chess, depth))
            );
          }
          // Every make must have been undone exactly.
          assert.equal(chess.fen(), pos.fen, "position not restored after perft");
        });
      }
    });
  }
});

describe("divide", () => {
  test("sums to perft and lists every root move once", () => {
    const chess = fromFen(positions[0].fen);
    const { rows, total } = divide(chess, 3);
    assert.equal(total, perft(chess, 3));
    assert.equal(rows.length, 20);
    assert.equal(new Set(rows.map((r) => r.move)).size, 20);
    assert.equal(rows.find((r) => r.move === "e2e4").nodes, 600);
  });
});
