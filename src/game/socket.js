"use strict";

// Socket.IO infrastructure + authoritative PvP handlers + robustness (M6) +
// clocks & Elo (M7).
//
// The handshake reuses the SAME Express session (io.engine.use). The server
// holds the authoritative Chess state AND the authoritative clocks per game
// (rooms.js); it never trusts the client for legality, turn, or time.

const { Server } = require("socket.io");
const sessionMiddleware = require("../auth/session");
const matchmaking = require("./matchmaking");
const rooms = require("./rooms");
const queries = require("../db/queries");
const config = require("../config");
const db = require("../db/index");
const { elo } = require("./elo");

const GRACE_MS = config.DISCONNECT_GRACE_MS;
const CLOCK_INC = config.CLOCK_INCREMENT_MS;

const other = (c) => (c === "w" ? "b" : "w");
const winResult = (winnerColor) => (winnerColor === "w" ? "1-0" : "0-1");

function attachSockets(httpServer) {
  const io = new Server(httpServer);

  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.userId) {
      socket.userId = session.userId;
      socket.username = session.username;
      return next();
    }
    return next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    console.log(`[socket] connected: ${socket.username} (#${socket.userId})`);
    socket.emit("welcome", { userId: socket.userId, username: socket.username });

    socket.on("lobby:join", () => matchmaking.join(io, socket));
    socket.on("lobby:leave", () => matchmaking.leave(socket));

    socket.on("game:join", (payload, ack) => handleGameJoin(io, socket, payload, ack));
    socket.on("move:make", (payload, ack) => handleMove(io, socket, payload, ack));
    socket.on("game:resign", (payload) => handleResign(io, socket, payload));

    socket.on("disconnect", (reason) => handleDisconnect(io, socket, reason));
  });

  return io;
}

function reply(ack, obj) {
  if (typeof ack === "function") ack(obj);
}

function colorOf(room, userId) {
  if (room.players.w === userId) return "w";
  if (room.players.b === userId) return "b";
  return null;
}

// ---- clocks ----

// Start the clock once both players have joined for the first time.
function startClocksIfReady(io, room) {
  if (room.started) return;
  if (!room.everJoined.w || !room.everJoined.b) return;
  room.started = true;
  room.turnStartedAt = Date.now();
  scheduleFlag(io, room);
}

// Arm a timer to flag the side to move when their remaining time elapses.
function scheduleFlag(io, room) {
  if (room.flagTimer) {
    clearTimeout(room.flagTimer);
    room.flagTimer = null;
  }
  if (!room.started || room.status !== "active") return;
  const turn = room.chess.turn;
  room.flagTimer = setTimeout(
    () => onFlag(io, room.gameId, turn),
    Math.max(0, room.clock[turn])
  );
}

function onFlag(io, gameId, turn) {
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  if (room.chess.turn !== turn) return; // a move already switched the turn
  room.clock[turn] = 0;
  concludeGame(io, room, winResult(other(turn)), "timeout");
}

// ---- game lifecycle ----

// Finalize a game: persist, rate (Elo), notify the room, clear timers, drop the
// room. result '*' means an abort (no winner, no rating change).
function concludeGame(io, room, result, termination) {
  room.status = result === "*" ? "aborted" : "finished";
  rooms.clearTimers(room);
  if (result === "*") queries.abortGame.run(termination, room.gameId);
  else queries.finishGame.run(result, termination, room.gameId);

  const ratings = result === "*" ? null : applyElo(room, result);

  io.to(`game:${room.gameId}`).emit("game:over", {
    result,
    termination,
    ratings,
    clocks: rooms.clockSnapshot(room),
  });
  rooms.deleteRoom(room.gameId);
  console.log(`[game] #${room.gameId} over: ${result} (${termination})`);
}

// Update both players' Elo ratings from a decisive/drawn result.
function applyElo(room, result) {
  const w = queries.getUserById.get(room.players.w);
  const b = queries.getUserById.get(room.players.b);
  if (!w || !b) return null;
  const scoreWhite = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  const { newWhite, newBlack } = elo(w.rating, b.rating, scoreWhite, config.ELO_K);
  db.transaction(() => {
    queries.updateRating.run(newWhite, w.id);
    queries.updateRating.run(newBlack, b.id);
  })();
  return {
    w: { id: w.id, before: w.rating, after: newWhite, delta: newWhite - w.rating },
    b: { id: b.id, before: b.rating, after: newBlack, delta: newBlack - b.rating },
  };
}

function handleGameJoin(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  if (!gameId) return reply(ack, { ok: false, error: "Missing gameId." });

  const room = rooms.getRoom(gameId) || rooms.loadRoomFromDb(gameId);
  if (!room) return reply(ack, { ok: false, error: "Game not found." });

  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });

  socket.join(`game:${gameId}`);
  socket.gameId = gameId;
  socket.gameColor = color;
  room.online[color].add(socket.id);
  room.everJoined[color] = true;

  // Reconnect: cancel a pending forfeit timer and tell the opponent.
  if (room.timers[color]) {
    clearTimeout(room.timers[color]);
    room.timers[color] = null;
    socket.to(`game:${gameId}`).emit("opponent:reconnected", { color });
  }

  // Start the clock once both sides are present.
  startClocksIfReady(io, room);

  reply(ack, {
    ok: true,
    state: {
      gameId,
      fen: room.chess.fen(),
      sans: room.sans.slice(),
      yourColor: color,
      turn: room.chess.turn,
      status: room.status,
      white: room.names.w,
      black: room.names.b,
      clocks: rooms.clockSnapshot(room),
      running: room.started,
      initialMs: config.CLOCK_INITIAL_MS,
    },
  });
}

function handleMove(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  const room = rooms.getRoom(gameId);
  if (!room) return reply(ack, { ok: false, error: "Game not found." });
  if (room.status !== "active") return reply(ack, { ok: false, error: "Game is not active." });

  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });

  // (2) Turn enforcement.
  if (room.chess.turn !== color) return reply(ack, { ok: false, error: "Not your turn." });

  // (3) Legality — match against the server's own legal moves. Never trust client.
  const { from, to, promo } = payload || {};
  const move = room.chess
    .legalMoves()
    .find((m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo));
  if (!move) return reply(ack, { ok: false, error: "Illegal move." });

  // (3b) Clock: charge the mover for their think time; flag if they're out.
  if (room.started) {
    const now = Date.now();
    const remaining = room.clock[color] - (now - room.turnStartedAt);
    if (remaining <= 0) {
      room.clock[color] = 0;
      reply(ack, { ok: false, error: "Out of time." });
      return concludeGame(io, room, winResult(other(color)), "timeout");
    }
    room.clock[color] = remaining + CLOCK_INC;
    room.turnStartedAt = now;
  }

  // (4) Apply on the authoritative board.
  const san = room.chess.moveToSan(move);
  room.chess.makeMove(move);
  room.sans.push(san);

  const ply = room.chess.history.length;
  const fen = room.chess.fen();
  const turn = room.chess.turn;
  const uci = uciOf(move);

  // (5) Persist + (6) broadcast (mover included; everyone applies on confirmation).
  queries.insertMove.run(gameId, ply, san, uci, fen, socket.userId);
  queries.updateGamePosition.run(fen, turn, gameId);
  reply(ack, { ok: true });
  io.to(`game:${gameId}`).emit("move:made", {
    from,
    to,
    promo: promo || null,
    san,
    fen,
    turn,
    ply,
    clocks: rooms.clockSnapshot(room),
  });

  // (7) Game over? Otherwise re-arm the flag timer for the new side to move.
  if (room.chess.isGameOver()) {
    concludeGame(io, room, room.chess.result(), terminationOf(room.chess));
  } else {
    scheduleFlag(io, room);
  }
}

function handleResign(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  const color = colorOf(room, socket.userId);
  if (!color) return;
  concludeGame(io, room, winResult(other(color)), "resign");
}

function handleDisconnect(io, socket, reason) {
  matchmaking.leave(socket);
  console.log(`[socket] disconnected: ${socket.username} (${reason})`);

  const gameId = socket.gameId;
  if (gameId == null) return;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;

  const color = socket.gameColor;
  if (!color || !room.online[color]) return;
  room.online[color].delete(socket.id);
  if (room.online[color].size > 0) return; // another tab for this player is still open

  io.to(`game:${gameId}`).emit("opponent:disconnected", { color, graceMs: GRACE_MS });
  if (room.timers[color]) clearTimeout(room.timers[color]);
  room.timers[color] = setTimeout(() => onGraceExpired(io, gameId, color), GRACE_MS);
}

function onGraceExpired(io, gameId, color) {
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  if (room.online[color].size > 0) return; // reconnected just in time

  if (room.sans.length === 0) concludeGame(io, room, "*", "aborted");
  else concludeGame(io, room, winResult(other(color)), "disconnect");
}

function uciOf(move) {
  const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
  return alg(move.from) + alg(move.to) + (move.promo || "");
}

function terminationOf(chess) {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient";
  if (chess.isThreefoldRepetition()) return "threefold";
  if (chess.halfmove >= 100) return "fifty-move";
  return null;
}

module.exports = { attachSockets };
