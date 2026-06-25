"use strict";

// Socket.IO infrastructure + authoritative PvP handlers.
//
// The handshake reuses the SAME Express session (io.engine.use) — one auth
// mechanism for REST and realtime, no separate token. The server holds the
// authoritative Chess state per game (see rooms.js) and NEVER trusts the client
// for legality or turn order.

const { Server } = require("socket.io");
const sessionMiddleware = require("../auth/session");
const matchmaking = require("./matchmaking");
const rooms = require("./rooms");
const queries = require("../db/queries");

function attachSockets(httpServer) {
  const io = new Server(httpServer);

  // Share the Express session with the Engine.IO handshake.
  io.engine.use(sessionMiddleware);

  // Reject any handshake without an authenticated session.
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

    // --- matchmaking ---
    socket.on("lobby:join", () => matchmaking.join(io, socket));
    socket.on("lobby:leave", () => matchmaking.leave(socket));

    // --- in-game ---
    socket.on("game:join", (payload, ack) => handleGameJoin(socket, payload, ack));
    socket.on("move:make", (payload, ack) => handleMove(io, socket, payload, ack));

    socket.on("disconnect", (reason) => {
      matchmaking.leave(socket);
      console.log(`[socket] disconnected: ${socket.username} (${reason})`);
      // In-game disconnect grace/forfeit handling is M6.
    });
  });

  return io;
}

function reply(ack, obj) {
  if (typeof ack === "function") ack(obj);
}

// The color this user plays in a room, or null if they're not a participant.
function colorOf(room, userId) {
  if (room.players.w === userId) return "w";
  if (room.players.b === userId) return "b";
  return null;
}

function handleGameJoin(socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  if (!gameId) return reply(ack, { ok: false, error: "Missing gameId." });

  const room = rooms.getRoom(gameId) || rooms.loadRoomFromDb(gameId);
  if (!room) return reply(ack, { ok: false, error: "Game not found." });

  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });

  socket.join(`game:${gameId}`);
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
  if (room.chess.turn !== color) {
    return reply(ack, { ok: false, error: "Not your turn." });
  }

  // (3) Legality — match against the server's own legal moves. Never trust client.
  const { from, to, promo } = payload || {};
  const move = room.chess
    .legalMoves()
    .find((m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo));
  if (!move) return reply(ack, { ok: false, error: "Illegal move." });

  // (4) Apply on the authoritative board.
  const san = room.chess.moveToSan(move);
  room.chess.makeMove(move);
  room.sans.push(san);

  const ply = room.chess.history.length;
  const fen = room.chess.fen();
  const turn = room.chess.turn;
  const uci = uciOf(move);

  // (5) Persist.
  queries.insertMove.run(gameId, ply, san, uci, fen, socket.userId);
  queries.updateGamePosition.run(fen, turn, gameId);

  // (6) Acknowledge the mover and broadcast to the whole room (mover included —
  // the mover applies their own move only on this confirmation).
  reply(ack, { ok: true });
  io.to(`game:${gameId}`).emit("move:made", { from, to, promo: promo || null, san, fen, turn, ply });

  // (7) Game over?
  if (room.chess.isGameOver()) {
    const result = room.chess.result();
    const termination = terminationOf(room.chess);
    room.status = "finished";
    queries.finishGame.run(result, termination, gameId);
    io.to(`game:${gameId}`).emit("game:over", { result, termination });
    rooms.deleteRoom(gameId);
    console.log(`[game] #${gameId} over: ${result} (${termination})`);
  }
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
