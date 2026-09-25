"use strict";

// Quick-match: FIFO queues of waiting sockets, one per (time control, rated,
// variant) triple — pooling by clock matters, since someone waiting for a 1+0
// bullet game should not be handed a 30-minute classical one. When two DISTINCT
// users are available in the same pool, pair them: randomize colors, create the
// games row + room, and emit game:start so their clients navigate to
// game.html?id=<id>.
//
// For a specific opponent or a published offer, see lobby.js — this is only the
// "just find me a game" path.

const queries = require("../db/queries");
const rooms = require("./rooms");
const { resolveTimeControl, DEFAULT_TC } = require("../shared/timeControls");
const chess960 = require("../shared/chess960");
const { PAWN_WARS_START } = require("../shared/chess");
const { resolveVariant } = require("../shared/variants");

// Every authenticated socket joins its user's room (see socket.js), so a game
// can be announced to the PERSON rather than to one guessed socket. A user
// often holds several: a tab they left open, or a socket from a page they have
// already navigated away from whose transport has not timed out yet. Emitting
// to a single one of those loses the announcement and strands them.
const userRoom = (userId) => `user:${userId}`;

// poolKey -> sockets currently seeking a match in that pool
const pools = new Map();

// Called whenever a match starts, with the game id and both players' user ids.
// The lobby uses it to withdraw the players' open seeks and challenges (an offer
// from someone who has just sat down to a game must not be acceptable any
// more); socket.js to start the clock against players who never turn up. Hooks
// rather than requires, because lobby.js already depends on this module.
const startHooks = [];
function onMatchStarted(fn) {
  startHooks.push(fn);
}

const poolKey = (tcKey, rated, variant) => `${tcKey}|${rated ? 1 : 0}|${variant}`;

function poolFor(key) {
  let pool = pools.get(key);
  if (!pool) {
    pool = [];
    pools.set(key, pool);
  }
  return pool;
}

function join(io, socket, payload) {
  if (socket.userId == null) return;
  leave(socket); // never queued in two pools at once
  // One game at a time: pairing someone who is already playing would pull them
  // out of that game.
  if (rooms.liveGameOf(socket.userId)) {
    return socket.emit("lobby:error", { error: "Finish your current game first." });
  }

  const tc = resolveTimeControl((payload && payload.tc) || DEFAULT_TC);
  const rated = !payload || payload.rated !== false;
  const variant = resolveVariant(payload && payload.variant);
  const key = poolKey(tc.key, rated, variant);
  const pool = poolFor(key);

  // Pair with the first waiter who is a different user, still connected, and
  // not meanwhile in a game.
  const idx = pool.findIndex(
    (s) => s.userId !== socket.userId && s.connected && !rooms.liveGameOf(s.userId)
  );
  if (idx === -1) {
    socket.matchPool = key;
    pool.push(socket);
    socket.emit("lobby:waiting", { tc: tc.key, rated, variant });
    return;
  }
  const opponent = pool.splice(idx, 1)[0];
  opponent.matchPool = null;
  // Randomize who plays White.
  const oppIsWhite = Math.random() < 0.5;
  startMatch(
    io,
    oppIsWhite ? opponent : socket,
    oppIsWhite ? socket : opponent,
    { initialMs: tc.initialMs, incrementMs: tc.incrementMs, rated, variant }
  );
}

function leave(socket) {
  // Sweep every pool: a socket's recorded pool can be stale if it reconnected.
  for (const [key, pool] of pools) {
    const i = pool.findIndex((s) => s.id === socket.id);
    if (i !== -1) pool.splice(i, 1);
    if (pool.length === 0) pools.delete(key);
  }
  socket.matchPool = null;
}

// Every socket of a user, out of every pool: when their game starts, a queue
// entry left from another tab must not pair them a second time.
function leaveUser(userId) {
  for (const [key, pool] of pools) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].userId !== userId) continue;
      pool[i].matchPool = null;
      pool.splice(i, 1);
    }
    if (pool.length === 0) pools.delete(key);
  }
}

// Create a game between two connected sockets with the colours given by the
// caller. Used by quick-match (random colours), by the lobby's seeks and
// challenges (offerer's preference), and by rematch (colours swapped).
function startMatch(io, white, black, opts) {
  const variant = resolveVariant(opts && opts.variant);
  // A handicap offer carries its own start position, and Chess960 draws a fresh
  // random back rank per game. Everything downstream just sees a start position.
  const start =
    variant === "chess960"
      ? chess960.randomFen()
      : variant === "pawnwars"
        ? PAWN_WARS_START
        : (opts && opts.startFen) || rooms.STANDARD_START;
  const tc = resolveTimeControl(DEFAULT_TC);
  const initialMs = opts && opts.initialMs != null ? opts.initialMs : tc.initialMs;
  const incrementMs = opts && opts.incrementMs != null ? opts.incrementMs : tc.incrementMs;
  const rated = !opts || opts.rated !== false;

  const info = queries.createGame.run(
    white.userId, black.userId, "pvp", null, null, start, start, "w",
    initialMs, incrementMs, rated ? 1 : 0, variant
  );
  const gameId = Number(info.lastInsertRowid);

  rooms.createRoom(gameId, {
    whiteId: white.userId,
    blackId: black.userId,
    whiteName: white.username,
    blackName: black.username,
    startFen: start,
    variant,
    initialMs,
    incrementMs,
    rated,
  });

  // Both players are spoken for now: out of the queues, and every other offer
  // they had open is withdrawn by the lobby.
  leaveUser(white.userId);
  leaveUser(black.userId);
  for (const fn of startHooks) fn(io, gameId, white.userId, black.userId);

  io.to(userRoom(white.userId)).emit("game:start", {
    gameId, color: "w", opponent: { username: black.username },
  });
  io.to(userRoom(black.userId)).emit("game:start", {
    gameId, color: "b", opponent: { username: white.username },
  });
  console.log(
    `[match] game #${gameId}: ${white.username}(w) vs ${black.username}(b) ` +
    `${initialMs / 60000}+${incrementMs / 1000}${rated ? " rated" : " casual"}`
  );
  return gameId;
}

module.exports = { join, leave, startMatch, onMatchStarted, userRoom };
