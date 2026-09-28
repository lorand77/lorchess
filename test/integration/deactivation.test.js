"use strict";

// Deactivated accounts: `npm run user:deactivate` ends their sessions and
// refuses their logins; they drop off the leaderboard and every friends list,
// their profile is a 404, and their sockets are swept, forfeiting a live game.
// Reactivating brings all of it back.

process.env.GRACE_MS = "400";
process.env.DEACTIVATION_SWEEP_MS = "100";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  startServer, client, registerUser, connectSocket, emitAck, waitFor, quickMatch,
} = require("../helpers/server");
const { recordGame } = require("../helpers/games");
const { sq } = require("../helpers/board");
const queries = require("../../src/db/queries");

const mv = (from, to) => ({ from: sq(from), to: sq(to), promo: null });
const CLI = path.join(__dirname, "../../src/db/deactivate.js");

// Run the command against the test database, as ops would against the real one.
function cli(mode, username) {
  const r = spawnSync(process.execPath, [CLI, mode, username], { env: process.env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const deactivate = (u) => queries.deactivateUser.run(u.user.id);
const reactivate = (u) => queries.reactivateUser.run(u.user.id);

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

describe("the command", () => {
  test("ends the user's sessions and refuses their login until reactivated", async () => {
    const alice = await registerUser(srv.baseUrl, "alice");
    const name = alice.user.username;

    const off = cli("deactivate", name);
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /deactivated .*; 1 session\(s\) ended/);
    assert.equal((await alice.c.get("/api/me")).status, 401);

    const login = await client(srv.baseUrl).post("/api/login", { username: name, password: alice.password });
    assert.equal(login.status, 403);
    assert.deepEqual(login.body, { error: "This account has been deactivated." });
    // Without the password, it is the same answer as for anyone else.
    const wrong = await client(srv.baseUrl).post("/api/login", { username: name, password: "wrong-password" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { error: "Invalid username or password." });

    assert.match(cli("deactivate", name).out, /already deactivated/);
    const on = cli("reactivate", name.toUpperCase());
    assert.equal(on.code, 0, on.out);
    assert.match(on.out, /reactivated/);
    assert.match(cli("reactivate", name).out, /not deactivated/);
    const back = await client(srv.baseUrl).post("/api/login", { username: name, password: alice.password });
    assert.equal(back.status, 200);
  });

  test("refuses unknown users and the AI account", () => {
    assert.equal(cli("deactivate", "no_such_user_x").code, 2);
    assert.equal(cli("deactivate", "LorFish").code, 2);
    assert.equal(cli("vanish", "anyone").code, 2);
  });
});

describe("a session that outlives the deactivation", () => {
  // A login racing the command can create a session after it deleted them.
  test("is refused on REST and at the socket handshake", async () => {
    const bob = await registerUser(srv.baseUrl, "bob");
    deactivate(bob);
    const me = await bob.c.get("/api/me");
    assert.equal(me.status, 401);
    assert.deepEqual(me.body, { error: "This account has been deactivated." });
    await assert.rejects(connectSocket(srv.baseUrl, bob.c.cookie()), /unauthorized/);
    reactivate(bob);
    assert.equal((await bob.c.get("/api/me")).status, 200);
  });
});

describe("visibility", () => {
  let viewer, gone;
  before(async () => {
    viewer = await registerUser(srv.baseUrl, "viewer");
    gone = await registerUser(srv.baseUrl, "carol");
  });

  test("off the leaderboard while deactivated", async () => {
    const names = async () => (await viewer.c.get("/api/leaderboard?sort=player")).body.map((r) => r.id);
    assert.ok((await names()).includes(gone.user.id));
    deactivate(gone);
    assert.ok(!(await names()).includes(gone.user.id));
    reactivate(gone);
    assert.ok((await names()).includes(gone.user.id));
  });

  test("profile is a 404, but past games still replay with their name", async () => {
    const gameId = recordGame({
      white: viewer.user.id, black: gone.user.id, moves: ["e2e4", "e7e5"],
      result: "1-0", termination: "resign",
    });
    deactivate(gone);
    for (const p of ["stats", "games/user", "achievements/user", "friends/user"]) {
      const res = await viewer.c.get(`/api/${p}/${gone.user.id}`);
      assert.equal(res.status, 404, p);
    }
    const replay = await viewer.c.get(`/api/games/${gameId}`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.black_username, gone.user.username);
    reactivate(gone);
    assert.equal((await viewer.c.get(`/api/stats/${gone.user.id}`)).status, 200);
  });
});

describe("friends", () => {
  test("a deactivated friend or requester disappears, and comes back", async () => {
    const me = await registerUser(srv.baseUrl, "dave");
    const friend = await registerUser(srv.baseUrl, "erin");
    const asker = await registerUser(srv.baseUrl, "frank");
    const other = await registerUser(srv.baseUrl, "grace");

    const req = await me.c.post("/api/friends/requests", { toUserId: friend.user.id });
    await friend.c.post(`/api/friends/requests/${req.body.id}/accept`);
    const incoming = await asker.c.post("/api/friends/requests", { toUserId: me.user.id });
    const ids = (list) => list.map((f) => f.userId);

    deactivate(friend);
    deactivate(asker);
    const mine = (await me.c.get("/api/friends")).body;
    assert.deepEqual(ids(mine.friends), []);
    assert.deepEqual(ids(mine.incoming), []);
    // Nor on my profile's Friends tab, as others see it.
    assert.deepEqual(ids((await other.c.get(`/api/friends/user/${me.user.id}`)).body.friends), []);
    // No new request to them, and theirs can't be accepted by id.
    assert.equal((await other.c.post("/api/friends/requests", { toUserId: friend.user.id })).status, 404);
    assert.equal((await me.c.post(`/api/friends/requests/${incoming.body.id}/accept`)).status, 404);

    reactivate(friend);
    reactivate(asker);
    const back = (await me.c.get("/api/friends")).body;
    assert.deepEqual(ids(back.friends), [friend.user.id]);
    assert.deepEqual(ids(back.incoming), [asker.user.id]);
  });
});

describe("sockets", () => {
  test("an idle socket is disconnected by the sweep", async () => {
    const heidi = await registerUser(srv.baseUrl, "heidi");
    const s = await connectSocket(srv.baseUrl, heidi.c.cookie());
    const dropped = waitFor(s, "disconnect", 2000);
    deactivate(heidi);
    assert.equal(await dropped, "io server disconnect");
  });

  // A game with no moves yet is aborted instead, like any other disconnect.
  test("a live game is forfeited once the grace runs out", async () => {
    const u1 = await registerUser(srv.baseUrl, "ivan");
    const u2 = await registerUser(srv.baseUrl, "judy");
    const a = await connectSocket(srv.baseUrl, u1.c.cookie());
    const b = await connectSocket(srv.baseUrl, u2.c.cookie());
    const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
    await emitAck(white, "game:join", { gameId });
    await emitAck(black, "game:join", { gameId });
    const moved = waitFor(white, "move:made");
    assert.deepEqual(await emitAck(white, "move:make", { gameId, ...mv("a2", "a3") }), { ok: true });
    await moved;

    const over = waitFor(white, "game:over", 3000);
    deactivate(black === a ? u1 : u2);
    const result = await over;
    assert.equal(result.result, "1-0");
    assert.equal(result.termination, "disconnect");
    white.close();
  });
});
