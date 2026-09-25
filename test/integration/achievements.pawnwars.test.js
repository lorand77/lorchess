"use strict";

// Pawn Wars has no kings. Live achievement evaluation and the backfill must
// both replay its positions under that variant and still award player stats.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { startServer, registerUser, connectSocket, quickMatch, emitAck, waitFor, db } = require("../helpers/server");

test("a finished Pawn Wars game awards both players live and survives backfill", async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await registerUser(srv.baseUrl, "pawn_a");
  const b = await registerUser(srv.baseUrl, "pawn_b");
  const sa = await connectSocket(srv.baseUrl, a.c.cookie());
  const sb = await connectSocket(srv.baseUrl, b.c.cookie());
  const { gameId, white, black } = await quickMatch(sa, sb, { variant: "pawnwars" });
  assert.equal((await emitAck(white, "game:join", { gameId })).ok, true);
  assert.equal((await emitAck(black, "game:join", { gameId })).ok, true);
  assert.deepEqual(await emitAck(white, "move:make", { gameId, from: 0, to: 8 }), { ok: true });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const over = waitFor(white, "game:over");
  black.emit("game:resign", { gameId });
  assert.equal((await over).result, "1-0");
  assert.deepEqual(errors, []);
  const row = db().prepare("SELECT * FROM games WHERE id = ?").get(gameId);
  const keys = (id) => db().prepare("SELECT key FROM user_achievements WHERE user_id = ?").all(id).map(r => r.key);
  assert.ok(keys(row.white_id).includes("wins"));
  assert.ok(keys(row.white_id).includes("games_played"));
  assert.ok(keys(row.black_id).includes("games_played"));

  db().prepare("DELETE FROM user_achievements WHERE user_id IN (?, ?)").run(a.user.id, b.user.id);
  const backfill = spawnSync(process.execPath, ["src/achievements/backfill.js"], {
    cwd: path.resolve(__dirname, "../.."), env: process.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(backfill.status, 0, backfill.stderr);
  assert.match(backfill.stdout, /Replayed 1 finished game/);
  assert.ok(keys(row.white_id).includes("wins"));
  assert.ok(keys(row.black_id).includes("games_played"));
});
