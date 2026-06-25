"use strict";

// Socket.IO infrastructure. The critical piece (per DESIGN.md) is that the
// WebSocket handshake reuses the SAME Express session — one auth mechanism for
// REST and realtime, no separate token. Handshakes without an authenticated
// session are rejected before any game logic runs.
//
// M4 establishes only the authenticated connection (welcome + presence logging).
// Matchmaking, rooms, and authoritative move handling land in M5 and plug into
// the `connection` handler here.

const { Server } = require("socket.io");
const sessionMiddleware = require("../auth/session");

function attachSockets(httpServer) {
  const io = new Server(httpServer);

  // Run the Express session middleware on every Engine.IO handshake request so
  // socket.request.session is populated from the same cookie the REST API uses.
  io.engine.use(sessionMiddleware);

  // Reject any handshake that isn't backed by a logged-in session.
  io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.userId) {
      // Stash identity on the socket for convenient access in handlers.
      socket.userId = session.userId;
      socket.username = session.username;
      return next();
    }
    return next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    console.log(`[socket] connected: ${socket.username} (#${socket.userId})`);

    // Confirm the authenticated identity back to the client.
    socket.emit("welcome", { userId: socket.userId, username: socket.username });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnected: ${socket.username} (${reason})`);
    });
  });

  return io;
}

module.exports = { attachSockets };
