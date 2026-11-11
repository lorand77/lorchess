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
  const a = E.analyse(pos("w", "k5,8|r1,20|Q30,20|R-40,-40|K-50,-50"), 2);
  assert.ok(a.san.startsWith("Q30,20"), a.san);
  assert.ok(a.score > 0, String(a.score));
});

test("sees the mate coming and stops it, however far the defender", () => {
  // White threatens R200,50>5,50#. Black's rook comes down to the king's file.
  const a = E.analyse(pos("b", `${CAGE}|R200,50|r30,30`), 2);
  assert.ok(a.score > -E.MATE + 100, `${a.san} ${a.score}`);
});

test("a mated side scores a loss, a stalemated one a draw", () => {
  const mated = pos("b", `${CAGE}|R100,5`);
  E.rootPly = mated.history.length;
  assert.equal(E.negamax(mated, 1, -Infinity, Infinity), -E.MATE);
  const stalemated = pos("b", CAGE);
  assert.equal(E.negamax(stalemated, 1, -Infinity, Infinity), 0);
  assert.equal(E.analyse(stalemated, 1), null, "nothing to search");
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
