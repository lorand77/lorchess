"use strict";

// Writes finished games straight into the database, for tests of what the
// server derives from stored games (achievements, history). Moves are replayed
// through the real engine so the stored SAN, UCI and FEN are exactly what the
// live server would have recorded. Load test/helpers/server.js first so the
// database is the throwaway one.

const { createEngine } = require("../../src/shared/engines");
const { moveOf } = require("./board");
const { formatUci } = require("../../src/shared/uci");

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const queries = () => require("../../src/db/queries");

let counter = 0;
let aiId = null;

// A user row with no usable password (these users never log in).
function makeUser(base = "u", rating = 1200) {
  const username = `${base}_${process.pid.toString(36)}${++counter}`.slice(0, 20);
  const info = queries().createUser.run(username, "not-a-real-hash", 1200);
  const id = Number(info.lastInsertRowid);
  if (rating !== 1200) queries().updateRating.run(rating, id);
  return { id, username };
}

function lorfishId() {
  if (aiId == null) aiId = queries().getUserByUsername.get("LorFish").id;
  return aiId;
}

// Create a game, store its moves, and finish it. Returns the game id.
// `moves` are coordinate strings ("e2e4", "e7e8q", "e1g1"); a termination of
// checkmate or stalemate is verified against the final position, so a fixture
// that does not do what it claims fails loudly.
function recordGame({
  white, black, mode = "pvp", aiColor = null, aiDepth = null, aiLevel = null, start = STANDARD_START,
  moves = [], result = null, termination = null, initialMs = 600000, incrementMs = 0,
  rated = 1, variant = "standard", thinkMs = null, premove = false, clocks = null,
}) {
  const q = queries();
  const info = q.createGame.run(
    white, black, mode, aiColor, aiDepth, aiLevel, start, start, "w", initialMs, incrementMs, rated, variant
  );
  const gameId = Number(info.lastInsertRowid);

  // The variant's own engine (infinite chess has its own), at `start`.
  const chess = createEngine(variant);
  if (start !== STANDARD_START) chess.loadFen(start);
  moves.forEach((text, i) => {
    const m = moveOf(chess, text);
    if (!m) throw new Error(`fixture: illegal move ${text} at ply ${i + 1} in ${chess.fen()}`);
    const san = chess.moveToSan(m);
    const mover = chess.turn === "w" ? white : black;
    chess.makeMove(m);
    const byUser = mover === lorfishId() ? null : mover;
    q.insertMoveTimed.run(gameId, i + 1, san, formatUci(m), chess.fen(), byUser, thinkMs, premove ? 1 : 0);
  });
  if (termination === "checkmate" && !chess.isCheckmate()) throw new Error(`fixture: ${chess.fen()} is not checkmate`);
  if (termination === "stalemate" && !chess.isStalemate()) throw new Error(`fixture: ${chess.fen()} is not stalemate`);
  q.updateGamePosition.run(chess.fen(), chess.turn, gameId);
  if (clocks) q.updateGameClocks.run(clocks.w, clocks.b, gameId);
  if (result) q.finishGame.run(result, termination, gameId);
  return gameId;
}

module.exports = { STANDARD_START, makeUser, lorfishId, recordGame };
