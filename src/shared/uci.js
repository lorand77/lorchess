"use strict";

// Reading and writing a move as it is stored and sent: UCI long algebraic,
// "e2e4", with a promotion letter on the end ("e7e8q"). Castling is spelled
// king-to-rook ("e1h1"), or by the king's destination in games recorded before
// Chess960; Chess.findMove takes either, so the reader need not know which. A
// Crazyhouse drop is the piece's letter, "@" and the square: "N@e4", "P@e4".
//
// One reader and one writer, because both were once copied into every place
// that records or replays a game — server rebuild, achievements, puzzles, the
// game, replay, review and analysis pages, the lobby's previews — and a new
// kind of move (a Crazyhouse drop, say) would have had to be taught to each.
//
// Loaded as a browser <script> (served at /js/uci.js) and as a Node `require`.
// It needs nothing from chess.js, so a page without the engine (the lobby) can
// still read a move's squares.

const UCI_MOVE = /^([a-h])([1-8])([a-h])([1-8])([qrbn]?)$/;
const UCI_DROP = /^([QRBNP])@([a-h])([1-8])$/;

// "e7e8q" -> { from: 52, to: 60, promo: "q", drop: null }, squares numbered as
// in chess.js (0 = a1, 63 = h8). A drop has no square it comes from:
// "N@e4" -> { from: null, to: 28, promo: null, drop: "n" }. null for anything
// that is not a well-formed move.
function parseUci(text) {
  if (typeof text !== 'string') return null;
  const sq = (file, rank) => (file.charCodeAt(0) - 97) + (Number(rank) - 1) * 8;
  const m = UCI_MOVE.exec(text);
  if (m) return { from: sq(m[1], m[2]), to: sq(m[3], m[4]), promo: m[5] || null, drop: null };
  const d = UCI_DROP.exec(text);
  if (d) return { from: null, to: sq(d[2], d[3]), promo: null, drop: d[1].toLowerCase() };
  return null;
}

// The legal move `text` names in `chess`'s current position, or null if it is
// malformed or not legal there.
function moveFromUci(chess, text) {
  const p = parseUci(text);
  if (!p) return null;
  return p.drop ? chess.findDrop(p.drop, p.to) : chess.findMove(p.from, p.to, p.promo);
}

// A move object from chess.js, written the way it is stored: castling by the
// rook's square ("e1h1", see Chess.findMove for why), a drop as "N@e4".
function formatUci(move) {
  const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
  if (move.drop) return move.drop.toUpperCase() + '@' + alg(move.to);
  const to = move.castle && move.rookFrom != null ? move.rookFrom : move.to;
  return alg(move.from) + alg(to) + (move.promo || '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseUci, moveFromUci, formatUci };
}
