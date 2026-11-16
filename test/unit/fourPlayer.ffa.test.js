"use strict";

// The four-player chess engine's free-for-all mode (src/shared/fourPlayer.js,
// new FourPlayer("ffa")), by chess.com's rules: everyone against everyone, for
// points. Pawns promote on their 8th rank to a one-point queen; taking a live
// piece scores it; a mate scores 20 for the mater and a stalemate 20 for the
// stalemated; one move checking two or three kings scores a bonus. A player
// mated, stalemated, whose king is taken, who resigns, flags or forfeits is
// eliminated: their army goes grey and stands still, dead, and the turn skips
// them. The game ends with one player left, on a draw by rule (10 points to
// each player still in), or when a player 21 points ahead of the only other
// claims it; the most points wins.
//
// Teams is tested in fourPlayer.test.js; the board, the moves and the turned
// rules are the same engine, held here to the same symmetry.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { seeded } = require("../helpers/random");
const { position, KINGS, turned, turnText } = require("../helpers/fourPlayer");

const sq = (name) => FourPlayer.squareOf(name);
const texts = (g) => g.legalMoves().map((m) => FourPlayer.moveText(m)).sort();
const ffa = (turn, pieces, opts = {}) => position(turn, pieces, Object.assign({ mode: "ffa" }, opts));
const play = (g, from, to, promo) => {
  const m = g.findMove(from, to, promo);
  assert.ok(m, `${from}-${to} is legal in ${g.fen()}`);
  g.makeMove(m);
  return m;
};
const points = (g) => Object.assign({}, g.points);

describe("four-player free-for-all: the mode", () => {
  test("a game is Teams unless asked, and no other mode exists", () => {
    assert.equal(new FourPlayer().mode, "teams");
    assert.equal(new FourPlayer("ffa").mode, "ffa");
    assert.throws(() => new FourPlayer("solo"), /no mode "solo"/);
  });

  test("the start is the same board, with no points and nobody out", () => {
    const g = new FourPlayer("ffa");
    assert.equal(g.fen(), new FourPlayer().fen());
    assert.equal(g.legalMoves().length, 20);
    assert.deepEqual(points(g), { r: 0, b: 0, y: 0, g: 0 });
    assert.deepEqual(g.active(), ["r", "b", "y", "g"]);
    assert.equal(g.result(), "*");
  });

  test("any position turned a quarter, colours one seat on, has the same moves turned", () => {
    const random = seeded(44);
    let checked = 0;
    for (let game = 0; game < 10; game++) {
      const g = new FourPlayer("ffa");
      for (let ply = 0; ply < 80 && !g.isGameOver(); ply++) {
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
});

describe("four-player free-for-all: everyone is an opponent", () => {
  test("the player opposite may be taken, and gives check", () => {
    const g = ffa("r", { ...KINGS, d5: "rR", f5: "yN" });
    assert.ok(texts(g).includes("d5f5"), "Yellow's knight is anyone's");
    assert.ok(!texts(g).includes("d5g5"), "and blocks like any piece");
    const check = ffa("r", { ...KINGS, h5: "yQ" });
    assert.equal(check.inCheck("r"), true);
    assert.ok(texts(check).every((t) => t.startsWith("h1")));
    assert.equal(check.moveToSan(check.findMove("h1", "i1")), "Kh1-i1");
    // A check to any player is "+".
    const yellow = ffa("r", { ...KINGS, d5: "rR" });
    assert.equal(yellow.moveToSan(yellow.findMove("d5", "g5")), "Rd5-g5+");
  });

  test("a piece taken scores what it is worth", () => {
    const g = ffa("r", { ...KINGS, d5: "rR", d9: "bN", e6: "yB", k9: "gR" });
    play(g, "d5", "d9");
    assert.equal(g.points.r, 3);
    play(g, "a7", "a6");          // Blue
    play(g, "e6", "d5");          // Yellow takes nothing
    play(g, "k9", "d9");          // Green takes Red's rook
    assert.deepEqual(points(g), { r: 3, b: 0, y: 0, g: 5 });
    for (const [t, v] of Object.entries({ p: 1, n: 3, b: 5, r: 5, q: 9, k: 20 })) assert.equal(FourPlayer.POINTS[t], v);
  });
});

describe("four-player free-for-all: pawns", () => {
  test("promote on their 8th rank, to a queen only, worth a point when taken", () => {
    const g = ffa("r", { ...KINGS, e7: "rP", c7: "bN" });
    assert.deepEqual(texts(g).filter((t) => t.startsWith("e7")), ["e7e8q"]);
    play(g, "e7", "e8", "q");
    assert.deepEqual(g.squares[sq("e8")], { t: "q", c: "r", promoted: true });
    assert.match(g.fen(), /rD/);
    play(g, "c7", "e8");
    assert.equal(g.points.b, 1);
    // In Teams the same pawn just steps on.
    const teams = position("r", { ...KINGS, e7: "rP" });
    assert.deepEqual(texts(teams).filter((t) => t.startsWith("e7")), ["e7e8"]);
  });

  test("each colour's 8th rank is its own, the middle of the board", () => {
    for (const [turn, from, to] of [["b", "g6", "h6"], ["y", "g8", "g7"], ["g", "h9", "g9"]]) {
      const g = ffa(turn, { ...KINGS, [from]: turn + "P" });
      assert.deepEqual(texts(g).filter((t) => t.startsWith(from)), [from + to + "q"], turn);
    }
  });
});

describe("four-player free-for-all: checks of several kings", () => {
  test("a knight checking two kings scores 5, a queen 1", () => {
    const knight = ffa("r", { h1: "rK", e8: "bK", g14: "yK", i8: "gK", e6: "rN" });
    play(knight, "e6", "g7");
    assert.equal(knight.points.r, 5);
    const queen = ffa("r", { h1: "rK", e10: "bK", g14: "yK", k10: "gK", h4: "rQ" });
    play(queen, "h4", "h10");
    assert.equal(queen.points.r, 1);
  });

  test("three kings score 20, or 5 when a queen gives one of the checks", () => {
    // The knight forks Blue's and Green's kings and uncovers the b6 piece on
    // Yellow's, k6.
    const pieces = { h1: "rK", e8: "bK", k6: "yK", i8: "gK", e6: "rN" };
    const rook = ffa("r", { ...pieces, b6: "rR" });
    play(rook, "e6", "g7");
    assert.equal(rook.points.r, 20);
    const queen = ffa("r", { ...pieces, b6: "rQ" });
    play(queen, "e6", "g7");
    assert.equal(queen.points.r, 5);
  });
});

describe("four-player free-for-all: eliminations", () => {
  // Green's king boxed in by its own pawns, Red's rook on the n-file.
  const BOXED = { h1: "rK", a7: "bK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP", n11: "rR" };

  test("mate on the mated player's turn: 20 to the mater, the army dead, the turn skips them", () => {
    const g = ffa("y", BOXED);
    assert.equal(g.inCheck("g"), true);
    play(g, "g14", "f14");        // Yellow; now Green has no move
    assert.deepEqual(g.out.g, { how: "checkmate", by: "r" });
    assert.equal(g.points.r, 20);
    assert.equal(g.turn, "r", "Green's turn is skipped");
    assert.deepEqual(g.active(), ["r", "b", "y"]);
    assert.equal(g.isGameOver(), false);
    // Dead pieces attack nothing and score nothing, but still block.
    assert.equal(g.attackedBy(sq("l8"), g.hostile("r")), false, "m8's pawn no longer attacks l8");
    const rook = texts(g).filter((t) => t.startsWith("n11"));
    assert.ok(rook.includes("n11n8") && !rook.includes("n11n7"), rook.join(" "));
    play(g, "n11", "n8");
    assert.equal(g.points.r, 20);
    // The turn goes on round the three left.
    assert.equal(g.turn, "b");
    play(g, "a7", "a6");
    assert.equal(g.turn, "y");
    play(g, "f14", "g14");
    assert.equal(g.turn, "r");
  });

  test("the mate is whoever gave check most recently", () => {
    // Red's rook checks first; Yellow's knight joins, and Yellow mates.
    const g = ffa("y", { ...BOXED, j6: "yN" });
    play(g, "j6", "l7");
    assert.deepEqual(g.out.g, { how: "checkmate", by: "y" });
    assert.deepEqual([g.points.r, g.points.y], [0, 20]);
  });

  test("a mate of the next player is '#' in the move list", () => {
    // Yellow's rook swings to the n-file, and Green, next, is mated.
    const g = ffa("y", { ...BOXED, n11: null, k11: "yR" });
    const m = g.findMove("k11", "n11");
    assert.equal(g.moveToSan(m), "Rk11-n11#");
    g.makeMove(m);
    assert.deepEqual(g.out.g, { how: "checkmate", by: "y" });
  });

  test("a stalemated player scores 20 themselves, and is out", () => {
    const g = ffa("y", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", l9: "rQ", l7: "rR" });
    play(g, "g14", "f14");
    assert.deepEqual(g.out.g, { how: "stalemate", by: null });
    assert.deepEqual(points(g), { r: 0, b: 0, y: 0, g: 20 });
    assert.equal(g.turn, "r");
  });

  test("a king left to be taken may be taken: 20 points, and its player is out", () => {
    // Blue's rook checks Red's king; Green's knight takes it.
    const g = ffa("y", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", h9: "bR", g3: "gN", d4: "rR" });
    play(g, "g14", "f14");
    const take = g.findMove("g3", "h1");
    assert.equal(g.moveToSan(take), "Ng3xh1");
    g.makeMove(take);
    assert.deepEqual(g.out.r, { how: "king captured", by: "g" });
    assert.equal(g.points.g, 20);
    assert.equal(g.turn, "b", "Red's turn is skipped");
    assert.equal(g.isGameOver(), false);
    assert.equal(g.kingTaken(), null, "no ending in free-for-all");
    // Red's rook is dead: Blue takes it for nothing.
    play(g, "h9", "h4");
    play(g, "f14", "g14");
    play(g, "n8", "n9");
    assert.equal(g.turn, "b");
    play(g, "h4", "d4");
    assert.equal(g.points.b, 0);
  });

  test("resigning, running out of time or forfeiting: the army goes dead, the points stay", () => {
    const g = ffa("r", { ...KINGS, d5: "rR", d9: "bN", e10: "bQ" }, { points: { b: 12 } });
    assert.equal(g.eliminate("b", "resign"), true);
    assert.deepEqual(g.out.b, { how: "resign", by: null });
    assert.equal(g.points.b, 12);
    assert.equal(g.turn, "r", "not Blue's turn: nothing changes");
    play(g, "d5", "d9");
    assert.equal(g.points.r, 0, "a dead knight scores nothing");
    assert.equal(g.turn, "y", "Blue is skipped");
    // The player to move leaving passes the turn on.
    assert.equal(g.eliminate("y", "timeout"), true);
    assert.equal(g.turn, "g");
    // Not twice, not for another reason, not in Teams.
    assert.equal(g.eliminate("b", "resign"), false);
    assert.equal(g.eliminate("g", "bored"), false);
    assert.equal(new FourPlayer().eliminate("r", "resign"), false);
    // Taken back like a move.
    g.undoMove();
    assert.equal(g.out.y, null);
    assert.equal(g.turn, "y");
  });
});

describe("four-player free-for-all: how a game ends", () => {
  test("with one player left, the most points wins; level players share a place", () => {
    const g = ffa("r", { ...KINGS, d4: "rR" }, { points: { r: 10, b: 30, y: 10 } });
    g.eliminate("y", "resign");
    g.eliminate("g", "disconnect");
    assert.equal(g.isGameOver(), false);
    g.eliminate("r", "timeout");
    assert.equal(g.isGameOver(), true);
    assert.equal(g.termination(), "timeout");
    assert.equal(g.result(), "b,r=y,g");
    assert.deepEqual(g.standings().map((s) => s.place), [2, 1, 2, 4]);
    assert.deepEqual(g.legalMoves(), []);
    assert.equal(g.eliminate("b", "resign"), false, "nothing to leave");
  });

  test("the last mate ends it, named by how", () => {
    const g = ffa("y", { h1: "rK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP", n11: "rR", a7: "bK" }, { out: "b" });
    g.eliminate("y", "resign");
    assert.equal(g.turn, "g");
    // It's Green's turn, mated already: a tracked move would settle it, and
    // an elimination is tracked.
    assert.deepEqual([g.isGameOver(), g.termination(), g.points.r], [true, "checkmate", 20]);
    assert.equal(g.result(), "r,b=y=g");
  });

  test("two left, one 21 ahead may claim it: the other gets 20", () => {
    const g = ffa("r", { ...KINGS, d4: "rR" }, { out: "yg", points: { r: 30, b: 9 } });
    assert.equal(g.canClaimWin("r"), true);
    assert.equal(g.canClaimWin("b"), false);
    assert.equal(g.claimWin("b"), false);
    const short = ffa("r", { ...KINGS, d4: "rR" }, { out: "yg", points: { r: 30, b: 10 } });
    assert.equal(short.canClaimWin("r"), false, "20 ahead is not enough");
    const three = ffa("r", { ...KINGS, d4: "rR" }, { out: "g", points: { r: 30 } });
    assert.equal(three.canClaimWin("r"), false, "only with two left");
    assert.equal(g.claimWin("r"), true);
    assert.deepEqual([g.isGameOver(), g.termination(), g.points.b], [true, "claim", 29]);
    assert.deepEqual(g.out.r, { how: "claim", by: null });
    assert.equal(g.result(), "r,b,y=g");
    assert.equal(new FourPlayer().canClaimWin("r"), false);
  });

  test("repetition, fifty moves each and bare kings draw: 10 to each player still in", () => {
    const shuffle = ffa("r", { ...KINGS, d4: "rR" });
    const round = [["h1", "i1"], ["a7", "a6"], ["g14", "f14"], ["n8", "n9"], ["i1", "h1"], ["a6", "a7"], ["f14", "g14"], ["n9", "n8"]];
    for (let i = 0; i < 2; i++) for (const [f, t] of round) play(shuffle, f, t);
    assert.deepEqual([shuffle.isGameOver(), shuffle.termination()], [true, "threefold"]);
    assert.deepEqual(points(shuffle), { r: 10, b: 10, y: 10, g: 10 });
    assert.equal(shuffle.result(), "r=b=y=g");

    // Fifty moves by each of three is 150 plies.
    const fifty = ffa("r", { ...KINGS, d4: "rR" }, { out: "y", halfmove: 149 });
    assert.equal(fifty.isGameOver(), false);
    play(fifty, "d4", "d5");
    assert.deepEqual([fifty.termination(), points(fifty)], ["fifty-move", { r: 10, b: 10, y: 0, g: 10 }]);

    // Yellow's rook is dead: nobody still in has more than a king.
    const bare = ffa("r", { ...KINGS, d4: "yR" }, { out: "y" });
    play(bare, "h1", "i1");
    assert.deepEqual([bare.termination(), points(bare)], ["insufficient", { r: 10, b: 10, y: 0, g: 10 }]);
  });
});

describe("four-player free-for-all: notation and records", () => {
  test("FEN4 carries the eliminated players, the points and a promoted queen", () => {
    const text = "B-0,0,1,0-0,0,0,0-0,0,0,0-21,4,0,7-3-" + ffa("b", { ...KINGS, e9: "rD" }, { out: "y" }).fen().split("-").slice(6).join("-");
    const g = new FourPlayer("ffa");
    g.loadFen(text);
    assert.equal(g.fen(), text);
    assert.deepEqual(points(g), { r: 21, b: 4, y: 0, g: 7 });
    assert.deepEqual(g.out.y, { how: null, by: null });
    assert.deepEqual(g.squares[sq("e9")], { t: "q", c: "r", promoted: true });
    assert.equal(g.turn, "b");
  });

  test("and refuses what free-for-all can't be, as Teams refuses what it can't", () => {
    const board = new FourPlayer().fen().split("-").slice(6).join("-");
    const load = (mode, header, rows = board) => () => new FourPlayer(mode).loadFen(`${header}-${rows}`);
    assert.throws(load("ffa", "R-1,1,1,0-0,0,0,0-0,0,0,0-0,0,0,0-0"), /fewer than two players/);
    assert.throws(load("ffa", "R-1,0,0,0-0,0,0,0-0,0,0,0-0,0,0,0-0"), /Red is eliminated/);
    assert.throws(load("ffa", "R-0,0,0,0-0,0,0,0-0,0,0,0-0,x,0,0-0"), /bad points/);
    assert.throws(load("teams", "R-0,1,0,0-0,0,0,0-0,0,0,0-0,0,0,0-0"), /no player is eliminated/);
    assert.throws(load("teams", "R-0,0,0,0-0,0,0,0-0,0,0,0-0,3,0,0-0"), /keeps no points/);
    const promoted = ffa("r", { ...KINGS, e9: "rD" }).fen();
    assert.throws(() => new FourPlayer().loadFen(promoted), /"rD" is not a piece/);
    // An eliminated player may have lost their king, but a player still in may not.
    const noBlueKing = { h1: "rK", g14: "yK", n8: "gK" };
    assert.doesNotThrow(() => ffa("r", noBlueKing, { out: "b" }));
    assert.throws(() => ffa("r", noBlueKing), /Blue must have exactly one king/);
    // A pawn on its 8th rank has already promoted.
    assert.throws(() => ffa("r", { ...KINGS, e8: "rP" }), /would have promoted/);
  });

  test("leaving is written as an event, and a game replays from its texts", () => {
    assert.equal(FourPlayer.eventText({ how: "resign", color: "b" }), "resign:b");
    assert.deepEqual(FourPlayer.eventFromText("claim:r"), { how: "claim", color: "r" });
    assert.equal(FourPlayer.eventFromText("resign:x"), null);
    assert.equal(FourPlayer.eventFromText("e2e4"), null);

    const random = seeded(7);
    for (let game = 0; game < 8; game++) {
      const g = new FourPlayer("ffa");
      const record = [];
      for (let ply = 0; ply < 150 && !g.isGameOver(); ply++) {
        if (random() < 0.02) {
          const c = g.active()[Math.floor(random() * g.active().length)];
          assert.ok(g.eliminate(c, "resign"));
          record.push(FourPlayer.eventText({ how: "resign", color: c }));
          continue;
        }
        const moves = g.legalMoves();
        const m = moves[Math.floor(random() * moves.length)];
        g.makeMove(m);
        record.push(FourPlayer.moveText(m));
      }
      const replay = new FourPlayer("ffa");
      for (const text of record) assert.ok(replay.playText(text), text);
      assert.equal(replay.fen(), g.fen());
      assert.deepEqual([replay.out, replay.ended, replay.result()], [g.out, g.ended, g.result()]);
      // And taken back to the start, exactly.
      while (g.history.length) g.undoMove();
      assert.equal(g.fen(), new FourPlayer("ffa").fen());
      assert.deepEqual([points(g), g.ended, g.positionCounts.size], [{ r: 0, b: 0, y: 0, g: 0 }, null, 1]);
    }
    const g = new FourPlayer("ffa");
    assert.equal(g.playText("e2e5"), false);
    assert.equal(g.playText("claim:r"), false);
    assert.equal(g.history.length, 0);
  });
});
