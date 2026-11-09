"use strict";

// The infinite chess engine (src/shared/infiniteChess.js): the board and the
// moves; how a game ends comes later.
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
