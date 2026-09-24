"use strict";

// Small conveniences for driving src/shared/chess.js from tests. Moves are
// written in coordinate form ("e2e4", "e7e8q", "e1g1") and resolved through
// findMove, so a test can only ever play a legal move.

const { Chess, sqIdx, rankOf, algOf } = require("../../src/shared/chess");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// A fresh board loaded from a FEN string, under standard rules unless a
// variant ("atomic", "pawnwars") is given. Mirrors what the server does when it
// builds a room: setVariant first, then load the start position.
function fromFen(fen, variant) {
  const chess = new Chess();
  if (variant) chess.setVariant(variant);
  chess.loadFen(fen);
  return chess;
}

// "e2" -> square index.
function sq(name) {
  return sqIdx(name.charCodeAt(0) - 97, Number(name[1]) - 1);
}

// Move object -> "e2e4", "e7e8q", or "e1g1" for castling.
function uci(m) {
  const to = m.castle ? sqIdx(m.castle === "K" ? 6 : 2, rankOf(m.from)) : m.to;
  return algOf(m.from) + algOf(to) + (m.promo || "");
}

// "e2e4" -> the legal move object in the current position, or null.
function moveOf(chess, text) {
  return chess.findMove(sq(text.slice(0, 2)), sq(text.slice(2, 4)), text[4] || undefined);
}

// Play a sequence of coordinate moves (strings or arrays of them). Throws on
// an illegal move so a mistyped test fails loudly rather than silently.
function play(chess, ...moves) {
  for (const text of moves.flat()) {
    const m = moveOf(chess, text);
    if (!m) throw new Error(`illegal move ${text} in ${chess.fen()}`);
    chess.makeMove(m);
  }
  return chess;
}

// SAN for a coordinate move in the current position, without playing it.
function sanOf(chess, text) {
  const m = moveOf(chess, text);
  if (!m) throw new Error(`illegal move ${text} in ${chess.fen()}`);
  return chess.moveToSan(m);
}

// Play moves and return the SAN of each as it was played.
function playSan(chess, ...moves) {
  return moves.flat().map((text) => {
    const san = sanOf(chess, text);
    play(chess, text);
    return san;
  });
}

module.exports = { START_FEN, fromFen, sq, uci, moveOf, play, sanOf, playSan };
