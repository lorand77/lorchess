"use strict";

// The socket.* and game.* lines a game leaves from connect to rematch, and
// what they must not hold (chat text). See "Logging" in docs/design.md.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, quickMatch, emitAck, waitFor,
} = require("../helpers/server");
const { captureLogs } = require("../helpers/logs");
const { sq } = require("../helpers/board");

const mv = (from, to) => ({ from: sq(from), to: sq(to), promo: null });

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("a game from connect to rematch, as the log tells it", async (t) => {
  const logs = captureLogs();
  t.after(() => logs.restore());
  const alice = await registerUser(srv.baseUrl, "lg_alice");
  const bob = await registerUser(srv.baseUrl, "lg_bob");
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());

  const connect = await logs.waitFor("socket.connect", { user: alice.user.id });
  assert.equal(connect.fields.name, alice.user.username);

  const { gameId, white, black } = await quickMatch(a, b, { tc: "5+0" });
  const start = logs.find("game.start", { game: gameId });
  assert.equal(start.fields.tc, "5+0");
  assert.equal(start.fields.rated, "true");
  assert.equal(start.fields.variant, "standard");
  const whiteUser = white === a ? alice.user : bob.user;
  assert.equal(start.fields.white, String(whiteUser.id));
  assert.equal(start.fields.white_name, whiteUser.username);

  await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  assert.equal((await emitAck(white, "chat:send", { gameId, text: "good luck, have fun" })).ok, true);
  assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
  const over = waitFor(white, "game:over");
  black.emit("game:resign", { gameId });
  await over;
  const ended = logs.find("game.over", { game: gameId });
  assert.equal(ended.fields.result, "1-0");
  assert.equal(ended.fields.termination, "resign");

  const next = waitFor(white, "game:start");
  white.emit("rematch:offer", { gameId });
  black.emit("rematch:offer", { gameId });
  const { gameId: newGameId } = await next;
  assert.ok(logs.find("game.rematch", { game: gameId, new_game: newGameId }));
  assert.ok(logs.find("game.start", { game: newGameId }));

  a.close();
  const left = await logs.waitFor("socket.disconnect", { user: alice.user.id });
  assert.equal(left.fields.reason, "client namespace disconnect");

  assert.equal(JSON.stringify(logs.lines).includes("good luck"), false, "chat text is never logged");
  for (const line of logs.lines) {
    if (!line.event.startsWith("auth.")) assert.equal("ip" in line.fields, false, line.event);
  }
});
