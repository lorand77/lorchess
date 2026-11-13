"use strict";

// One worker thread of the server's LorFish (src/game/bots.js). LorFish's
// search is synchronous and can take seconds; on the main thread it would hold
// up every live game, so it runs here. It answers one question at a time:
// the position (a FEN, which for a Bughouse board carries its pockets), the
// variant's rules and how hard to look, and replies with the move.
//
//   in:  { id, variant, fen, depth, temperature }
//   out: { id, move: { from, to, promo, drop } | null } or { id, error }
//
// It searches as getBestMove does (the jitter, the pruned root, a temperature
// for the weaker levels) but through searchRoot, which writes nothing to the
// console: this is server code.

const { parentPort } = require("worker_threads");
const { createEngine } = require("../shared/engines");
const { LorFish } = require("../shared/lorfish");

parentPort.on("message", ({ id, variant, fen, depth, temperature }) => {
  try {
    const chess = createEngine(variant);
    chess.loadFen(fen);
    const { best } = LorFish.searchRoot(chess, depth, { noise: true, prune: true, temperature });
    const m = best && best.move;
    parentPort.postMessage({
      id,
      move: m ? { from: m.drop ? null : m.from, to: m.to, promo: m.promo || null, drop: m.drop || null } : null,
    });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
