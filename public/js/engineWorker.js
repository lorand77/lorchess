"use strict";

// LorFish runs a synchronous, main-thread-blocking search. Hosting it in this
// Web Worker keeps the UI responsive — no more setTimeout paint hacks or
// "scanner" sound to mask a freeze, because the freeze no longer happens.
//
// Pick a move — { id, startFen, moves, depth, temperature }
//   startFen : starting position FEN (ICN for infinite chess), or null for
//              the variant's own start
//   variant  : the catalogue key; infinite chess has an engine and a LorFish
//              of its own (infiniteChess.js, lorfishInfinite.js)
//   moves    : the moves since startFen as stored ("e2e4", "N@e4",
//              "5,2>5,4"), replayed here so positionCounts / threefold
//              repetition is rebuilt correctly (loadFen and reset both wipe it).
//   depth, temperature : the game's level (src/shared/aiLevels.js); a
//              temperature of 0 is the plain search with its tiebreak jitter.
// Reply: { id, move|null, error? }  move = {from,to,promo,drop}, squares as
// the variant's engine numbers them: 0-63, or { x, y } in infinite chess.
//
// Game review used to run here too; it is Stockfish's job now (gameReview.js).

importScripts("/js/chess.js", "/js/infiniteChess.js", "/js/engines.js", "/js/uci.js",
  "/js/lorfish.js", "/js/lorfishInfinite.js");

self.onmessage = (e) => {
  const { id, startFen, variant, moves, depth, temperature } = e.data || {};
  try {
    // The variant's engine, at its own start, then the game's start if it has
    // one: loading never changes the rules.
    const chess = createEngine(variant || "standard");
    if (startFen) chess.loadFen(startFen);
    const bot = variant === "infinite" ? LorFishInfinite : LorFish;

    for (const text of moves || []) {
      const match = moveFromUci(chess, text);
      if (!match) {
        self.postMessage({ id, move: null, error: "illegal move during replay" });
        return;
      }
      chess.makeMove(match);
    }

    const move = bot.getBestMove(chess, depth, { temperature });
    self.postMessage({
      id,
      // Castling spelled by the rook square: on a shuffled back rank the king's
      // destination alone can also be a plain king step (see Chess.findMove).
      // A Crazyhouse drop names its piece and has no square it leaves. An
      // infinite-chess castling is the king's two-square step, which its
      // findMove reads as castling (it has no rookFrom).
      move: move
        ? {
            from: move.from,
            to: move.castle && move.rookFrom != null ? move.rookFrom : move.to,
            promo: move.promo || null,
            drop: move.drop || null,
          }
        : null,
    });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err && err.message || err) });
  }
};
