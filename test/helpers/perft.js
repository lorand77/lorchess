"use strict";

// Perft ("performance test") counts the leaf nodes of the legal-move tree from
// a position to a fixed depth. The counts for well-known positions are
// published (see test/fixtures/perft.json), so one number checks castling,
// en passant, promotion, pins and checks at once: if it matches, the generator
// is right for everything that position exercises; if it is off by one,
// something is wrong.
//
// divide() breaks the total down per root move. When a total disagrees, run
// it on the same position with a known-good engine and compare branch by
// branch until you find the one that differs, then repeat one ply deeper on
// that branch.

const { Chess, algOf, sqIdx, rankOf } = require("../../src/shared/chess");

// A fresh standard-rules board loaded from a FEN string.
function fromFen(fen) {
  const chess = new Chess();
  chess.loadFen(fen);
  return chess;
}

// Leaf count at `depth`. At depth 1 the move list is simply counted ("bulk
// counting"); the result is identical and much faster. Moves are made with
// repetition tracking off, exactly as legalMoves() does internally.
function perft(chess, depth) {
  if (depth === 0) return 1;
  const moves = chess.legalMoves();
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) {
    chess.makeMove(m, false);
    nodes += perft(chess, depth - 1);
    chess.undoMove();
  }
  return nodes;
}

// UCI-style move text: e2e4, e7e8q, e1g1 for castling.
function uci(m) {
  const to = m.castle ? sqIdx(m.castle === "K" ? 6 : 2, rankOf(m.from)) : m.to;
  return algOf(m.from) + algOf(to) + (m.promo || "");
}

// Per-root-move counts, sorted by move text, plus the total.
function divide(chess, depth) {
  const rows = [];
  for (const m of chess.legalMoves()) {
    chess.makeMove(m, false);
    rows.push({ move: uci(m), nodes: perft(chess, depth - 1) });
    chess.undoMove();
  }
  rows.sort((a, b) => (a.move < b.move ? -1 : a.move > b.move ? 1 : 0));
  const total = rows.reduce((sum, r) => sum + r.nodes, 0);
  return { rows, total };
}

function formatDivide({ rows, total }) {
  return rows.map((r) => `${r.move}: ${r.nodes}`).concat(`total: ${total}`).join("\n");
}

module.exports = { fromFen, perft, divide, formatDivide, uci };
