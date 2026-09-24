"use strict";

// Plays a Lichess puzzle against LorFish.
//
// A puzzle's `fen` is the position BEFORE the opponent's setup move, and its
// `moves` (UCI, space separated) begin with that move and then alternate:
// solution move, forced reply, solution move, ... The engine must produce
// every solution move. On the last move of a mate puzzle any mating move is
// accepted, as on Lichess itself.

const { Chess } = require("../../src/shared/chess");
const { LorFish } = require("../../src/shared/lorfish");
const { moveOf, uci } = require("./board");

function mates(chess, text) {
  if (!text) return false;
  const m = moveOf(chess, text);
  if (!m) return false;
  chess.makeMove(m);
  const yes = chess.isCheckmate();
  chess.undoMove();
  return yes;
}

// Returns { ok: true, ms } or { ok: false, ply, got, want, ms }.
function solvePuzzle(puzzle, depth) {
  const chess = new Chess();
  chess.loadFen(puzzle.fen);
  const moves = puzzle.moves.split(" ");
  const setup = moveOf(chess, moves[0]);
  if (!setup) throw new Error(`puzzle ${puzzle.id}: setup move ${moves[0]} is illegal`);
  chess.makeMove(setup);
  const mate = /\bmateIn\d\b/.test(puzzle.themes);
  const t0 = performance.now();
  for (let i = 1; i < moves.length; i += 2) {
    const verdict = LorFish.analyse(chess, depth);
    const got = verdict ? uci(verdict.move) : null;
    const want = moves[i];
    const lastMove = i === moves.length - 1;
    if (got !== want && !(mate && lastMove && mates(chess, got))) {
      return { ok: false, ply: (i + 1) / 2, got, want, ms: performance.now() - t0 };
    }
    chess.makeMove(moveOf(chess, want));
    if (i + 1 < moves.length) chess.makeMove(moveOf(chess, moves[i + 1]));
  }
  return { ok: true, ms: performance.now() - t0 };
}

const link = (puzzle) => `https://lichess.org/training/${puzzle.id}`;

module.exports = { solvePuzzle, link };
