"use strict";

// Quick-match: a single FIFO queue of waiting sockets. When two DISTINCT users
// are available, pair them — randomize colors, create the games row + room, and
// emit game:start to each so their clients navigate to game.html?id=<gameId>.

const queries = require("../db/queries");
const rooms = require("./rooms");

const waiting = []; // sockets currently seeking a match

function join(io, socket) {
  if (socket.userId == null) return;
  if (waiting.some((s) => s.id === socket.id)) return; // already queued

  // Pair with the first waiter who is a different user and still connected.
  const idx = waiting.findIndex((s) => s.userId !== socket.userId && s.connected);
  if (idx === -1) {
    waiting.push(socket);
    socket.emit("lobby:waiting");
    return;
  }
  const opponent = waiting.splice(idx, 1)[0];
  startMatch(io, opponent, socket);
}

function leave(socket) {
  const i = waiting.findIndex((s) => s.id === socket.id);
  if (i !== -1) waiting.splice(i, 1);
}

function startMatch(io, a, b) {
  // Randomize who plays White.
  const aIsWhite = Math.random() < 0.5;
  const white = aIsWhite ? a : b;
  const black = aIsWhite ? b : a;
  const start = rooms.STANDARD_START;

  const info = queries.createGame.run(
    white.userId, black.userId, "pvp", null, null, start, start, "w"
  );
  const gameId = Number(info.lastInsertRowid);

  rooms.createRoom(gameId, {
    whiteId: white.userId,
    blackId: black.userId,
    whiteName: white.username,
    blackName: black.username,
    startFen: start,
  });

  white.emit("game:start", { gameId, color: "w", opponent: { username: black.username } });
  black.emit("game:start", { gameId, color: "b", opponent: { username: white.username } });
  console.log(`[match] game #${gameId}: ${white.username}(w) vs ${black.username}(b)`);
}

module.exports = { join, leave };
