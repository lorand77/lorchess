"use strict";

// Fog of War in the rules engine (src/shared/chess.js, variant 'fog'). The
// rules: no check or mate, so a king may step into attack and castle through
// it, and taking the king wins; no stalemate, a side with no move at all
// draws; threefold and fifty moves draw; material never runs out. The fog:
// a side sees its own pieces and the squares they can move to, and fogView
// gives it the position as it sees it. The view is enough to move from: the
// moves worked out on it are the real ones, with the same notation.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, W, B } = require("../../src/shared/chess");

const fog = (fen) => {
  const c = new Chess().setVariant("fog");
  if (fen) c.loadFen(fen);
  else c.reset();
  return c;
};
const sqOf = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
const nameOf = (sq) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const play = (c, ...ucis) => {
  for (const u of ucis) {
    const m = c.findMove(sqOf(u.slice(0, 2)), sqOf(u.slice(2, 4)), u[4]);
    assert.ok(m, `${u} in ${c.fen()}`);
    c.makeMove(m);
  }
  return c;
};
const sans = (c) => c.legalMoves().map((m) => c.moveToSan(m)).sort();
const seen = (c, colour) => [...c.visibleSquares(colour)].map(nameOf).sort();

describe("Fog of War: the rules", () => {
  test("no check: a king may step into attack, a pinned piece may move, and nothing is marked +", () => {
    // White's rook on e1 faces Black's king down the open e-file; Black's
    // knight on e5 stands between them.
    const c = fog("4k3/8/8/4n3/8/8/8/4R1K1 b - - 0 1");
    assert.equal(c.inCheck(B), false);
    const moves = sans(c);
    assert.ok(moves.includes("Nc4"), "the knight leaves the file");
    assert.ok(moves.includes("Kd8"));
    play(c, "e5c4");
    assert.equal(c.moveToSan(c.findMove(sqOf("e1"), sqOf("e7"))), "Re7", "no +");
    assert.equal(c.isCheckmate(), false);
  });

  test("castling out of, through and into attack", () => {
    // Black's rooks on e8 and g8 rake e1 and g1; f1 is free of attack.
    const c = fog("k3r1r1/8/8/8/8/8/8/R3K2R w KQ - 0 1");
    const moves = sans(c);
    assert.ok(moves.includes("O-O"));
    assert.ok(moves.includes("O-O-O"));
  });

  test("taking the king wins, and nothing moves after", () => {
    const c = fog("4k3/8/8/8/8/8/8/4R1K1 w - - 0 1");
    play(c, "e1e8");
    assert.equal(c.kingMissing(B), true);
    assert.equal(c.isGameOver(), true);
    assert.equal(c.result(), "1-0");
    assert.equal(c.termination(), "king captured");
    assert.deepEqual(c.legalMoves(), []);
  });

  test("no stalemate: a king with only attacked squares must step into one", () => {
    // Ordinary chess's stalemate: Black's king on a8, White's queen on b6.
    const c = fog("k7/8/1Q6/8/8/8/8/2K5 b - - 0 1");
    assert.deepEqual(sans(c), ["Ka7", "Kb7", "Kb8"]);
    assert.equal(c.isStalemate(), false);
    assert.equal(c.isGameOver(), false);
    play(c, "a8b8", "b6b8");
    assert.equal(c.result(), "1-0");
  });

  test("a side with no move at all draws", () => {
    // White's king boxed in by its own pieces, each blocked in turn.
    const c = fog("7k/8/8/8/p1p5/P1Pp4/PB1P4/KNB5 w - - 0 1");
    assert.deepEqual(c.legalMoves(), []);
    assert.equal(c.isGameOver(), true);
    assert.equal(c.termination(), "no moves");
    assert.equal(c.result(), "1/2-1/2");
  });

  test("material never runs out; threefold and fifty moves draw", () => {
    const bare = fog("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    assert.equal(bare.isInsufficientMaterial(), false);
    assert.equal(bare.hasMatingMaterial(W), true);
    assert.equal(bare.isGameOver(), false);
    for (let i = 0; i < 2; i++) play(bare, "e1d1", "e8d8", "d1e1", "d8e8");
    assert.equal(bare.termination(), "threefold");
    assert.equal(bare.result(), "1/2-1/2");
    const fifty = fog("4k3/8/8/8/8/8/8/4K3 w - - 99 80");
    play(fifty, "e1d1");
    assert.equal(fifty.termination(), "fifty-move");
  });

  test("a FEN may lack a king (taken, or out of sight), never have two", () => {
    assert.equal(fog("8/8/8/8/8/8/8/4K3 b - - 0 1").result(), "1-0");
    assert.throws(() => fog("4k3/8/8/8/8/8/8/3KK3 w - - 0 1"), /exactly one king|one king/);
  });
});

describe("Fog of War: what each side sees", () => {
  test("from the start: your own half and the two ranks your pieces reach", () => {
    const c = fog();
    const white = seen(c, W);
    assert.equal(white.length, 32);
    assert.ok(white.every((n) => Number(n[1]) <= 4));
    assert.deepEqual(c.fogView(W), {
      fen: "8/8/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1",
      visible: [...Array(32).keys()],
    });
    assert.equal(c.fogView(B).fen, "rnbqkbnr/pppppppp/8/8/8/8/8/8 w kq - 0 1");
  });

  test("a pawn sees its diagonal only when it could take there, and not past a piece in its way", () => {
    const c = play(fog(), "e2e4", "d7d5");
    const view = c.fogView(W);
    assert.ok(view.visible.includes(sqOf("d5")), "exd5 is possible");
    assert.match(view.fen, /^8\/8\/8\/3p4\//, "the pawn on d5 shows");
    assert.ok(!view.visible.includes(sqOf("f5")), "nothing to take on f5");
    // A pawn blocked head-on doesn't see what blocks it.
    const blocked = play(fog(), "e2e4", "e7e5", "a2a3");
    assert.ok(!blocked.visibleSquares(W).has(sqOf("e5")));
    assert.ok(!blocked.visibleSquares(B).has(sqOf("e4")));
    // Nor can a pawn's double step jump a piece it can't see: Black's pawn on
    // f7 is blocked by White's bishop on f6, though f5 is in sight.
    const jump = fog("4k3/5p2/5B2/r7/8/8/8/4K3 b - - 0 1");
    const jumper = new Chess().setVariant("fog").loadFogView(jump.fogView(B));
    assert.ok(jumper.fogVisible.has(sqOf("f5")) && !jumper.fogVisible.has(sqOf("f6")));
    assert.equal(jumper.findMove(sqOf("f7"), sqOf("f5")), null);
  });

  test("a capture is seen only if another piece looks at the square", () => {
    // Black's bishop takes White's knight on a5; nothing else of White's
    // reaches a5.
    const c = fog("4k3/8/8/N7/8/8/8/3bK3 b - - 0 1");
    play(c, "d1a4");
    play(c, "a5c6");
    play(c, "a4c6");
    const view = c.fogView(W);
    assert.ok(!view.visible.includes(sqOf("c6")));
    assert.equal(view.fen, "8/8/8/8/8/8/8/4K3 w - - 0 3");
  });

  test("en passant: the square and the pawn to take are seen by the side that can take", () => {
    const c = play(fog(), "e2e4", "a7a6", "e4e5", "d7d5");
    const view = c.fogView(W);
    assert.match(view.fen, / w KQ d6 0 3$/);
    assert.ok(view.visible.includes(sqOf("d6")));
    assert.ok(view.visible.includes(sqOf("d5")), "the pawn it would take");
    // Black, who just pushed, has no en passant square to see.
    assert.match(c.fogView(B).fen, / w kq - 0 3$/);
    // Taken: the view knows the move.
    const mine = new Chess().setVariant("fog").loadFogView(view);
    assert.ok(mine.legalMoves().some((m) => m.enpassant));
  });

  test("the view keeps your castling rights only, and the fifty-move count at nought", () => {
    const c = fog("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 37 40");
    assert.match(c.fogView(W).fen, / w KQ - 0 40$/);
    assert.match(c.fogView(B).fen, / w kq - 0 40$/);
  });

  test("once a king is taken, everyone sees everything", () => {
    const c = play(fog("4k3/8/8/8/8/8/8/4R1K1 w - - 0 1"), "e1e8");
    assert.equal(c.visibleSquares(B).size, 64);
    assert.equal(c.fogView(B).fen.split(" ")[0], c.fen().split(" ")[0]);
  });

  test("a view never ends the game, though the other king is out of sight", () => {
    const view = new Chess().setVariant("fog").loadFogView(fog().fogView(W));
    assert.equal(view.kingMissing(B), true);
    assert.equal(view.isGameOver(), false);
    assert.equal(view.result(), "*");
    assert.equal(view.termination(), null);
    assert.equal(view.legalMoves().length, 20);
  });
});

describe("Fog of War: the view is enough to move from", () => {
  // A seeded generator, so a failure can be replayed.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const key = (m) => `${m.from}-${m.to}-${m.promo || ""}-${m.castle || ""}-${!!m.enpassant}`;

  test("in random games, the side to move's moves from its view are the real ones, with the same SAN", () => {
    let positions = 0;
    for (let game = 0; game < 40; game++) {
      const rand = rng(game + 1);
      const real = fog();
      for (let ply = 0; ply < 120 && !real.isGameOver(); ply++) {
        const moves = real.legalMoves();
        const view = new Chess().setVariant("fog").loadFogView(real.fogView(real.turn));
        const fromView = view.legalMoves();
        assert.deepEqual(fromView.map(key).sort(), moves.map(key).sort(), `game ${game}, ${real.fen()}`);
        for (const m of fromView) {
          const twin = moves.find((r) => key(r) === key(m));
          assert.equal(view.moveToSan(m), real.moveToSan(twin), `game ${game}, ${real.fen()}`);
        }
        // Nothing in the view that the side can't see.
        const visible = new Set(real.fogView(real.turn).visible);
        view.squares.forEach((p, sq) => { if (p) assert.ok(visible.has(sq)); });
        positions++;
        // Prefer captures, so kings do get taken.
        const caps = moves.filter((m) => m.capture);
        const pool = caps.length && rand() < 0.7 ? caps : moves;
        real.makeMove(pool[Math.floor(rand() * pool.length)]);
      }
    }
    assert.ok(positions > 1000, `${positions} positions`);
  });
});
