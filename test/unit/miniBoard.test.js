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
const { parse, turnOf, icnWindow } = context.window.MiniBoard;
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

test("draws an infinite-chess position as an 8x8 window around the kings", () => {
  const start = "w 0/100 1 (8|1) checkmate K5,1+|k5,8+|Q4,1|p1,7+";
  const near = icnWindow(start);
  assert.deepEqual([near.x0, near.y0], [1, 1], "the kings' middle, 5,4.5, centres the window");
  assert.equal(near.squares[0 * 8 + 4], "K");
  assert.equal(near.squares[7 * 8 + 4], "k");
  assert.equal(near.squares[6 * 8 + 0], "p");
  // Kings too far apart for one window: White's king and its surroundings.
  const far = icnWindow("w 0/100 1 (8|1) checkmate K-500,30|k5,8|B-499,31");
  assert.deepEqual([far.x0, far.y0], [-504, 26]);
  assert.equal(far.squares.filter(Boolean).join(""), "KB");
  assert.equal(icnWindow("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"), null, "a FEN is not ICN");
  assert.equal(icnWindow("w 0/100 1 (8|1) checkmate K5,1|Q4,1"), null, "two kings wanted");
});
