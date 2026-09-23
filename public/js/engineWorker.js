"use strict";

// LorFish runs a synchronous, main-thread-blocking search. Hosting it in this
// Web Worker keeps the UI responsive — no more setTimeout paint hacks or
// "scanner" sound to mask a freeze, because the freeze no longer happens.
//
// Two jobs, both CPU-bound enough to need their own thread.
//
// 1. Pick a move — { id, startFen, moves, depth }
//      startFen : starting position FEN, or null for the standard start
//      moves    : [{from,to,promo}] applied since startFen, replayed here so
//                 positionCounts / threefold repetition is rebuilt correctly
//                 (loadFen and reset both wipe it).
//      depth    : search depth.
//    Reply: { id, move|null, error? }  move = {from,to,promo}
//
// 2. Review a game — { id, type:"review", startFen, uciMoves, depth }
//    Evaluates every position in turn and streams one message per ply, so the
//    page can show progress instead of freezing for ten seconds:
//      { id, type:"review:eval", ply, total, turn, score|null, best|null, depth }
//    `depth` is the EFFECTIVE depth — LorFish searches deeper once material
//    comes off (adaptiveDepth), in review exactly as it does when playing.
//      { id, type:"review:done", total }
//      { id, type:"review:error", error }
//    `score` is centipawns from the side to move's point of view.

importScripts("/js/chess.js", "/js/lorfish.js");

const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
const uciOf = (m) => alg(m.from) + alg(m.to) + (m.promo || "");

function findUci(chess, uci) {
  if (typeof uci !== "string" || uci.length < 4) return null;
  const from = (uci.charCodeAt(0) - 97) + (Number(uci[1]) - 1) * 8;
  const to = (uci.charCodeAt(2) - 97) + (Number(uci[3]) - 1) * 8;
  const promo = uci[4] || null;
  return chess.legalMoves().find(
    (m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo)
  ) || null;
}

// Walk the game from the start, assessing the position BEFORE each move and
// then the final one. Position i's score and best move are everything the page
// needs to judge move i: what was available, and what it cost to play something
// else.
function runReview(data) {
  const { id, startFen, uciMoves, depth } = data;
  const moves = uciMoves || [];
  const total = moves.length;
  try {
    const chess = new Chess();
    if (startFen) chess.loadFen(startFen);
    else chess.reset();

    for (let ply = 0; ply <= total; ply++) {
      const a = LorFish.analyse(chess, depth);
      self.postMessage({
        id,
        type: "review:eval",
        ply,
        total,
        turn: chess.turn,
        score: a ? a.score : null,
        best: a ? { uci: uciOf(a.move), san: a.san } : null,
        depth: a ? a.depth : null,
      });
      if (ply === total) break;
      const mv = findUci(chess, moves[ply]);
      if (!mv) {
        self.postMessage({ id, type: "review:error", error: "Illegal move in the game record: " + moves[ply] });
        return;
      }
      chess.makeMove(mv);
    }
    self.postMessage({ id, type: "review:done", total });
  } catch (err) {
    self.postMessage({ id, type: "review:error", error: String((err && err.message) || err) });
  }
}

self.onmessage = (e) => {
  const data = e.data || {};
  if (data.type === "review") return runReview(data);
  const { id, startFen, moves, depth } = data;
  try {
    const chess = new Chess();
    if (startFen) chess.loadFen(startFen);
    else chess.reset();

    for (const mv of moves || []) {
      const match = chess.legalMoves().find(
        (m) =>
          m.from === mv.from &&
          m.to === mv.to &&
          (mv.promo ? m.promo === mv.promo : !m.promo)
      );
      if (!match) {
        self.postMessage({ id, move: null, error: "illegal move during replay" });
        return;
      }
      chess.makeMove(match);
    }

    const move = LorFish.getBestMove(chess, depth);
    self.postMessage({
      id,
      move: move ? { from: move.from, to: move.to, promo: move.promo || null } : null,
    });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err && err.message || err) });
  }
};
