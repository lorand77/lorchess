"use strict";

// Building four-player positions for tests (src/shared/fourPlayer.js): a
// position from a map of squares to pieces, four kings out of the way, and the
// same position turned a quarter with every colour one seat on — the board's
// own symmetry, which the engine and LorFish's evaluation are both held to.

const { FourPlayer } = require("../../src/shared/fourPlayer");

const sq = (name) => FourPlayer.squareOf(name);

// A position from a map of squares to pieces ({ h1: "rK", ... }), with no
// castling rights unless given ("rk" for Red's kingside, "bq", ...).
function position(turn, pieces, { castling = "", halfmove = 0 } = {}) {
  const rows = [];
  for (let y = 13; y >= 0; y--) {
    const cells = [];
    let empty = 0;
    for (let x = 0; x < 14; x++) {
      const name = String.fromCharCode(97 + x) + (y + 1);
      if (!pieces[name]) { empty++; continue; }
      if (empty) { cells.push(String(empty)); empty = 0; }
      cells.push(pieces[name]);
    }
    if (empty) cells.push(String(empty));
    rows.push(cells.join(","));
  }
  const flag = (side) => ["r", "b", "y", "g"].map((c) => (castling.includes(c + side) ? 1 : 0)).join(",");
  const g = new FourPlayer();
  g.loadFen(`${turn.toUpperCase()}-0,0,0,0-${flag("k")}-${flag("q")}-0,0,0,0-${halfmove}-${rows.join("/")}`);
  return g;
}
// Four kings, out of each other's way, for positions that need little else.
const KINGS = { h1: "rK", a7: "bK", g14: "yK", n8: "gK" };

// The same position turned a quarter clockwise, every colour one seat on.
const NEXT = { r: "b", b: "y", y: "g", g: "r" };
function turned(g) {
  const t = new FourPlayer();
  t.squares = new Array(196).fill(null);
  g.squares.forEach((p, i) => {
    if (!p) return;
    const [x, y] = FourPlayer.rotate(i % 14, Math.floor(i / 14), 1);
    t.squares[FourPlayer.sqOf(x, y)] = { t: p.t, c: NEXT[p.c] };
  });
  t.turn = NEXT[g.turn];
  t.castling = {};
  for (const c of ["r", "b", "y", "g"]) t.castling[NEXT[c]] = Object.assign({}, g.castling[c]);
  const turnSq = (s) => FourPlayer.sqOf(...FourPlayer.rotate(s % 14, Math.floor(s / 14), 1));
  t.ep = g.ep ? { passed: turnSq(g.ep.passed), pawn: turnSq(g.ep.pawn) } : null;
  t.halfmove = g.halfmove;
  t.history = [];
  t.positionCounts = new Map([[t.positionKey(), 1]]);
  return t;
}
const turnText = (text) => {
  const m = /^([a-n]\d+)([a-n]\d+)(.?)$/.exec(text);
  const one = (name) => {
    const s = sq(name);
    return FourPlayer.nameOf(FourPlayer.sqOf(...FourPlayer.rotate(s % 14, Math.floor(s / 14), 1)));
  };
  return one(m[1]) + one(m[2]) + m[3];
};

module.exports = { position, KINGS, turned, turnText };
