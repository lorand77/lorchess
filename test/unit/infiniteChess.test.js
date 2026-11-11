"use strict";

// The infinite chess engine (src/shared/infiniteChess.js): the board, the
// moves, and how a game ends.
//
// The main check is against chess.js. With every piece inside the usual 8x8
// box, a move that stays inside the box is legal on the infinite board exactly
// when it is legal on the ordinary one: no piece outside can attack, block or
// pin, and the Classical rules are the ordinary ones there (castling as a
// two-square king step with the corner rook, promotion on the last rank). So
// on every perft position, and on positions played out from them, the two
// engines must agree move for move inside the box. The rest of the tests are
// about what only exists outside it.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
const { fromFen } = require("../helpers/board");
const perft = require("../fixtures/perft.json");

const LIMIT = InfiniteChess.LIMIT;
const xy = (sq) => ({ x: (sq & 7) + 1, y: (sq >> 3) + 1 });
const text = (from, to, promo) => `${from.x},${from.y}>${to.x},${to.y}${promo || ""}`;

// A chess.js position as an infinite one: same pieces, pawns on their starting
// rank may step twice, and the king and corner rook of each castling right hold
// theirs.
function setupFromChess(chess) {
  const pieces = [];
  const rights = { w: ["K", "Q"], b: ["k", "q"] };
  for (let sq = 0; sq < 64; sq++) {
    const p = chess.squares[sq];
    if (!p) continue;
    const { x, y } = xy(sq);
    const home = p.c === "w" ? 1 : 8;
    let right = false;
    if (p.t === "p") right = y === (p.c === "w" ? 2 : 7);
    if (p.t === "k") right = rights[p.c].some((r) => chess.castling[r]);
    if (p.t === "r") right = y === home && rights[p.c].some((r) => chess.castling[r] && chess.castleRook[r] + 1 === x);
    pieces.push({ t: p.t, c: p.c, x, y, right });
  }
  return {
    pieces,
    turn: chess.turn,
    ep: chess.ep == null ? null : xy(chess.ep),
    halfmove: chess.halfmove,
    fullmove: chess.fullmove,
  };
}

// FEN keeps a castling right per side, ICN per piece. Once a king has moved
// its rooks keep their own rights in ICN, and once both rooks have moved the
// king keeps its; FEN has nothing left either way. The moves are the same, so
// compare the pieces with only the castling rights that can still be used:
// a king's while a partner holds one, a partner's while its king does.
function comparable(inf) {
  const kingRight = {}, partnerRight = {};
  for (const p of inf.board.values()) {
    if (p.t === "k") kingRight[p.c] = p.right;
    else if (p.t !== "p" && p.right) partnerRight[p.c] = true;
  }
  return inf.pieceList().map((s) => {
    const t = s[0].toLowerCase();
    const own = s[0] === t ? "b" : "w";
    if (t === "p") return s;
    const usable = t === "k" ? partnerRight[own] : kingRight[own];
    return usable ? s : s.replace("+", "");
  }).sort();
}

const fromChess = (chess) => {
  const inf = new InfiniteChess();
  inf.setup(setupFromChess(chess));
  return inf;
};

// Every legal move of the side to move that lands inside the 8x8 box.
function movesInBox(inf) {
  const out = [];
  for (const p of [...inf.board.values()]) {
    if (p.c !== inf.turn) continue;
    const from = { x: p.x, y: p.y };
    for (let x = 1; x <= 8; x++) {
      for (let y = 1; y <= 8; y++) {
        for (const promo of p.t === "p" ? [null, ...InfiniteChess.PROMOTIONS] : [null]) {
          const m = inf.findMove(from, { x, y }, promo);
          if (m) out.push(text(m.from, m.to, promo));
        }
      }
    }
  }
  return out.sort();
}

const chessMoves = (chess) =>
  chess.legalMoves().map((m) => text(xy(m.from), xy(m.to), m.promo)).sort();

// A small seeded generator, so a failing playout can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const anon = (pieces, opts = {}) => {
  const inf = new InfiniteChess();
  inf.setup({ pieces, ...opts });
  return inf;
};
const P = (t, c, x, y, right = false) => ({ t, c, x, y, right });
const kings = [P("k", "w", 5, 1), P("k", "b", 5, 8)];

describe("infinite chess, inside the 8x8 box", () => {
  for (const pos of perft) {
    test(`agrees with chess.js: ${pos.name}`, () => {
      const chess = fromFen(pos.fen);
      assert.deepEqual(movesInBox(fromChess(chess)), chessMoves(chess), pos.fen);
    });
  }

  test("agrees with chess.js move by move through random games, and keeps the same state", () => {
    let positions = 0;
    perft.forEach((pos, i) => {
      const random = rng(1000 + i);
      const chess = fromFen(pos.fen);
      const inf = fromChess(chess);
      for (let ply = 0; ply < 16; ply++) {
        const legal = chess.legalMoves();
        if (!legal.length) break;
        const m = legal[Math.floor(random() * legal.length)];
        const played = inf.findMove(xy(m.from), xy(m.to), m.promo);
        assert.ok(played, `${pos.name}, ply ${ply}: ${text(xy(m.from), xy(m.to), m.promo)} refused in ${chess.fen()}`);
        chess.makeMove(m);
        inf.makeMove(played);
        const fresh = fromChess(chess);
        const where = `${pos.name}, ply ${ply + 1}: ${chess.fen()}`;
        assert.deepEqual(comparable(inf), comparable(fresh), where);
        assert.deepEqual([inf.turn, inf.ep, inf.halfmove, inf.fullmove],
          [fresh.turn, fresh.ep, fresh.halfmove, fresh.fullmove], where);
        assert.equal(inf.inCheck(), chess.inCheck(), where);
        assert.deepEqual(movesInBox(inf), chessMoves(chess), where);
        positions++;
      }
    });
    assert.ok(positions > 400, `${positions} positions compared`);
  });
});

describe("infinite chess, off the box", () => {
  test("starts from the Classical setup", () => {
    const inf = new InfiniteChess();
    assert.equal(inf.pieceList().length, 32);
    assert.ok(inf.pieceList().includes("K5,1+") && inf.pieceList().includes("R8,1+") && inf.pieceList().includes("p3,7+"));
    assert.ok(inf.pieceList().includes("N2,1"), "a knight has no special right");
    assert.equal(inf.turn, "w");
  });

  test("sliders go as far as the limit, and no further", () => {
    const inf = anon([...kings, P("r", "w", 1, 1), P("b", "w", 3, 3)]);
    assert.ok(inf.findMove({ x: 1, y: 1 }, { x: 1, y: LIMIT }));
    assert.ok(inf.findMove({ x: 1, y: 1 }, { x: -LIMIT, y: 1 }));
    assert.equal(inf.findMove({ x: 1, y: 1 }, { x: 1, y: LIMIT + 1 }), null);
    assert.ok(inf.findMove({ x: 3, y: 3 }, { x: LIMIT, y: LIMIT }));
    assert.equal(inf.findMove({ x: 3, y: 3 }, { x: -999997, y: -999997 }), null, "the rook on 1,1 is in the way");
    assert.equal(inf.findMove({ x: 3, y: 3 }, { x: 10, y: 11 }), null, "not on a diagonal");
  });

  test("a piece a long way off still blocks, pins and checks", () => {
    const blocked = anon([...kings, P("r", "w", 1, 1), P("n", "b", 1, 500000)]);
    assert.ok(blocked.findMove({ x: 1, y: 1 }, { x: 1, y: 500000 }), "it can take the knight");
    assert.equal(blocked.findMove({ x: 1, y: 1 }, { x: 1, y: 600000 }), null, "but not jump it");

    const pinned = anon([P("k", "w", 5, 1), P("b", "w", 5, 2), P("r", "b", 5, 999999), P("k", "b", 900, 900)]);
    assert.equal(pinned.findMove({ x: 5, y: 2 }, { x: 6, y: 3 }), null, "pinned from 999,997 squares away");

    const check = anon([P("k", "w", 5, 1), P("q", "b", -40000, 1), P("k", "b", 5, 8)]);
    assert.equal(check.inCheck(), true);
    assert.equal(check.findMove({ x: 5, y: 1 }, { x: 4, y: 1 }), null, "still on the queen's rank");
    assert.ok(check.findMove({ x: 5, y: 1 }, { x: 5, y: 2 }));
  });

  test("kings and knights step off the box as anywhere else", () => {
    const inf = anon([...kings, P("n", "w", 1, 1)]);
    assert.ok(inf.findMove({ x: 5, y: 1 }, { x: 5, y: 0 }));
    assert.ok(inf.findMove({ x: 1, y: 1 }, { x: -1, y: 0 }));
    assert.equal(inf.findMove({ x: 1, y: 1 }, { x: -1, y: -1 }), null);
  });

  test("pawns step twice only with their right, and promote only on the last rank", () => {
    const inf = anon([...kings, P("p", "w", 2, 2, true), P("p", "w", 3, 2), P("p", "w", 4, -5, true), P("p", "w", 1, 7)]);
    assert.ok(inf.findMove({ x: 2, y: 2 }, { x: 2, y: 4 }));
    assert.equal(inf.findMove({ x: 3, y: 2 }, { x: 3, y: 4 }), null, "no right, no double step");
    assert.ok(inf.findMove({ x: 4, y: -5 }, { x: 4, y: -3 }), "a pawn far behind the box still holds its right");
    assert.equal(inf.findMove({ x: 1, y: 7 }, { x: 1, y: 8 }), null, "a promotion needs its piece");
    assert.equal(inf.findMove({ x: 1, y: 7 }, { x: 1, y: 8 }, "k"), null);
    assert.equal(inf.findMove({ x: 2, y: 2 }, { x: 2, y: 3 }, "q"), null, "and nothing else names one");
    const promo = inf.findMove({ x: 1, y: 7 }, { x: 1, y: 8 }, "n");
    inf.makeMove(promo);
    assert.ok(inf.pieceList().includes("N1,8"));
    inf.undoMove();
    assert.ok(inf.pieceList().includes("P1,7"));
  });

  test("castles with the nearest piece on the rank, however far, if it holds the right", () => {
    const far = anon([P("k", "w", 5, 1, true), P("r", "w", 100, 1, true), P("k", "b", 5, 8)]);
    const castle = far.findMove({ x: 5, y: 1 }, { x: 7, y: 1 });
    assert.deepEqual(castle.castle, { rookFrom: { x: 100, y: 1 }, rookTo: { x: 6, y: 1 } });
    far.makeMove(castle);
    assert.deepEqual(far.pieceList(), ["K7,1", "R6,1", "k5,8"]);
    far.undoMove();
    assert.deepEqual(far.pieceList(), ["K5,1+", "R100,1+", "k5,8"]);

    // A nearer piece decides: without a right it can't be castled with, with
    // one it can — any piece but a pawn, as the rules have it.
    const knight = (right) => anon([P("k", "w", 5, 1, true), P("n", "w", 50, 1, right), P("r", "w", 100, 1, true), P("k", "b", 5, 8)]);
    assert.equal(knight(false).findMove({ x: 5, y: 1 }, { x: 7, y: 1 }), null);
    assert.deepEqual(knight(true).findMove({ x: 5, y: 1 }, { x: 7, y: 1 }).castle.rookFrom, { x: 50, y: 1 });

    const close = anon([P("k", "w", 5, 1, true), P("r", "w", 7, 1, true), P("k", "b", 5, 8)]);
    assert.equal(close.findMove({ x: 5, y: 1 }, { x: 7, y: 1 }), null, "two squares away is too close");
    const noRight = anon([P("k", "w", 5, 1), P("r", "w", 100, 1, true), P("k", "b", 5, 8)]);
    assert.equal(noRight.findMove({ x: 5, y: 1 }, { x: 7, y: 1 }), null, "the king needs its right too");
  });

  test("castling is judged with the king on the square it passes over", () => {
    // Black's rook on the far side of the king attacks f1 only once the king
    // has stepped off e1 — which the king can't do, being in check already.
    const passing = anon([P("k", "w", 5, 1, true), P("r", "w", 8, 1, true), P("b", "b", 1, 6), P("k", "b", 5, 8)]);
    assert.equal(passing.findMove({ x: 5, y: 1 }, { x: 7, y: 1 }), null, "f1 is attacked from a6");
    const landing = anon([P("k", "w", 5, 1, true), P("r", "w", 8, 1, true), P("r", "b", 7, 1000), P("k", "b", 5, 8)]);
    assert.equal(landing.findMove({ x: 5, y: 1 }, { x: 7, y: 1 }), null, "g1 is attacked from far up the file");
  });

  test("en passant takes the pawn beside, and undo puts everything back", () => {
    const inf = anon([...kings, P("p", "w", 4, 5), P("p", "b", 5, 7, true)], { turn: "b" });
    inf.makeMove(inf.findMove({ x: 5, y: 7 }, { x: 5, y: 5 }));
    assert.deepEqual(inf.ep, { x: 5, y: 6 });
    const before = inf.pieceList();
    const ep = inf.findMove({ x: 4, y: 5 }, { x: 5, y: 6 });
    assert.equal(ep.enpassant, true);
    inf.makeMove(ep);
    assert.deepEqual(inf.pieceList(), ["K5,1", "P5,6", "k5,8"]);
    inf.undoMove();
    assert.deepEqual(inf.pieceList(), before);
    assert.deepEqual(inf.ep, { x: 5, y: 6 });
  });

  test("findMove refuses anything malformed or not the mover's", () => {
    const inf = new InfiniteChess();
    for (const [from, to] of [
      [null, { x: 5, y: 4 }], [{ x: 5, y: 2 }, null], [{ x: "5", y: 2 }, { x: 5, y: 4 }],
      [{ x: 5, y: 2 }, { x: 5.5, y: 4 }], [{ x: 5, y: 2 }, { x: 5, y: Infinity }],
      [{ x: 5, y: 2 }, { x: 5, y: 2 }], [{ x: 5, y: 3 }, { x: 5, y: 4 }], [{ x: 5, y: 7 }, { x: 5, y: 5 }],
    ]) {
      assert.equal(inf.findMove(from, to), null, JSON.stringify([from, to]));
    }
  });

  test("setup refuses what these rules could not reach", () => {
    const bad = [
      [[P("k", "w", 5, 1)], /exactly one king/],
      [[...kings, P("k", "w", 1, 1)], /exactly one king/],
      [[...kings, P("q", "w", 5, 1)], /Two pieces/],
      [[...kings, P("q", "w", LIMIT + 1, 1)], /within/],
      [[...kings, P("q", "w", 1.5, 1)], /within/],
      [[...kings, P("x", "w", 1, 1)], /Not a piece/],
      [[...kings, P("p", "w", 3, 8)], /would have promoted/],
      [[...kings, P("r", "w", 5, 3)], /not to move is in check/],
    ];
    for (const [pieces, message] of bad) {
      const inf = new InfiniteChess();
      assert.throws(() => inf.setup({ pieces }), message);
      assert.equal(inf.pieceList().length, 32, "the old position is kept");
      assert.equal(inf.turn, "w");
    }
    assert.throws(() => anon(kings, { ep: { x: 4, y: 6 } }), /not behind a pawn/);
    assert.throws(() => anon(kings, { turn: "x" }), /Side to move/);
    assert.throws(() => anon(kings, { fullmove: 0 }), /fullmove/);
  });
});

// "Is there any legal move?" without listing them, checked against brute
// force. Every kind of legal move has an example within two squares of the
// box the pieces occupy: a slider's first step, a capture of a checking piece,
// a block between a checker and the king (always between two pieces), and the
// steps of pawns, knights and kings. So trying every square there is exact.
function bruteHasMove(inf) {
  const ps = [...inf.board.values()];
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 2, Math.max(...xs) + 2, Math.min(...ys) - 2, Math.max(...ys) + 2];
  for (const p of ps) {
    if (p.c !== inf.turn) continue;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const promo of p.t === "p" ? [null, "q"] : [null]) {
          if (inf.findMove({ x: p.x, y: p.y }, { x, y }, promo)) return true;
        }
      }
    }
  }
  return false;
}

// Black kings boxed in by rooks on the lines beside them, at random
// distances: sometimes a rook is missing, sometimes a piece gives check, and
// black pieces wander about to block, capture or be pinned. About half have no
// move at all.
function cagePositions(seed, count) {
  const random = rng(seed);
  const r = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const far = () => (random() < 0.5 ? -1 : 1) * r(4, 18);
  const out = [];
  while (out.length < count) {
    const pieces = [P("k", "b", 0, 0)];
    const cage = [P("r", "w", -1, far()), P("r", "w", 1, far()), P("r", "w", far(), -1), P("r", "w", far(), 1)];
    if (random() < 0.3) cage.splice(r(0, 3), 1);
    pieces.push(...cage);
    const check = r(0, 3);
    if (check === 1) pieces.push(P("r", "w", 0, far()));
    if (check === 2) pieces.push(P("r", "w", far(), 0));
    if (check === 3) { const d = r(2, 15); pieces.push(P(random() < 0.5 ? "b" : "q", "w", d, d)); }
    for (let i = r(0, 2); i > 0; i--) pieces.push(P("rbnqp"[r(0, 4)], "b", r(-18, 18), r(-18, 18)));
    pieces.push(P("k", "w", r(-18, 18), r(-18, 18)));
    const inf = new InfiniteChess();
    try { inf.setup({ pieces, turn: "b" }); } catch (e) { continue; }
    out.push(inf);
  }
  return out;
}

// Small positions with every kind of piece and right, either side to move.
function scatteredPositions(seed, count) {
  const random = rng(seed);
  const r = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const out = [];
  while (out.length < count) {
    const pieces = [P("k", "b", r(0, 7), r(0, 7)), P("k", "w", r(-2, 9), r(-2, 9), random() < 0.3)];
    for (let i = r(2, 6); i > 0; i--) {
      pieces.push(P("pnbrqr"[r(0, 5)], random() < 0.6 ? "w" : "b", r(-2, 9), r(-2, 9), random() < 0.3));
    }
    const inf = new InfiniteChess();
    try { inf.setup({ pieces, turn: random() < 0.5 ? "w" : "b" }); } catch (e) { continue; }
    out.push(inf);
  }
  return out;
}

describe("infinite chess, whether any move is left", () => {
  test("agrees with brute force on boxed-in kings, mated and not", () => {
    let none = 0;
    for (const inf of cagePositions(3, 1000)) {
      const has = inf.hasLegalMove();
      assert.equal(has, bruteHasMove(inf), inf.pieceList().join("|"));
      if (!has) none++;
    }
    assert.ok(none > 300, `${none} positions with no move`);
  });

  test("agrees with brute force on scattered positions", () => {
    for (const inf of scatteredPositions(7, 1500)) {
      assert.equal(inf.hasLegalMove(), bruteHasMove(inf), `${inf.turn} ${inf.pieceList().join("|")}`);
    }
  });

  test("finds a block or a capture a long way off", () => {
    // Mate by a rook cage and a check along the rank — unless a black piece
    // far away can come down to block, or take the checker.
    const cage = [P("k", "b", 5, 5), P("r", "w", 4, 100), P("r", "w", 6, 100), P("r", "w", 100, 4),
      P("r", "w", 100, 6), P("r", "w", 100, 5), P("k", "w", -50, -50)];
    const mate = anon(cage, { turn: "b" });
    assert.equal(mate.isCheckmate(), true);
    assert.equal(mate.result(), "1-0");

    const blocker = anon([...cage, P("r", "b", 50, 900)], { turn: "b" });
    assert.equal(blocker.isCheckmate(), false, "the rook drops 895 squares to block");
    assert.ok(blocker.findMove({ x: 50, y: 900 }, { x: 50, y: 5 }));

    const taker = anon([...cage, P("b", "b", 100 - 70000, 5 - 70000)], { turn: "b" });
    assert.equal(taker.isCheckmate(), false, "the bishop takes the checker from 70,000 squares");

    const pinned = anon([...cage, P("r", "b", 5, 6), P("q", "w", 5, 40)], { turn: "b" });
    assert.equal(pinned.isCheckmate(), true, "a pinned piece can't block");
  });

  test("stalemate is a king with nowhere to go and no check", () => {
    const pieces = [P("k", "b", 5, 5), P("r", "w", 4, 100), P("r", "w", 6, 100), P("r", "w", 100, 4),
      P("r", "w", 100, 6), P("k", "w", -50, -50)];
    const stale = anon(pieces, { turn: "b" });
    assert.equal(stale.isStalemate(), true);
    assert.equal(stale.result(), "1/2-1/2");
    const pinnedButFree = anon([...pieces, P("r", "b", 5, 8), P("r", "w", 5, 40)], { turn: "b" });
    assert.equal(pinnedButFree.isStalemate(), false, "a pinned rook still slides along the pin");
  });
});

// Every legal move landing within two squares of the box around all the
// pieces. That holds every capture, every pawn, knight and king move, and in
// check every legal move, since a block lies between two pieces.
function windowMoves(inf) {
  const ps = [...inf.board.values()];
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 2, Math.max(...xs) + 2, Math.min(...ys) - 2, Math.max(...ys) + 2];
  const out = [];
  for (const p of ps) {
    if (p.c !== inf.turn) continue;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const promo of p.t === "p" ? [null, ...InfiniteChess.PROMOTIONS] : [null]) {
          const m = inf.findMove({ x: p.x, y: p.y }, { x, y }, promo);
          if (m) out.push(m);
        }
      }
    }
  }
  return out;
}

const keyOfMove = (m) => text(m.from, m.to, m.promo);

// Positions from random games played with the candidate list itself.
function playedPositions(seed, games, plies) {
  const random = rng(seed);
  const out = [];
  for (let g = 0; g < games; g++) {
    const inf = new InfiniteChess();
    for (let i = 0; i < plies && !inf.isGameOver(); i++) {
      const moves = inf.candidateMoves();
      inf.makeMove(moves[Math.floor(random() * moves.length)]);
      if (i % 4 === 3) {
        const copy = new InfiniteChess();
        copy.loadFen(inf.fen());
        out.push(copy);
      }
    }
  }
  return out;
}

describe("infinite chess, candidate moves", () => {
  const POSITIONS = [
    new InfiniteChess(),
    ...scatteredPositions(11, 250),
    ...cagePositions(5, 150),
    ...playedPositions(13, 4, 32),
  ];

  test("every candidate is legal, and none is listed twice", () => {
    for (const inf of POSITIONS) {
      const keys = new Set();
      for (const m of inf.candidateMoves()) {
        assert.deepEqual(inf.findMove(m.from, m.to, m.promo), m, inf.fen());
        assert.ok(!keys.has(keyOfMove(m)), `${keyOfMove(m)} twice in ${inf.fen()}`);
        keys.add(keyOfMove(m));
      }
    }
  });

  test("holds every pawn, knight and king move, every capture, and in check every move", () => {
    let checked = 0;
    for (const inf of POSITIONS) {
      const listed = new Set(inf.candidateMoves().map(keyOfMove));
      const all = windowMoves(inf);
      const inCheck = inf.inCheck();
      if (inCheck) {
        checked++;
        assert.deepEqual([...listed].sort(), all.map(keyOfMove).sort(), inf.fen());
        continue;
      }
      for (const m of all) {
        if (m.piece === "p" || m.piece === "n" || m.piece === "k" || m.capture) {
          assert.ok(listed.has(keyOfMove(m)), `${keyOfMove(m)} missing from ${inf.fen()}`);
        }
      }
    }
    assert.ok(checked > 50, `${checked} positions in check`);
  });

  test("holds every check a slider gives from a line it was not already on", () => {
    let checks = 0;
    for (const inf of POSITIONS) {
      if (inf.inCheck()) continue;
      const listed = new Set(inf.candidateMoves().map(keyOfMove));
      const enemy = inf.kingOf(inf.turn === "w" ? "b" : "w");
      for (const m of windowMoves(inf)) {
        if (m.piece === "p" || m.piece === "n" || m.piece === "k") continue;
        inf.makeMove(m, false);
        const gives = inf.attacks(inf.pieceAt(m.to.x, m.to.y), enemy.x, enemy.y);
        inf.undoMove();
        // Sliding along the line it already checks on gives check from every
        // square of it, and only some of those are listed.
        const along = (m.to.x - m.from.x) * (enemy.y - m.to.y) === (m.to.y - m.from.y) * (enemy.x - m.to.x);
        if (!gives || along) continue;
        checks++;
        assert.ok(listed.has(keyOfMove(m)), `check ${keyOfMove(m)} missing from ${inf.fen()}`);
      }
    }
    assert.ok(checks > 100, `${checks} checks`);
  });

  test("captures only: the full list's captures, no more and no fewer", () => {
    for (const inf of POSITIONS) {
      if (inf.inCheck()) continue;
      assert.deepEqual(inf.candidateMoves(true).map(keyOfMove).sort(),
        inf.candidateMoves().filter((m) => m.capture).map(keyOfMove).sort(), inf.fen());
    }
  });

  test("is empty exactly when there is no legal move", () => {
    let none = 0;
    for (const inf of cagePositions(3, 400)) {
      const has = inf.hasLegalMove();
      assert.equal(inf.candidateMoves().length > 0, has, inf.fen());
      if (!has) none++;
    }
    assert.ok(none > 100, `${none} positions with no move`);
  });

  test("a free slider gets its first step, the squares beside pieces, and the lines onto the king", () => {
    const rookMoves = (pieces) => anon(pieces).candidateMoves()
      .filter((m) => m.piece === "r").map((m) => `${m.to.x},${m.to.y}`).sort();
    // Lines through the black king and the squares beside it: files 9-11 to
    // the right, ranks 9-11 up. The white pawn at 3,1 stands beside 2,0-4,0.
    assert.deepEqual(rookMoves([P("r", "w", 0, 0), P("k", "b", 10, 10), P("k", "w", -5, -5), P("p", "w", 3, 1)]),
      ["-1,0", "0,-1", "0,1", "0,10", "0,11", "0,9", "1,0", "10,0", "11,0", "2,0", "3,0", "4,0", "9,0"]);
    // However far away the king, and no further than the limit.
    const far = rookMoves([P("r", "w", 0, 0), P("k", "b", 500000, 3), P("k", "w", -5, -5)]);
    assert.ok(far.includes("500000,0") && far.includes("0,3"), far.join(" "));
    const edge = rookMoves([P("r", "w", LIMIT - 1, 0), P("k", "b", 10, 10), P("k", "w", -5, -5)]);
    assert.ok(edge.includes(`${LIMIT},0`) && !edge.some((s) => Number(s.split(",")[0]) > LIMIT), edge.join(" "));
  });

  test("a far block or capture is listed, and a pinned piece's moves stay on the pin", () => {
    const cage = [P("k", "b", 5, 5), P("r", "w", 4, 100), P("r", "w", 6, 100), P("r", "w", 100, 4),
      P("r", "w", 100, 6), P("r", "w", 100, 5), P("k", "w", -50, -50)];
    const listed = (inf) => inf.candidateMoves().map(keyOfMove);
    assert.ok(listed(anon([...cage, P("r", "b", 50, 900)], { turn: "b" })).includes("50,900>50,5"));
    assert.ok(listed(anon([...cage, P("b", "b", 100 - 70000, 5 - 70000)], { turn: "b" })).includes(`${100 - 70000},${5 - 70000}>100,5`));
    const pinned = anon([P("k", "b", 5, 5), P("r", "b", 5, 8), P("r", "w", 5, 40), P("k", "w", -50, -50)], { turn: "b" });
    const rook = pinned.candidateMoves().filter((m) => m.piece === "r");
    assert.ok(rook.length > 0 && rook.every((m) => m.to.x === 5), rook.map(keyOfMove).join(" "));
    assert.ok(rook.some((m) => m.capture), "taking the pinner");
  });

  test("offers about as many moves as ordinary chess from the start", () => {
    assert.equal(new InfiniteChess().candidateMoves().length, 45);
  });
});

describe("infinite chess, how a game ends", () => {
  test("a game in progress is undecided", () => {
    const inf = new InfiniteChess();
    assert.equal(inf.isGameOver(), false);
    assert.equal(inf.result(), "*");
  });

  test("threefold repetition, with special rights part of the position", () => {
    const knights = new InfiniteChess();
    const shuffle = () => {
      for (const [a, b] of [[[7, 1], [6, 3]], [[7, 8], [6, 6]], [[6, 3], [7, 1]], [[6, 6], [7, 8]]]) {
        knights.makeMove(knights.findMove({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }));
      }
    };
    shuffle();
    assert.equal(knights.isThreefoldRepetition(), false);
    shuffle();
    assert.equal(knights.isThreefoldRepetition(), true);
    assert.equal(knights.result(), "1/2-1/2");

    // A king that steps out and back has lost its right: not the same position.
    const king = anon([P("k", "w", 5, 1, true), P("r", "w", 8, 1, true), P("k", "b", 5, 8)]);
    const out = () => king.makeMove(king.findMove({ x: 5, y: 1 }, { x: 5, y: 2 }));
    const back = () => king.makeMove(king.findMove({ x: 5, y: 2 }, { x: 5, y: 1 }));
    const blackOut = () => king.makeMove(king.findMove({ x: 5, y: 8 }, { x: 5, y: 7 }));
    const blackBack = () => king.makeMove(king.findMove({ x: 5, y: 7 }, { x: 5, y: 8 }));
    for (let i = 0; i < 2; i++) { out(); blackOut(); back(); blackBack(); }
    assert.equal(king.isThreefoldRepetition(), false, "the first position had the right");
    out(); blackOut(); back(); blackBack();
    assert.equal(king.isThreefoldRepetition(), true);
  });

  test("an en passant square counts only while the capture is legal", () => {
    const withEp = anon([...kings, P("p", "w", 4, 5), P("p", "b", 5, 5)], { ep: { x: 5, y: 6 } });
    const without = anon([...kings, P("p", "w", 4, 5), P("p", "b", 5, 5)]);
    assert.notEqual(withEp.positionKey(), without.positionKey());
    const noTaker = anon([...kings, P("p", "b", 5, 5)], { ep: { x: 5, y: 6 } });
    assert.equal(noTaker.positionKey(), anon([...kings, P("p", "b", 5, 5)]).positionKey());
  });

  test("the 50-move rule draws, but mate on the same move still wins", () => {
    const fifty = anon([...kings, P("n", "w", 1, 1)], { halfmove: 100 });
    assert.equal(fifty.isGameOver(), true);
    assert.equal(fifty.result(), "1/2-1/2");
    const pieces = [P("k", "b", 5, 5), P("r", "w", 4, 100), P("r", "w", 6, 100), P("r", "w", 100, 4),
      P("r", "w", 100, 6), P("r", "w", 100, 5), P("k", "w", -50, -50)];
    assert.equal(anon(pieces, { turn: "b", halfmove: 100 }).result(), "1-0");
  });

  test("dead material follows infinitechess.org's table", () => {
    const dead = (extra) => anon([...kings, ...extra]).isInsufficientMaterial();
    assert.equal(dead([]), true, "bare kings");
    assert.equal(dead([P("q", "w", 1, 1)]), true, "a queen can't mate on a board with no edges");
    assert.equal(dead([P("q", "w", 1, 1), P("q", "b", 8, 8)]), true);
    assert.equal(dead([P("r", "w", 1, 1), P("r", "b", 8, 8)]), true);
    assert.equal(dead([P("b", "w", 1, 1), P("b", "w", 2, 1)]), true, "two bishops can't either");
    assert.equal(dead([P("b", "w", 1, 1), P("b", "w", 3, 1), P("b", "w", 5, 3), P("b", "w", 2, 1)]), true,
      "any number on one colour and one on the other");
    assert.equal(dead([P("b", "w", 1, 1), P("b", "w", 3, 1), P("b", "w", 2, 1), P("b", "w", 4, 1)]), false,
      "two on each colour can");
    assert.equal(dead([P("q", "w", 1, 1), P("r", "w", 2, 1)]), false, "queen and rook can");
    assert.equal(dead([P("r", "w", 1, 1), P("r", "w", 2, 3)]), false, "two rooks can");
    assert.equal(dead([P("n", "w", 1, 1), P("n", "w", 2, 1), P("n", "w", 3, 1)]), true, "three knights can't");
    assert.equal(dead([P("p", "w", 1, 2)]), true, "a lone pawn can't, whatever it becomes");
    assert.equal(dead([P("p", "w", 1, 2), P("p", "w", 2, 2), P("p", "w", 3, 2)]), false,
      "three promotable pawns: never called dead");
    // White's two bishops and Black's one: dead whatever colour Black's is on.
    assert.equal(dead([P("b", "w", 1, 1), P("b", "w", 2, 1), P("b", "b", 3, 3)]), true);
    assert.equal(dead([P("b", "w", 1, 1), P("b", "w", 2, 1), P("b", "b", 4, 3)]), true);
    // Read either way round: a black queen alone is as dead as a white one.
    assert.equal(dead([P("q", "b", 1, 1)]), true);
    // More than ten pieces is never dead, whatever the table says.
    const bishops = [1, 3, 5, 7, 9, 11, 13, 15, 17].map((x) => P("b", "w", x, 3));
    assert.equal(dead(bishops), false);
    assert.equal(dead(bishops.slice(1)), true);
  });

  test("a flag draws when the side on time couldn't mate", () => {
    const can = (extra, c) => anon([...kings, ...extra]).hasMatingMaterial(c);
    assert.equal(can([], "w"), false, "a bare king never can");
    assert.equal(can([P("q", "b", 1, 1), P("r", "b", 2, 2)], "w"), false, "nor against any material");
    assert.equal(can([P("q", "w", 1, 1)], "w"), false, "a queen can't on this board");
    assert.equal(can([P("q", "w", 1, 1), P("r", "w", 2, 3)], "w"), true);
    assert.equal(can([P("q", "b", 1, 1), P("r", "b", 2, 3)], "b"), true, "and the same for Black");
    assert.equal(can([P("q", "b", 1, 1)], "b"), false);
    assert.equal(can([P("p", "w", 1, 2), P("p", "w", 2, 2), P("p", "w", 3, 2)], "w"), true,
      "three pawns: assumed able");
  });
});

describe("infinite chess, notation", () => {
  // The two example positions in the ICN spec (github.com/tsevasa/infinite-chess-notation).
  const SPEC_START = "w 0/100 1 (8|1) checkmate P1,2+|P2,2+|P3,2+|P4,2+|P5,2+|P6,2+|P7,2+|P8,2+|" +
    "p1,7+|p2,7+|p3,7+|p4,7+|p5,7+|p6,7+|p7,7+|p8,7+|R1,1+|R8,1+|r1,8+|r8,8+|N2,1|N7,1|n2,8|n7,8|" +
    "B3,1|B6,1|b3,8|b6,8|Q4,1|q4,8|K5,1+|k5,8+";
  const SPEC_AFTER_D4 = "b 4,3 0/100 1 (8|1) checkmate P1,2+|P2,2+|P3,2+|P4,4|P5,2+|P6,2+|P7,2+|P8,2+|" +
    "p1,7+|p2,7+|p3,7+|p4,7+|p5,7+|p6,7+|p7,7+|p8,7+|R1,1+|R8,1+|r1,8+|r8,8+|N2,1|N7,1|n2,8|n7,8|" +
    "B3,1|B6,1|b3,8|b6,8|Q4,1|q4,8|K5,1+|k5,8+";

  const loaded = (text) => {
    const inf = new InfiniteChess();
    inf.loadFen(text);
    return inf;
  };

  test("reads the spec's own positions, and they are ours", () => {
    const start = new InfiniteChess();
    assert.equal(loaded(SPEC_START).fen(), start.fen());
    start.makeMove(start.findMove({ x: 4, y: 2 }, { x: 4, y: 4 }));
    assert.equal(loaded(SPEC_AFTER_D4).fen(), start.fen());
    assert.ok(start.fen().startsWith("b 4,3 0/100 1 (8|1) checkmate "));
  });

  test("writes what it reads, for every kind of position", () => {
    const positions = [...cagePositions(21, 150), ...scatteredPositions(22, 150)];
    const played = new InfiniteChess();
    for (const [a, b] of [[[5, 2], [5, 4]], [[4, 7], [4, 5]], [[5, 4], [4, 5]], [[4, 8], [4, 5]], [[7, 1], [6, 3]]]) {
      played.makeMove(played.findMove({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }));
      positions.push(loaded(played.fen()));
    }
    for (const inf of positions) {
      const again = loaded(inf.fen());
      assert.equal(again.fen(), inf.fen());
      assert.equal(again.positionKey(), inf.positionKey());
    }
  });

  test("takes the fields ICN lets you leave out, and the spelled-out promotions", () => {
    const short = loaded("0/100 (8|1) K5,1|k5,8|Q1,1");
    assert.equal(short.turn, "w");
    assert.equal(short.fullmove, 1);
    const long = loaded("b 7/100 30 (8;Q,R,B,N|1;q,r,b,n) checkmate K-5,-1000|k5,8|Q1,1");
    assert.deepEqual([long.turn, long.halfmove, long.fullmove], ["b", 7, 30]);
    assert.ok(long.pieceList().includes("K-5,-1000"));
  });

  test("refuses anything these rules don't play, and keeps the position it had", () => {
    for (const [text, message] of [
      ["w 1 (8|1) checkmate K5,1|k5,8", /move rule/],
      ["w 0/50 1 (8|1) checkmate K5,1|k5,8", /50-ply/],
      ["w 0/100 1 checkmate K5,1|k5,8", /promotion ranks/],
      ["w 0/100 1 (8|-8) checkmate K5,1|k5,8", /promotions/],
      ["w 0/100 1 (8;Q,AM|1) checkmate K5,1|k5,8", /promotions/],
      ["w 0/100 1 (8|1) allpiecescaptured K5,1|k5,8", /allpiecescaptured/],
      ['[Variant "Classical"] w 0/100 1 (8|1) checkmate K5,1|k5,8', /not part of these rules/],
      ["w 0/100 1 (8|1) checkmate Rays:1,1>0,1 K5,1|k5,8", /not part of these rules/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|AM1,1", /not a piece/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|3q1,1", /not a piece/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|Q-0,1", /not a piece/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|Q01,1", /not a piece/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|Q1000001,1", /within/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|Q5,1", /Two pieces/],
      ["w 0/100 1 (8|1) checkmate K5,1|k5,8|P3,8", /would have promoted/],
      ["w 0/100 1 (8|1) checkmate K5,1", /exactly one king/],
      ["", /move rule/],
    ]) {
      const inf = new InfiniteChess();
      const before = inf.fen();
      assert.throws(() => inf.loadFen(text), message, text);
      assert.equal(inf.fen(), before, text);
    }
  });

  test("writes moves for the move list in ICN's long form", () => {
    const start = new InfiniteChess();
    const san = (inf, a, b, promo) => inf.moveToSan(inf.findMove({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, promo));
    assert.equal(san(start, [5, 2], [5, 4]), "P5,2>5,4");
    assert.equal(san(start, [7, 1], [6, 3]), "N7,1>6,3");
    const capture = loaded("w 0/100 1 (8|1) checkmate K5,1|k5,8|R1,1|n1,500000");
    assert.equal(san(capture, [1, 1], [1, 500000]), "R1,1x1,500000");
    const promote = loaded("w 0/100 1 (8|1) checkmate K-10,1|k10,8|P1,7");
    assert.equal(san(promote, [1, 7], [1, 8], "q"), "P1,7>1,8=Q+");
    const blackPromote = loaded("b 0/100 1 (8|1) checkmate K-10,1|k10,8|p1,2");
    assert.equal(san(blackPromote, [1, 2], [1, 1], "n"), "p1,2>1,1=n");
    const castle = loaded("w 0/100 1 (8|1) checkmate K5,1+|R8,1+|k5,8");
    assert.equal(san(castle, [5, 1], [7, 1]), "K5,1>7,1");
    // The rook cage: a rook on the king's rank mates.
    const mate = loaded("w 0/100 1 (8|1) checkmate k5,5|R4,100|R6,100|R100,4|R100,6|R150,10|K-50,-50");
    assert.equal(san(mate, [150, 10], [150, 5]), "R150,10>150,5#");
    assert.equal(mate.fen(), loaded(mate.fen()).fen(), "and naming it changed nothing");
  });
});

