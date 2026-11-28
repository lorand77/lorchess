"use strict";

// Shadow Chess over the socket: casual, from the standard setup, and the
// server refuses a move that lands on a shadow, the mover's own included,
// until its owner's next move has lifted it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, quickMatch, db } = require("../helpers/server");
const { sq } = require("../helpers/board");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

test("a move onto a shadow is refused until the shadow lifts", async () => {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "shadow" });
  const joined = await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  assert.equal(joined.state.variant, "shadow");
  assert.equal(db().prepare("SELECT rated FROM games WHERE id = ?").get(gameId).rated, 0, "casual");
  const move = (s, from, to) => emitAck(s, "move:make", { gameId, from: sq(from), to: sq(to) });

  assert.deepEqual(await move(white, "g1", "f3"), { ok: true });
  assert.deepEqual(await move(black, "g8", "f6"), { ok: true });
  assert.deepEqual(await move(white, "f3", "g1"), { ok: false, error: "Illegal move." }, "g1 is still White's shadow");
  assert.deepEqual(await move(white, "e2", "e4"), { ok: true });
  assert.deepEqual(await move(black, "f6", "g8"), { ok: false, error: "Illegal move." }, "and g8 Black's");
  assert.deepEqual(await move(black, "b8", "c6"), { ok: true });
  assert.deepEqual(await move(white, "f3", "g1"), { ok: true }, "lifted by White's e4");
  a.close();
  b.close();
});
