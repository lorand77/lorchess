"use strict";

// LorFish runs a synchronous, main-thread-blocking search. Hosting it in this
// Web Worker keeps the UI responsive — no more setTimeout paint hacks or
// "scanner" sound to mask a freeze, because the freeze no longer happens.
//
// Protocol (main thread → worker): { id, startFen, moves, depth }
//   startFen : starting position FEN, or null for the standard start
//   moves    : [{from,to,promo}] applied since startFen, replayed here so
//              positionCounts / threefold repetition is rebuilt correctly
//              (loadFen and reset both wipe it).
//   depth    : search depth.
// Reply (worker → main): { id, move|null, error? }  move = {from,to,promo}

importScripts("/js/chess.js", "/js/lorfish.js");

self.onmessage = (e) => {
  const { id, startFen, moves, depth } = e.data || {};
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
