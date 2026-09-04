"use strict";

// The live lobby: who is online, what games are on offer, and who is
// challenging whom. All state is in-memory and deliberately so — a seek or a
// challenge is only meaningful while both parties hold an open socket, so
// nothing here outlives a restart and nothing needs a table.
//
// Two kinds of offer, differing only in who may accept:
//   seek      — open to the room; the first taker gets the game.
//   challenge — addressed to one user; only that user may accept.
//
// The client is never trusted for the clock: `tc` is a key into the shared
// time-control allowlist, and the resolved milliseconds are what get stored.

const queries = require("../db/queries");
const matchmaking = require("./matchmaking");
const { resolveTimeControl } = require("../shared/timeControls");

const LOBBY_ROOM = "lobby";

// userId -> { userId, username, rating, sockets: Map<socketId, socket> }
const presence = new Map();
// seekId -> { id, userId, username, rating, tc, rated, color, socketId }
const seeks = new Map();
// challengeId -> { id, fromId, fromName, fromRating, toId, toName, tc, rated, color }
const challenges = new Map();

let nextId = 1;
const genId = () => String(nextId++);

// A user may hold at most one open seek — creating a second replaces the first,
// so the list can't be flooded from one account.
function seekOf(userId) {
  for (const s of seeks.values()) if (s.userId === userId) return s;
  return null;
}

// ---- presence ----

// Presence follows the SOCKET, not the lobby page: someone who has walked into
// a game still belongs in the list, marked "playing", rather than blinking out
// of existence. Called for every authenticated connection.
function connected(io, socket) {
  if (socket.userId == null) return;

  let entry = presence.get(socket.userId);
  if (!entry) {
    const user = queries.getUserById.get(socket.userId);
    entry = {
      userId: socket.userId,
      username: socket.username,
      rating: user ? user.rating : 1200,
      sockets: new Map(),
    };
    presence.set(socket.userId, entry);
  }
  entry.sockets.set(socket.id, socket);

  broadcastState(io);
  pushChallenges(io, socket.userId);
}

// Subscribe to lobby broadcasts. Presence is already established by connected();
// this only controls who receives the pushes.
function enter(io, socket) {
  if (socket.userId == null) return;
  socket.join(LOBBY_ROOM);
  socket.emit("lobby:state", snapshot());
  pushChallenges(io, socket.userId);
}

// Unsubscribe. NOT the same as going offline — the socket stays connected (it
// may be heading into a game), it just stops listening here.
function exit(io, socket) {
  socket.leave(LOBBY_ROOM);
}

function onDisconnect(io, socket) {
  removeSocket(io, socket);
}

function removeSocket(io, socket) {
  const entry = presence.get(socket.userId);
  if (!entry) return;
  entry.sockets.delete(socket.id);
  if (entry.sockets.size > 0) {
    broadcastState(io); // another tab is still here
    return;
  }
  // Last socket gone: the user is offline, so their offers die with them.
  presence.delete(socket.userId);
  dropOffersFor(io, socket.userId);
  broadcastState(io);
}

// Withdraw every seek and challenge involving a user who just went offline, so
// nobody can accept into a game the other side will never join.
function dropOffersFor(io, userId) {
  for (const [id, s] of seeks) if (s.userId === userId) seeks.delete(id);
  const touched = new Set();
  for (const [id, c] of challenges) {
    if (c.fromId !== userId && c.toId !== userId) continue;
    challenges.delete(id);
    touched.add(c.fromId === userId ? c.toId : c.fromId);
  }
  for (const other of touched) pushChallenges(io, other);
}

// Any socket belonging to a user (they may have several tabs open).
function socketFor(userId) {
  const entry = presence.get(userId);
  if (!entry) return null;
  for (const s of entry.sockets.values()) if (s.connected) return s;
  return null;
}

// ---- state broadcast ----

// The player list and the seek list are identical for everyone, so they go to
// the room as one payload. Challenges are per-user and travel separately.
function broadcastState(io) {
  io.to(LOBBY_ROOM).emit("lobby:state", snapshot());
}

function snapshot() {
  // One query, not one per player: both sides of every live PvP game.
  const busy = new Set();
  for (const row of queries.playersInLiveGames.all()) {
    busy.add(row.white_id);
    busy.add(row.black_id);
  }
  const players = [...presence.values()]
    .map((p) => ({
      userId: p.userId,
      username: p.username,
      rating: p.rating,
      playing: busy.has(p.userId),
    }))
    .sort((a, b) => b.rating - a.rating || a.username.localeCompare(b.username));

  const open = [...seeks.values()].map((s) => ({
    id: s.id,
    userId: s.userId,
    username: s.username,
    rating: s.rating,
    tc: s.tc,
    rated: s.rated,
    color: s.color,
  }));
  return { players, seeks: open };
}

// Send a user their own incoming/outgoing challenges, on every socket they have.
function pushChallenges(io, userId) {
  const entry = presence.get(userId);
  if (!entry) return;
  const mine = { incoming: [], outgoing: [] };
  for (const c of challenges.values()) {
    const view = {
      id: c.id,
      tc: c.tc,
      rated: c.rated,
      color: c.color,
      from: { userId: c.fromId, username: c.fromName, rating: c.fromRating },
      to: { userId: c.toId, username: c.toName },
    };
    if (c.toId === userId) mine.incoming.push(view);
    else if (c.fromId === userId) mine.outgoing.push(view);
  }
  for (const s of entry.sockets.values()) s.emit("challenge:list", mine);
}

// ---- offer validation ----

// Normalize whatever the client sent into something safe to store: the time
// control resolves against the allowlist, and colour is one of three literals.
function normalizeOffer(payload) {
  const p = payload || {};
  const tc = resolveTimeControl(p.tc);
  const color = p.color === "w" || p.color === "b" ? p.color : "random";
  return { tc: tc.key, rated: p.rated !== false, color };
}

// Turn the offering side's colour preference into concrete white/black sockets.
function assignColors(offerSocket, accepterSocket, color) {
  const offererIsWhite = color === "random" ? Math.random() < 0.5 : color === "w";
  return offererIsWhite
    ? { white: offerSocket, black: accepterSocket }
    : { white: accepterSocket, black: offerSocket };
}

function optsOf(offer) {
  const tc = resolveTimeControl(offer.tc);
  return { initialMs: tc.initialMs, incrementMs: tc.incrementMs, rated: offer.rated };
}

// ---- seeks ----

function createSeek(io, socket, payload) {
  if (socket.userId == null) return;
  const existing = seekOf(socket.userId);
  if (existing) seeks.delete(existing.id); // one open seek per user

  const offer = normalizeOffer(payload);
  const entry = presence.get(socket.userId);
  const seek = {
    id: genId(),
    userId: socket.userId,
    username: socket.username,
    rating: entry ? entry.rating : 1200,
    socketId: socket.id,
    ...offer,
  };
  seeks.set(seek.id, seek);
  broadcastState(io);
}

function cancelSeek(io, socket, payload) {
  const id = payload && payload.id;
  const seek = id ? seeks.get(id) : seekOf(socket.userId);
  if (!seek || seek.userId !== socket.userId) return; // only your own
  seeks.delete(seek.id);
  broadcastState(io);
}

function acceptSeek(io, socket, payload) {
  const seek = seeks.get(payload && payload.id);
  if (!seek) return socket.emit("lobby:error", { error: "That challenge is no longer open." });
  if (seek.userId === socket.userId) {
    return socket.emit("lobby:error", { error: "You can't accept your own challenge." });
  }
  const offerer = socketFor(seek.userId);
  if (!offerer) {
    seeks.delete(seek.id);
    broadcastState(io);
    return socket.emit("lobby:error", { error: "That player went offline." });
  }

  // Consume the seek (and the accepter's own, if any) before starting, so a
  // double-click can't produce two games.
  seeks.delete(seek.id);
  const own = seekOf(socket.userId);
  if (own) seeks.delete(own.id);

  const { white, black } = assignColors(offerer, socket, seek.color);
  matchmaking.startMatch(io, white, black, optsOf(seek));
  broadcastState(io);
}

// ---- direct challenges ----

function createChallenge(io, socket, payload) {
  const toId = Number(payload && payload.toUserId);
  if (!toId || toId === socket.userId) return;
  const target = presence.get(toId);
  if (!target) return socket.emit("lobby:error", { error: "That player is offline." });

  // One pending challenge per direction per pair — re-challenging replaces it.
  for (const [id, c] of challenges) {
    if (c.fromId === socket.userId && c.toId === toId) challenges.delete(id);
  }

  const offer = normalizeOffer(payload);
  const entry = presence.get(socket.userId);
  const challenge = {
    id: genId(),
    fromId: socket.userId,
    fromName: socket.username,
    fromRating: entry ? entry.rating : 1200,
    toId,
    toName: target.username,
    ...offer,
  };
  challenges.set(challenge.id, challenge);
  pushChallenges(io, challenge.fromId);
  pushChallenges(io, challenge.toId);
}

function acceptChallenge(io, socket, payload) {
  const c = challenges.get(payload && payload.id);
  if (!c) return socket.emit("lobby:error", { error: "That challenge has expired." });
  if (c.toId !== socket.userId) return; // only the addressee may accept
  const challenger = socketFor(c.fromId);
  if (!challenger) {
    challenges.delete(c.id);
    pushChallenges(io, c.toId);
    return socket.emit("lobby:error", { error: "That player went offline." });
  }
  challenges.delete(c.id);

  const { white, black } = assignColors(challenger, socket, c.color);
  matchmaking.startMatch(io, white, black, optsOf(c));
  pushChallenges(io, c.fromId);
  pushChallenges(io, c.toId);
  broadcastState(io);
}

function declineChallenge(io, socket, payload) {
  const c = challenges.get(payload && payload.id);
  if (!c || c.toId !== socket.userId) return;
  challenges.delete(c.id);
  const from = socketFor(c.fromId);
  if (from) from.emit("challenge:declined", { username: socket.username });
  pushChallenges(io, c.fromId);
  pushChallenges(io, c.toId);
}

function cancelChallenge(io, socket, payload) {
  const c = challenges.get(payload && payload.id);
  if (!c || c.fromId !== socket.userId) return; // only the sender may withdraw
  challenges.delete(c.id);
  pushChallenges(io, c.fromId);
  pushChallenges(io, c.toId);
}

// Called when a game ends so the lobby's "playing" badges refresh without
// waiting for someone to reconnect.
function refresh(io) {
  broadcastState(io);
}

module.exports = {
  connected,
  enter,
  exit,
  onDisconnect,
  createSeek,
  cancelSeek,
  acceptSeek,
  createChallenge,
  acceptChallenge,
  declineChallenge,
  cancelChallenge,
  refresh,
};
