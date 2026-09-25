"use strict";

// In-memory authoritative state for live PvP games. The server owns a Chess
// instance per active game; clients are never trusted for legality. Rooms are
// keyed by gameId and map 1:1 to the Socket.IO room `game:<id>`.

const { Chess, STANDARD_START } = require("../shared/chess");
const queries = require("../db/queries");
const config = require("../config");
const { describeTimeControl } = require("../shared/timeControls");
const handicap = require("../shared/handicap");
const { usesStandardSetup } = require("../shared/variants");

const rooms = new Map(); // gameId -> room

const sqFromAlg = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;

function createRoom(
  gameId,
  { whiteId, blackId, whiteName, blackName, startFen, initialMs, incrementMs, rated,
    clockW, clockB, rehydrated, variant }
) {
  // Games created before per-game time controls existed have NULL clock
  // columns; fall back to the server-wide default so they still run.
  const initial = initialMs == null ? config.CLOCK_INITIAL_MS : initialMs;
  const increment = incrementMs == null ? config.CLOCK_INCREMENT_MS : incrementMs;

  const chess = new Chess();
  // Atomic changes what a capture does, so the board must know before any move
  // is validated against it.
  chess.setVariant(variant || "standard");
  if (startFen && startFen !== STANDARD_START) chess.loadFen(startFen);
  else chess.reset();

  const room = {
    gameId,
    chess,
    players: { w: whiteId, b: blackId },
    names: { w: whiteName, b: blackName },
    sans: [],
    status: "active",
    result: null,
    termination: null,
    startFen: startFen || null,
    // Colour of the player with an outstanding draw offer, or null. Cleared
    // when the offer is answered or when either side moves.
    drawOffer: null,
    // Connected socket ids per color, and a pending forfeit timer per color.
    online: { w: new Set(), b: new Set() },
    timers: { w: null, b: null },
    // Pending "opponent disconnected" announcements, kept separate from the
    // forfeit timers above so one can be cancelled without the other.
    notices: { w: null, b: null },
    // Server-authoritative clocks (ms remaining per color). The clock starts
    // once both players have joined; turnStartedAt marks when the side to move
    // began consuming time. flagTimer fires when the side to move runs out.
    // A game rebuilt after a restart resumes on its stored clocks; a new one
    // starts both sides at the full allowance.
    clock: { w: clockW == null ? initial : clockW, b: clockB == null ? initial : clockB },
    initialMs: initial,
    incrementMs: increment,
    timeControl: describeTimeControl(initial, increment),
    // Unrated games skip the Elo update when they conclude.
    rated: rated == null ? true : !!rated,
    // "White −Q" style summary when the game started from a handicap position,
    // recovered from start_fen so it survives a restart. null for a normal
    // game, and for variants that don't start from the standard setup: a
    // shuffled Chess960 back rank is not a handicap, however it differs.
    variant: variant || "standard",
    handicap: usesStandardSetup(variant || "standard") ? handicapLabel(startFen) : null,
    turnStartedAt: null,
    started: false,
    everJoined: { w: false, b: false },
    flagTimer: null,
    // True when this room was rebuilt from the database rather than created
    // fresh — nobody is connected yet, so the first player back has to start
    // the forfeit clock against the one who hasn't returned.
    rehydrated: !!rehydrated,
    // Socket ids of non-players watching this game (they sit in the same
    // Socket.IO room and receive every broadcast, but can never act).
    spectators: new Set(),
  };
  rooms.set(gameId, room);
  return room;
}

// Describe a start position that is the standard setup minus some pieces.
function handicapLabel(startFen) {
  if (!startFen || startFen === STANDARD_START) return null;
  const changes = handicap.diffFromFen(startFen);
  return changes && Object.keys(changes).length ? handicap.describe(changes) : null;
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
    if (room.notices[c]) {
      clearTimeout(room.notices[c]);
      room.notices[c] = null;
    }
  }
  if (room.flagTimer) {
    clearTimeout(room.flagTimer);
    room.flagTimer = null;
  }
}

// PvP games left 'active' by a previous run. Nothing is thrown away at boot:
// every one of these can be rebuilt in full by loadRoomFromDb (position from
// `moves`, clocks from the games row), so the players just reconnect and carry
// on. AI games are untouched — they keep no server-side state, so a restart
// never interrupted them in the first place.
function resumableGames() {
  return queries.listActivePvpGames.all();
}

// The live PvP game a user is in, or null. Read from the database rather than
// the room map so a game waiting to be resumed after a restart counts too: its
// player is still committed to it.
function liveGameOf(userId) {
  const row = queries.liveGameForUser.get(userId, userId);
  return row ? row.id : null;
}

// Abort whatever nobody came back for. A game that WAS resumed has a live room
// and is skipped. Called once, RESUME_WINDOW_MS after boot.
function sweepUnresumed() {
  let aborted = 0;
  for (const g of queries.listActivePvpGames.all()) {
    if (rooms.has(g.id)) continue; // somebody reconnected and rebuilt it
    queries.abortGame.run("server-restart", g.id);
    aborted++;
  }
  return aborted;
}

function getRoom(gameId) {
  return rooms.get(gameId);
}

function deleteRoom(gameId) {
  rooms.delete(gameId);
}

// Every live room, for the lobby's "Live games" list.
function listRooms() {
  return [...rooms.values()];
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
    initialMs: game.initial_ms,
    incrementMs: game.increment_ms,
    rated: game.rated,
    variant: game.variant,
    clockW: game.clock_w_ms,
    clockB: game.clock_b_ms,
    rehydrated: true,
  });

  for (const m of queries.getMovesForGame.all(gameId)) {
    const from = sqFromAlg(m.uci.slice(0, 2));
    const to = sqFromAlg(m.uci.slice(2, 4));
    const promo = m.uci[4] || null;
    const mv = room.chess.findMove(from, to, promo);
    if (!mv) {
      // A stored move the rules refuse cannot be skipped: the room would sit a
      // ply behind its own record and the next move would collide with the
      // stored one. Refuse to rebuild rather than resume a broken game.
      console.error(`[rooms] game #${gameId}: stored move ${m.uci} at ply ${m.ply} is illegal in ${room.chess.fen()}`);
      deleteRoom(gameId);
      return null;
    }
    room.chess.makeMove(mv);
    room.sans.push(m.san);
  }
  room.status = game.status;
  room.result = game.result;
  room.termination = game.termination;
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
  listRooms,
  loadRoomFromDb,
  clearTimers,
  clockSnapshot,
  resumableGames,
  liveGameOf,
  sweepUnresumed,
  STANDARD_START,
};
