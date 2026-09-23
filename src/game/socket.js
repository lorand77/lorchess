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
const lobby = require("./lobby");
const rooms = require("./rooms");
const queries = require("../db/queries");
const config = require("../config");
const db = require("../db/index");
const { elo } = require("./elo");
const achievements = require("../achievements/service");

const GRACE_MS = config.DISCONNECT_GRACE_MS;

// After a restart both clients usually auto-reconnect within a second of each
// other. Wait this long before telling the first one back that their opponent
// is missing, so a red "disconnected" banner doesn't flash up and vanish on
// every deploy. The forfeit clock itself starts immediately either way.
const REJOIN_SETTLE_MS = 3000;

// A move flagged as a premove must land within this long of the opponent's
// move (one network round trip) to be recorded as one.
const PREMOVE_MAX_MS = 1500;

const other = (c) => (c === "w" ? "b" : "w");

// Chat is split by audience. Everyone in a game shares `game:<id>` for moves,
// clocks and the result, but chat is delivered to one of these two rooms only,
// so a spectator can never pass a move to a player mid-game.
const chatRoom = (gameId, audience) => `chat:${gameId}:${audience}`;
const audienceOf = (role) => (role === "s" ? "spectators" : "players");

// Pending rematch offers for FINISHED games, keyed by the old gameId. The room
// is gone by then (concludeGame drops it), so this holds the offering sockets
// directly: gameId -> Map<userId, socket>. When both participants appear, a new
// game is created with the colours swapped.
const rematches = new Map();
const winResult = (winnerColor) => (winnerColor === "w" ? "1-0" : "0-1");

function attachSockets(httpServer) {
  const io = new Server(httpServer);

  // Games left 'active' by the previous run are waiting to be resumed. Give
  // the players a window to reconnect, then abort whatever nobody claimed.
  // unref'd so it never holds the process open by itself.
  setTimeout(() => {
    const aborted = rooms.sweepUnresumed();
    if (!aborted) return;
    console.log(`Aborted ${aborted} game(s) nobody resumed after the restart.`);
    lobby.refresh(io);
  }, config.RESUME_WINDOW_MS).unref();

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
    lobby.connected(io, socket);

    // Quick-match queue.
    socket.on("lobby:join", (payload) => matchmaking.join(io, socket, payload));
    socket.on("lobby:leave", () => matchmaking.leave(socket));

    // Live lobby: presence, open seeks, direct challenges.
    socket.on("lobby:enter", () => lobby.enter(io, socket));
    socket.on("lobby:exit", () => lobby.exit(io, socket));
    socket.on("seek:create", (p) => lobby.createSeek(io, socket, p));
    socket.on("seek:cancel", (p) => lobby.cancelSeek(io, socket, p));
    socket.on("seek:accept", (p) => lobby.acceptSeek(io, socket, p));
    socket.on("challenge:create", (p) => lobby.createChallenge(io, socket, p));
    socket.on("challenge:accept", (p) => lobby.acceptChallenge(io, socket, p));
    socket.on("challenge:decline", (p) => lobby.declineChallenge(io, socket, p));
    socket.on("challenge:cancel", (p) => lobby.cancelChallenge(io, socket, p));

    socket.on("game:join", (payload, ack) => handleGameJoin(io, socket, payload, ack));
    socket.on("game:watch", (payload, ack) => handleWatch(io, socket, payload, ack));
    socket.on("chat:send", (payload, ack) => handleChat(io, socket, payload, ack));
    socket.on("move:make", (payload, ack) => handleMove(io, socket, payload, ack));
    socket.on("game:resign", (payload) => handleResign(io, socket, payload));
    socket.on("draw:offer", (payload) => handleDrawOffer(io, socket, payload));
    socket.on("draw:respond", (payload) => handleDrawRespond(io, socket, payload));
    socket.on("rematch:offer", (payload) => handleRematchOffer(io, socket, payload));
    socket.on("rematch:decline", (payload) => handleRematchDecline(io, socket, payload));

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
  // The player who joined first got `running: false` in their join ack; tell
  // the whole room the clock is now live so their display starts ticking.
  io.to(`game:${room.gameId}`).emit("clock:started", {
    clocks: rooms.clockSnapshot(room),
  });
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
  // Snapshot before the status flips: clockSnapshot only charges the side to
  // move while the game is still active, and a resignation should record the
  // time the resigning player had actually burned.
  const clocks = rooms.clockSnapshot(room);
  room.status = result === "*" ? "aborted" : "finished";
  rooms.clearTimers(room);
  queries.updateGameClocks.run(clocks.w, clocks.b, room.gameId);
  if (result === "*") queries.abortGame.run(termination, room.gameId);
  else queries.finishGame.run(result, termination, room.gameId);

  // Aborts have no result to rate, and a casual game moves nobody's Elo.
  const ratings = result === "*" || !room.rated ? null : applyElo(room, result);

  io.to(`game:${room.gameId}`).emit("game:over", {
    result,
    termination,
    ratings,
    clocks,
  });
  if (result !== "*") notifyAchievements(room, { resignReactionMs: room.resignReactionMs });
  rooms.deleteRoom(room.gameId);
  lobby.refresh(io); // both players are free again
  console.log(`[game] #${room.gameId} over: ${result} (${termination})`);
}

// Evaluate achievements for both players now that the game is in the database,
// and tell each of them (every tab they have open) what they just earned.
function notifyAchievements(room, extra) {
  let earned;
  try {
    earned = achievements.onGameFinished(room.gameId, extra);
  } catch (err) {
    console.error(`[achievements] game #${room.gameId}:`, err);
    return;
  }
  for (const [userId, list] of Object.entries(earned)) {
    if (list.length) lobby.notifyUser(Number(userId), "achievements:earned", { list });
  }
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
    queries.insertRatingHistory.run(w.id, room.gameId, w.rating, newWhite);
    queries.insertRatingHistory.run(b.id, room.gameId, b.rating, newBlack);
  })();
  return {
    w: { id: w.id, before: w.rating, after: newWhite, delta: newWhite - w.rating },
    b: { id: b.id, before: b.rating, after: newBlack, delta: newBlack - b.rating },
  };
}

// Start the forfeit clock against a player who isn't here. `settleMs` delays
// only the announcement: a fresh disconnect is reported at once, while a room
// rebuilt after a restart gives the other client a moment to come back first.
function armAbsence(io, room, color, settleMs) {
  if (room.status !== "active") return;
  if (room.timers[color] || room.online[color].size > 0) return;
  const gameId = room.gameId;

  room.timers[color] = setTimeout(() => onGraceExpired(io, gameId, color), GRACE_MS);

  const announce = () => {
    room.notices[color] = null;
    const live = rooms.getRoom(gameId);
    if (!live || live.status !== "active" || live.online[color].size > 0) return;
    io.to(`game:${gameId}`).emit("opponent:disconnected", { color, graceMs: GRACE_MS });
  };
  if (settleMs > 0) room.notices[color] = setTimeout(announce, settleMs);
  else announce();
}

function handleGameJoin(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  if (!gameId) return reply(ack, { ok: false, error: "Missing gameId." });

  const room = rooms.getRoom(gameId) || rooms.loadRoomFromDb(gameId);
  if (!room) return reply(ack, { ok: false, error: "Game not found." });

  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });

  socket.join(`game:${gameId}`);
  socket.join(chatRoom(gameId, "players"));
  socket.gameId = gameId;
  socket.gameColor = color;
  room.online[color].add(socket.id);
  room.everJoined[color] = true;

  // Reconnect: cancel a pending forfeit timer and tell the opponent.
  if (room.timers[color]) {
    clearTimeout(room.timers[color]);
    room.timers[color] = null;
    // Only announce the return if the absence was ever announced — a notice
    // still pending means nobody was told about it in the first place.
    const wasAnnounced = room.notices[color] == null;
    if (room.notices[color]) {
      clearTimeout(room.notices[color]);
      room.notices[color] = null;
    }
    if (wasAnnounced) socket.to(`game:${gameId}`).emit("opponent:reconnected", { color });
  }

  // A room rebuilt from the database has nobody connected yet, so the first
  // player back starts the forfeit clock against the one who hasn't returned.
  // Without this a restart would leave the game hanging for ever when the
  // opponent simply closed their tab.
  if (room.rehydrated) armAbsence(io, room, other(color), REJOIN_SETTLE_MS);

  // Start the clock once both sides are present. Neither player is charged for
  // the downtime: the clock resumes from the stored values only once the game
  // is properly under way again.
  startClocksIfReady(io, room);
  lobby.refresh(io); // this player now shows as "playing" in the lobby

  reply(ack, { ok: true, state: stateOf(room, color) });
}

// The full board state a client needs to (re)draw a game. `color` is the
// receiving player's colour, or null for a spectator.
function stateOf(room, color) {
  return {
    gameId: room.gameId,
    fen: room.chess.fen(),
    sans: room.sans.slice(),
    yourColor: color,
    turn: room.chess.turn,
    status: room.status,
    result: room.result || null,
    termination: room.termination || null,
    white: room.names.w,
    black: room.names.b,
    whiteId: room.players.w,
    blackId: room.players.b,
    clocks: rooms.clockSnapshot(room),
    running: room.started,
    drawOffer: room.drawOffer,
    initialMs: room.initialMs,
    incrementMs: room.incrementMs,
    timeControl: room.timeControl,
    rated: room.rated,
    // Only set when the game did NOT begin from the standard position, so the
    // client knows to put a SetUp/FEN header in the exported PGN.
    startFen: room.startFen && room.startFen !== rooms.STANDARD_START ? room.startFen : null,
    handicap: room.handicap,
    variant: room.variant,
    spectators: room.spectators.size,
    // Only this recipient's side of the conversation. `color` is null for a
    // spectator, which is exactly the audience distinction we need.
    chat: color
      ? queries.listPlayerChat.all(room.gameId, CHAT_HISTORY)
      : queries.listSpectatorChat.all(room.gameId, CHAT_HISTORY),
  };
}

// ---- chat ----
// Anyone in the game may talk: the two players (also after the game ends, while
// they hang around for a rematch) and spectators. The room object may already be
// gone by then, so membership is judged from the socket's own join/watch markers
// and the seat from the games row. Messages persist.
//
// Crucially there are TWO conversations, not one. A spectator watching a live
// game can see the position, so if their messages reached the players they could
// simply type out an engine's best move. Player chat and spectator chat are
// therefore delivered to separate Socket.IO rooms and read back through separate
// queries: neither side ever receives the other's messages, at any point.
const CHAT_HISTORY = 100;
const CHAT_MAX_LEN = 300;
const CHAT_BURST = 5;        // at most this many messages...
const CHAT_WINDOW_MS = 5000; // ...per this window, per socket

function handleChat(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  const text = typeof (payload && payload.text) === "string"
    ? payload.text.replace(/\s+/g, " ").trim()
    : "";
  if (!gameId || socket.gameId !== gameId && socket.watching !== gameId) {
    return reply(ack, { ok: false, error: "You're not in this game." });
  }
  if (!text) return reply(ack, { ok: false, error: "Empty message." });
  if (text.length > CHAT_MAX_LEN) {
    return reply(ack, { ok: false, error: `Keep it under ${CHAT_MAX_LEN} characters.` });
  }

  // Sliding-window rate limit.
  const now = Date.now();
  socket.chatTimes = (socket.chatTimes || []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (socket.chatTimes.length >= CHAT_BURST) {
    return reply(ack, { ok: false, error: "Slow down a little." });
  }
  socket.chatTimes.push(now);

  const game = queries.getGameById.get(gameId);
  if (!game) return reply(ack, { ok: false, error: "Game not found." });
  const role =
    game.white_id === socket.userId ? "w" : game.black_id === socket.userId ? "b" : "s";

  // Store the message and bump the sender's lifetime tally together: the
  // messages get swept eventually, the tally is what "Chatty" counts.
  const info = db.transaction(() => {
    const res = queries.insertChat.run(gameId, socket.userId, role, text);
    queries.bumpChatCount.run(socket.userId);
    return res;
  })();
  const msg = queries.getChatById.get(Number(info.lastInsertRowid));
  // Players hear players; spectators hear spectators. Never across.
  io.to(chatRoom(gameId, audienceOf(role))).emit("chat:message", msg);
  reply(ack, { ok: true });
  const earned = achievements.onChat(socket.userId);
  if (earned.length) lobby.notifyUser(socket.userId, "achievements:earned", { list: earned });
}

// ---- spectators ----
// A spectator joins the Socket.IO room like a player, so every broadcast
// (moves, clocks, game over) reaches them for free. They are NOT recorded in
// room.online / socket.gameColor, so disconnecting one never starts a forfeit
// timer, and every action handler rejects them via colorOf() === null.
function handleWatch(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  if (!gameId) return reply(ack, { ok: false, error: "Missing gameId." });

  // Deliberately NOT loadRoomFromDb: a spectator must never be the one to
  // rebuild a room. Doing so would keep a game the players abandoned alive past
  // the resume sweep, with no forfeit clock running against either of them.
  const room = rooms.getRoom(gameId);
  if (!room) {
    const game = queries.getGameById.get(gameId);
    if (!game || game.mode !== "pvp") return reply(ack, { ok: false, error: "Game not found." });
    // Still 'active' with no room means a restart left it waiting for its
    // players; it becomes watchable again as soon as one of them reconnects.
    if (game.status === "active") {
      return reply(ack, { ok: false, error: "That game is waiting for its players to reconnect." });
    }
    return reply(ack, { ok: false, error: "That game has already finished.", finished: true });
  }
  if (colorOf(room, socket.userId)) {
    return reply(ack, { ok: false, error: "You're a player in this game.", player: true });
  }

  // Switching to a different game on the same socket: drop the old rooms so
  // its broadcasts and chat don't bleed into the new one.
  if (socket.watching != null && socket.watching !== gameId) leaveWatching(io, socket);

  socket.join(`game:${gameId}`);
  socket.join(chatRoom(gameId, "spectators"));
  socket.watching = gameId;
  room.spectators.add(socket.id);
  broadcastSpectators(io, room);
  reply(ack, { ok: true, state: stateOf(room, null) });
}

function broadcastSpectators(io, room) {
  io.to(`game:${room.gameId}`).emit("spectators", { count: room.spectators.size });
}

function leaveWatching(io, socket) {
  if (socket.watching == null) return;
  const gameId = socket.watching;
  const room = rooms.getRoom(gameId);
  socket.watching = null;
  socket.leave(`game:${gameId}`);
  socket.leave(chatRoom(gameId, "spectators"));
  if (!room || !room.spectators.delete(socket.id)) return;
  broadcastSpectators(io, room);
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
  const move = room.chess.findMove(from, to, promo);
  if (!move) return reply(ack, { ok: false, error: "Illegal move." });

  // (3b) Clock: charge the mover for their think time; flag if they're out.
  let thinkMs = null;
  if (room.started) {
    const now = Date.now();
    thinkMs = now - room.turnStartedAt;
    const remaining = room.clock[color] - thinkMs;
    if (remaining <= 0) {
      room.clock[color] = 0;
      reply(ack, { ok: false, error: "Out of time." });
      return concludeGame(io, room, winResult(other(color)), "timeout");
    }
    room.clock[color] = remaining + room.incrementMs;
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
  // The client says whether this was a premove; believe it only if the move
  // really did arrive on the heels of the opponent's, so a crafted payload
  // can't claim a premove it had time to think about.
  const premove = !!(payload && payload.premove) && (thinkMs == null || thinkMs < PREMOVE_MAX_MS);
  queries.insertMoveTimed.run(gameId, ply, san, uci, fen, socket.userId, thinkMs, premove ? 1 : 0);
  queries.updateGamePosition.run(fen, turn, gameId);
  // Clocks go to the database too, so this game survives a restart.
  queries.updateGameClocks.run(room.clock.w, room.clock.b, gameId);

  // An outstanding draw offer lapses as soon as a move is played.
  if (room.drawOffer) {
    room.drawOffer = null;
    io.to(`game:${gameId}`).emit("draw:cleared");
  }

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

  lobby.nudge(io); // keep the lobby's board previews roughly current

  // (7) Game over? Otherwise re-arm the flag timer for the new side to move.
  if (room.chess.isGameOver()) {
    concludeGame(io, room, room.chess.result(), terminationOf(room.chess));
  } else {
    scheduleFlag(io, room);
  }
}

// ---- draw offers ----
// An offer is stored on the room as the offering colour. Offering while the
// opponent already has an offer outstanding counts as accepting it.
function handleDrawOffer(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  const color = colorOf(room, socket.userId);
  if (!color) return;

  if (room.drawOffer === color) return;                 // already pending from us
  if (room.drawOffer === other(color)) {                // crossed offers = agreement
    return concludeGame(io, room, "1/2-1/2", "agreement");
  }
  room.drawOffer = color;
  socket.to(`game:${gameId}`).emit("draw:offered", { from: color });
}

function handleDrawRespond(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  const color = colorOf(room, socket.userId);
  if (!color) return;
  // Only the side that did NOT offer can answer.
  if (!room.drawOffer || room.drawOffer === color) return;

  if (payload && payload.accept) {
    return concludeGame(io, room, "1/2-1/2", "agreement");
  }
  room.drawOffer = null;
  io.to(`game:${gameId}`).emit("draw:declined", { by: color });
}

// ---- rematch ----
// Mutual-offer model: whoever offers second is accepting. Both players stay in
// the Socket.IO room `game:<oldId>` after the game ends, so offers still reach
// the opponent even though the room object is gone.
function handleRematchOffer(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  if (!gameId) return;
  const game = queries.getGameById.get(gameId);
  if (!game || game.mode !== "pvp" || game.status === "active") return;
  const uid = socket.userId;
  if (game.white_id !== uid && game.black_id !== uid) return;

  let offers = rematches.get(gameId);
  if (!offers) {
    offers = new Map();
    rematches.set(gameId, offers);
  }
  offers.set(uid, socket);

  // Both sides in? Start the new game with the colours swapped.
  if (offers.has(game.white_id) && offers.has(game.black_id)) {
    rematches.delete(gameId);
    const newWhite = offers.get(game.black_id);
    const newBlack = offers.get(game.white_id);
    console.log(`[rematch] game #${gameId} -> new game, colours swapped`);
    return matchmaking.startMatch(io, newWhite, newBlack, {
      initialMs: game.initial_ms,
      incrementMs: game.increment_ms,
      rated: !!game.rated,
      // A Chess960 rematch draws a new position rather than repeating the old.
      variant: game.variant || "standard",
    });
  }
  socket.to(`game:${gameId}`).emit("rematch:offered", { username: socket.username });
}

function handleRematchDecline(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  if (!gameId || !rematches.has(gameId)) return;
  const game = queries.getGameById.get(gameId);
  if (!game || (game.white_id !== socket.userId && game.black_id !== socket.userId)) return;
  rematches.delete(gameId);
  socket.to(`game:${gameId}`).emit("rematch:declined", { username: socket.username });
}

// Drop a disconnecting player's pending rematch offers, so the opponent can't
// accept into a game the offerer will never join.
function clearRematchOffers(socket) {
  for (const [gid, offers] of rematches) {
    if (offers.get(socket.userId) !== socket) continue;
    offers.delete(socket.userId);
    if (offers.size === 0) rematches.delete(gid);
  }
}

function handleResign(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  const color = colorOf(room, socket.userId);
  if (!color) return;
  // How long after the opponent's last move the resignation came (the "Rage
  // Quit" achievement wants to know). Only meaningful once the clock runs.
  room.resignReactionMs =
    room.started && room.turnStartedAt != null && room.chess.turn === color
      ? Date.now() - room.turnStartedAt
      : null;
  concludeGame(io, room, winResult(other(color)), "resign");
}

function handleDisconnect(io, socket, reason) {
  matchmaking.leave(socket);
  lobby.onDisconnect(io, socket);
  clearRematchOffers(socket);
  leaveWatching(io, socket);
  console.log(`[socket] disconnected: ${socket.username} (${reason})`);

  const gameId = socket.gameId;
  if (gameId == null) return;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;

  const color = socket.gameColor;
  if (!color || !room.online[color]) return;
  room.online[color].delete(socket.id);
  if (room.online[color].size > 0) return; // another tab for this player is still open

  armAbsence(io, room, color, 0); // a real disconnect is announced immediately
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
  // Castling points at the rook, not the king's destination — see
  // Chess.findMove for why.
  const to = move.castle && move.rookFrom != null ? move.rookFrom : move.to;
  return alg(move.from) + alg(to) + (move.promo || "");
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
