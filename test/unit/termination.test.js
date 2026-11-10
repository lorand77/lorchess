"use strict";

// How a game ended, as both engines name it (termination()): the names the
// server records for PvP games and the game page reports for AI games.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
const { fromFen, play } = require("../helpers/board");

const ended = (fen, variant) => fromFen(fen, variant).termination();

test("standard chess: mate, stalemate and the draws, or nothing yet", () => {
  assert.equal(ended("6k1/5ppp/8/8/8/8/8/K3R3 w - - 0 1"), null);
  assert.equal(ended("4R1k1/5ppp/8/8/8/8/8/K7 b - - 0 1"), "checkmate");
  assert.equal(ended("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), "stalemate");
  assert.equal(ended("7k/8/8/8/8/8/8/K6N w - - 0 1"), "insufficient");
  assert.equal(ended("7k/8/8/8/8/8/8/K5QN w - - 100 80"), "fifty-move");
  const knights = fromFen("7k/7p/8/8/8/8/P7/K5N1 w - - 0 1");
  for (let i = 0; i < 2; i++) play(knights, "g1f3", "h8g8", "f3g1", "g8h8");
  assert.equal(knights.termination(), "threefold");
});

test("each variant names its own ending", () => {
  // A king can't be loaded missing: blow it up.
  assert.equal(play(fromFen("4k3/4p3/8/8/8/8/8/K3R3 w - - 0 1", "atomic"), "e1e7").termination(), "explosion");
  assert.equal(ended("8/8/8/8/8/8/8/P7 b - - 0 1", "pawnwars"), "pawns captured");
  assert.equal(ended("8/8/8/p7/P7/8/8/8 w - - 0 1", "pawnwars"), "stalemate", "pawns locked, both still there");
  assert.equal(ended("8/8/8/8/8/8/8/R7 b - - 0 1", "antichess"), "all pieces lost");
  assert.equal(ended("8/8/8/p7/P7/8/8/8 w - - 0 1", "antichess"), "no moves");
});

test("infinite chess names its endings as standard chess does", () => {
  const inf = (text) => { const c = new InfiniteChess(); c.loadFen(text); return c.termination(); };
  assert.equal(new InfiniteChess().termination(), null);
  assert.equal(inf("b 0/100 1 (8|1) checkmate k5,5|R4,100|R6,100|R100,4|R100,6|R100,5|K-50,-50"), "checkmate");
  assert.equal(inf("b 0/100 1 (8|1) checkmate k5,5|R4,100|R6,100|R100,4|R100,6|K-50,-50"), "stalemate");
  assert.equal(inf("w 0/100 1 (8|1) checkmate K5,1|k5,8|Q1,1"), "insufficient");
  assert.equal(inf("w 100/100 80 (8|1) checkmate K5,1|k5,8|Q1,1|R2,2"), "fifty-move");
});
