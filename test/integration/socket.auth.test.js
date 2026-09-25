"use strict";

// Session revocation must cover live game connections, every tab sharing the
// cookie, and handshakes that began before logout. Separate logins stay valid.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, client, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const { Manager } = require("socket.io-client");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

async function game(t) {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  t.after(() => { a.close(); b.close(); });
  const match = await quickMatch(a, b);
  assert.equal((await emitAck(a, "game:join", { gameId: match.gameId })).ok, true);
  assert.equal((await emitAck(b, "game:join", { gameId: match.gameId })).ok, true);
  return { ...match, player: match.white === a ? alice : bob };
}

const firstMove = (gameId) => ({ gameId, from: sq("e2"), to: sq("e4") });
const moves = (gameId) => db().prepare("SELECT uci FROM moves WHERE game_id = ? ORDER BY ply").all(gameId);

test("logout disconnects all session tabs and prevents further game moves", async (t) => {
  const { gameId, white, black, player } = await game(t);
  const cookie = player.c.cookie();
  const tab = await connectSocket(srv.baseUrl, cookie);
  t.after(() => tab.close());
  assert.equal((await emitAck(tab, "game:join", { gameId })).ok, true);

  const [out, reason, tabReason, absence] = await Promise.all([
    player.c.post("/api/logout"),
    waitFor(white, "disconnect"),
    waitFor(tab, "disconnect"),
    waitFor(black, "opponent:disconnected"),
  ]);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.equal(player.c.cookie(), undefined);
  assert.equal(reason, "io server disconnect");
  assert.equal(tabReason, "io server disconnect");
  assert.equal(absence.color, "w");
  assert.equal(black.connected, true);
  assert.equal(rooms.getRoom(gameId).online.w.size, 0);
  assert.ok(rooms.getRoom(gameId).timers.w, "normal disconnect grace applies");

  white.emit("move:make", firstMove(gameId));
  tab.emit("move:make", firstMove(gameId));
  const state = await emitAck(black, "game:join", { gameId });
  assert.deepEqual(state.state.sans, []);
  assert.deepEqual(moves(gameId), []);

  const stale = client(srv.baseUrl);
  stale.setCookie("connect.sid", cookie);
  assert.equal((await stale.get("/api/me")).status, 401);
  await assert.rejects(connectSocket(srv.baseUrl, cookie), /unauthorized/);
});

test("logout preserves an independent login for the same player", async (t) => {
  const { gameId, white, black, player } = await game(t);
  const other = client(srv.baseUrl);
  assert.equal((await other.post("/api/login", {
    username: player.user.username, password: player.password,
  })).status, 200);
  const device = await connectSocket(srv.baseUrl, other.cookie());
  t.after(() => device.close());
  assert.equal((await emitAck(device, "game:join", { gameId })).ok, true);

  const [out] = await Promise.all([player.c.post("/api/logout"), waitFor(white, "disconnect")]);
  assert.equal(out.status, 200);
  assert.equal(device.connected, true);
  assert.equal(black.connected, true);
  assert.equal((await other.get("/api/me")).status, 200);
  assert.equal(rooms.getRoom(gameId).online.w.size, 1);
  assert.equal(rooms.getRoom(gameId).timers.w, null);
  assert.deepEqual(await emitAck(device, "move:make", firstMove(gameId)), { ok: true });
  assert.deepEqual(moves(gameId), [{ uci: "e2e4" }]);
});

test("a session that expires on an open connection cannot make a move", async (t) => {
  const { gameId, white, black } = await game(t);
  const sid = srv.io.sockets.sockets.get(white.id).request.sessionID;
  db().prepare("UPDATE sessions SET expire = ? WHERE sid = ?").run("2000-01-01T00:00:00.000Z", sid);
  const disconnected = waitFor(white, "disconnect");
  white.emit("move:make", firstMove(gameId));
  assert.equal(await disconnected, "io server disconnect");
  assert.equal(black.connected, true);
  assert.deepEqual(moves(gameId), []);
});

test("logout between the transport handshake and socket connect rejects the stale session", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "late");
  const manager = new Manager(srv.baseUrl, {
    autoConnect: false, transports: ["websocket"], reconnection: false,
    extraHeaders: { Cookie: `connect.sid=${c.cookie()}` },
  });
  const socket = manager.socket("/");
  t.after(() => { socket.close(); manager.engine.close(); });
  const opened = waitFor(manager, "open");
  manager.open();
  await opened;
  assert.equal((await c.post("/api/logout")).status, 200);
  const result = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.connect();
  await assert.rejects(result, /unauthorized/);
});

test("regenerating a login disconnects sockets authenticated by the old session", async (t) => {
  const { c, user, password } = await registerUser(srv.baseUrl, "renew");
  const cookie = c.cookie();
  const socket = await connectSocket(srv.baseUrl, cookie);
  t.after(() => socket.close());
  const [login, reason] = await Promise.all([
    c.post("/api/login", { username: user.username, password }),
    waitFor(socket, "disconnect"),
  ]);
  assert.equal(login.status, 200);
  assert.equal(reason, "io server disconnect");
  assert.notEqual(c.cookie(), cookie);
  await assert.rejects(connectSocket(srv.baseUrl, cookie), /unauthorized/);
  const fresh = await connectSocket(srv.baseUrl, c.cookie());
  t.after(() => fresh.close());
  assert.equal((await fresh.welcome).userId, user.id);
});

test("logout reports a store failure instead of claiming the session was revoked", async (t) => {
  const { c } = await registerUser(srv.baseUrl, "failure");
  const cookie = c.cookie();
  const socket = await connectSocket(srv.baseUrl, cookie);
  t.after(() => socket.close());
  const store = srv.io.sockets.sockets.get(socket.id).request.sessionStore;
  t.mock.method(store, "destroy", (_sid, callback) => callback(new Error("write failed")));
  t.mock.method(console, "error", () => {});
  const out = await c.post("/api/logout");
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: "Logout failed." });
  assert.equal(c.cookie(), cookie);
  assert.equal((await c.get("/api/me")).status, 200);
  assert.equal(socket.connected, true);
});
