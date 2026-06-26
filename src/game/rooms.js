"use strict";

// In-memory authoritative state for live PvP games. The server owns a Chess
// instance per active game; clients are never trusted for legality. Rooms are
// keyed by gameId and map 1:1 to the Socket.IO room `game:<id>`.

const { Chess } = require("../shared/chess");
const queries = require("../db/queries");
const config = require("../config");

const STANDARD_START =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const rooms = new Map(); // gameId -> room

const sqFromAlg = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;

function createRoom(gameId, { whiteId, blackId, whiteName, blackName, startFen }) {
  const chess = new Chess();
  if (startFen && startFen !== STANDARD_START) chess.loadFen(startFen);
  else chess.reset();

  const room = {
    gameId,
    chess,
    players: { w: whiteId, b: blackId },
    names: { w: whiteName, b: blackName },
    sans: [],
    status: "active",
    startFen: startFen || null,
    // Connected socket ids per color, and a pending forfeit timer per color.
    online: { w: new Set(), b: new Set() },
    timers: { w: null, b: null },
    // Server-authoritative clocks (ms remaining per color). The clock starts
    // once both players have joined; turnStartedAt marks when the side to move
    // began consuming time. flagTimer fires when the side to move runs out.
    clock: { w: config.CLOCK_INITIAL_MS, b: config.CLOCK_INITIAL_MS },
    turnStartedAt: null,
    started: false,
    everJoined: { w: false, b: false },
    flagTimer: null,
  };
  rooms.set(gameId, room);
  return room;
}

// Current clocks, decrementing the side-to-move by the time elapsed since their
// turn began — so a snapshot is accurate at any instant, not just on a move.
function clockSnapshot(room) {
  const snap = { w: room.clock.w, b: room.clock.b };
  if (room.started && room.status === "active" && room.turnStartedAt != null) {
    const t = room.chess.turn;
    snap[t] = Math.max(0, snap[t] - (Date.now() - room.turnStartedAt));
  }
  return snap;
}

function clearTimers(room) {
  for (const c of ["w", "b"]) {
    if (room.timers[c]) {
      clearTimeout(room.timers[c]);
      room.timers[c] = null;
    }
  }
  if (room.flagTimer) {
    clearTimeout(room.flagTimer);
    room.flagTimer = null;
  }
}

// Boot cleanup: abort any game left 'active' from a previous run (its in-memory
// room didn't survive the restart). Returns the number of games aborted.
function cleanupOrphanedGames() {
  return queries.abortOrphanedGames.run().changes;
}

function getRoom(gameId) {
  return rooms.get(gameId);
}

function deleteRoom(gameId) {
  rooms.delete(gameId);
}

// Rebuild a room's live state from the DB. Used when a participant connects but
// the room isn't in memory (e.g. a mid-game page reload). Returns null for
// non-pvp or unknown games.
function loadRoomFromDb(gameId) {
  const game = queries.getGameById.get(gameId);
  if (!game || game.mode !== "pvp") return null;

  const room = createRoom(gameId, {
    whiteId: game.white_id,
    blackId: game.black_id,
    whiteName: nameOf(game.white_id),
    blackName: nameOf(game.black_id),
    startFen: game.start_fen,
  });

  for (const m of queries.getMovesForGame.all(gameId)) {
    const from = sqFromAlg(m.uci.slice(0, 2));
    const to = sqFromAlg(m.uci.slice(2, 4));
    const promo = m.uci[4] || null;
    const mv = room.chess
      .legalMoves()
      .find((x) => x.from === from && x.to === to && (promo ? x.promo === promo : !x.promo));
    if (mv) room.chess.makeMove(mv);
    room.sans.push(m.san);
  }
  room.status = game.status;
  return room;
}

function nameOf(userId) {
  const u = queries.getUserById.get(userId);
  return u ? u.username : "?";
}

module.exports = {
  createRoom,
  getRoom,
  deleteRoom,
  loadRoomFromDb,
  clearTimers,
  clockSnapshot,
  cleanupOrphanedGames,
  STANDARD_START,
};
