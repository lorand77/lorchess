"use strict";

// Reading and writing a move as it is stored and sent: UCI long algebraic,
// "e2e4", with a promotion letter on the end ("e7e8q"). Castling is spelled
// king-to-rook ("e1h1"), or by the king's destination in games recorded before
// Chess960; Chess.findMove takes either, so the reader need not know which. A
// Crazyhouse drop is the piece's letter, "@" and the square: "N@e4", "P@e4".
// An infinite-chess move is ICN's compact form, coordinates on a board with
// no edges: "5,2>5,4", with a promotion letter in the mover's case
// ("4,7>4,8Q" for White, "4,2>4,1q" for Black).
//
// One reader and one writer, because both were once copied into every place
// that records or replays a game — server rebuild, achievements, puzzles, the
// game, replay, review and analysis pages, the lobby's previews — and a new
// kind of move (a Crazyhouse drop, say) would have had to be taught to each.
//
// Loaded as a browser <script> (served at /js/uci.js) and as a Node `require`.
// It needs nothing from chess.js, so a page without the engine (the lobby) can
// still read a move's squares.

// The promotion letter can be a king's: Antichess pawns may promote to one.
const UCI_MOVE = /^([a-h])([1-8])([a-h])([1-8])([qrbnk]?)$/;
const UCI_DROP = /^([QRBNP])@([a-h])([1-8])$/;
// Coordinates are whole numbers written plainly: no leading zeros, no "-0".
const ICN_MOVE = /^((?:0|-?[1-9]\d{0,14})),((?:0|-?[1-9]\d{0,14}))>((?:0|-?[1-9]\d{0,14})),((?:0|-?[1-9]\d{0,14}))([QRBNqrbn]?)$/;

// "e7e8q" -> { from: 52, to: 60, promo: "q", drop: null }, squares numbered as
// in chess.js (0 = a1, 63 = h8). A drop has no square it comes from:
// "N@e4" -> { from: null, to: 28, promo: null, drop: "n" }. An infinite-chess
// move has coordinates for squares, and says whose promotion it is:
// "4,7>4,8Q" -> { from: { x: 4, y: 7 }, to: { x: 4, y: 8 }, promo: "q",
// drop: null, promoColor: "w" }. null for anything that is not a well-formed move.
function parseUci(text) {
  if (typeof text !== 'string') return null;
  const sq = (file, rank) => (file.charCodeAt(0) - 97) + (Number(rank) - 1) * 8;
  const m = UCI_MOVE.exec(text);
  if (m) return { from: sq(m[1], m[2]), to: sq(m[3], m[4]), promo: m[5] || null, drop: null };
  const d = UCI_DROP.exec(text);
  if (d) return { from: null, to: sq(d[2], d[3]), promo: null, drop: d[1].toLowerCase() };
  const c = ICN_MOVE.exec(text);
  if (c) {
    const parsed = {
      from: { x: Number(c[1]), y: Number(c[2]) },
      to: { x: Number(c[3]), y: Number(c[4]) },
      promo: c[5] ? c[5].toLowerCase() : null,
      drop: null,
    };
    if (c[5]) parsed.promoColor = c[5] === parsed.promo ? 'b' : 'w';
    return parsed;
  }
  return null;
}

// The legal move `text` names in `chess`'s current position, or null if it is
// malformed or not legal there.
function moveFromUci(chess, text) {
  const p = parseUci(text);
  if (!p) return null;
  // A promotion letter in the other side's case names the wrong piece.
  if (p.promoColor && p.promoColor !== chess.turn) return null;
  return p.drop ? chess.findDrop(p.drop, p.to) : chess.findMove(p.from, p.to, p.promo);
}

// A move object from chess.js, written the way it is stored: castling by the
// rook's square ("e1h1", see Chess.findMove for why), a drop as "N@e4". One
// from infiniteChess.js, whose squares are { x, y }, in ICN's compact form.
function formatUci(move) {
  if (move.from && typeof move.from === 'object') {
    const promo = move.promo ? (move.color === 'w' ? move.promo.toUpperCase() : move.promo) : '';
    return `${move.from.x},${move.from.y}>${move.to.x},${move.to.y}${promo}`;
  }
  const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
  if (move.drop) return move.drop.toUpperCase() + '@' + alg(move.to);
  const to = move.castle && move.rookFrom != null ? move.rookFrom : move.to;
  return alg(move.from) + alg(to) + (move.promo || '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseUci, moveFromUci, formatUci };
}
