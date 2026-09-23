"use strict";

// Chess960 (Fischer Random). Same pieces on the back rank as standard chess,
// shuffled, subject to two rules:
//   - the two bishops stand on opposite-coloured squares;
//   - the king stands somewhere between the two rooks.
// Exactly 960 arrangements satisfy both, hence the name. Black mirrors White.
//
// Castling still exists and still finishes with the king on the g- or c-file and
// the rook beside it — the engine handles that from arbitrary starting squares
// (see deriveCastlingLayout in chess.js).
//
// Shared by the server (which generates the position for a new game) and the
// browser (which previews it), the same way chess.js and timeControls.js are.

const PIECES = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

// Is this back rank a legal Chess960 arrangement?
function isValidBackRank(rank) {
  if (!Array.isArray(rank) || rank.length !== 8) return false;
  const counts = {};
  for (const p of rank) counts[p] = (counts[p] || 0) + 1;
  for (const p of PIECES) {
    const want = PIECES.filter((x) => x === p).length;
    if (counts[p] !== want) return false;
  }
  const bishops = [];
  const rooks = [];
  let king = -1;
  rank.forEach((p, f) => {
    if (p === 'b') bishops.push(f);
    else if (p === 'r') rooks.push(f);
    else if (p === 'k') king = f;
  });
  // Opposite-coloured bishops: their files differ in parity.
  if ((bishops[0] % 2) === (bishops[1] % 2)) return false;
  // King between the rooks, so both castlings are possible.
  if (!(king > rooks[0] && king < rooks[1])) return false;
  return true;
}

// A random legal back rank. Rejection sampling: about one shuffle in twenty is
// legal, so this returns after a handful of tries and is far easier to read
// (and to be sure of) than the indexed construction.
function randomBackRank(rnd) {
  const random = rnd || Math.random;
  for (let tries = 0; tries < 10000; tries++) {
    const rank = PIECES.slice();
    for (let i = rank.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = rank[i]; rank[i] = rank[j]; rank[j] = t;
    }
    if (isValidBackRank(rank)) return rank;
  }
  // Unreachable in practice; fall back to the standard arrangement.
  return ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
}

// Full starting FEN for a back rank. Castling rights are written as plain KQkq:
// chess.js resolves which rook each refers to from the board itself.
function fenFor(rank) {
  const black = rank.join('');
  const white = black.toUpperCase();
  return black + '/pppppppp/8/8/8/8/PPPPPPPP/' + white + ' w KQkq - 0 1';
}

function randomFen(rnd) {
  return fenFor(randomBackRank(rnd));
}

// Is this FEN a Chess960 start (or the standard one, which is also a member)?
function isStartFen(fen) {
  if (typeof fen !== 'string') return false;
  const parts = fen.trim().split(/\s+/);
  const ranks = parts[0].split('/');
  if (ranks.length !== 8) return false;
  if (ranks[1] !== 'pppppppp' || ranks[6] !== 'PPPPPPPP') return false;
  for (const empty of [2, 3, 4, 5]) if (ranks[empty] !== '8') return false;
  if (ranks[0] !== ranks[7].toLowerCase()) return false;
  return isValidBackRank(ranks[0].split(''));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PIECES, isValidBackRank, randomBackRank, fenFor, randomFen, isStartFen };
}
