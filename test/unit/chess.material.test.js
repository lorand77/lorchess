"use strict";

// Chess.hasMatingMaterial: whether a side could still, in principle, deliver
// mate. The server uses it to score a flag against such a side as a draw.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { fromFen } = require("../helpers/board");

const has = (fen, colour, variant) => fromFen(fen, variant).hasMatingMaterial(colour);

describe("mating material", () => {
  test("a bare king, a lone knight, a lone bishop or same-coloured bishops cannot mate", () => {
    assert.equal(has("k7/8/8/8/8/8/8/K6R w - - 0 1", "b"), false, "bare king");
    assert.equal(has("k7/8/8/8/8/8/8/K6N w - - 0 1", "w"), false, "king and knight");
    assert.equal(has("k7/8/8/8/8/8/8/K6B w - - 0 1", "w"), false, "king and bishop");
    assert.equal(has("k7/8/8/8/8/8/8/K3B1B1 w - - 0 1", "w"), false, "two bishops on dark squares");
  });

  test("a pawn, a rook, a queen, two knights or bishops of both colours can", () => {
    assert.equal(has("k7/8/8/8/8/8/8/K6R w - - 0 1", "w"), true, "rook");
    assert.equal(has("k7/8/8/8/8/8/P7/K7 w - - 0 1", "w"), true, "pawn");
    assert.equal(has("k7/8/8/8/8/8/8/K6Q w - - 0 1", "w"), true, "queen");
    assert.equal(has("k7/8/8/8/8/8/8/K5NN w - - 0 1", "w"), true, "two knights");
    assert.equal(has("k7/8/8/8/8/8/8/K4BB1 w - - 0 1", "w"), true, "bishops of both colours");
    assert.equal(has("k7/8/8/8/8/8/8/K5NB w - - 0 1", "w"), true, "knight and bishop");
  });

  test("a lone knight or one-coloured bishops can mate once the opponent has a piece to be mated against", () => {
    assert.equal(has("kn6/1B6/1K6/8/8/8/8/8 b - - 0 1", "w"), true, "bishop against a knight (Bb7#)");
    assert.equal(has("kn6/2N5/1K6/8/8/8/8/8 b - - 0 1", "w"), true, "knight against a knight (Nc7#)");
    assert.equal(has("kb6/1B6/1K6/8/8/8/8/8 b - - 0 1", "w"), true, "bishops of opposite colours (Bb7#)");
    assert.equal(has("8/8/8/8/8/6N1/5K1p/7k b - - 0 1", "w"), true, "knight against a pawn (Ng3#)");
    assert.equal(has("k7/8/8/8/8/8/8/K2B1b2 w - - 0 1", "w"), false, "bishops on the same colour cannot help each other");
    assert.equal(has("k7/8/8/8/8/8/8/K6N w - - 0 1", "w"), false, "a lone knight against a bare king still cannot");
  });

  test("Atomic and Pawn Wars always have a way to win", () => {
    assert.equal(has("k7/8/8/8/8/8/8/K7 w - - 0 1", "w", "atomic"), true);
    assert.equal(has("pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1", "b", "pawnwars"), true);
  });
});
