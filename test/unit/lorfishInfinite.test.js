"use strict";

// LorFish for infinite chess (src/shared/lorfishInfinite.js): the search over
// the engine's candidate moves. Its tactics a long way off, how it scores the
// end of a game, and that its root pruning never changes the move it plays.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LorFishInfinite: E } = require("../../src/shared/lorfishInfinite");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
const { seeded } = require("../helpers/random");

const load = (text) => {
  const c = new InfiniteChess();
  c.loadFen(text);
  return c;
};
const pos = (turn, pieces) => load(`${turn} 0/100 1 (8|1) checkmate ${pieces}`);
// A black king on 5,5 that can't move: rooks hold the files and ranks beside it.
const CAGE = "k5,5|R4,100|R6,100|R100,4|R100,6|K-50,-50";

test("mates with a rook from far off, onto the king's file or rank", () => {
  const a = E.analyse(pos("w", `${CAGE}|R200,50`), 1);
  assert.ok(["R200,50>5,50#", "R200,50>200,5#"].includes(a.san), a.san);
  assert.equal(a.score, E.MATE - 1);
});

test("takes a queen left hanging a long way off", () => {
  assert.equal(E.analyse(pos("w", "k5,8|q40,3|R1,3|K-50,-50"), 1).san, "R1,3x40,3");
});

test("looks past the horizon: a pawn guarded from far off is left alone", () => {
  // Rx1,20 wins a pawn at depth 1, then the rook on 30,20 takes back.
  const a = E.analyse(pos("w", "k5,8|p1,20|r30,20|p8,7|R1,1|P8,2|K-50,-50"), 1);
  assert.notEqual(a.san, "R1,1x1,20");
});

test("moves its queen out of an attack rather than lose it", () => {
  // (A white rook as well: a queen against a rook alone is dead material on
  // a board without edges, and every line scores a draw.)
  // Moving it, or first a check the rook on 1,20 must answer: either way the
  // queen is still White's when the search ends.
  const a = E.analyse(pos("w", "k5,8|r1,20|Q30,20|R-40,-40|K-50,-50"), 2);
  assert.ok(a.score > E.pieceValues.q / 2, `${a.san} ${a.score}`);
});

test("sees the mate coming and stops it, however far the defender", () => {
  // White threatens R200,50>5,50#. Black's rook comes down to the king's file.
  const a = E.analyse(pos("b", `${CAGE}|R200,50|r30,30`), 2);
  assert.ok(a.score > -E.MATE + 100, `${a.san} ${a.score}`);
});

test("a mated side scores a loss, a stalemated one a draw", () => {
  const mated = pos("b", `${CAGE}|R100,5`);
  E.rootPly = mated.history.length;
  E.rootSide = "b";
  assert.equal(E.negamax(mated, 1, -Infinity, Infinity), -E.MATE);
  const stalemated = pos("b", CAGE);
  assert.equal(E.negamax(stalemated, 1, -Infinity, Infinity), -E.CONTEMPT, "a draw, a little worse for LorFish");
  E.rootSide = "w";
  assert.equal(E.negamax(stalemated, 1, -Infinity, Infinity), E.CONTEMPT, "and a little better for its opponent");
  assert.equal(E.analyse(stalemated, 1), null, "nothing to search");
});

test("plays on rather than repeat, unless every other line is worse", () => {
  // White has just shuffled its king out and back; going out again would
  // repeat the position a second time in the game.
  const c = pos("w", "k5,8|r1,8|p8,7|R1,1|P8,2|K-50,-50");
  for (const [f, t] of [[[-50, -50], [-50, -49]], [[5, 8], [5, 9]], [[-50, -49], [-50, -50]], [[5, 9], [5, 8]]]) {
    c.makeMove(c.findMove({ x: f[0], y: f[1] }, { x: t[0], y: t[1] }));
  }
  const { evals } = E.searchRoot(c, 1, {});
  const repeat = evals.find((e) => e.san === "K-50,-50>-50,-49");
  assert.equal(repeat.raw, -E.CONTEMPT, "repeating scores below level for LorFish");
  assert.notEqual(E.analyse(c, 1).san, "K-50,-50>-50,-49");
});

test("a repeated position and the 50-move rule are draws", () => {
  // Pawns on both sides, so the material is never dead: only the rules draw.
  const fifty = load(`w 100/100 60 (8|1) checkmate k5,8|r1,8|p8,7|R1,1|P8,2|K-50,-50`);
  assert.equal(E.isDraw(fifty), true);
  assert.equal(E.isDraw(load(`w 99/100 60 (8|1) checkmate k5,8|r1,8|p8,7|R1,1|P8,2|K-50,-50`)), false);
  const shuffle = pos("w", "k5,8|r1,8|p8,7|R1,1|P8,2|K-50,-50");
  assert.equal(E.isDraw(shuffle), false);
  for (const [from, to] of [["-50,-50", "-50,-49"], ["5,8", "5,9"], ["-50,-49", "-50,-50"], ["5,9", "5,8"]]) {
    const [fx, fy] = from.split(",").map(Number), [tx, ty] = to.split(",").map(Number);
    shuffle.makeMove(shuffle.findMove({ x: fx, y: fy }, { x: tx, y: ty }));
  }
  assert.equal(E.isDraw(shuffle), true, "a second time");
});

test("the same position gets the same verdict, however the board got there", () => {
  const fresh = new InfiniteChess();
  const used = new InfiniteChess();
  E.searchRoot(used, 2, {});   // makes and takes back moves, reordering its pieces
  assert.deepEqual(E.searchRoot(used, 2, { noise: true, rng: seeded(1) }).best.san,
    E.searchRoot(fresh, 2, { noise: true, rng: seeded(1) }).best.san);
});

test("the pruned root plays the move the full search plays", () => {
  const random = seeded(3);
  const positions = [new InfiniteChess(), pos("w", "k5,8|q40,3|R1,3|K-50,-50"), pos("b", `${CAGE}|R200,50|r30,30`)];
  const played = new InfiniteChess();
  for (let i = 0; i < 16; i++) {
    const ms = played.candidateMoves();
    played.makeMove(ms[Math.floor(random() * ms.length)]);
  }
  positions.push(load(played.fen()));
  positions.forEach((c, i) => {
    const full = E.searchRoot(c, 2, { noise: true, rng: seeded(i) }).best;
    const fast = E.searchRoot(c, 2, { noise: true, prune: true, rng: seeded(i) }).best;
    assert.deepEqual([fast.san, fast.raw], [full.san, full.raw], c.fen());
  });
});

test("a hot level plays legal, varied moves", () => {
  const chess = new InfiniteChess();
  const rng = seeded(9);
  const firsts = new Set();
  for (let i = 0; i < 30; i++) {
    const m = E.getBestMove(chess, 1, { temperature: 100, rng });
    assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${i + 1}`);
    if (i === 0) firsts.add(E.moveKey(m));
    chess.makeMove(m);
  }
  for (let s = 0; s < 8; s++) firsts.add(E.moveKey(E.getBestMove(new InfiniteChess(), 1, { temperature: 100, rng: seeded(s) })));
  assert.ok(firsts.size > 3, `${firsts.size} different first moves`);
});

// The same position with the colours swapped and the board turned over
// (rank y becomes 9 - y): it must look the same to the side to move.
const mirror = (chess) => {
  const flip = (s) => {
    const [, letter, x, y, right] = /^([a-zA-Z])(-?\d+),(-?\d+)(\+?)$/.exec(s);
    const other = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
    return `${other}${x},${9 - Number(y)}${right}`;
  };
  return pos(chess.turn === "w" ? "b" : "w", chess.pieceList().map(flip).join("|"));
};

test("the evaluation is the same for either colour, and level at the start", () => {
  assert.equal(E.evaluate(new InfiniteChess()), 0);
  const random = seeded(21);
  const c = new InfiniteChess();
  for (let i = 0; i < 40 && !c.isGameOver(); i++) {
    const ms = c.candidateMoves();
    c.makeMove(ms[Math.floor(random() * ms.length)]);
    if (c.ep) continue;   // the mirror leaves out the en passant square
    assert.equal(E.evaluate(mirror(c)), E.evaluate(c), c.fen());
  }
});

test("a rook outweighs a bishop, and a bishop a knight, on a board without edges", () => {
  const v = E.pieceValues;
  assert.ok(v.q > v.r && v.r > v.b && v.b > v.n && v.n > v.p);
});

test("a piece far from the enemy king counts for less", () => {
  const near = E.evaluate(pos("w", "k5,8|p1,7|P1,2|N6,5|K5,1"));
  const far = E.evaluate(pos("w", "k5,8|p1,7|P1,2|N60,5|K5,1"));
  const outOfPlay = E.evaluate(pos("w", "k5,8|p1,7|P1,2|N6000,5|K5,1"));
  assert.ok(near > far, `${near} vs ${far}`);
  assert.equal(far - outOfPlay, 0, "past forty squares it is simply out of play");
  assert.equal(E.strayPenalty({ t: "r", x: 5, y: 20 }, { x: 5, y: 8 }), 0, "a rook within 16 squares pays nothing");
});

test("a king with open lines around it is in danger, if the enemy has sliders to use them", () => {
  const sheltered = pos("w", "k5,8|r1,8|K5,1|P4,2|P5,2|P6,2|P4,0|P5,0|P6,0|B4,1|B6,1");
  const open = pos("w", "k5,8|r1,8|K5,1|P4,2|P5,2|P6,2|B4,1|B6,1");
  const rooks = { line: 1, diag: 0 }, none = { line: 0, diag: 0 };
  const kOf = (c) => c.kingOf("w");
  assert.ok(E.kingDanger(open, kOf(open), rooks) > E.kingDanger(sheltered, kOf(sheltered), rooks));
  // Open below: the file down is a road for the rook; the diagonals are not,
  // since Black has no bishop or queen.
  assert.equal(E.kingDanger(open, kOf(open), rooks) - E.kingDanger(open, kOf(open), none), E.OPEN_LINE);
  // A piece far off along a line closes nothing: something can come between.
  const distant = pos("w", "k5,8|r1,8|K5,1|P4,2|P5,2|P6,2|P5,-30|B4,1|B6,1");
  assert.equal(E.kingDanger(distant, kOf(distant), rooks), E.kingDanger(open, kOf(open), rooks));
});

test("a pawn is worth more the nearer it is to promoting, and more again when passed", () => {
  const at = (y, blockers = "") => E.pawnBonus(pos("w", `k5,8|K5,1|P3,${y}${blockers}`), { t: "p", c: "w", x: 3, y });
  assert.ok(at(6) > at(4) && at(4) > at(2));
  assert.ok(at(5) > at(5, "|p4,7"), "an enemy pawn ahead on the next file stops it being passed");
  assert.equal(at(5, "|p4,3"), at(5), "one behind does not");
  assert.equal(E.pawnBonus(pos("b", "k5,8|K5,1|p3,3"), { t: "p", c: "b", x: 3, y: 3 }), at(6), "Black's run the other way");
});
