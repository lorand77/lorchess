"use strict";

// The LorFish engine in src/shared/lorfish.js. Searches are kept shallow so
// the file runs in a couple of seconds; the engine deepens endgames itself.
//
// getBestMove() adds a random tiebreak to non-mate scores and logs to the
// console, both by design, so determinism is asserted on analyse() and the
// console is mocked wherever getBestMove() runs.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, B } = require("../../src/shared/chess");
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

describe("LorFish temperature", () => {
  const pick = (chess, depth, temperature, seed) =>
    LorFish.searchRoot(chess, depth, { noise: true, temperature, rng: seeded(seed) }).best;

  test("weights each move by exp(-loss / T)", () => {
    // Losses 0 and 100 at T=100: weights 1 and 1/e, so the worse move is drawn
    // when the roll lands past 1 / (1 + 1/e), about 0.7311.
    const evals = [{ raw: 0 }, { raw: -100 }];
    assert.equal(LorFish.sample(evals, 100, () => 0.73), evals[0]);
    assert.equal(LorFish.sample(evals, 100, () => 0.7322), evals[1]);
    assert.equal(LorFish.sample(evals, 100, () => 1), evals[1], "a roll of 1 still lands on a move");
  });

  test("the same seed replays the same move and the board is left as it was", (t) => {
    silence(t);
    const rnd = seeded(3);
    for (let i = 0; i < 12; i++) {
      const chess = randomPosition(rnd, 6 + Math.floor(rnd() * 16));
      if (chess.legalMoves().length === 0) continue;
      const fen = chess.fen();
      const first = pick(chess, 1, 80, i);
      assert.ok(isLegal(chess, first.move), fen);
      assert.equal(pick(chess, 1, 80, i).san, first.san, fen);
      assert.ok(isLegal(chess, LorFish.getBestMove(chess, 1, { temperature: 80 })), fen);
      assert.equal(chess.fen(), fen);
    }
  });

  test("replaces the jitter rather than adding to it", () => {
    const { evals } = LorFish.searchRoot(new Chess(), 1, { noise: true, temperature: 50, rng: seeded(1) });
    for (const e of evals) assert.equal(e.v, e.raw, e.san);
  });

  test("a cold temperature plays a top-scoring move", () => {
    const rnd = seeded(11);
    for (let i = 0; i < 12; i++) {
      const chess = randomPosition(rnd, 6 + Math.floor(rnd() * 16));
      if (chess.legalMoves().length === 0) continue;
      const { evals, best } = LorFish.searchRoot(chess, 1, { temperature: 0.01, rng: seeded(i) });
      assert.equal(best.raw, Math.max(...evals.map((e) => e.raw)), chess.fen());
    }
  });

  test("a hotter temperature spreads the choice over more moves", () => {
    const distinct = (temperature) =>
      new Set(Array.from({ length: 40 }, (_, seed) => pick(new Chess(), 1, temperature, seed).san)).size;
    // At depth 1 the start position's top four moves (d4 e4 Nf3 Nc3) sit
    // within 10 centipawns of each other, out of twenty spread over 51.
    const cold = distinct(5);
    const hot = distinct(200);
    assert.ok(cold <= 4, `T=5 played ${cold} different moves`);
    assert.ok(hot >= 12, `T=200 played ${hot} different moves`);
  });

  test("still takes a free queen and a mate it sees", () => {
    for (let seed = 0; seed < 30; seed++) {
      assert.equal(pick(fromFen("k7/8/8/3q4/8/8/8/K2R4 w - - 0 1"), 1, 50, seed).san, "Rxd5", `seed ${seed}`);
      assert.match(pick(fromFen("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1"), 1, 500, seed).san, /#$/, `seed ${seed}`);
    }
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

describe("LorFish in the variants", () => {
  // The rules engine's result() says who has won when no move is left; the
  // search used to assume mate or stalemate, and scored these wins as draws.
  const winIn = (fen, variant, depth) => LorFish.analyse(fromFen(fen, variant), depth);

  test("Atomic: blowing up the king wins", () => {
    const a = winIn("4k3/4p3/8/8/8/8/8/K3R3 w - - 0 1", "atomic", 1);
    assert.equal(a.san, "Rxe7");
    assert.ok(a.score > LorFish.MATE - 10, String(a.score));
  });

  test("Pawn Wars: taking the last pawn wins", () => {
    const a = winIn("8/8/8/8/3p4/4P3/8/8 w - - 0 1", "pawnwars", 1);
    assert.equal(a.san, "exd4");
    assert.ok(a.score > LorFish.MATE - 10, String(a.score));
  });

  test("Antichess: losing the last piece wins", () => {
    // A quiet rook move onto the black rook's line: it must take, and White,
    // with nothing left, has won.
    const a = winIn("r7/8/8/8/8/8/8/7R w - - 0 1", "antichess", 2);
    assert.ok(a.score > LorFish.MATE - 10, `${a.san} ${a.score}`);
  });

  test("standard chess: mate and stalemate as before", () => {
    const mate = winIn("6k1/5ppp/8/8/8/8/8/K3R3 w - - 0 1", undefined, 1);
    assert.equal(mate.san, "Re8#");
    assert.ok(mate.score > LorFish.MATE - 10);
  });
});

describe("LorFish plays Pawn Wars", () => {
  const pawnWars = (fen) => fromFen(fen || "pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1", "pawnwars");

  test("takes a pawn left hanging", () => {
    assert.equal(LorFish.analyse(pawnWars("p7/8/8/3p4/4P3/8/8/7P w - - 0 1"), 1).san, "exd5");
  });

  test("never promotes its last pawn, which would lose", () => {
    const a = LorFish.analyse(pawnWars("8/P7/8/8/8/p7/8/7Q w - - 0 1"), 2);
    assert.ok(!a.san.startsWith("a8"), a.san);
    assert.ok(a.score > 0, "and still wins, with the queen it already has");
  });

  test("promotes when it has pawns to spare: a queen hunts pawns", () => {
    const a = LorFish.analyse(pawnWars("8/P7/8/3p4/8/8/7P/8 w - - 0 1"), 2);
    assert.equal(a.san, "a8=Q");
    assert.ok(a.score > LorFish.MATE - 20, "and sees the win");
  });

  test("a running pawn is worth more the further it has got", () => {
    const near = LorFish.evaluate(pawnWars("p7/8/8/8/8/8/8/7P w - - 0 1"));
    const far = LorFish.evaluate(pawnWars("p7/8/8/8/8/8/7P/8 w - - 0 1"));
    assert.ok(far > near);
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = pawnWars();
    const rng = seeded(7);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
    assert.ok(["pawns captured", "stalemate", "threefold", "fifty-move"].includes(chess.termination()));
  });
});


describe("LorFish plays Antichess", () => {
  const antichess = (fen) => fromFen(fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1", "antichess");

  test("every piece counts against its owner, a queen no more than a pawn", () => {
    const queen = LorFish.evaluate(antichess("4k3/8/8/8/8/8/8/Q3K3 w - - 0 1"));
    assert.ok(queen < 0, String(queen));
    assert.equal(LorFish.evaluate(antichess("4k3/8/8/8/8/8/P7/4K3 w - - 0 1")), queen);
    assert.equal(LorFish.evaluate(antichess("4k3/8/8/8/8/8/P7/4K3 b - - 0 1")), -queen, "from the side to move");
  });

  test("follows a forced capture chain to its end", () => {
    // Rb1 must be taken, and the h1 rook must then take back: White is left
    // with a piece and Black with none, which wins for Black. A stand-pat
    // would have stopped after the first capture and missed it.
    const chess = play(antichess("1r6/8/8/8/8/8/8/R6R w - - 0 1"), "a1b1");
    assert.ok(LorFish.quiescence(chess, -Infinity, Infinity, 0) > LorFish.MATE - 10);
    assert.notEqual(LorFish.analyse(antichess("1r6/8/8/8/8/8/8/R6R w - - 0 1"), 1).san, "Rb1");
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = antichess();
    const rng = seeded(7);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
    assert.ok(["all pieces lost", "no moves", "insufficient", "threefold", "fifty-move"].includes(chess.termination()));
  });
});

describe("LorFish plays Atomic", () => {
  const atomic = (fen) => fromFen(fen || START_FEN, "atomic");

  test("a capture is worth what it blows up, less the capturer", () => {
    // Nxd5 takes a pawn and the queen beside it, and loses the knight and
    // the bishop on c4 in the same blast.
    const chess = atomic("8/8/4q3/3p4/2B5/4N3/8/K6k w - - 0 1");
    const v = LorFish.pieceValues;
    assert.equal(LorFish.blastGain(chess, chess.findMove(sq("e3"), sq("d5"))), -v.n + v.p + v.q - v.b);
    // Taking the king is worth a mate, and comes first.
    const king = atomic("4k3/4p3/8/8/8/8/8/K3R2N w - - 0 1");
    assert.ok(LorFish.blastGain(king, king.findMove(sq("e1"), sq("e7"))) > LorFish.MATE - 1000);
  });

  test("counts the pieces beside a king that the enemy can blow up", () => {
    // A knight on e5 hits f7 and d7, both beside the black king.
    assert.equal(LorFish.blastThreats(atomic("rnbqkb1r/pppppppp/8/4N3/8/8/PPPPPPPP/RNBQKB1R b KQkq - 0 1"), B), 2);
    assert.equal(LorFish.blastThreats(atomic(), B), 0);
    // The queen may take d4 and the king with it — unless the kings touch:
    // then the blast would take White's king too, and no such capture is legal.
    assert.equal(LorFish.blastThreats(atomic("8/8/8/3k4/3p3Q/8/8/K7 b - - 0 1"), B), 1);
    assert.equal(LorFish.blastThreats(atomic("8/8/8/3kK3/3p3Q/8/8/8 b - - 0 1"), B), 0);
  });

  test("sees a knight's double threat on the king coming", () => {
    // After 1.d4 a6 2.Nf3, 2...Nf6 allows 3.Ne5, hitting f7 and d7 at once.
    const chess = atomic("rnbqkbnr/1ppppppp/p7/8/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 1 2");
    const { evals, best } = LorFish.searchRoot(chess, 2, {});
    assert.notEqual(best.san, "Nf6");
    assert.ok(evals.find((e) => e.san === "Nf6").raw < best.raw - 2 * LorFish.ATOMIC_DANGER + 50);
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = atomic();
    const rng = seeded(7);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
  });
});

describe("LorFish's pruned root and killer moves", () => {
  // Both only change how soon a score is found, never the move played: the
  // pruned root gives up exact scores for moves that could not be picked, and
  // killers only reorder. Checked against the plain full-window search.
  const POSITIONS = [
    [START_FEN],
    ...[positions[2], positions[3]].map((p) => [p.fen]),
    ["r1b1kbnr/ppp2ppp/2n5/q7/3P4/2N2N2/PPP2PPP/R1BQKB1R[NPnp] w KQkq - 0 6", "crazyhouse"],
    ["rnbqkbnr/1ppppppp/p7/8/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 1 2", "atomic"],
    ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1", "antichess"],
  ];

  test("the move played is the one the full search plays", (t) => {
    t.mock.property(LorFish, "KILLER_BONUS", 0);
    const plain = POSITIONS.map(([fen, variant], i) =>
      LorFish.searchRoot(fromFen(fen, variant), 2, { noise: true, rng: seeded(i) }).best);
    t.mock.restoreAll();
    POSITIONS.forEach(([fen, variant], i) => {
      const fast = LorFish.searchRoot(fromFen(fen, variant), 2, { noise: true, prune: true, rng: seeded(i) }).best;
      assert.deepEqual([fast.san, fast.raw], [plain[i].san, plain[i].raw], fen);
    });
  });

  test("searches fewer positions to find it", () => {
    const chess = new Chess();
    LorFish.searchRoot(chess, 3, {});
    const full = LorFish.nodes;
    LorFish.searchRoot(chess, 3, { prune: true });
    assert.ok(LorFish.nodes < full / 2, `${LorFish.nodes} of ${full}`);
  });

  test("a killer is tried after the captures, ahead of the other quiet moves", () => {
    const chess = fromFen("4k3/8/8/3p4/4P3/8/8/R3K3 w - - 0 1");
    const killer = chess.findMove(sq("a1"), sq("a7"));
    const ordered = LorFish.orderMoves(chess, chess.legalMoves(), [LorFish.moveKey(killer)]);
    assert.deepEqual(ordered.slice(0, 2).map((m) => chess.moveToSan(m)), ["exd5", "Ra7"]);
  });
});

describe("LorFish plays Crazyhouse", () => {
  const zh = (fen) => fromFen(fen || START_FEN, "crazyhouse");

  test("a piece in hand is material, and still counts towards the game's phase", () => {
    assert.equal(LorFish.evaluate(zh("k7/8/8/8/8/8/8/7K[N] w - - 0 1")) - LorFish.evaluate(zh("k7/8/8/8/8/8/8/7K[] w - - 0 1")),
      LorFish.pieceValues.n);
    assert.equal(LorFish.gamePhase(zh("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R[N] w KQkq - 0 1")), 24);
  });

  test("a square the enemy attacks beside the king is a way in, worth more the more they hold", () => {
    // The h5 queen hits f7 beside the black king.
    const fen = (hand) => `rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR[${hand}] b KQkq - 0 2`;
    const none = LorFish.kingZoneDanger(zh(fen("")), B);
    assert.ok(none > 0);
    assert.ok(LorFish.kingZoneDanger(zh(fen("N")), B) > none, "a knight in White's hand");
    assert.equal(LorFish.kingZoneDanger(zh(fen("n")), B), none, "one in Black's own changes nothing");
  });

  test("follows capture chains only so deep: pieces only change hands", () => {
    // A position from self-play where they ran past twenty captures.
    const chess = zh("r1qqkbr1/2pbn1p1/p2p3p/1p1Npp2/2PPP3/P3B1P1/1PKNNP1q~/2R2BR1[] w q - 2 24");
    LorFish.searchRoot(chess, 1, {});
    assert.ok(LorFish.maxQ <= LorFish.CRAZYHOUSE_QDEPTH, String(LorFish.maxQ));
  });

  test("drops a knight to mate", () => {
    const a = LorFish.analyse(zh("6rk/6pp/8/8/8/8/8/4K3[N] w - - 0 1"), 1);
    assert.equal(a.san, "N@f7#");
    assert.ok(a.score > LorFish.MATE - 10);
  });

  test("below the root, searches only the drops near a king; in check, every one", () => {
    const quiet = zh("4k3/8/8/8/8/8/8/4K3[N] w - - 0 1");
    const kept = LorFish.searchableDrops(quiet, quiet.legalMoves());
    assert.ok(kept.some((m) => m.drop && m.to === sq("e6")), "two squares from the black king");
    assert.ok(kept.some((m) => m.drop && m.to === sq("d2")), "beside the white king");
    assert.ok(!kept.some((m) => m.drop && m.to === sq("a4")), "nowhere near either");
    assert.ok(kept.some((m) => !m.drop && m.to === sq("d1")), "king moves all stay");
    const checked = zh("4k3/8/8/8/8/8/8/r3K3[N] w - - 0 1");
    assert.equal(LorFish.searchableDrops(checked, checked.legalMoves()).length, checked.legalMoves().length);
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = zh();
    const rng = seeded(3);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      const legal = m.drop ? chess.findDrop(m.drop, m.to) : chess.findMove(m.from, m.to, m.promo);
      assert.ok(legal, `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
  });
});

describe("LorFish plays King of the Hill", () => {
  const hill = (fen) => fromFen(fen, "kingofthehill");

  test("walks into the centre when it can", () => {
    const a = LorFish.analyse(hill("7k/7p/8/8/8/3K4/P7/8 w - - 0 1"), 1);
    assert.ok(["Kd4", "Ke4"].includes(a.san), a.san);
    assert.equal(a.score, LorFish.MATE - 1);
  });

  test("keeps the enemy king out: a rook onto the fifth rank, where it would step in", () => {
    // Black's king on e6 is a step from d5 and e5; White's rook can hold the rank.
    const a = LorFish.analyse(hill("8/7p/4k3/8/8/8/P7/K6R w - - 0 1"), 2);
    assert.ok(a.score > -LorFish.MATE + 100, `${a.san} ${a.score}`);
    assert.equal(a.san, "Rh5");
  });

  test("a king nearer the centre is worth more, the more so in an endgame", () => {
    const far = LorFish.evaluate(hill("7k/7p/8/8/8/8/P7/K7 w - - 0 1"));
    const near = LorFish.evaluate(hill("7k/7p/8/8/8/2K5/P7/8 w - - 0 1"));
    assert.ok(near > far, `${near} vs ${far}`);
    assert.equal(LorFish.hillTerm(new Chess(), 0), 0, "both kings at home: level");
    const step = (eg) => LorFish.hillTerm(hill("7k/8/8/8/8/3K4/8/8 w - - 0 1"), eg);
    assert.ok(step(24) > step(0));
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = hill("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    const rng = seeded(5);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
    assert.equal(chess.termination(), "king in the centre");
  });
});

describe("LorFish plays Three-check", () => {
  const three = (fen) => fromFen(fen, "threecheck");

  test("gives the third check when it can", () => {
    // White has given two; Re1-e8 is a quiet rook check, and the third.
    const a = LorFish.analyse(three("6k1/8/8/8/8/8/5PPP/4R1K1 w - - 1+3 0 30"), 1);
    assert.ok(a.san.endsWith("+") || a.san.endsWith("#"), a.san);
    assert.equal(a.score, LorFish.MATE - 1);
  });

  test("its capture search sees a quiet third check, not only captures", () => {
    // Black to move has given two checks and can give a third with ...Rd1+.
    const chess = three("3r2k1/8/8/8/8/8/5PPP/6K1 b - - 3+1 0 30");
    LorFish.rootPly = chess.history.length;
    assert.ok(LorFish.quiescence(chess, -Infinity, Infinity, 0) > LorFish.MATE - 10);
    // With only one given, a check is just a check: the stand-pat holds.
    const one = three("3r2k1/8/8/8/8/8/5PPP/6K1 b - - 3+2 0 30");
    assert.ok(LorFish.quiescence(one, -Infinity, Infinity, 0) < LorFish.MATE - 10);
  });

  test("each check given is worth more than the last", () => {
    const at = (left) => LorFish.checksTerm(three(`4k3/8/8/8/8/8/8/R3K3 w - - ${left}+3 0 1`));
    assert.equal(at(3), 0);
    assert.ok(at(1) - at(2) > at(2) - at(3), "the second check counts most");
  });

  test("plays a whole game to a finish, every move legal", (t) => {
    silence(t);
    const chess = three("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1");
    const rng = seeded(5);
    let plies = 0;
    while (!chess.isGameOver() && plies < 400) {
      const m = LorFish.getBestMove(chess, 1, { temperature: 30, rng });
      assert.ok(chess.findMove(m.from, m.to, m.promo), `ply ${plies + 1}`);
      chess.makeMove(m);
      plies++;
    }
    assert.equal(chess.isGameOver(), true, `still going after ${plies} plies: ${chess.fen()}`);
  });
});
