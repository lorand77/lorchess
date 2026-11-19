"use strict";

// Starred games (POST /api/games/:id/star, GET /api/games/starred): a user may
// star any game that is over, theirs or anyone's, up to the limit, and take
// the star off again. Stars are the user's alone: the game lists, the game
// itself and the starred list show each user only their own.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { recordGame, lorfishId, makeUser } = require("../helpers/games");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");
const { STAR_LIMIT } = require("../../src/game/routes");

const MATE = { moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate" };

let srv, alice, bob, carol;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
});
after(async () => { await srv.close(); });

const star = (who, id, starred = true) => who.c.post(`/api/games/${id}/star`, { starred });

// A finished four-player game between four made-up users.
function fourGame(variant = "fourplayer", result = "1-0") {
  const info = queries.createGame.run(null, null, "pvp", null, null, null, "four", "four", "w", 600000, 0, 0, variant);
  const id = Number(info.lastInsertRowid);
  for (const c of ["r", "b", "y", "g"]) queries.insertSeat.run(id, c, makeUser("four").id);
  queries.finishGame.run(result, "checkmate", id);
  return id;
}

describe("starring a game", () => {
  let own, others, live;
  before(() => {
    own = recordGame({ white: alice.user.id, black: bob.user.id, ...MATE });
    others = recordGame({ white: bob.user.id, black: carol.user.id, ...MATE });
    live = recordGame({ white: bob.user.id, black: carol.user.id, moves: ["e2e4"] });
  });

  test("your own game, and anyone's that is over; twice is once", async () => {
    assert.deepEqual((await star(alice, own)).body, { ok: true, starred: true });
    assert.deepEqual((await star(alice, others)).body, { ok: true, starred: true });
    assert.equal((await star(alice, others)).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_stars WHERE user_id = ?").get(alice.user.id).n, 2);
  });

  test("a game still being played waits until it is over; no such game is a 404", async () => {
    const r = await star(alice, live);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "A game can be starred once it is over.");
    assert.equal((await star(alice, 999999)).status, 404);
    assert.equal((await alice.c.post(`/api/games/${own}/star`, { starred: "yes" })).status, 400);
    assert.equal((await alice.c.post(`/api/games/${own}/star`, {})).status, 400);
  });

  test("shows as starred to you, and to no one else", async () => {
    assert.equal((await alice.c.get(`/api/games/${own}`)).body.starred, true);
    assert.equal((await bob.c.get(`/api/games/${own}`)).body.starred, false);
    assert.deepEqual((await alice.c.get(`/api/games/${others}/star`)).body, { starred: true });
    assert.deepEqual((await carol.c.get(`/api/games/${others}/star`)).body, { starred: false });
    assert.equal((await alice.c.get("/api/games/999999/star")).status, 404);
    // Alice's list marks her star; Bob's list of the same game doesn't.
    const mine = (await alice.c.get("/api/games")).body.find((g) => g.id === own);
    assert.equal(mine.starred, true);
    const bobs = (await bob.c.get("/api/games")).body.find((g) => g.id === own);
    assert.equal(bobs.starred, false);
    // On Bob's profile, Alice sees her own stars, Bob's never.
    await star(bob, others);
    const onBobsProfile = (await alice.c.get(`/api/games/user/${bob.user.id}`)).body;
    assert.equal(onBobsProfile.find((g) => g.id === own).starred, true);
    const viaCarol = (await carol.c.get(`/api/games/user/${bob.user.id}`)).body;
    assert.equal(viaCarol.find((g) => g.id === others).starred, false, "Bob's star is his own");
  });

  test("the starred list: yours only, newest game first, with the players", async () => {
    const list = (await alice.c.get("/api/games/starred")).body;
    assert.deepEqual(list.map((g) => g.id), [others, own]);
    assert.ok(list.every((g) => g.starred === true));
    assert.equal(list[0].white_username, bob.user.username);
    assert.equal(list[0].black_username, carol.user.username);
    assert.deepEqual((await bob.c.get("/api/games/starred")).body.map((g) => g.id), [others]);
  });

  test("taking the star off, even one that isn't there", async () => {
    assert.deepEqual((await star(alice, own, false)).body, { ok: true, starred: false });
    assert.deepEqual((await star(alice, own, false)).body, { ok: true, starred: false });
    assert.deepEqual((await alice.c.get("/api/games/starred")).body.map((g) => g.id), [others]);
    // A live game can't be starred, but taking a star off is always allowed.
    assert.equal((await star(alice, live, false)).status, 200);
  });

  test("a four-player game, played or not, comes with its seats", async () => {
    const id = fourGame("fourplayer_ffa", "b,r=y,g");
    assert.equal((await star(carol, id)).status, 200);
    const [g] = (await carol.c.get("/api/games/starred")).body;
    assert.equal(g.id, id);
    assert.equal(g.seat, null, "carol didn't play it");
    assert.deepEqual(Object.keys(g.seats).sort(), ["b", "g", "r", "y"]);
    assert.equal(g.seats.r.bot, false);
  });
});

describe("the limit", () => {
  test(`up to ${STAR_LIMIT} games; one already starred can be starred again`, async () => {
    const dave = await registerUser(srv.baseUrl, "dave");
    const ids = [];
    for (let i = 0; i < STAR_LIMIT; i++) ids.push(recordGame({ white: dave.user.id, black: lorfishId(), mode: "ai", aiColor: "b", rated: 0, result: "1-0", termination: "resign" }));
    const insert = db.prepare("INSERT INTO game_stars (user_id, game_id) VALUES (?, ?)");
    db.transaction(() => { for (const id of ids) insert.run(dave.user.id, id); })();
    const extra = recordGame({ white: dave.user.id, black: alice.user.id, ...MATE });
    const r = await star(dave, extra);
    assert.equal(r.status, 409);
    assert.match(r.body.error, new RegExp(`up to ${STAR_LIMIT} games`));
    assert.equal((await star(dave, ids[0])).status, 200, "already starred");
    assert.equal((await star(dave, ids[0], false)).status, 200);
    assert.equal((await star(dave, extra)).status, 200, "room for one again");
  });
});

describe("account deletion", () => {
  test("takes the user's stars, and anyone's on their games against LorFish", async () => {
    const erin = await registerUser(srv.baseUrl, "erin");
    const ai = recordGame({ white: erin.user.id, black: lorfishId(), mode: "ai", aiColor: "b", rated: 0, ...MATE });
    const pvp = recordGame({ white: erin.user.id, black: bob.user.id, ...MATE });
    await star(erin, pvp);
    await star(bob, ai);
    await star(bob, pvp);
    assert.equal(queries.deletionSummary.get({ id: erin.user.id }).stars, 1);
    db.transaction(() => { for (const stmt of queries.deleteAccountRows) stmt.run({ id: erin.user.id }); })();
    const starsOn = (id) => db.prepare("SELECT user_id FROM game_stars WHERE game_id = ?").all(id).map((r) => r.user_id);
    assert.deepEqual(starsOn(ai), [], "the game is gone, and Bob's star with it");
    assert.deepEqual(starsOn(pvp), [bob.user.id], "Bob keeps his star on the PvP game");
  });
});
