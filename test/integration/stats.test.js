"use strict";

// Profiles are visible to every signed-in player, not just their owner.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { lorfishId } = require("../helpers/games");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

test("your own profile says it is yours", async () => {
  const res = await alice.c.get("/api/profile");
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, alice.user.id);
  assert.equal(res.body.you, true);

  const byId = await alice.c.get(`/api/profile/${alice.user.id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.you, true);
});

test("another player's profile is readable, and says it isn't yours", async () => {
  const res = await alice.c.get(`/api/profile/${bob.user.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, bob.user.id);
  assert.equal(res.body.user.username, bob.user.username);
  assert.equal(res.body.you, false);
  assert.ok(res.body.games && res.body.puzzles);
});

test("LorFish is not a player and has no profile", async () => {
  const res = await alice.c.get(`/api/profile/${lorfishId()}`);
  assert.equal(res.status, 404);
});

test("unknown and malformed ids", async () => {
  assert.equal((await alice.c.get("/api/profile/999999")).status, 404);
  assert.equal((await alice.c.get("/api/profile/abc")).status, 400);
  assert.equal((await alice.c.get("/api/profile/0")).status, 400);
});
