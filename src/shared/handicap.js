"use strict";

// Handicap positions: the standard opening setup with pieces taken off or
// swapped for different ones, so players of different strength can agree terms.
// Loaded both as a browser <script> (served at /js/handicap.js, used by the
// position editor) and as a Node `require` (used by the lobby to validate).
//
// The wire format is a sparse map of CHANGES to the 32 starting squares:
//
//   { "3": null, "1": "r" }   // clear d1, make b1 a rook
//
// never a FEN. The server rebuilds the position itself, so the worst a crafted
// payload can do is describe a different arrangement of the starting squares —
// which is exactly the feature. Colour is never sent: it comes from the square,
// so a change can't smuggle a black piece onto White's rank.

// Square index is file + rank * 8, so 0 = a1 and 63 = h8.
const START_PIECES = (function () {
  const map = new Array(64).fill(null);
  const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (let f = 0; f < 8; f++) {
    map[f] = back[f];                    // rank 1, white back rank
    map[8 + f] = 'P';                    // rank 2
    map[48 + f] = 'p';                   // rank 7
    map[56 + f] = back[f].toLowerCase(); // rank 8, black back rank
  }
  return map;
})();

const WHITE_KING_SQ = 4;
const BLACK_KING_SQ = 60;
// Corner rooks. Castling is offered only when the original corner still holds a
// rook — putting a rook somewhere else on the back rank doesn't create a right.
const ROOK_SQ = { K: 7, Q: 0, k: 63, q: 56 };

// The types a square may be set to. Kings are excluded: a side must have exactly
// one, and moving it would change the position's character entirely.
const PLACEABLE = ['q', 'r', 'b', 'n', 'p'];

const isStartSquare = (sq) => !!START_PIECES[sq];
const isKingSquare = (sq) => sq === WHITE_KING_SQ || sq === BLACK_KING_SQ;
const isEditable = (sq) => isStartSquare(sq) && !isKingSquare(sq);
const isWhiteSquare = (sq) => sq < 16;
// A pawn cannot stand on the first or last rank.
const isBackRank = (sq) => sq < 8 || sq >= 56;
const algOfSq = (sq) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const isWhitePiece = (p) => p === p.toUpperCase();

// Colour the type for the square it sits on. Nothing else decides colour.
function pieceFor(sq, type) {
  if (type == null) return null;
  const t = String(type).toLowerCase();
  return isWhiteSquare(sq) ? t.toUpperCase() : t;
}

// Check a client-supplied change map. Returns { ok: true, squares } with the
// no-op entries dropped, or { ok: false, error }.
function validateSquares(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'No changes given.' };
  }
  const squares = {};
  for (const key of Object.keys(input)) {
    const sq = Number(key);
    if (!Number.isInteger(sq) || sq < 0 || sq > 63) {
      return { ok: false, error: 'That is not a square on the board.' };
    }
    if (!isStartSquare(sq)) {
      return { ok: false, error: 'That square is empty in the starting position.' };
    }
    if (isKingSquare(sq)) {
      return { ok: false, error: 'A king cannot be removed or replaced.' };
    }
    const raw = input[key];
    if (raw === null || raw === undefined || raw === '') {
      squares[sq] = null;
      continue;
    }
    const type = String(raw).toLowerCase();
    if (!PLACEABLE.includes(type)) {
      return { ok: false, error: 'A square can only hold a queen, rook, bishop, knight or pawn.' };
    }
    if (type === 'p' && isBackRank(sq)) {
      return { ok: false, error: 'A pawn cannot stand on the first or last rank.' };
    }
    // Setting a square back to what it already holds is not a change.
    if (pieceFor(sq, type) === START_PIECES[sq]) continue;
    squares[sq] = type;
  }
  if (!Object.keys(squares).length) {
    return { ok: false, error: 'Change at least one piece.' };
  }
  return { ok: true, squares };
}

// Build the FEN for the standard setup with `squares` applied. White is always
// to move; castling rights follow the corner rooks that are still in place.
function buildFen(squares) {
  const changes = squares || {};
  const pieceAt = (sq) =>
    Object.prototype.hasOwnProperty.call(changes, sq)
      ? pieceFor(sq, changes[sq])
      : START_PIECES[sq];

  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pieceAt(rank * 8 + file);
      if (!piece) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += piece;
    }
    if (empty) row += empty;
    rows.push(row);
  }

  let castling = '';
  for (const right of ['K', 'Q', 'k', 'q']) {
    const sq = ROOK_SQ[right];
    if (pieceAt(sq) === START_PIECES[sq]) castling += right;
  }
  return rows.join('/') + ' w ' + (castling || '-') + ' - 0 1';
}

// Short summary of the terms, e.g. "White −Q · Black N→R". Used in the lobby
// lists so whoever accepts an offer can read what they are agreeing to.
function describe(squares) {
  const changes = squares || {};
  const sides = { w: [], b: [] };
  const order = ['Q', 'R', 'B', 'N', 'P'];
  for (const key of Object.keys(changes)) {
    const sq = Number(key);
    const was = START_PIECES[sq];
    if (!was) continue;
    const now = pieceFor(sq, changes[key]);
    const side = isWhitePiece(was) ? 'w' : 'b';
    sides[side].push(
      now === null
        ? { sort: order.indexOf(was.toUpperCase()), text: '−' + was.toUpperCase() }
        : { sort: order.indexOf(was.toUpperCase()), text: was.toUpperCase() + '→' + now.toUpperCase() }
    );
  }
  const fmt = (list) =>
    list.sort((a, b) => a.sort - b.sort).map((x) => x.text).join(' ');
  const parts = [];
  if (sides.w.length) parts.push('White ' + fmt(sides.w));
  if (sides.b.length) parts.push('Black ' + fmt(sides.b));
  return parts.join(' · ');
}

// The same terms for the other side: every change moved to the mirrored
// square (same file, opposite rank). Colour comes from the square, so the type
// carries over as it is. A rematch swaps colours, and the player who gave the
// odds should still be the one giving them.
function mirror(squares) {
  const out = {};
  for (const key of Object.keys(squares || {})) out[Number(key) ^ 56] = squares[key];
  return out;
}

// Recover the change map from a stored start position. Returns null when the
// FEN is not the standard setup with the starting squares rearranged — a
// Chess960 start, for instance, or any mid-game position.
function diffFromFen(fen) {
  if (typeof fen !== 'string') return null;
  const ranks = fen.trim().split(/\s+/)[0].split('/');
  if (ranks.length !== 8) return null;

  const at = new Array(64).fill(null);
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i; // FEN lists rank 8 first
    let file = 0;
    for (const ch of ranks[i]) {
      if (ch >= '1' && ch <= '8') { file += Number(ch); continue; }
      if (file > 7) return null;
      at[rank * 8 + file] = ch;
      file++;
    }
    if (file !== 8) return null;
  }

  const changes = {};
  for (let sq = 0; sq < 64; sq++) {
    const want = START_PIECES[sq];
    const got = at[sq];
    if (!want) {
      if (got) return null;      // something on a square the setup leaves empty
      continue;
    }
    if (got === want) continue;
    if (isKingSquare(sq)) return null; // a king elsewhere: not a handicap
    changes[sq] = got === null ? null : got.toLowerCase();
  }
  return changes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    START_PIECES, PLACEABLE, WHITE_KING_SQ, BLACK_KING_SQ,
    isStartSquare, isKingSquare, isEditable, isWhiteSquare, isBackRank,
    algOfSq, isWhitePiece, pieceFor,
    validateSquares, buildFen, describe, diffFromFen, mirror,
  };
}
