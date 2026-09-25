"use strict";

// Registration, login, logout and session handling over real HTTP, against
// the real server on a throwaway database.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, uniqueName, registerUser } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

describe("register", () => {
  test("creates the user, starts a session, and /api/me sees it", async () => {
    const c = client(srv.baseUrl);
    const username = uniqueName("alice");
    const reg = await c.post("/api/register", { username, password: "hunter22" });
    assert.equal(reg.status, 201);
    assert.ok(Number.isInteger(reg.body.id));
    assert.deepEqual(reg.body, { id: reg.body.id, username });
    assert.ok(c.cookie(), "a session cookie was set");
    const setCookie = reg.headers.getSetCookie()[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await c.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.id, reg.body.id);
    assert.equal(me.body.username, username);
    assert.equal(me.body.rating, 1200);
    assert.equal("password_hash" in me.body, false, "the hash never leaves the server");
  });

  test("rejects bad usernames, short passwords, the reserved name and duplicates", async () => {
    const c = client(srv.baseUrl);
    const bad = [
      ["too short", { username: "ab", password: "hunter22" }, /Username must be/],
      ["bad characters", { username: "bad name!", password: "hunter22" }, /Username must be/],
      ["too long", { username: "a".repeat(21), password: "hunter22" }, /Username must be/],
      ["not a string", { username: 42, password: "hunter22" }, /Username must be/],
      ["short password", { username: uniqueName("bob"), password: "12345" }, /Password must be/],
      ["missing password", { username: uniqueName("bob") }, /Password must be/],
      ["reserved name", { username: "LorFish", password: "hunter22" }, /reserved/],
      ["reserved name, other case", { username: "lorfish", password: "hunter22" }, /reserved/],
    ];
    for (const [name, body, message] of bad) {
      const res = await c.post("/api/register", body);
      assert.equal(res.status, 400, name);
      assert.match(res.body.error, message, name);
      assert.equal(c.cookie(), undefined, `${name}: no session on failure`);
    }
    const taken = uniqueName("carol");
    assert.equal((await c.post("/api/register", { username: taken, password: "hunter22" })).status, 201);
    const dup = await client(srv.baseUrl).post("/api/register", { username: taken, password: "other123" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already taken/);
    // A name that differs only in case is the same name.
    const cased = await client(srv.baseUrl).post("/api/register", { username: taken.toUpperCase(), password: "other123" });
    assert.equal(cased.status, 409);
    assert.match(cased.body.error, /already taken/);
  });

  test("two registrations racing for one name: the loser gets a 409, not a 500", async (t) => {
    const argon2 = require("argon2");
    const queries = require("../../src/db/queries");
    const name = uniqueName("dave");
    const realHash = argon2.hash.bind(argon2);
    // While this request is still hashing its password, "the other" request
    // for the same name gets its row in first.
    t.mock.method(argon2, "hash", async (password) => {
      queries.createUser.run(name, "hash-of-the-other-request", 1200);
      return realHash(password);
    });
    const res = await client(srv.baseUrl).post("/api/register", { username: name, password: "hunter22" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already taken/);
    // The same race with a name differing only in case is closed by the index.
    assert.throws(() => queries.createUser.run(name.toUpperCase(), "x", 1200), /UNIQUE/);
  });
});

describe("login and logout", () => {
  test("wrong password, unknown user and the AI account are all refused alike", async () => {
    const { user, c } = await registerUser(srv.baseUrl, "dave");
    await c.post("/api/logout");
    const anon = client(srv.baseUrl);
    for (const body of [
      { username: user.username, password: "wrong-password" },
      { username: uniqueName("nobody"), password: "hunter22" },
      { username: "LorFish", password: "hunter22" },
      { username: user.username },
      {},
    ]) {
      const res = await anon.post("/api/login", body);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.deepEqual(res.body, { error: "Invalid username or password." });
      assert.equal(anon.cookie(), undefined);
    }
  });

  test("a correct password logs in and the cookie works on later requests", async () => {
    const { user, c, password } = await registerUser(srv.baseUrl, "erin");
    await c.post("/api/logout");
    const fresh = client(srv.baseUrl);
    const res = await fresh.post("/api/login", { username: user.username, password });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: user.id, username: user.username });
    const me = await fresh.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.username, user.username);
  });

  test("logging in issues a new session id and the old one stops working", async () => {
    const { user, c, password } = await registerUser(srv.baseUrl, "frank");
    const before = c.cookie();
    const res = await c.post("/api/login", { username: user.username, password });
    assert.equal(res.status, 200);
    assert.notEqual(c.cookie(), before, "session regenerated on login");
    const stale = client(srv.baseUrl);
    stale.setCookie("connect.sid", before);
    assert.equal((await stale.get("/api/me")).status, 401);
    assert.equal((await c.get("/api/me")).status, 200);
  });

  test("logout ends the session on the server, not just in the browser", async () => {
    const { c } = await registerUser(srv.baseUrl, "grace");
    const cookie = c.cookie();
    const out = await c.post("/api/logout");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(c.cookie(), undefined, "the cookie was cleared");
    const stale = client(srv.baseUrl);
    stale.setCookie("connect.sid", cookie);
    assert.equal((await stale.get("/api/me")).status, 401);
  });

  test("a session survives a server restart", async () => {
    const { user, c } = await registerUser(srv.baseUrl, "heidi");
    const cookie = c.cookie();
    await srv.close();
    srv = await startServer();
    const again = client(srv.baseUrl);
    again.setCookie("connect.sid", cookie);
    const me = await again.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.id, user.id);
  });
});

describe("access control", () => {
  const protectedPaths = [
    "/api/me", "/api/games", "/api/leaderboard", "/api/friends", "/api/settings",
    "/api/puzzles/daily", "/api/membership", "/api/stats", "/api/achievements/me",
  ];

  test("protected routes answer 401 without a session", async () => {
    const anon = client(srv.baseUrl);
    for (const p of protectedPaths) {
      const res = await anon.get(p);
      assert.equal(res.status, 401, p);
      assert.deepEqual(res.body, { error: "Authentication required." }, p);
    }
    assert.equal((await anon.post("/api/games", { humanColor: "w" })).status, 401);
  });

  test("a forged or garbage cookie is not a session", async () => {
    const forged = client(srv.baseUrl);
    forged.setCookie("connect.sid", "s%3Aforged.signature");
    assert.equal((await forged.get("/api/me")).status, 401);
  });

  test("static pages and the shared engine are public", async () => {
    const anon = client(srv.baseUrl);
    const login = await anon.get("/login.html");
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-type"), /text\/html/);
    const engine = await anon.get("/js/chess.js");
    assert.equal(engine.status, 200);
    assert.match(engine.body, /class Chess/);
    assert.equal((await anon.get("/js/ui.js")).status, 200, "public/js falls through");
  });

  test("the old My Games, Achievements and Friends pages redirect to profile tabs", async () => {
    const cases = [
      ["/history.html", "/profile.html#games"],
      ["/friends.html", "/profile.html#friends"],
      ["/achievements.html", "/profile.html#achievements"],
      ["/achievements.html?user=42", "/profile.html?id=42#achievements"],
      ["/achievements.html?user=nonsense", "/profile.html#achievements"],
    ];
    for (const [from, to] of cases) {
      const res = await fetch(srv.baseUrl + from, { redirect: "manual" });
      assert.equal(res.status, 302, from);
      assert.equal(res.headers.get("location"), to, from);
    }
    assert.equal((await client(srv.baseUrl).get("/profile.html")).status, 200);
  });
});
