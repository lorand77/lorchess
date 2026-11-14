"use strict";

// In-memory authoritative state for live PvP games. The server owns a Chess
// instance per active game; clients are never trusted for legality. Rooms are
// keyed by gameId and map 1:1 to the Socket.IO room `game:<id>`. A Bughouse
// match is two rooms, one per board, that know each other (matchId, boardIds):
// they are created together, rebuilt together from the match's moves, and
// ended together (socket.js concludeMatch). A four-player game is one room
// with four seats (`seats`), its colours r, b, y and g in place of w and b:
// everything kept per colour is kept for each of `room.colors`.

const { STANDARD_START } = require("../shared/chess");
const { createEngine } = require("../shared/engines");
const queries = require("../db/queries");
const config = require("../config");
const log = require("../log");
const { describeTimeControl } = require("../shared/timeControls");
const handicap = require("../shared/handicap");
const { moveFromUci } = require("../shared/uci");
const { usesStandardSetup } = require("../shared/variants");
const { Bughouse } = require("../shared/bughouse");
const matches = require("./matches");
const fourGames = require("./fourGames");
const { FourPlayer } = require("../shared/fourPlayer");

const rooms = new Map(); // gameId -> room

function createRoom(
  gameId,
  { whiteId, blackId, whiteName, blackName, startFen, initialMs, incrementMs, rated,
    clockW, clockB, rehydrated, variant, matchId, board, boardIds, botLevel,
    seats, seatNames, clocks }
) {
  // Games created before per-game time controls existed have NULL clock
  // columns; fall back to the server-wide default so they still run.
  const initial = initialMs == null ? config.CLOCK_INITIAL_MS : initialMs;
  const increment = incrementMs == null ? config.CLOCK_INCREMENT_MS : incrementMs;

  // The engine comes with its rules already set (Atomic changes what a capture
  // does; infinite chess is another engine altogether) and at its own start,
  // so only a start of the game's own needs loading.
  const chess = createEngine(variant || "standard");
  if (startFen && startFen !== STANDARD_START) chess.loadFen(startFen);
  // The seats: White and Black, or a four-player game's four colours, whose
  // players (`seats`), names and clocks come keyed by colour.
  const four = variant === fourGames.VARIANT;
  const colors = four ? FourPlayer.COLORS : ["w", "b"];
  const each = (fn) => Object.fromEntries(colors.map((c) => [c, fn(c)]));
  const startClocks = four ? clocks || {} : { w: clockW, b: clockB };

  const room = {
    gameId,
    chess,
    colors,
    four,
    players: four ? { ...seats } : { w: whiteId, b: blackId },
    names: four ? { ...seatNames } : { w: whiteName, b: blackName },
    sans: [],
    status: "active",
    result: null,
    termination: null,
    startFen: startFen || null,
    // Colour of the player with an outstanding draw offer, or null. Cleared
    // when the offer is answered or when either side moves.
    drawOffer: null,
    // Connected socket ids per color, and a pending forfeit timer per color.
    online: each(() => new Set()),
    timers: each(() => null),
    // Pending "opponent disconnected" announcements, kept separate from the
    // forfeit timers above so one can be cancelled without the other.
    notices: each(() => null),
    // Server-authoritative clocks (ms remaining per color). The clock starts
    // once both players have joined; turnStartedAt marks when the side to move
    // began consuming time. flagTimer fires when the side to move runs out.
    // A game rebuilt after a restart resumes on its stored clocks; a new one
    // starts both sides at the full allowance.
    clock: each((c) => (startClocks[c] == null ? initial : startClocks[c])),
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
    // Whether the clock has ever run, i.e. both players took their seats at
    // some point. Kept on the games row as well, so it survives a restart.
    clockStarted: false,
    everJoined: each(() => false),
    flagTimer: null,
    // True when this room was rebuilt from the database rather than created
    // fresh — nobody is connected yet, so the first player back has to start
    // the forfeit clock against the one who hasn't returned.
    rehydrated: !!rehydrated,
    // Socket ids of non-players watching this game (they sit in the same
    // Socket.IO room and receive every broadcast, but can never act).
    spectators: new Set(),
    // Bughouse: the match, this board (0 or 1) and both boards' game ids. Null
    // for every other game.
    matchId: matchId || null,
    board: matchId ? board : null,
    boardIds: matchId ? boardIds : null,
    // Bughouse seats LorFish holds, played by the server (socket.js botTurn),
    // at its level; null when it holds none. A bot is always there: seated
    // from the start, and online, so no absence clock ever runs against it.
    bots: null,
    botLevel: null,
    botThinking: false,
  };
  if (matchId) {
    const ai = aiUserId();
    const held = { w: whiteId === ai, b: blackId === ai };
    if (held.w || held.b) {
      room.bots = held;
      room.botLevel = botLevel || null;
      for (const c of ["w", "b"]) {
        if (!held[c]) continue;
        room.everJoined[c] = true;
        room.online[c].add("lorfish");
      }
    }
  }
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
  const snap = { ...room.clock };
  if (room.started && room.status === "active" && room.turnStartedAt != null) {
    const t = room.chess.turn;
    snap[t] = Math.max(0, snap[t] - (Date.now() - room.turnStartedAt));
  }
  return snap;
}

function clearTimers(room) {
  for (const c of room.colors) {
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
  const row = queries.liveGameForUser.get({ user: userId });
  return row ? row.id : null;
}

// Abort whatever nobody came back for. A game that WAS resumed has a live room
// and is skipped. Called once, RESUME_WINDOW_MS after boot.
function sweepUnresumed() {
  let aborted = 0;
  for (const g of queries.listActivePvpGames.all()) {
    if (rooms.has(g.id)) continue; // somebody reconnected and rebuilt it
    // A Bughouse board goes with its match: both boards are aborted at once
    // (the second one is then no longer active when the loop reaches it).
    if (g.match_id) matches.abortMatch(g.match_id, "server-restart");
    else queries.abortGame.run("server-restart", g.id);
    aborted++;
  }
  return aborted;
}

// Both rooms of a Bughouse match, board 0's first, or null for a room that
// isn't one (or whose partner board is gone).
function matchRooms(room) {
  if (!room || !room.matchId) return null;
  const both = room.boardIds.map((id) => rooms.get(id));
  return both.every(Boolean) ? both : null;
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
  if (game.match_id) {
    const both = loadMatchRoomsFromDb(game.match_id);
    return both ? both[game.board] : null;
  }
  if (game.variant === fourGames.VARIANT) return loadFourRoomFromDb(game);

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
    const mv = moveFromUci(room.chess, m.uci);
    if (!mv) {
      // A stored move the rules refuse cannot be skipped: the room would sit a
      // ply behind its own record and the next move would collide with the
      // stored one. Refuse to rebuild — and abort the game, since left 'active'
      // it would hold both players to a game nobody can enter (one game at a
      // time) until the next restart's sweep.
      log.error("game.corrupt_record", { game: gameId, ply: m.ply, move: m.uci, fen: room.chess.fen() });
      deleteRoom(gameId);
      if (game.status === "active") queries.abortGame.run("corrupt-record", gameId);
      return null;
    }
    room.chess.makeMove(mv);
    room.sans.push(m.san);
  }
  room.clockStarted = !!game.clock_started;
  room.status = game.status;
  room.result = game.result;
  room.termination = game.termination;
  return room;
}

// Rebuild both rooms of a Bughouse match: a board's pockets depend on what
// was taken on the other, so neither can be replayed alone. Both boards' moves
// are replayed in the order they were made, each capture passed across as it
// happened (Bughouse.play). A room already live is kept; a stored move the
// rules refuse aborts the whole match, as loadRoomFromDb does a game.
function loadMatchRoomsFromDb(matchId) {
  const games = queries.getMatchBoards.all(matchId);
  if (games.length !== 2) return null;
  const live = games.map((g) => rooms.get(g.id));
  if (live.every(Boolean)) return live;
  const boardIds = games.map((g) => g.id);
  const both = games.map((game) => createRoom(game.id, {
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
    matchId,
    board: game.board,
    boardIds,
    botLevel: game.ai_level,
  }));
  const engines = both.map((r) => r.chess);
  for (const m of queries.getMovesForMatch.all(matchId)) {
    const mv = moveFromUci(engines[m.board], m.uci);
    if (!mv) {
      log.error("game.corrupt_record", { match: matchId, board: m.board, ply: m.ply, move: m.uci, fen: engines[m.board].fen() });
      for (const g of games) deleteRoom(g.id);
      matches.abortMatch(matchId, "corrupt-record");
      return null;
    }
    Bughouse.play(engines, m.board, mv);
    both[m.board].sans.push(m.san);
  }
  games.forEach((game, i) => {
    both[i].clockStarted = !!game.clock_started;
    both[i].status = game.status;
    both[i].result = game.result;
    both[i].termination = game.termination;
  });
  return both;
}

// Rebuild a four-player game's room: its seats and clocks from game_seats, its
// position by replaying its moves, as loadRoomFromDb does a game's.
function loadFourRoomFromDb(game) {
  const seats = fourGames.seatsOf(game.id);
  const each = (fn) => Object.fromEntries(FourPlayer.COLORS.map((c) => [c, fn(seats[c])]));
  const room = createRoom(game.id, {
    seats: each((s) => s.userId),
    seatNames: each((s) => nameOf(s.userId)),
    clocks: each((s) => s.clockMs),
    startFen: game.start_fen,
    initialMs: game.initial_ms,
    incrementMs: game.increment_ms,
    rated: false,
    variant: game.variant,
    rehydrated: true,
  });
  for (const m of queries.getMovesForGame.all(game.id)) {
    const mv = room.chess.moveFromText(m.uci);
    if (!mv) {
      log.error("game.corrupt_record", { game: game.id, ply: m.ply, move: m.uci, fen: room.chess.fen() });
      deleteRoom(game.id);
      if (game.status === "active") queries.abortGame.run("corrupt-record", game.id);
      return null;
    }
    room.chess.makeMove(mv);
    room.sans.push(m.san);
  }
  room.clockStarted = !!game.clock_started;
  room.status = game.status;
  room.result = game.result;
  room.termination = game.termination;
  return room;
}

// The reserved LorFish account's id (db/index.js seeds it).
let aiId = null;
function aiUserId() {
  if (aiId == null) aiId = queries.getUserByUsername.get(config.AI_USERNAME).id;
  return aiId;
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
  loadMatchRoomsFromDb,
  matchRooms,
  clearTimers,
  clockSnapshot,
  resumableGames,
  liveGameOf,
  sweepUnresumed,
  STANDARD_START,
};
