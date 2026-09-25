"use strict";

// Run the real worker and review scorer in isolated browser-like contexts,
// including terminal positions where the engine cannot return a best move.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Chess } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");
const source = (file) => fs.readFileSync(path.join(__dirname, "../../public/js", file), "utf8");
const reviewContext = { window: {} };
vm.runInNewContext(source("gameReview.js"), reviewContext);
const review = reviewContext.window.GameReview;

function evaluate(startFen, uciMoves) {
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source("engineWorker.js"), { Chess, LorFish, self, importScripts() {} });
  self.onmessage({ data: { id: 1, type: "review", startFen, uciMoves, depth: 2 } });
  assert.equal(messages.at(-1).type, "review:done", JSON.stringify(messages.at(-1)));
  return messages.filter(m => m.type === "review:eval");
}

test("throwing away mate by stalemate is a blunder", () => {
  const moves = ["g5g6"];
  const evals = evaluate("7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", moves);
  assert.ok(evals[0].score >= 99000);
  assert.equal(evals[1].score, 0);
  const result = review.summarise(evals, moves).moves[0];
  assert.equal(result.kind, "blunder");
  assert.equal(result.loss, 1000);
  assert.ok(result.accuracy < 50);
});

test("mate has an explicit losing score for the side to move", () => {
  for (const [fen, move] of [
    ["7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", "g5g7"],
    ["8/8/8/8/6q1/8/5k2/7K b - - 0 1", "g4g2"],
  ]) {
    const evals = evaluate(fen, [move]);
    assert.equal(evals[1].score, -100000);
    assert.equal(evals[1].best, null);
    const result = review.summarise(evals, [move]).moves[0];
    assert.equal(result.evalAfter, 100000);
    assert.equal(result.loss, 0);
  }
});

test("rule draws are zero even when legal moves remain", () => {
  const evals = evaluate("7k/8/8/8/8/8/8/K7 w - - 0 1", []);
  assert.equal(evals[0].score, 0);
});

test("missing evaluations are not fabricated as good moves", () => {
  assert.equal(review.summarise([{ turn: "w", score: 500 }, null], ["e2e4"]).moves.length, 0);
});
