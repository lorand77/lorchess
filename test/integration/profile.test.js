"use strict";

// What a visitor can see on someone else's profile: their games (and the
// replay of any that are over) and their friends — read-only, and never their
// pending friend requests or a game still being played.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { recordGame, lorfishId } = require("../helpers/games");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let srv, alice, bob, carol, finishedId, activeId;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
  finishedId = recordGame({
    white: alice.user.id, black: bob.user.id,
    moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate",
  });
  activeId = recordGame({ white: alice.user.id, black: bob.user.id, moves: ["e2e4"] });

  // alice and bob are friends; alice has asked carol, who hasn't answered.
  const req = await alice.c.post("/api/friends/requests", { toUserId: bob.user.id });
  assert.equal((await bob.c.post(`/api/friends/requests/${req.body.id}/accept`)).status, 200);
  assert.equal((await alice.c.post("/api/friends/requests", { toUserId: carol.user.id })).status, 201);
});
after(async () => { await srv.close(); });

test("another player's games are listed, finished and in progress", async () => {
  const res = await carol.c.get(`/api/games/user/${alice.user.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((g) => g.id), [activeId, finishedId], "newest first");
  assert.equal(res.body[1].white_username, alice.user.username);
  assert.equal(res.body[1].black_username, bob.user.username);
});

test("a finished game can be replayed by anyone; a live one only by its players", async () => {
  const replay = await carol.c.get(`/api/games/${finishedId}`);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.moves.map((m) => m.uci), ["f2f3", "e7e5", "g2g4", "d8h4"]);

  const live = await carol.c.get(`/api/games/${activeId}`);
  assert.equal(live.status, 403);
  assert.equal((await alice.c.get(`/api/games/${activeId}`)).status, 200, "its players still can");
});

test("reading someone's game does not let you change it", async () => {
  assert.equal((await carol.c.post(`/api/games/${finishedId}/end`, { result: "1-0" })).status, 403);
  assert.equal((await carol.c.post(`/api/games/${finishedId}/truncate`, { toPly: 0, fen: START_FEN })).status, 403);
  assert.equal((await alice.c.get(`/api/games/${finishedId}`)).body.result, "0-1");
});

test("another player's friends are listed, without their pending requests", async () => {
  const res = await carol.c.get(`/api/friends/user/${alice.user.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ["friends"]);
  assert.deepEqual(res.body.friends.map((f) => f.userId), [bob.user.id]);
  assert.equal(res.body.friends[0].username, bob.user.username);
});

test("another player's achievements are listed", async () => {
  const res = await carol.c.get(`/api/achievements/user/${alice.user.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, alice.user.id);
  assert.ok(Array.isArray(res.body.earned));
});

test("LorFish, unknown players and bad ids have no games, friends or achievements to show", async () => {
  for (const base of ["/api/games/user", "/api/friends/user", "/api/achievements/user"]) {
    assert.equal((await carol.c.get(`${base}/${lorfishId()}`)).status, 404, base);
    assert.equal((await carol.c.get(`${base}/999999`)).status, 404, base);
    assert.equal((await carol.c.get(`${base}/abc`)).status, 400, base);
    assert.equal((await carol.c.get(`${base}/0`)).status, 400, base);
  }
});
