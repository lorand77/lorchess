"use strict";

// The four-player chess engine (src/shared/fourPlayer.js), Teams mode: the
// cross-shaped board, four armies moving clockwise, partners opposite who
// can't take each other's pieces, pawns going four ways and promoting on their
// 11th rank, castling, en passant, and how a game ends — a mate decided only
// when the mated player's turn comes, a king left to be taken, and the draws.
//
// There are no published move counts to hold it to, so the strongest check is
// the board's own symmetry: every rule is written once, for Red, and turned a
// quarter for each seat after it, so any position turned a quarter — Red's
// pieces becoming Blue's, Blue's Yellow's, and so on — must have exactly the
// same moves, turned. A direction, a promotion rank or a castling square
// wrong for one colour fails it.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { seeded } = require("../helpers/random");

const sq = (name) => FourPlayer.squareOf(name);
const texts = (g) => g.legalMoves().map((m) => FourPlayer.moveText(m)).sort();
function perft(g, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of g.legalMoves()) {
    g.makeMove(m, false);
    n += perft(g, depth - 1);
    g.undoMove();
  }
  return n;
}

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

describe("four-player chess: the board and the armies", () => {
  test("a 14x14 board with its corners cut: 160 squares", () => {
    let n = 0;
    for (let x = 0; x < 14; x++) for (let y = 0; y < 14; y++) if (FourPlayer.onBoard(x, y)) n++;
    assert.equal(n, 160);
    assert.equal(sq("c3"), -1, "a corner square");
    assert.equal(sq("d1"), 3);
    assert.equal(sq("o1"), -1);
  });

  test("starts as chess.com's FEN4 has it, every king on its owner's right", () => {
    const g = new FourPlayer();
    assert.equal(g.fen(),
      "R-0,0,0,0-1,1,1,1-1,1,1,1-0,0,0,0-0-3,yR,yN,yB,yK,yQ,yB,yN,yR,3/3,yP,yP,yP,yP,yP,yP,yP,yP,3/14/" +
      "bR,bP,10,gP,gR/bN,bP,10,gP,gN/bB,bP,10,gP,gB/bQ,bP,10,gP,gK/bK,bP,10,gP,gQ/bB,bP,10,gP,gB/" +
      "bN,bP,10,gP,gN/bR,bP,10,gP,gR/14/3,rP,rP,rP,rP,rP,rP,rP,rP,3/3,rR,rN,rB,rQ,rK,rB,rN,rR,3");
    assert.equal(g.squares.filter(Boolean).length, 64);
    for (const [k, q, c] of [["h1", "g1", "r"], ["a7", "a8", "b"], ["g14", "h14", "y"], ["n8", "n7", "g"]]) {
      assert.deepEqual([g.squares[sq(k)], g.squares[sq(q)]], [{ t: "k", c }, { t: "q", c }], c);
    }
    assert.equal(g.turn, "r");
  });

  test("turns go clockwise, partners sit opposite", () => {
    assert.deepEqual(["r", "b", "y", "g"].map(FourPlayer.nextColor), ["b", "y", "g", "r"]);
    assert.deepEqual(["r", "b", "y", "g"].map(FourPlayer.partnerOf), ["y", "g", "r", "b"]);
    assert.deepEqual(FourPlayer.opponentsOf("r"), ["b", "g"]);
    assert.equal(FourPlayer.teamOf("y"), FourPlayer.teamOf("r"));
    // Teams as the stored game spells sides and results.
    assert.deepEqual(["r", "b", "y", "g"].map(FourPlayer.sideOf), ["w", "b", "w", "b"]);
    assert.deepEqual(["r", "b", "y", "g"].map(FourPlayer.lossFor), ["0-1", "1-0", "0-1", "1-0"]);
  });

  test("each side's first move: twenty, as in chess; then a pin the cross board makes", () => {
    const g = new FourPlayer();
    assert.equal(perft(g, 1), 20);
    // 400 less five: after f3 or f4, Red's queen on g1 looks down the long
    // diagonal through b6 to Blue's king on a7, pinning that pawn (two moves
    // each); after d4, Red's pawn stops Blue's b4 pawn stepping twice (one).
    assert.equal(perft(g, 2), 395);
    g.makeMove(g.findMove("f2", "f3"));
    assert.ok(!texts(g).some((t) => t.startsWith("b6")), "b6 is pinned");
    assert.ok(texts(g).includes("b4d4"));
  });
});

describe("four-player chess: the same rules for every seat", () => {
  test("any position turned a quarter, colours one seat on, has the same moves turned", () => {
    const random = seeded(4);
    let checked = 0;
    for (let game = 0; game < 12; game++) {
      const g = new FourPlayer();
      for (let ply = 0; ply < 60 && !g.isGameOver(); ply++) {
        const t = turned(g);
        assert.deepEqual(texts(t), texts(g).map(turnText).sort(), `${g.fen()} turned`);
        assert.equal(t.inCheck(), g.inCheck());
        checked++;
        const moves = g.legalMoves();
        g.makeMove(moves[Math.floor(random() * moves.length)]);
      }
    }
    assert.ok(checked > 500, `${checked} positions`);
  });

  test("and the start turned is the start", () => {
    const g = new FourPlayer();
    const t = turned(g);
    assert.deepEqual(t.squares, g.squares);
  });
});

describe("four-player chess: partners and opponents", () => {
  test("a partner's piece can't be taken, and blocks like any other", () => {
    // Red's rook on d5 looks along rank 5 at Yellow's knight (a partner) on f5.
    const g = position("r", { ...KINGS, d5: "rR", f5: "yN", d9: "bN" });
    const moves = texts(g).filter((t) => t.startsWith("d5"));
    assert.ok(moves.includes("d5e5"));
    assert.ok(!moves.includes("d5f5") && !moves.includes("d5g5"), "not the partner, not past it");
    assert.ok(moves.includes("d5d9"), "an opponent's piece is taken");
    // A knight's and a king's moves the same way.
    const jumps = position("r", { ...KINGS, e5: "rN", f7: "yP", d7: "bP", i2: "yP", g2: "gP" });
    const knight = texts(jumps).filter((t) => t.startsWith("e5"));
    assert.ok(knight.includes("e5d7") && !knight.includes("e5f7"), knight.join(" "));
    const king = texts(jumps).filter((t) => t.startsWith("h1"));
    assert.ok(king.includes("h1g2") && !king.includes("h1i2"), king.join(" "));
  });

  test("only the other team gives check", () => {
    const partner = position("r", { ...KINGS, h5: "yQ" });   // on Red's king's file
    assert.equal(partner.inCheck("r"), false);
    const opponent = position("r", { ...KINGS, h5: "gQ" });
    assert.equal(opponent.inCheck("r"), true);
    assert.ok(texts(opponent).every((t) => t.startsWith("h1")), "Red must deal with it: only the king can");
  });
});

describe("four-player chess: pawns", () => {
  test("each colour's pawns go its own way, two steps from their second rank", () => {
    const g = position("b", { ...KINGS, b6: "bP", e2: "rP", e13: "yP", m6: "gP" });
    assert.deepEqual(texts(g).filter((t) => t.startsWith("b6")), ["b6c6", "b6d6"]);
    const green = position("g", { ...KINGS, m6: "gP" });
    assert.deepEqual(texts(green).filter((t) => t.startsWith("m6")), ["m6k6", "m6l6"]);
  });

  test("they promote on their 11th rank — not their 8th — to any of four pieces", () => {
    const red = position("r", { ...KINGS, e10: "rP", f7: "rP" });
    assert.deepEqual(texts(red).filter((t) => t.startsWith("e10")), ["e10e11b", "e10e11n", "e10e11q", "e10e11r"]);
    assert.deepEqual(texts(red).filter((t) => t.startsWith("f7")), ["f7f8"], "the 8th rank is just a rank");
    const blue = position("b", { ...KINGS, j6: "bP" });
    assert.deepEqual(texts(blue).filter((t) => t.startsWith("j6")), ["j6k6b", "j6k6n", "j6k6q", "j6k6r"]);
    const g = position("r", { ...KINGS, e10: "rP" });
    g.makeMove(g.findMove("e10", "e11", "q"));
    assert.deepEqual(g.squares[sq("e11")], { t: "q", c: "r" });
  });

  test("they take diagonally ahead, and en passant on the very next move only", () => {
    // Blue's pawn steps two, b6 to d6, past c6. Yellow moves next, an
    // opponent: its pawn on d7 (going south) may take on c6, and the pawn on
    // d6 goes. Red, an opponent too but two moves later, may not.
    const pieces = { ...KINGS, b6: "bP", d7: "yP", d5: "rP" };
    const now = position("b", pieces);
    now.makeMove(now.findMove("b6", "d6"));
    const ep = now.findMove("d7", "c6");
    assert.ok(ep && ep.enpassant, "Yellow takes en passant");
    now.makeMove(ep);
    assert.deepEqual([now.squares[sq("c6")], now.squares[sq("d6")]], [{ t: "p", c: "y" }, null]);
    now.undoMove();
    assert.deepEqual(now.squares[sq("d6")], { t: "p", c: "b" }, "and back");

    const later = position("b", pieces);
    later.makeMove(later.findMove("b6", "d6"));
    later.makeMove(later.findMove("g14", "f14"));   // Yellow lets it go
    later.makeMove(later.findMove("n8", "n9"));     // Green
    assert.equal(later.findMove("d5", "c6"), null, "too late for Red");
    assert.ok(later.findMove("d5", "e6") === null && later.findMove("d5", "d6") === null, "and d6 is no capture for d5");
  });
});

describe("four-player chess: castling", () => {
  test("Red castles short and long, as in ordinary chess on its own back rank", () => {
    const g = position("r", { ...KINGS, d1: "rR", k1: "rR" }, { castling: "rkrq" });
    const castles = g.legalMoves().filter((m) => m.castle);
    assert.deepEqual(castles.map((m) => [FourPlayer.nameOf(m.to), m.castle.side]).sort(), [["f1", "q"], ["j1", "k"]]);
    g.makeMove(castles.find((m) => m.castle.side === "k"));
    assert.deepEqual([g.squares[sq("j1")], g.squares[sq("i1")], g.squares[sq("k1")]],
      [{ t: "k", c: "r" }, { t: "r", c: "r" }, null]);
    assert.deepEqual(g.castling.r, { k: false, q: false });
    g.undoMove();
    assert.deepEqual(g.castling.r, { k: true, q: true });
  });

  test("not through a square an opponent attacks, nor out of check", () => {
    const crossed = position("r", { ...KINGS, k1: "rR", i9: "bR" }, { castling: "rk" });
    assert.ok(!crossed.legalMoves().some((m) => m.castle), "Blue's rook watches i1");
    const partnerWatching = position("r", { ...KINGS, k1: "rR", i9: "yR" }, { castling: "rk" });
    assert.ok(partnerWatching.legalMoves().some((m) => m.castle), "a partner's rook is no threat");
    const checked = position("r", { ...KINGS, k1: "rR", h9: "gR" }, { castling: "rk" });
    assert.ok(!checked.legalMoves().some((m) => m.castle));
  });
});

describe("four-player chess: how a game ends", () => {
  test("mate is decided on the mated player's turn: a partner may still help", () => {
    // Red's rook checks Green's king along the n-file; Blue (Green's partner)
    // moves before Green and can block on n10.
    const pieces = { h1: "rK", a7: "bK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP", n11: "rR", c10: "bR" };
    const g = position("b", pieces);
    assert.equal(g.inCheck("g"), true);
    assert.equal(g.isCheckmate(), false, "it is Blue's turn, not Green's");
    g.makeMove(g.findMove("c10", "n10"));   // blocks
    g.makeMove(g.legalMoves()[0]);         // Yellow
    assert.equal(g.turn, "g");
    assert.equal(g.isCheckmate(), false);
  });

  test("with no help, the mated player's turn ends it: a win for the other team", () => {
    const g = position("y", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP", n11: "rR" });
    g.makeMove(g.legalMoves().find((m) => m.piece === "k"));   // Yellow passes the turn
    assert.equal(g.turn, "g");
    assert.equal(g.isCheckmate(), true);
    assert.equal(g.result(), "1-0", "Red and Yellow");
    assert.equal(g.termination(), "checkmate");
    assert.deepEqual(g.legalMoves(), []);
  });

  test("a king left where an opponent can take it may be taken, and that wins", () => {
    // Blue's rook checks Red's king; Yellow can't help; Green's knight can take it.
    const g = position("y", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", h9: "bR", g3: "gN" });
    assert.equal(g.inCheck("r"), true);
    g.makeMove(g.legalMoves().find((m) => m.piece === "k"));   // Yellow
    const take = g.findMove("g3", "h1");
    assert.ok(take);
    assert.equal(g.moveToSan(take), "Ng3xh1");
    g.makeMove(take);
    assert.deepEqual([g.result(), g.termination()], ["0-1", "king captured"]);
    assert.equal(g.isGameOver(), true);
    // Even from check: taking the king ends the game before anything else.
    const checked = position("g", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", h9: "bR", g3: "gN", n5: "yR" });
    assert.equal(checked.inCheck("g"), true, "Yellow's rook checks Green");
    assert.ok(checked.findMove("g3", "h1"), "and Green may still take Red's king");
  });

  test("stalemate, repetition, fifty moves each and bare kings are draws", () => {
    // Green's king boxed in, not in check, nothing else to move.
    const stale = position("g", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", l9: "rQ", l7: "rR" });
    assert.equal(stale.inCheck(), false);
    assert.equal(stale.isStalemate(), true);
    assert.deepEqual([stale.result(), stale.termination()], ["1/2-1/2", "stalemate"]);

    const bare = position("r", KINGS);
    assert.deepEqual([bare.isGameOver(), bare.termination()], [true, "insufficient"]);

    assert.equal(position("r", { ...KINGS, d4: "rR" }, { halfmove: 199 }).isGameOver(), false);
    assert.equal(position("r", { ...KINGS, d4: "rR" }, { halfmove: 200 }).termination(), "fifty-move");

    const shuffle = position("r", { ...KINGS, d4: "rR" });
    const round = [["h1", "i1"], ["a7", "a6"], ["g14", "f14"], ["n8", "n9"], ["i1", "h1"], ["a6", "a7"], ["f14", "g14"], ["n9", "n8"]];
    for (let i = 0; i < 2; i++) for (const [f, t] of round) shuffle.makeMove(shuffle.findMove(f, t));
    assert.equal(shuffle.termination(), "threefold");
  });
});

describe("four-player chess: notation", () => {
  test("FEN4 reads back what it writes, and refuses what Teams can't be", () => {
    const g = new FourPlayer();
    g.makeMove(g.findMove("h2", "h4"));
    const again = new FourPlayer();
    again.loadFen(g.fen());
    assert.equal(again.fen(), g.fen());
    assert.equal(again.turn, "b");
    const start = new FourPlayer().fen();
    assert.throws(() => again.loadFen(start.replace("R-0,0,0,0", "R-0,1,0,0")), /eliminated/);
    assert.throws(() => again.loadFen(start.replace("-0,0,0,0-0-", "-3,0,0,0-0-")), /points/);
    assert.throws(() => again.loadFen(start.replace(/^R/, "X")), /not Red, Blue, Yellow or Green/);
    assert.throws(() => again.loadFen(start.replace("3,yR", "yR,2,yR")), /outside the board/);
    assert.throws(() => again.loadFen(start.replace("yK", "yQ")), /exactly one king/);
    assert.equal(again.fen(), g.fen(), "a refused FEN4 leaves the position as it was");
  });

  test("moves are stored from-to-promotion, and shown in chess.com's long form", () => {
    const g = new FourPlayer();
    assert.equal(FourPlayer.moveText(g.findMove("e2", "e4")), "e2e4");
    assert.equal(g.moveToSan(g.findMove("e2", "e4")), "e2-e4");
    assert.equal(g.moveToSan(g.findMove("j1", "i3")), "Nj1-i3");
    const promo = position("r", { ...KINGS, e10: "rP" });
    assert.equal(FourPlayer.moveText(promo.findMove("e10", "e11", "q")), "e10e11q");
    // The new queen checks Blue along e11-a7.
    assert.equal(promo.moveToSan(promo.findMove("e10", "e11", "q")), "e10-e11=Q+");
    const castle = position("r", { ...KINGS, d1: "rR", k1: "rR" }, { castling: "rkrq" });
    assert.equal(castle.moveToSan(castle.findMove("h1", "j1")), "O-O");
    assert.equal(castle.moveToSan(castle.findMove("h1", "f1")), "O-O-O");
    assert.ok(g.moveFromText("e2e4"));
    assert.equal(g.moveFromText("e2e5"), null);
    assert.equal(g.moveFromText("c3c4"), null, "a corner is no square");
  });
});
