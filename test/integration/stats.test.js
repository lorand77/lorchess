"use strict";

// Stats are visible to every signed-in player, not just their owner.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { lorfishId, recordGame } = require("../helpers/games");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

test("your own stats say they are yours", async () => {
  const res = await alice.c.get("/api/stats");
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, alice.user.id);
  assert.equal(res.body.you, true);

  const byId = await alice.c.get(`/api/stats/${alice.user.id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.you, true);
});

test("another player's stats are readable, and say they aren't yours", async () => {
  const res = await alice.c.get(`/api/stats/${bob.user.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, bob.user.id);
  assert.equal(res.body.user.username, bob.user.username);
  assert.equal(res.body.you, false);
  assert.ok(res.body.games && res.body.puzzles);
});

test("LorFish is not a player and has no stats", async () => {
  const res = await alice.c.get(`/api/stats/${lorfishId()}`);
  assert.equal(res.status, 404);
});

test("unknown and malformed ids", async () => {
  assert.equal((await alice.c.get("/api/stats/999999")).status, 404);
  assert.equal((await alice.c.get("/api/stats/abc")).status, 400);
  assert.equal((await alice.c.get("/api/stats/0")).status, 400);
});

test("the record against LorFish is broken down by level, weakest first", async () => {
  const carol = await registerUser(srv.baseUrl, "carol");
  const me = carol.user.id;
  const ai = lorfishId();
  const vsAi = (aiLevel, result, aiDepth = null) =>
    recordGame({ white: me, black: ai, mode: "ai", aiColor: "b", aiLevel, aiDepth, result, termination: "resign", rated: 0 });
  vsAi("advanced", "0-1");
  vsAi("casual", "1-0");
  vsAi("casual", "1/2-1/2");
  vsAi(null, "1-0", 3); // from before levels, at a depth that matched none
  recordGame({ white: me, black: bob.user.id, result: "1-0", termination: "resign" });

  const { games } = (await carol.c.get("/api/stats")).body;
  assert.equal(games.ai.played, 4);
  assert.deepEqual(
    games.aiByLevel.map((r) => [r.level, r.played, r.wins, r.losses, r.draws]),
    [["casual", 2, 1, 0, 1], ["advanced", 1, 0, 1, 0], [null, 1, 1, 0, 0]]
  );
  assert.equal(games.aiByLevel[0].winRate, 50);
});
