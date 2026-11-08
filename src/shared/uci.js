"use strict";

// Reading a move as it is stored and sent: UCI long algebraic, "e2e4", with a
// promotion letter on the end ("e7e8q"). Castling is spelled king-to-rook
// ("e1h1"), or by the king's destination in games recorded before Chess960;
// Chess.findMove takes either, so this file need not know which.
//
// One reader, because the slicing was once copied into every place that
// replays a game — server rebuild, achievements, puzzles, the game, replay,
// review and analysis pages, the lobby's previews — and a new kind of move (a
// Crazyhouse drop, say) would have had to be taught to each copy.
//
// Loaded as a browser <script> (served at /js/uci.js) and as a Node `require`.
// It needs nothing from chess.js, so a page without the engine (the lobby) can
// still read a move's squares.

const UCI_MOVE = /^([a-h])([1-8])([a-h])([1-8])([qrbn]?)$/;

// "e7e8q" -> { from: 52, to: 60, promo: "q" }, squares numbered as in chess.js
// (0 = a1, 63 = h8). null for anything that is not a well-formed move.
function parseUci(text) {
  const m = typeof text === 'string' ? UCI_MOVE.exec(text) : null;
  if (!m) return null;
  const sq = (file, rank) => (file.charCodeAt(0) - 97) + (Number(rank) - 1) * 8;
  return { from: sq(m[1], m[2]), to: sq(m[3], m[4]), promo: m[5] || null };
}

// The legal move `text` names in `chess`'s current position, or null if it is
// malformed or not legal there.
function moveFromUci(chess, text) {
  const p = parseUci(text);
  return p ? chess.findMove(p.from, p.to, p.promo) : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseUci, moveFromUci };
}
