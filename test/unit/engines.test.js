"use strict";

// Which engine plays a variant (src/shared/engines.js): infinite chess gets
// its own, every other variant chess.js with its rule set, each at its start.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEngine } = require("../../src/shared/engines");
const { Chess, STANDARD_START, PAWN_WARS_START, ANTICHESS_START } = require("../../src/shared/chess");
const { InfiniteChess } = require("../../src/shared/infiniteChess");

test("infinite chess gets the infinite engine, at the Classical start", () => {
  const engine = createEngine("infinite");
  assert.ok(engine instanceof InfiniteChess);
  assert.equal(engine.fen(), new InfiniteChess().fen());
});

test("every other variant gets chess.js with its rules, at its own start", () => {
  for (const [variant, fen] of [
    ["standard", STANDARD_START], ["chess960", STANDARD_START], ["atomic", STANDARD_START],
    ["pawnwars", PAWN_WARS_START], ["antichess", ANTICHESS_START], ["kingofthehill", STANDARD_START],
    ["crazyhouse", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1"],
  ]) {
    const engine = createEngine(variant);
    assert.ok(engine instanceof Chess, variant);
    assert.equal(engine.fen(), fen, variant);
  }
  assert.equal(createEngine("atomic").variant, "atomic");
});

test("an unknown name is standard chess, and each call is a fresh engine", () => {
  for (const name of ["nope", undefined, "__proto__", "Infinite"]) {
    const engine = createEngine(name);
    assert.ok(engine instanceof Chess, String(name));
    assert.equal(engine.variant, "standard");
  }
  const a = createEngine("infinite");
  a.makeMove(a.findMove({ x: 5, y: 2 }, { x: 5, y: 4 }));
  assert.equal(createEngine("infinite").turn, "w");
});
