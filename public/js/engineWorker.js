"use strict";

// LorFish runs a synchronous, main-thread-blocking search. Hosting it in this
// Web Worker keeps the UI responsive — no more setTimeout paint hacks or
// "scanner" sound to mask a freeze, because the freeze no longer happens.
//
// Pick a move — { id, startFen, moves, depth }
//   startFen : starting position FEN, or null for the standard start
//   moves    : [{from,to,promo}] applied since startFen, replayed here so
//              positionCounts / threefold repetition is rebuilt correctly
//              (loadFen and reset both wipe it).
//   depth    : search depth.
// Reply: { id, move|null, error? }  move = {from,to,promo}
//
// Game review used to run here too; it is Stockfish's job now (gameReview.js).

importScripts("/js/chess.js", "/js/lorfish.js");

self.onmessage = (e) => {
  const { id, startFen, moves, depth } = e.data || {};
  try {
    const chess = new Chess();
    if (startFen) chess.loadFen(startFen);
    else chess.reset();

    for (const mv of moves || []) {
      const match = chess.findMove(mv.from, mv.to, mv.promo);
      if (!match) {
        self.postMessage({ id, move: null, error: "illegal move during replay" });
        return;
      }
      chess.makeMove(match);
    }

    const move = LorFish.getBestMove(chess, depth);
    self.postMessage({
      id,
      // Castling spelled by the rook square: on a shuffled back rank the king's
      // destination alone can also be a plain king step (see Chess.findMove).
      move: move
        ? {
            from: move.from,
            to: move.castle && move.rookFrom != null ? move.rookFrom : move.to,
            promo: move.promo || null,
          }
        : null,
    });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err && err.message || err) });
  }
};
