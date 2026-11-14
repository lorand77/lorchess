"use strict";

// Socket.IO infrastructure and the authoritative PvP handlers: joining,
// moving, clocks and flags, draws, resignation, rematches, chat, spectating,
// disconnects and Elo.
//
// The handshake reuses the SAME Express session (io.engine.use). The server
// holds the authoritative Chess state AND the authoritative clocks per game
// (rooms.js); it never trusts the client for legality, turn, or time.

const { Server } = require("socket.io");
const log = require("../log");
const sessionMiddleware = require("../auth/session");
const { sameOrigin } = require("../auth/sameOrigin");
const matchmaking = require("./matchmaking");
const lobby = require("./lobby");
const rooms = require("./rooms");
const queries = require("../db/queries");
const config = require("../config");
const db = require("../db/index");
const { elo } = require("./elo");
const achievements = require("../achievements/service");
const handicap = require("../shared/handicap");
const { formatUci } = require("../shared/uci");
const { InfiniteChess } = require("../shared/infiniteChess");
const { usesStandardSetup } = require("../shared/variants");
const { Bughouse } = require("../shared/bughouse");
const matches = require("./matches");
const fourGames = require("./fourGames");
const { FourPlayer } = require("../shared/fourPlayer");
const bots = require("./bots");
const { aiLevelOf, resolveAiLevel } = require("../shared/aiLevels");
const { resolveTimeControl, DEFAULT_TC } = require("../shared/timeControls");

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
// The result when `color` loses (resigns, flags, is forfeited): the other
// player wins, or in a four-player game the other team.
const lossFor = (room, color) => (room.four ? FourPlayer.lossFor(color) : winResult(other(color)));

// Running out of time loses — unless the other side could never have delivered
// mate, in which case it is a draw, as over the board (FIDE 6.9: the flag only
// wins for a side that could still have won). Atomic and Pawn Wars win by other
// means, so there hasMatingMaterial is always true and a flag is always a loss.
// So does a four-player flag, for the flagged player's team.
function flagResult(room, flagged) {
  if (room.four) return FourPlayer.lossFor(flagged);
  const winner = other(flagged);
  return room.chess.hasMatingMaterial(winner) ? winResult(winner) : "1/2-1/2";
}

// One move's writes as a single transaction: the move row, the position and
// the clocks (so the game survives a restart). All or nothing, so a failure can
// be rolled back in memory without a half-recorded move left behind. A
// four-player game stores the team to move and its four clocks (fourGames.js).
const persistMove = db.transaction((room, ply, san, uci, fen, userId, thinkMs, premove) => {
  const turn = room.chess.turn;
  queries.insertMoveTimed.run(room.gameId, ply, san, uci, fen, userId, thinkMs, premove ? 1 : 0);
  queries.updateGamePosition.run(fen, room.four ? FourPlayer.sideOf(turn) : turn, room.gameId);
  saveClocks(room, room.clock);
});

function saveClocks(room, clocks) {
  if (room.four) fourGames.saveClocks(room.gameId, clocks);
  else queries.updateGameClocks.run(clocks.w, clocks.b, room.gameId);
}

// Engine.IO may have loaded the cookie before logout, and an established
// connection may outlive its session. Check the store without saving/touching
// it so a stale socket cannot recreate or extend a revoked/expired session.
function reloadSocketSession(socket, done) {
  const session = socket.request.session;
  if (!session || !session.userId) return done(new Error("unauthorized"));
  session.reload((err) => {
    const current = socket.request.session;
    if (
      err || !current.userId ||
      (socket.userId != null && current.userId !== socket.userId) ||
      queries.isDeactivated.get(current.userId)
    ) {
      return done(new Error("unauthorized"));
    }
    done(null, current);
  });
}

function attachSockets(httpServer) {
  // Only LorChess's own pages may open a socket; see src/auth/sameOrigin.js.
  const io = new Server(httpServer, {
    allowRequest: (req, done) => done(null, sameOrigin(req)),
  });

  // Games left 'active' by the previous run are waiting to be resumed. Give
  // the players a window to reconnect, then abort whatever nobody claimed.
  // unref'd so it never holds the process open by itself.
  setTimeout(() => safely("restart sweep", () => {
    const aborted = rooms.sweepUnresumed();
    if (!aborted) return;
    log.info("game.restart_sweep", { aborted });
    lobby.refresh(io);
  }), config.RESUME_WINDOW_MS).unref();

  // `npm run user:deactivate` runs in another process and cannot reach these
  // sockets. An idle one never sends the event that would re-check it, so it
  // would keep its owner listed (and challengeable) in the lobby. Sweep them;
  // the ordinary disconnect path then withdraws seeks and challenges, and a
  // live game is forfeited once the reconnect grace runs out.
  setInterval(() => safely("deactivation sweep", () => {
    for (const socket of io.of("/").sockets.values()) {
      if (queries.isDeactivated.get(socket.userId)) socket.disconnect(true);
    }
  }), config.DEACTIVATION_SWEEP_MS).unref();

  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    reloadSocketSession(socket, (err, session) => {
      if (err) return next(err);
      socket.userId = session.userId;
      socket.username = session.username;
      socket.log = log.child({ user: session.userId, name: session.username });
      next();
    });
  });

  io.on("connection", (socket) => {
    // All tabs sharing a cookie leave together; another login on the same
    // account has its own session room and stays connected.
    socket.join(`session:${socket.request.sessionID}`);
    socket.use((_packet, next) => {
      reloadSocketSession(socket, (err) => {
        if (err) return socket.disconnect(true);
        next();
      });
    });
    socket.log.info("socket.connect");
    socket.emit("welcome", { userId: socket.userId, username: socket.username });
    // One room per user, so "your game is starting" reaches every tab this
    // person has open instead of whichever socket we happened to pick.
    socket.join(matchmaking.userRoom(socket.userId));
    safely("connection setup", () => lobby.connected(io, socket));

    // Socket.IO runs listeners with no try/catch of its own, so an exception
    // in a handler (better-sqlite3 raises synchronously) would take the whole
    // process down, and every live game with it. Log it, fail the caller's
    // acknowledgement if there is one, and carry on.
    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        try {
          handler(payload, ack);
        } catch (err) {
          socket.log.error("socket.handler_failed", { event, err });
          reply(ack, { ok: false, error: "Server error." });
        }
      });
    };

    // Quick-match queue.
    on("lobby:join", (payload) => matchmaking.join(io, socket, payload));
    on("lobby:leave", () => matchmaking.leave(socket));

    // Live lobby: presence, open seeks, direct challenges.
    on("lobby:enter", () => lobby.enter(io, socket));
    on("seek:create", (p) => lobby.createSeek(io, socket, p));
    on("seek:cancel", (p) => lobby.cancelSeek(io, socket, p));
    on("seek:accept", (p) => lobby.acceptSeek(io, socket, p));
    on("challenge:create", (p) => lobby.createChallenge(io, socket, p));
    on("challenge:accept", (p) => lobby.acceptChallenge(io, socket, p));
    on("challenge:decline", (p) => lobby.declineChallenge(io, socket, p));
    on("challenge:cancel", (p) => lobby.cancelChallenge(io, socket, p));
    on("bughouse:bots", (payload, ack) => handleBughouseBots(io, socket, payload, ack));
    on("table:create", (p) => lobby.createTable(io, socket, p));
    on("table:sit", (p) => lobby.sitAtTable(io, socket, p));
    on("table:leave", () => lobby.leaveTable(io, socket));
    on("table:start", (p) => lobby.startTableNow(io, socket, p));
    on("bughouse:call", (payload, ack) => handleBughouseCall(io, socket, payload, ack));

    on("game:join", (payload, ack) => handleGameJoin(io, socket, payload, ack));
    on("game:watch", (payload, ack) => handleWatch(io, socket, payload, ack));
    on("chat:send", (payload, ack) => handleChat(io, socket, payload, ack));
    on("move:make", (payload, ack) => handleMove(io, socket, payload, ack));
    on("game:resign", (payload) => handleResign(io, socket, payload));
    on("draw:offer", (payload) => handleDrawOffer(io, socket, payload));
    on("draw:respond", (payload) => handleDrawRespond(io, socket, payload));
    on("rematch:offer", (payload) => handleRematchOffer(io, socket, payload));
    on("rematch:decline", (payload) => handleRematchDecline(io, socket, payload));

    on("disconnect", (reason) => handleDisconnect(io, socket, reason));
  });

  return io;
}

function reply(ack, obj) {
  if (typeof ack === "function") ack(obj);
}

// Timer callbacks and the connection setup run outside the per-event wrapper
// in attachSockets; the same rule applies to them: log, never crash.
function safely(label, fn) {
  try {
    fn();
  } catch (err) {
    log.error("socket.task_failed", { task: label, err });
  }
}

function colorOf(room, userId) {
  return room.colors.find((c) => room.players[c] === userId) || null;
}

// Whether a user plays in a game, by its row: White, Black, or one of a
// four-player game's seats.
function seatedIn(game, userId) {
  if (game.white_id === userId || game.black_id === userId) return true;
  return game.variant === fourGames.VARIANT && !!fourGames.colorIn(game.id, userId);
}

// ---- clocks ----

// Start the clock once every player has joined for the first time. A
// Bughouse board waits for all four players, and then both boards start
// together: neither team gets a head start on the other board.
function startClocksIfReady(io, room) {
  if (room.started) return;
  const seated = (r) => r.colors.every((c) => r.everJoined[c]);
  if (room.matchId) {
    const both = rooms.matchRooms(room);
    if (!both || !both.every(seated)) return;
    for (const r of both) if (!r.started) startClock(io, r);
    return;
  }
  if (!seated(room)) return;
  startClock(io, room);
}

function startClock(io, room) {
  room.started = true;
  // Remembered on the games row too: after a restart it is the only record
  // that both players ever took their seats (see onGraceExpired).
  room.clockStarted = true;
  queries.markClockStarted.run(room.gameId);
  room.turnStartedAt = Date.now();
  scheduleFlag(io, room);
  // The player who joined first got `running: false` in their join ack; tell
  // the whole room the clock is now live so their display starts ticking.
  io.to(`game:${room.gameId}`).emit("clock:started", {
    clocks: rooms.clockSnapshot(room),
  });
  tellPartner(io, (rooms.matchRooms(room) || [])[1 - room.board] || room); // its clocks now run
  botTurn(io, room); // a LorFish with White moves first
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
    () => safely("flag timer", () => onFlag(io, room.gameId, turn)),
    Math.max(0, room.clock[turn])
  );
}

function onFlag(io, gameId, turn) {
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active") return;
  if (room.chess.turn !== turn) return; // a move already switched the turn
  room.clock[turn] = 0;
  concludeGame(io, room, flagResult(room, turn), "timeout");
}

// ---- game lifecycle ----

// Finalize a game: persist, rate (Elo), notify the room, clear timers, drop the
// room. result '*' means an abort (no winner, no rating change).
function concludeGame(io, room, result, termination) {
  // A Bughouse board never ends alone: whatever ended it ends the match.
  if (room.matchId) return concludeMatch(io, room, result, termination);
  // Snapshot before the status flips: clockSnapshot only charges the side to
  // move while the game is still active, and a resignation should record the
  // time the resigning player had actually burned.
  const clocks = rooms.clockSnapshot(room);
  // The database first, in one transaction, and only then the room: if the
  // write fails (the timer wrapper logs it), the room stays live with whatever
  // timers it had and a later trigger tries again, rather than a game that is
  // over in memory but still active on disk.
  const ratings = db.transaction(() => {
    saveClocks(room, clocks);
    if (result === "*") queries.abortGame.run(termination, room.gameId);
    else queries.finishGame.run(result, termination, room.gameId);
    // Aborts have no result to rate, and a casual game moves nobody's Elo.
    return result === "*" || !room.rated ? null : applyElo(room, result);
  })();
  room.status = result === "*" ? "aborted" : "finished";
  rooms.clearTimers(room);

  io.to(`game:${room.gameId}`).emit("game:over", {
    result,
    termination,
    ratings,
    clocks,
  });
  if (result !== "*") notifyAchievements(room, { resignReactionMs: room.resignReactionMs });
  rooms.deleteRoom(room.gameId);
  lobby.refresh(io); // both players are free again
  log.info("game.over", { game: room.gameId, result, termination });
}

// End a Bughouse match because one of its boards ended (`room`, with that
// board's result: a mate, a flag, a resignation, a forfeit or an abort). The
// team that won there wins the match, and both boards are finished with the
// results that follow for their players (matches.finishMatch), the other
// board's ending "on the other board". Each board's players and spectators
// hear their own board's result and the match's. Always casual: no Elo.
function concludeMatch(io, room, result, termination) {
  const both = rooms.matchRooms(room) || [room];
  const clocks = both.map((r) => rooms.clockSnapshot(r));
  const aborted = result === "*";
  const team = aborted ? null
    : result === "1/2-1/2" ? "draw"
      : Bughouse.teamOf(room.board, result === "1-0" ? "w" : "b");
  db.transaction(() => {
    both.forEach((r, i) => queries.updateGameClocks.run(clocks[i].w, clocks[i].b, r.gameId));
    if (aborted) matches.abortMatch(room.matchId, termination);
    else matches.finishMatch(room.matchId, { result: team, termination, decidedOn: room.board });
  })();
  const results = aborted ? null : Bughouse.boardResults(team);
  both.forEach((r, i) => {
    r.status = aborted ? "aborted" : "finished";
    rooms.clearTimers(r);
    io.to(`game:${r.gameId}`).emit("game:over", {
      result: aborted ? "*" : results[r.board],
      termination: r === room || aborted ? termination : matches.OTHER_BOARD,
      ratings: null,
      clocks: clocks[i],
      match: { id: room.matchId, result: team, termination, decidedOn: room.board },
    });
  });
  if (!aborted) for (const r of both) notifyAchievements(r, {});
  for (const r of both) rooms.deleteRoom(r.gameId);
  lobby.refresh(io); // all four players are free again
  log.info("match.over", { match: room.matchId, result: aborted ? "*" : team, termination, board: room.board });
}

// How many moves a game has seen: for a Bughouse board, both boards' together,
// since a match one board has moved in has been played.
function pliesPlayed(room) {
  const both = rooms.matchRooms(room);
  return both ? both[0].sans.length + both[1].sans.length : room.sans.length;
}

// Evaluate achievements for both players now that the game is in the database,
// and tell each of them (every tab they have open) what they just earned.
function notifyAchievements(room, extra) {
  let earned;
  try {
    earned = achievements.onGameFinished(room.gameId, extra);
  } catch (err) {
    log.error("achievements.game_failed", { game: room.gameId, err });
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
  lobby.ratingChanged(w.id, newWhite);
  lobby.ratingChanged(b.id, newBlack);
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

  room.timers[color] = setTimeout(
    () => safely("forfeit timer", () => onGraceExpired(io, gameId, color)),
    GRACE_MS
  );

  // The notice carries the time the absent player has left when it is shown,
  // not the full grace period, since it may be held back by `settleMs`.
  const announce = () => {
    room.notices[color] = null;
    const live = rooms.getRoom(gameId);
    if (!live || live.status !== "active" || live.online[color].size > 0) return;
    io.to(`game:${gameId}`).emit("opponent:disconnected", {
      color,
      graceMs: Math.max(0, GRACE_MS - settleMs),
    });
  };
  if (settleMs > 0) room.notices[color] = setTimeout(() => safely("absence notice", announce), settleMs);
  else announce();
}

// A fresh game has nobody in it yet. Both players are expected within the
// grace period, so the absence clock runs against each until they arrive (all
// four in a four-player game), and
// a game nobody turns up for aborts (no move was played) instead of sitting
// 'active' for ever — which, with one game at a time, would lock both players
// out. The notice to whoever did arrive waits long enough for a normal page
// load, so an opponent who is merely a few seconds behind is never reported.
const JOIN_SETTLE_MS = 10000;
matchmaking.onMatchStarted((io, gameId) => {
  const room = rooms.getRoom(gameId);
  if (!room) return;
  for (const c of room.colors) armAbsence(io, room, c, JOIN_SETTLE_MS);
});

function handleGameJoin(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  if (!gameId) return reply(ack, { ok: false, error: "Missing gameId." });

  let room = rooms.getRoom(gameId);
  if (!room) {
    // Rebuilding registers live state and may abort a corrupt record. Only a
    // participant may trigger those effects; rejected joins must not shelter
    // an unresumed game from the restart sweep.
    const game = queries.getGameById.get(gameId);
    if (!game || game.mode !== "pvp") return reply(ack, { ok: false, error: "Game not found." });
    if (!seatedIn(game, socket.userId)) {
      return reply(ack, { ok: false, error: "You are not a player in this game." });
    }
    room = rooms.loadRoomFromDb(gameId);
  }
  if (!room) {
    const g = queries.getGameById.get(gameId);
    const damaged = !!g && g.termination === "corrupt-record";
    if (damaged) lobby.refresh(io); // the "playing" badges must not linger
    return reply(ack, {
      ok: false,
      error: damaged ? "This game's record could not be replayed, so it was aborted." : "Game not found.",
    });
  }

  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });

  socket.join(`game:${gameId}`);
  socket.join(chatRoom(gameId, "players"));
  socket.gameId = gameId;
  socket.gameColor = color;

  // A game that is over has nothing live about it. Hand back its final state
  // for the result screen (the socket stays in the game's rooms for post-game
  // chat and the rematch offer) but keep no room for it: only concludeGame
  // ever deletes rooms, and for this game it has already run.
  if (room.status !== "active") {
    const state = stateOf(room, color);
    // A Bughouse board was rebuilt with its partner board: drop both.
    for (const r of rooms.matchRooms(room) || [room]) rooms.deleteRoom(r.gameId);
    return reply(ack, { ok: true, state });
  }

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
  // player back starts the forfeit clock against those who haven't returned.
  // Without this a restart would leave the game hanging for ever when the
  // opponent simply closed their tab.
  if (room.rehydrated) {
    for (const c of room.colors) if (c !== color) armAbsence(io, room, c, REJOIN_SETTLE_MS);
  }
  // A Bughouse board brings its partner board back with it, which nobody may
  // ever rejoin: run the same clock against both of its players.
  if (room.rehydrated && room.matchId) {
    const partnerRoom = (rooms.matchRooms(room) || [])[1 - room.board];
    if (partnerRoom) for (const c of ["w", "b"]) armAbsence(io, partnerRoom, c, REJOIN_SETTLE_MS);
  }

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
  const members = new Set(queries.listMemberIds.all().map((r) => r.id));
  return {
    gameId: room.gameId,
    fen: room.chess.fen(),
    sans: room.sans.slice(),
    // The moves as played (castling by the rook square), so a client can
    // rebuild the position by replaying them: a FEN loses the repetition
    // history, and cannot always say which rook a Chess960 castling right means.
    moves: room.chess.history.map((h) => (room.four ? FourPlayer.moveText(h.move) : formatUci(h.move))),
    yourColor: color,
    turn: room.chess.turn,
    status: room.status,
    result: room.result || null,
    termination: room.termination || null,
    // Who plays: White and Black, or a four-player game's seats, each colour's
    // { id, name, member } in turn order.
    ...(room.four
      ? { seats: Object.fromEntries(room.colors.map((c) => [c, {
        id: room.players[c], name: room.names[c], member: members.has(room.players[c]),
      }])) }
      : {
        white: room.names.w,
        black: room.names.b,
        whiteId: room.players.w,
        blackId: room.players.b,
        whiteMember: members.has(room.players.w),
        blackMember: members.has(room.players.b),
      }),
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
    // Bughouse: the match, this board, both boards' game ids, and (for a
    // player) their team. Null for every other game.
    match: room.matchId
      ? { id: room.matchId, board: room.board, boards: room.boardIds, team: color ? Bughouse.teamOf(room.board, color) : null }
      : null,
    // Bughouse: the other board as it stands, for the small board beside this
    // one (kept current by bughouse:partner).
    partner: room.matchId ? partnerView(room) : null,
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
  // A four-player game's players speak as their team's side, 'w' or 'b'.
  const seat = game.variant === fourGames.VARIANT ? fourGames.colorIn(gameId, socket.userId) : null;
  const role = game.white_id === socket.userId ? "w"
    : game.black_id === socket.userId ? "b"
      : seat ? FourPlayer.sideOf(seat) : "s";

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
  // Moves come from a player who has taken their seat (sent game:join at least
  // once). Judged per player, not per socket: a client reconnecting after a
  // blip flushes a buffered move before its connect handler re-joins, and that
  // move is good. A player who never joined has no seat, and the clock would
  // never start running against them.
  if (!room.everJoined[color]) return reply(ack, { ok: false, error: "Join the game first." });

  // (2) Turn enforcement.
  if (room.chess.turn !== color) return reply(ack, { ok: false, error: "Not your turn." });

  // (3) Legality — match against the server's own legal moves. Never trust client.
  // A Crazyhouse drop comes as { drop, to } and has no square it leaves. An
  // infinite-chess move comes as { from: { x, y }, to: { x, y }, promo }, and
  // its shape is checked before the engine sees it at all.
  const { from, to, promo, drop } = payload || {};
  if (room.variant === "infinite" && !isInfiniteMove(payload)) {
    return reply(ack, { ok: false, error: "Illegal move." });
  }
  if (room.four && !isFourMove(payload)) return reply(ack, { ok: false, error: "Illegal move." });
  const move = drop ? room.chess.findDrop(drop, to) : room.chess.findMove(from, to, promo);
  if (!move) return reply(ack, { ok: false, error: "Illegal move." });

  playMove(io, room, color, move, {
    byUser: socket.userId, premove: !!(payload && payload.premove), from, to, ack,
  });
}

// Play a legal move for `color` — a player's (handleMove), or LorFish's in a
// Bughouse seat (bots, below) — on the room's board: charge the clock, record
// it, pass a capture to the other board, tell everyone, and end the game if it
// is over. `from`/`to` are the squares as the player sent them (castling may
// be spelled by the rook's square), echoed back so their board applies it the
// same way; a bot sends none, and the move's own are used.
function playMove(io, room, color, move, { byUser, premove: claimed, from, to, ack }) {
  const gameId = room.gameId;

  // (3b) Clock: charge the mover for their think time; flag if they're out.
  let thinkMs = null;
  const clockBefore = { ms: room.clock[color], turnStartedAt: room.turnStartedAt };
  if (room.started) {
    const now = Date.now();
    thinkMs = now - room.turnStartedAt;
    const remaining = room.clock[color] - thinkMs;
    if (remaining <= 0) {
      room.clock[color] = 0;
      reply(ack, { ok: false, error: "Out of time." });
      return concludeGame(io, room, flagResult(room, color), "timeout");
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
  const uci = room.four ? FourPlayer.moveText(move) : formatUci(move);

  // (5) Persist + (6) broadcast (mover included; everyone applies on confirmation).
  // The client says whether this was a premove; believe it only if the move
  // really did arrive on the heels of the opponent's, so a crafted payload
  // can't claim a premove it had time to think about.
  const premove = !!claimed && (thinkMs == null || thinkMs < PREMOVE_MAX_MS);
  try {
    persistMove(room, ply, san, uci, fen, byUser, thinkMs, premove);
  } catch (err) {
    // The database refused the move, so the room must not have it either: put
    // the board and the clock back exactly as they were, then let the
    // connection handler log the failure and fail the acknowledgement.
    room.chess.undoMove();
    room.sans.pop();
    room.clock[color] = clockBefore.ms;
    room.turnStartedAt = clockBefore.turnStartedAt;
    throw err;
  }

  // Bughouse: what this move captured goes to the partner on the other board,
  // now that the move is recorded. Nothing is stored for it: a restart passes
  // it again by replaying both boards in order. Only the other board's shown
  // position (its pockets) is written, and its players and watchers are told.
  const passed = room.matchId ? room.chess.history[room.chess.history.length - 1].passed || null : null;
  if (passed) {
    const partnerRoom = (rooms.matchRooms(room) || [])[1 - room.board];
    if (partnerRoom) {
      partnerRoom.chess.receive(passed.c, passed.t);
      const partnerFen = partnerRoom.chess.fen();
      queries.updateGamePosition.run(partnerFen, partnerRoom.chess.turn, partnerRoom.gameId);
      io.to(`game:${partnerRoom.gameId}`).emit("bughouse:received", { piece: passed, fen: partnerFen });
      // This board's audience sees the other board's pockets change.
      tellPartner(io, room);
      // A LorFish there waiting for a piece may have a move now.
      botTurn(io, partnerRoom);
    }
  }

  // An outstanding draw offer lapses as soon as a move is played.
  if (room.drawOffer) {
    room.drawOffer = null;
    io.to(`game:${gameId}`).emit("draw:cleared");
  }

  reply(ack, { ok: true });
  // The move as the server resolved it, not as sent: a drop leaves no square,
  // a promotion letter only goes out on a promotion, and infinite-chess
  // squares are the engine's own objects, not whatever the client's carried,
  // and a four-player square is the engine's number even if sent as a name.
  const coords = typeof move.from === "object" && move.from !== null;
  const own = room.four || from === undefined;
  io.to(`game:${gameId}`).emit("move:made", {
    from: move.drop ? null : coords ? { x: move.from.x, y: move.from.y } : own ? move.from : from,
    to: coords ? { x: move.to.x, y: move.to.y } : own ? move.to : to,
    promo: move.promo || null,
    drop: move.drop || null,
    san,
    fen,
    turn,
    ply,
    clocks: rooms.clockSnapshot(room),
    // Bughouse: the piece this capture sent to the other board.
    passed,
  });

  lobby.nudge(io); // keep the lobby's board previews roughly current
  // Bughouse: the other board's audience sees this move on its small board.
  if (room.matchId) {
    const partnerRoom = (rooms.matchRooms(room) || [])[1 - room.board];
    if (partnerRoom) tellPartner(io, partnerRoom);
  }

  // (7) Game over? Otherwise re-arm the flag timer for the new side to move,
  // which may be a LorFish's.
  if (room.chess.isGameOver()) {
    concludeGame(io, room, room.chess.result(), terminationOf(room.chess));
  } else {
    scheduleFlag(io, room);
    botTurn(io, room);
  }
}

// ---- Bughouse: the other board, and calls to a partner ----

// The board beside `room`'s in its match, as its players and watchers see it:
// the position (pockets and all), who plays it, its clocks, and the last move.
function partnerView(room) {
  const other = (rooms.matchRooms(room) || [])[1 - room.board];
  if (!other) return null;
  const last = other.chess.history[other.chess.history.length - 1];
  return {
    gameId: other.gameId,
    board: other.board,
    fen: other.chess.fen(),
    turn: other.chess.turn,
    white: other.names.w,
    black: other.names.b,
    clocks: rooms.clockSnapshot(other),
    running: other.started && other.status === "active",
    lastMove: last ? { from: last.move.drop ? null : last.move.from, to: last.move.to } : null,
    san: other.sans[other.sans.length - 1] || null,
  };
}

// Tell `room`'s players and watchers how the other board now stands.
function tellPartner(io, room) {
  if (!room.matchId) return;
  const view = partnerView(room);
  if (view) io.to(`game:${room.gameId}`).emit("bughouse:partner", view);
}

// A call to your partner (one of Bughouse.CALLS): passed on live to them
// alone — every tab they have open — and never stored or logged. A LorFish
// partner doesn't listen. Rate-limited like chat.
function handleBughouseCall(io, socket, payload, ack) {
  const gameId = Number(payload && payload.gameId);
  const room = rooms.getRoom(gameId);
  if (!room || !room.matchId || room.status !== "active") return reply(ack, { ok: false, error: "No match to call in." });
  const color = colorOf(room, socket.userId);
  if (!color) return reply(ack, { ok: false, error: "You are not a player in this game." });
  const call = payload && payload.call;
  if (!Bughouse.callText(call)) return reply(ack, { ok: false, error: "Unknown call." });
  const now = Date.now();
  socket.callTimes = (socket.callTimes || []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (socket.callTimes.length >= CHAT_BURST) return reply(ack, { ok: false, error: "Slow down a little." });
  socket.callTimes.push(now);
  const seat = Bughouse.partnerOf(room.board, color);
  const partnerRoom = (rooms.matchRooms(room) || [])[seat.board];
  const partnerId = partnerRoom && partnerRoom.players[seat.color];
  if (partnerRoom && !(partnerRoom.bots && partnerRoom.bots[seat.color])) {
    io.to(matchmaking.userRoom(partnerId)).emit("bughouse:call", {
      gameId: partnerRoom.gameId, from: socket.username, call,
    });
  }
  reply(ack, { ok: true });
}

// A Bughouse match against LorFish: the player on board 0 with White, LorFish
// their partner on board 1, and two more LorFish for the other team, at a time
// control and a LorFish level from the allowlists. Until the lobby seats four
// people, the way into Bughouse.
function handleBughouseBots(io, socket, payload, ack) {
  if (rooms.liveGameOf(socket.userId)) return reply(ack, { ok: false, error: "Finish your current game first." });
  const tc = resolveTimeControl((payload && payload.tc) || DEFAULT_TC);
  const level = resolveAiLevel(payload && payload.level);
  const ai = queries.getUserByUsername.get(config.AI_USERNAME);
  const bot = { userId: ai.id, username: ai.username };
  const me = { userId: socket.userId, username: socket.username };
  const { matchId, boards } = matchmaking.startBughouse(io, { teamA: [me, bot], teamB: [bot, bot] },
    { initialMs: tc.initialMs, incrementMs: tc.incrementMs, botLevel: level });
  reply(ack, { ok: true, matchId, gameId: boards[0] });
}

// ---- LorFish in Bughouse seats ----
// A seat held by the reserved LorFish account (room.bots) is played by the
// server: whenever it is that seat's turn and the clock runs, the position goes
// to a worker thread (bots.js) and the move that comes back is played through
// playMove like anyone's. A bot is always present, so no absence clock ever
// runs against it. With no move it waits, as a player would, until a piece
// arrives from the other board (playMove calls back here). Its clock runs
// while it thinks. The position can't change under it meanwhile — it is its
// turn, and pockets only fill — but the game can end, and then the answer is
// dropped.
function botTurn(io, room) {
  if (!room.bots || room.status !== "active" || !room.started) return;
  const color = room.chess.turn;
  if (!room.bots[color] || room.botThinking) return;
  if (room.chess.legalMoves().length === 0) return; // waiting for a piece
  room.botThinking = true;
  const level = aiLevelOf(room.botLevel);
  bots.think({
    variant: room.variant,
    fen: room.chess.fen(),
    depth: Math.min(level.depth, config.BOT_MAX_DEPTH),
    temperature: level.temperature,
  }).then((answer) => safely("bot move", () => {
    room.botThinking = false;
    const live = rooms.getRoom(room.gameId);
    if (live !== room || room.status !== "active" || room.chess.turn !== color || !answer) return;
    const move = answer.drop
      ? room.chess.findDrop(answer.drop, answer.to)
      : room.chess.findMove(answer.from, answer.to, answer.promo);
    if (!move) {
      log.error("bot.bad_move", { game: room.gameId, move: JSON.stringify(answer), fen: room.chess.fen() });
      return;
    }
    playMove(io, room, color, move, { byUser: null });
  }), (err) => {
    room.botThinking = false;
    log.error("bot.failed", { game: room.gameId, err });
  });
}

// ---- draw offers ----
// An offer is stored on the room as the offering colour. Offering while the
// opponent already has an offer outstanding counts as accepting it.
// Not in Bughouse or four-player chess for now: a draw there would need all
// four players' word.
function handleDrawOffer(io, socket, payload) {
  const gameId = Number(payload && payload.gameId) || socket.gameId;
  const room = rooms.getRoom(gameId);
  if (!room || room.status !== "active" || room.matchId || room.four) return;
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
  if (!room || room.status !== "active" || room.matchId || room.four) return;
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
  // A Bughouse or four-player rematch needs all four players, which this
  // two-player offer can't ask: not yet.
  if (!game || game.mode !== "pvp" || game.status === "active" || game.match_id) return;
  if (game.variant === fourGames.VARIANT) return;
  const uid = socket.userId;
  if (game.white_id !== uid && game.black_id !== uid) return;
  // One game at a time applies here too: a rematch accepted from another game
  // would drag its owner out of the one they are playing.
  if (rooms.liveGameOf(uid)) {
    return socket.emit("lobby:error", { error: "Finish your current game first." });
  }

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
    // The first offer may be old: its owner could have sat down to another
    // game since. Then there is no rematch, and both players hear why.
    const busy = [newWhite, newBlack].find((s) => rooms.liveGameOf(s.userId));
    if (busy) {
      const msg = { error: `${busy.username} is already in another game.` };
      newWhite.emit("lobby:error", msg);
      newBlack.emit("lobby:error", msg);
      return;
    }
    const newGameId = matchmaking.startMatch(io, newWhite, newBlack, {
      initialMs: game.initial_ms,
      incrementMs: game.increment_ms,
      rated: !!game.rated,
      // A Chess960 rematch draws a new position rather than repeating the old.
      variant: game.variant || "standard",
      // An odds game keeps its odds, mirrored to follow the colour swap.
      startFen: rematchStartFen(game),
    });
    log.info("game.rematch", { game: gameId, new_game: newGameId });
    return newGameId;
  }
  socket.to(`game:${gameId}`).emit("rematch:offered", { username: socket.username });
}

// The start position for a rematch. Odds are given by a player, not by a
// colour, so with the colours swapped the same terms mean the handicap mirrored
// onto the other side. null for an ordinary game, and for variants that don't
// start from the standard setup (Chess960 draws afresh).
function rematchStartFen(game) {
  if (!usesStandardSetup(game.variant || "standard")) return null;
  const changes = handicap.diffFromFen(game.start_fen);
  if (!changes || !Object.keys(changes).length) return null;
  return handicap.buildFen(handicap.mirror(changes));
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
  // Before the first move there is nothing to concede: this is an abort, as
  // when a player never turns up, never a rated loss for a game not played.
  if (pliesPlayed(room) === 0) return concludeGame(io, room, "*", "aborted");
  // How long after the opponent's last move the resignation came (the "Rage
  // Quit" achievement wants to know). Only meaningful once the clock runs.
  room.resignReactionMs =
    room.started && room.turnStartedAt != null && room.chess.turn === color
      ? Date.now() - room.turnStartedAt
      : null;
  concludeGame(io, room, lossFor(room, color), "resign");
}

function handleDisconnect(io, socket, reason) {
  matchmaking.leave(socket);
  lobby.onDisconnect(io, socket);
  clearRematchOffers(socket);
  leaveWatching(io, socket);
  socket.log.info("socket.disconnect", { reason });

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

  // Nothing to forfeit if no move was played — or if this player never took
  // their seat: the other side may have moved while waiting, but a game one
  // player never saw was not played. A room rebuilt after a restart has nobody
  // marked as joined, so there the games row answers instead: the clock only
  // ever started once both had joined.
  const neverCame = !room.everJoined[color] && !(room.rehydrated && room.clockStarted);
  if (pliesPlayed(room) === 0 || neverCame) concludeGame(io, room, "*", "aborted");
  else concludeGame(io, room, lossFor(room, color), "disconnect");
}

// An infinite-chess move payload: two squares, each exactly { x, y } in whole
// numbers within the board's limit, and a promotion that is a piece or
// nothing. No drop, no extra fields riding along.
function isInfiniteMove(payload) {
  const square = (s) =>
    !!s && typeof s === "object" && !Array.isArray(s) &&
    Object.keys(s).length === 2 &&
    [s.x, s.y].every((n) => Number.isInteger(n) && Math.abs(n) <= InfiniteChess.LIMIT);
  const p = payload || {};
  return square(p.from) && square(p.to) && !p.drop &&
    (p.promo == null || InfiniteChess.PROMOTIONS.includes(p.promo));
}

// A four-player move payload: two squares, each the engine's number (0-195)
// or a name ("e2"), and a promotion that is a piece or nothing. No drop. The
// engine's findMove decides the rest, a corner's number included.
function isFourMove(payload) {
  const square = (s) => (typeof s === "string" ? FourPlayer.squareOf(s) >= 0 : Number.isInteger(s));
  const p = payload || {};
  return square(p.from) && square(p.to) && !p.drop &&
    (p.promo == null || FourPlayer.PROMOTIONS.includes(p.promo));
}

// How the game ended — the engine says (Chess.termination), so the server
// and the game page name each ending the same way.
function terminationOf(chess) {
  return chess.termination();
}

module.exports = { attachSockets };
