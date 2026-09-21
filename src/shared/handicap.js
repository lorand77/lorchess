"use strict";

// Handicap positions: the standard opening setup with some pieces taken off, so
// a stronger player can give material odds. Loaded both as a browser <script>
// (served at /js/handicap.js, used by the position editor) and as a Node
// `require` (used by the lobby to validate an offer).
//
// The wire format is a list of SQUARES TO REMOVE, never a FEN. The server
// rebuilds the position itself from that list, so a crafted payload can't
// smuggle in an arbitrary board — the worst anyone can do is remove pieces,
// which is exactly the feature.

// Square index is file + rank * 8, so 0 = a1 and 63 = h8.
const START_PIECES = (function () {
  const map = new Array(64).fill(null);
  const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (let f = 0; f < 8; f++) {
    map[f] = back[f];                  // rank 1, white back rank
    map[8 + f] = 'P';                  // rank 2
    map[48 + f] = 'p';                 // rank 7
    map[56 + f] = back[f].toLowerCase(); // rank 8, black back rank
  }
  return map;
})();

const WHITE_KING_SQ = 4;
const BLACK_KING_SQ = 60;
// Corner rooks, which decide castling rights once a rook is taken off.
const ROOK_SQ = { K: 7, Q: 0, k: 63, q: 56 };

// Every piece except the two kings. This is only a bound on payload size: what
// actually rules out silly positions is the caller's check that the game isn't
// already over (see lobby.js resolveHandicap), which rejects bare kings and
// king-plus-lone-minor endings with a message that explains itself.
const MAX_REMOVED = 30;

const PIECE_NAMES = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };

const isWhitePiece = (p) => p === p.toUpperCase();
const canRemove = (sq) => !!START_PIECES[sq] && sq !== WHITE_KING_SQ && sq !== BLACK_KING_SQ;
const algOfSq = (sq) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);

// Build the FEN for the standard setup minus `removed`. White is always to move
// and castling rights are recomputed from the rooks still standing on their
// original squares — the kings can never be removed, so nothing else matters.
function buildFen(removed) {
  const gone = new Set(removed);
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const sq = rank * 8 + file;
      const piece = gone.has(sq) ? null : START_PIECES[sq];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      row += piece;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  let castling = '';
  for (const right of ['K', 'Q', 'k', 'q']) {
    if (!gone.has(ROOK_SQ[right])) castling += right;
  }
  return rows.join('/') + ' w ' + (castling || '-') + ' - 0 1';
}

// Structural check on a client-supplied removal list. Returns
// { ok: true, removed } with duplicates dropped and the order normalised, or
// { ok: false, error }. Whether the resulting position is *playable* (not an
// immediate dead draw) is checked by the caller, which has the chess rules.
function validateRemovals(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'No pieces given.' };
  const seen = new Set();
  for (const raw of list) {
    const sq = Number(raw);
    if (!Number.isInteger(sq) || sq < 0 || sq > 63) {
      return { ok: false, error: 'That is not a square on the board.' };
    }
    if (!START_PIECES[sq]) {
      return { ok: false, error: 'That square is empty in the starting position.' };
    }
    if (sq === WHITE_KING_SQ || sq === BLACK_KING_SQ) {
      return { ok: false, error: 'A king cannot be removed.' };
    }
    seen.add(sq);
  }
  if (seen.size === 0) return { ok: false, error: 'Remove at least one piece.' };
  if (seen.size > MAX_REMOVED) {
    return { ok: false, error: `Remove at most ${MAX_REMOVED} pieces.` };
  }
  return { ok: true, removed: [...seen].sort((a, b) => a - b) };
}

// Short summary of the odds, e.g. "White −Q · Black −R−N". Used in the lobby
// lists so whoever accepts an offer can see the terms first.
function describe(removed) {
  const sides = { w: [], b: [] };
  for (const sq of removed || []) {
    const piece = START_PIECES[sq];
    if (!piece) continue;
    sides[isWhitePiece(piece) ? 'w' : 'b'].push(piece.toUpperCase());
  }
  const order = ['Q', 'R', 'B', 'N', 'P'];
  const fmt = (list) =>
    list.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => '−' + p).join('');
  const parts = [];
  if (sides.w.length) parts.push('White ' + fmt(sides.w));
  if (sides.b.length) parts.push('Black ' + fmt(sides.b));
  return parts.join(' · ');
}

// Which standard-start squares are empty in `fen`? Returns null when the position
// is not simply the standard setup minus pieces — i.e. not a handicap at all —
// so a caller can tell "odds game" from "some other custom position".
function removalsFromFen(fen) {
  if (typeof fen !== 'string') return null;
  const ranks = fen.trim().split(/\s+/)[0].split('/');
  if (ranks.length !== 8) return null;

  const at = new Array(64).fill(null);
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i; // FEN lists rank 8 first
    let file = 0;
    for (const ch of ranks[i]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (file > 7) return null;
      at[rank * 8 + file] = ch;
      file++;
    }
    if (file !== 8) return null;
  }

  const removed = [];
  for (let sq = 0; sq < 64; sq++) {
    if (at[sq] === START_PIECES[sq]) continue;
    if (at[sq] === null && START_PIECES[sq]) {
      removed.push(sq);
      continue;
    }
    return null; // a piece somewhere the standard setup doesn't put one
  }
  return removed;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    START_PIECES, MAX_REMOVED, PIECE_NAMES, WHITE_KING_SQ, BLACK_KING_SQ,
    canRemove, algOfSq, isWhitePiece, buildFen, validateRemovals, describe,
    removalsFromFen,
  };
}
