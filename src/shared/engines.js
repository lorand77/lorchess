"use strict";

// Which rules engine plays a variant. Every variant but one is chess.js with
// its rule set chosen by setVariant(); infinite chess, whose board has no
// edges, is infiniteChess.js. The two share what a game needs of them —
// findMove, makeMove, moveToSan, fen and loadFen, reset, turn, history,
// isGameOver, result, hasMatingMaterial — so the server and the pages ask
// here for an engine and never need to know which one they got.
//
// Loaded as a browser <script> after chess.js and infiniteChess.js (their
// globals are used there), and as a Node `require`.

const createEngine = (function () {
  const node = typeof module !== 'undefined' && module.exports;
  const classes = () => (node
    ? { Chess: require('./chess').Chess, InfiniteChess: require('./infiniteChess').InfiniteChess }
    : { Chess, InfiniteChess });

  // A fresh engine for `variant`, at its own start position. Anything that
  // is not infinite chess is a chess.js rule set, which itself turns an
  // unknown name into standard chess.
  return function createEngine(variant) {
    const { Chess: ChessEngine, InfiniteChess: InfiniteEngine } = classes();
    if (variant === 'infinite') return new InfiniteEngine();
    const engine = new ChessEngine().setVariant(variant);
    engine.reset();
    return engine;
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createEngine };
}
