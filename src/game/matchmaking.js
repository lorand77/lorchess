"use strict";

// Quick-match: FIFO queues of waiting sockets, one per (time control, rated)
// pair — pooling by clock matters, since someone waiting for a 1+0 bullet game
// should not be handed a 30-minute classical one. When two DISTINCT users are
// available in the same pool, pair them: randomize colors, create the games row
// + room, and emit game:start so their clients navigate to game.html?id=<id>.
//
// For a specific opponent or a published offer, see lobby.js — this is only the
// "just find me a game" path.

const queries = require("../db/queries");
const rooms = require("./rooms");
const { resolveTimeControl, DEFAULT_TC } = require("../shared/timeControls");

// poolKey -> sockets currently seeking a match in that pool
const pools = new Map();

const poolKey = (tcKey, rated) => `${tcKey}|${rated ? 1 : 0}`;

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

  const tc = resolveTimeControl((payload && payload.tc) || DEFAULT_TC);
  const rated = !payload || payload.rated !== false;
  const key = poolKey(tc.key, rated);
  const pool = poolFor(key);

  // Pair with the first waiter who is a different user and still connected.
  const idx = pool.findIndex((s) => s.userId !== socket.userId && s.connected);
  if (idx === -1) {
    socket.matchPool = key;
    pool.push(socket);
    socket.emit("lobby:waiting", { tc: tc.key, rated });
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
    { initialMs: tc.initialMs, incrementMs: tc.incrementMs, rated }
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

// Create a game between two connected sockets with the colours given by the
// caller. Used by quick-match (random colours), by the lobby's seeks and
// challenges (offerer's preference), and by rematch (colours swapped).
function startMatch(io, white, black, opts) {
  const start = rooms.STANDARD_START;
  const tc = resolveTimeControl(DEFAULT_TC);
  const initialMs = opts && opts.initialMs != null ? opts.initialMs : tc.initialMs;
  const incrementMs = opts && opts.incrementMs != null ? opts.incrementMs : tc.incrementMs;
  const rated = !opts || opts.rated !== false;

  const info = queries.createGame.run(
    white.userId, black.userId, "pvp", null, null, start, start, "w",
    initialMs, incrementMs, rated ? 1 : 0
  );
  const gameId = Number(info.lastInsertRowid);

  rooms.createRoom(gameId, {
    whiteId: white.userId,
    blackId: black.userId,
    whiteName: white.username,
    blackName: black.username,
    startFen: start,
    initialMs,
    incrementMs,
    rated,
  });

  white.emit("game:start", { gameId, color: "w", opponent: { username: black.username } });
  black.emit("game:start", { gameId, color: "b", opponent: { username: white.username } });
  console.log(
    `[match] game #${gameId}: ${white.username}(w) vs ${black.username}(b) ` +
    `${initialMs / 60000}+${incrementMs / 1000}${rated ? " rated" : " casual"}`
  );
  return gameId;
}

module.exports = { join, leave, startMatch };
