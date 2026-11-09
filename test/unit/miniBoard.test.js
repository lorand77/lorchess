"use strict";

// The lobby's thumbnail board (public/js/miniBoard.js) reads only the board
// out of a FEN. Loaded the way the browser runs it, as a script with `window`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../public/js/miniBoard.js"), "utf8"), context);
const { parse, turnOf } = context.window.MiniBoard;
const placed = (squares) => [...squares].map((p, sq) => (p ? sq + p : null)).filter(Boolean);

test("reads the pieces of an ordinary FEN, a1 first", () => {
  const squares = parse("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.equal(squares.length, 64);
  assert.equal(squares[0], "R");
  assert.equal(squares[4], "K");
  assert.equal(squares[60], "k");
  assert.equal(squares[28], null);
});

test("draws a Crazyhouse position: the board, without its pockets or marks", () => {
  const plain = parse("4k3/8/8/8/8/8/8/Q3K3 b - - 0 1");
  const crazy = parse("4k3/8/8/8/8/8/8/Q~3K3[QRbnpp] b - - 0 1");
  assert.deepEqual(placed(crazy), placed(plain));
  assert.deepEqual(placed(parse("4k3/8/8/8/8/8/8/4K3[] w - - 0 1")), ["4K", "60k"]);
  assert.equal(turnOf("4k3/8/8/8/8/8/8/Q~3K3[Qp] b - - 0 1"), "b");
});

test("returns null for what it cannot draw", () => {
  for (const bad of [
    null, 42, "", "8/8/8 w - - 0 1", "9/8/8/8/8/8/8/8 w - - 0 1",
    "4k3/8/8/8/8/8/8/4K3[Q]x w - - 0 1", "4k3/8/8/8/8/8/8/4X3 w - - 0 1",
  ]) {
    assert.equal(parse(bad), null, String(bad));
  }
});
