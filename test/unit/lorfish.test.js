"use strict";

// The LorFish engine in src/shared/lorfish.js. Searches are kept shallow so
// the file runs in a couple of seconds; the engine deepens endgames itself.
//
// getBestMove() adds a random tiebreak to non-mate scores and logs to the
// console, both by design, so determinism is asserted on analyse() and the
// console is mocked wherever getBestMove() runs.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");
const positions = require("../fixtures/perft.json");
const { START_FEN, fromFen, sq, uci, play } = require("../helpers/board");
const { seeded } = require("../helpers/random");

const silence = (t) => t.mock.method(console, "log", () => {});

// Flip the ranks, swap the colours, and swap the side to move. A correct
// evaluation gives the mirrored position exactly the same score.
function mirrorFen(fen) {
  const [board, turn, castling, ep, half, full] = fen.split(" ");
  const swapCase = (s) =>
    s.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()));
  const ranks = board.split("/").reverse().map(swapCase).join("/");
  const rights = castling === "-"
    ? "-"
    : swapCase(castling).split("").sort((a, b) => "KQkq".indexOf(a) - "KQkq".indexOf(b)).join("");
  const epSq = ep === "-" ? "-" : ep[0] + (9 - Number(ep[1]));
  return `${ranks} ${turn === "w" ? "b" : "w"} ${rights} ${epSq} ${half} ${full}`;
}

// A position reached by up to `plies` random legal moves from the start.
function randomPosition(rnd, plies) {
  const chess = new Chess();
  for (let i = 0; i < plies; i++) {
    const moves = chess.legalMoves();
    if (!moves.length) break;
    chess.makeMove(moves[Math.floor(rnd() * moves.length)]);
  }
  return chess;
}

// Accepts a move from legalMoves() or the {from, to, promo} shape analyse() returns.
const isLegal = (chess, move) =>
  !!move && chess.legalMoves().some(
    (m) => m.from === move.from && m.to === move.to && (m.promo || null) === (move.promo || null)
  );

describe("LorFish search", () => {
  test("always returns a legal move and leaves the board untouched", (t) => {
    silence(t);
    const rnd = seeded(42);
    let searched = 0;
    // Up to 24 plies keeps most samples in the middlegame, where depth 1
    // stays depth 1; the engine deepens sparse positions on its own.
    for (let i = 0; i < 24; i++) {
      const chess = randomPosition(rnd, Math.floor(rnd() * 24));
      if (chess.legalMoves().length === 0) continue;
      const fen = chess.fen();
      const counts = new Map(chess.positionCounts);
      const plies = chess.history.length;

      const verdict = LorFish.analyse(chess, 1);
      assert.ok(isLegal(chess, verdict.move), `analyse returned ${JSON.stringify(verdict.move)} in ${fen}`);
      const best = LorFish.getBestMove(chess, 1);
      assert.ok(isLegal(chess, best), `getBestMove returned ${JSON.stringify(best)} in ${fen}`);

      assert.equal(chess.fen(), fen);
      assert.equal(chess.history.length, plies);
      assert.deepEqual(chess.positionCounts, counts);
      searched++;
    }
    assert.ok(searched >= 16, `only ${searched} positions searched`);
  });

  test("a depth below 1 searches at 1 rather than never bottoming out", () => {
    for (const depth of [0, -2, undefined, NaN, "x"]) {
      const chess = new Chess();
      const verdict = LorFish.analyse(chess, depth);
      assert.ok(verdict && isLegal(chess, verdict.move), String(depth));
      assert.ok(verdict.depth >= 1);
      assert.equal(chess.history.length, 0, "the board is left as it was");
    }
  });

  test("handles the tactical reference positions", () => {
    // Kiwipete is left out: its capture chains run the quiescence search
    // nineteen plies deep and cost about four seconds even at depth 1.
    for (const pos of positions.slice(0, 7).filter((p) => !p.name.startsWith("kiwipete"))) {
      const chess = fromFen(pos.fen);
      const verdict = LorFish.analyse(chess, 1);
      assert.ok(isLegal(chess, verdict.move), pos.name);
      assert.equal(chess.fen(), pos.fen, pos.name);
    }
  });

  test("returns null when the game is over", (t) => {
    silence(t);
    const mated = play(new Chess(), "f2f3", "e7e5", "g2g4", "d8h4");
    assert.equal(LorFish.analyse(mated, 1), null);
    assert.equal(LorFish.getBestMove(mated, 1), null);
    assert.equal(LorFish.analyse(fromFen("k7/8/1Q6/8/8/8/8/K7 b - - 0 1"), 1), null, "stalemate");
  });

  test("analyse gives the same verdict every time", () => {
    const fen = positions[5].fen; // cpw position 5, tactical but quick
    const first = LorFish.analyse(fromFen(fen), 1);
    assert.deepEqual(LorFish.analyse(fromFen(fen), 1), first);
    const reused = fromFen(fen);
    play(reused, "c4b3");
    reused.undoMove();
    assert.deepEqual(LorFish.analyse(reused, 1), first, "after a make and undo");
  });

  test("the score is from the side to move's point of view", () => {
    assert.ok(LorFish.analyse(fromFen("k7/8/8/8/8/8/8/K6R w - - 0 1"), 1).score > 400);
    assert.ok(LorFish.analyse(fromFen("k7/8/8/8/8/8/8/K6R b - - 0 1"), 1).score < -400);
  });
});

describe("LorFish mates", () => {
  const MATE_IN_ONE = [
    ["back rank", () => fromFen("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1")],
    ["scholar's", () => play(new Chess(), "e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6")],
    ["fool's, black to move", () => play(new Chess(), "f2f3", "e7e5", "g2g4")],
    ["smothered", () => fromFen("6rk/6pp/8/4N3/8/8/8/K7 w - - 0 1")],
    ["queen and king", () => fromFen("7k/8/6K1/8/8/8/8/1Q6 w - - 0 1")],
  ];
  for (const [name, setup] of MATE_IN_ONE) {
    test(`finds mate in one: ${name}`, (t) => {
      silence(t);
      const chess = setup();
      const verdict = LorFish.analyse(chess, 1);
      assert.ok(verdict.score >= 99999, `score ${verdict.score}`);
      assert.match(verdict.san, /#$/);
      play(chess, uci(verdict.move));
      assert.equal(chess.isCheckmate(), true);

      // The playing entry point never jitters a mate, so it agrees every time.
      for (let i = 0; i < 5; i++) {
        const again = setup();
        play(again, uci(LorFish.getBestMove(again, 1)));
        assert.equal(again.isCheckmate(), true, `getBestMove run ${i + 1}`);
      }
    });
  }

  test("a mate scores 100000 minus the plies to it, wherever the search found it", () => {
    // The game review turns this back into a distance ("M1", "M2").
    const one = LorFish.analyse(fromFen("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1"), 1);
    assert.equal(one.score, LorFish.MATE - 1, "mate at ply 1");
    const two = LorFish.analyse(fromFen("k7/8/2K5/8/8/8/8/6R1 w - - 0 1"), 1);
    assert.equal(two.score, LorFish.MATE - 3, "mate at ply 3");
    // Found inside the quiescence search at depth 1: Qe8+ Qf8 Qxf8#.
    const deep = LorFish.analyse(fromFen("7k/p5pp/2r2q2/2p4Q/8/8/P5PP/3r1R1K w - - 0 30"), 1);
    assert.equal(deep.score, LorFish.MATE - 3, "still three plies, not the depth it was found at");
  });

  test("analyse spells a castling move with its rook square", () => {
    const verdict = LorFish.analyse(fromFen("8/8/3B4/8/8/2N2k1P/8/2B1K2R w K - 0 1"), 1);
    assert.equal(verdict.san, "O-O#");
    assert.equal(verdict.move.castle, "K");
    assert.equal(verdict.move.rookFrom, sq("h1"));
    assert.equal(verdict.score, LorFish.MATE - 1);
  });

  test("the search depth is clamped to a sane range", () => {
    assert.equal(LorFish.clampDepth(Infinity), LorFish.MAX_DEPTH);
    assert.equal(LorFish.clampDepth("1e9"), LorFish.MAX_DEPTH);
    assert.equal(LorFish.clampDepth(0), 1);
    assert.equal(LorFish.clampDepth("2"), 2);
    assert.equal(LorFish.clampDepth(2.7), 2);
  });

  const MATE_IN_TWO = [
    ["rook: a quiet king move first", "k7/8/2K5/8/8/8/8/6R1 w - - 0 1", "Kb6"],
    ["queen: a quiet king move first", "7k/8/5K2/8/8/8/8/Q7 w - - 0 1", null],
  ];
  for (const [name, fen, san] of MATE_IN_TWO) {
    test(`finds mate in two: ${name}`, () => {
      const chess = fromFen(fen);
      const verdict = LorFish.analyse(chess, 1); // an endgame: depth 1 becomes 3
      assert.equal(verdict.depth, 3);
      assert.ok(verdict.score > 99000, `score ${verdict.score}`);
      if (san) assert.equal(verdict.san, san);
      // Play it out: whatever the defender tries, the next move mates.
      play(chess, uci(verdict.move));
      play(chess, uci(LorFish.analyse(chess, 1).move));
      play(chess, uci(LorFish.analyse(chess, 1).move));
      assert.equal(chess.isCheckmate(), true);
    });
  }
});

describe("LorFish evaluation", () => {
  test("the start position is level", () => {
    assert.equal(LorFish.evaluate(new Chess()), 0);
  });

  test("is symmetric under a colour mirror", () => {
    // + 0 turns a negated zero back into plain zero, which strict equality wants.
    const level = (chess) => LorFish.evaluate(chess) + 0;
    for (const pos of positions) {
      const mirrored = mirrorFen(pos.fen);
      assert.equal(level(fromFen(mirrored)), level(fromFen(pos.fen)), pos.name);
    }
    const rnd = seeded(7);
    for (let i = 0; i < 20; i++) {
      const fen = randomPosition(rnd, 30).fen();
      assert.equal(level(fromFen(mirrorFen(fen))), level(fromFen(fen)), fen);
    }
  });

  test("counts material for the side to move", () => {
    assert.ok(LorFish.evaluate(fromFen("k7/8/8/8/8/8/8/K6R w - - 0 1")) > 400);
    assert.ok(LorFish.evaluate(fromFen("k7/8/8/8/8/8/8/K6R b - - 0 1")) < -400);
  });

  test("passed pawns", () => {
    const passed = (fen, square, colour) => LorFish.isPassedPawn(fromFen(fen), sq(square), colour);
    assert.equal(passed("k7/8/8/3P4/8/8/8/K7 w - - 0 1", "d5", "w"), true, "nothing ahead");
    assert.equal(passed("k7/8/4p3/3P4/8/8/8/K7 w - - 0 1", "d5", "w"), false, "enemy pawn on an adjacent file ahead");
    assert.equal(passed("k7/3p4/8/3P4/8/8/8/K7 w - - 0 1", "d5", "w"), false, "enemy pawn on the same file ahead");
    assert.equal(passed("k7/8/2p5/3P4/8/8/8/K7 w - - 0 1", "d5", "w"), false, "enemy pawn on the other adjacent file");
    assert.equal(passed("k7/8/8/3P4/4p3/8/8/K7 w - - 0 1", "d5", "w"), true, "enemy pawn behind does not count");
    assert.equal(passed("k7/8/8/8/3p4/2P5/8/K7 w - - 0 1", "d4", "b"), false, "black pawn blocked by a white pawn ahead");
    assert.equal(passed("k7/8/8/2P5/3p4/8/8/K7 w - - 0 1", "d4", "b"), true, "black pawn with the white pawn behind it");
  });
});

describe("LorFish game phase and adaptive depth", () => {
  const cases = [
    ["start position", START_FEN, 24, 0],
    ["pawn endgame", "k7/pppp4/8/8/8/8/PPPP4/K7 w - - 0 1", 0, 2],
    ["two rooks", "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", 4, 2],
    ["four rooks", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", 8, 1],
    ["rook and queen each", "rq2k3/8/8/8/8/8/8/RQ2K3 w - - 0 1", 12, 1],
    ["rook and queen each plus a knight", "rq2k3/8/8/8/8/8/8/RQ2K1N1 w - - 0 1", 13, 0],
    ["all pieces, no pawns", "rnbqk3/8/8/8/8/8/8/RNBQK3 w - - 0 1", 16, 0],
  ];
  for (const [name, fen, phase, bump] of cases) {
    test(`${name}: phase ${phase}, depth +${bump}`, () => {
      const chess = fromFen(fen);
      assert.equal(LorFish.gamePhase(chess), phase);
      assert.equal(LorFish.adaptiveDepth(chess, 1), 1 + bump);
      assert.equal(LorFish.adaptiveDepth(chess, 3), 3 + bump);
    });
  }

  test("analyse reports the depth it actually searched", () => {
    assert.equal(LorFish.analyse(new Chess(), 1).depth, 1);
    assert.equal(LorFish.analyse(fromFen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1"), 1).depth, 3);
  });
});

describe("LorFish lone-king endgames", () => {
  const detect = (fen) => LorFish.isLoneKingMate(fromFen(fen));
  const term = (fen) => {
    const chess = fromFen(fen);
    return LorFish.loneKingMateTerm(chess, LorFish.isLoneKingMate(chess));
  };

  test("detection needs a bare king against a king and a major piece, with no pawns", () => {
    assert.deepEqual(detect("k7/8/8/8/8/8/8/K6R w - - 0 1"), { winner: "w", loser: "b" });
    assert.deepEqual(detect("k7/8/8/8/8/8/8/K6Q w - - 0 1"), { winner: "w", loser: "b" });
    assert.deepEqual(detect("K7/8/8/8/8/8/8/k6q w - - 0 1"), { winner: "b", loser: "w" });
    assert.equal(detect("k7/8/8/8/8/8/8/K6B w - - 0 1"), null, "a bishop is not a major piece");
    assert.equal(detect("k7/8/8/8/8/8/P7/K6R w - - 0 1"), null, "the winner has a pawn");
    assert.equal(detect("k7/p7/8/8/8/8/8/K6R w - - 0 1"), null, "the loser is not bare");
    assert.equal(detect(START_FEN), null);
  });

  test("the herding term rewards a cornered king, a close king, and the opposition", () => {
    // Black king a8 vs white king e4: edge 120 + corner 30 + proximity 48.
    assert.equal(term("k7/8/8/8/4K3/8/8/7R w - - 0 1"), 198);
    // Black king d5 vs white king e4: no edge, proximity 96.
    assert.equal(term("8/8/8/3k4/4K3/8/8/7R w - - 0 1"), 96);
    // Kings d6 and d4: edge 20, proximity 80, opposition 24.
    assert.equal(term("8/8/3k4/8/3K4/8/8/7R w - - 0 1"), 124);
    // Kings d6 and c4: same distance, no opposition.
    assert.equal(term("8/8/3k4/8/2K5/8/8/7R w - - 0 1"), 100);
  });

  test("the term flips sign when the colours are mirrored", () => {
    const fen = "k7/8/8/8/4K3/8/8/7R w - - 0 1";
    assert.equal(term(mirrorFen(fen)), -term(fen));
  });

  test("evaluation prefers the lone king cornered", () => {
    const cornered = LorFish.evaluate(fromFen("k7/8/8/8/4K3/8/8/7R w - - 0 1"));
    const central = LorFish.evaluate(fromFen("8/8/8/3k4/4K3/8/8/7R w - - 0 1"));
    assert.ok(cornered > central, `${cornered} vs ${central}`);
  });
});

describe("LorFish move ordering", () => {
  test("captures first by victim value, then promotions, then quiet moves", () => {
    const chess = fromFen("k7/7P/8/1p1q4/2P5/8/8/K2R4 w - - 0 1");
    const moves = chess.legalMoves();
    const ordered = LorFish.orderMoves(chess, moves);
    assert.deepEqual(ordered.map(uci).sort(), moves.map(uci).sort(), "a permutation of the input");
    assert.deepEqual(
      ordered.slice(0, 7).map(uci),
      ["c4d5", "d1d5", "h7h8q", "h7h8r", "h7h8b", "h7h8n", "c4b5"]
    );
    for (const m of ordered.slice(7)) assert.ok(!m.capture && !m.promo, uci(m));
  });
});
