"use strict";

// A page on a sibling *.lorand77.dev app is same-site, so the browser sends it
// the Lax session cookie. The server must still refuse what it asks for: a
// body-less POST (no CORS preflight) and a socket handshake (no CORS at all).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket } = require("../helpers/server");

const FOREIGN = "https://lorciv.lorand77.dev";

let srv, alice, own;
before(async () => {
  srv = await startServer();
  own = srv.baseUrl;
  alice = await registerUser(srv.baseUrl, "alice");
  assert.equal((await alice.c.put("/api/settings", { scheme: "light" })).status, 200);
});
after(async () => { await srv.close(); });

// What a browser sends for fetch(url, { method: "POST", credentials: "include" }).
const post = (path, origin) => fetch(srv.baseUrl + path, {
  method: "POST",
  headers: { Cookie: "connect.sid=" + alice.c.cookie(), ...(origin ? { Origin: origin } : {}) },
});

test("a body-less POST from a sibling site is refused and changes nothing", async () => {
  const before = (await alice.c.get("/api/settings")).body;
  const res = await post("/api/settings/reset", FOREIGN);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Cross-origin request refused." });
  assert.equal(before.scheme, "light");
  assert.deepEqual((await alice.c.get("/api/settings")).body, before);
});

test("the same POST from LorChess's own page, or without an Origin, goes through", async () => {
  assert.equal((await post("/api/settings/reset", own)).status, 200);
  assert.equal((await post("/api/settings/reset")).status, 200);
});

test("a GET from a sibling site is served: CORS keeps the answer from it", async () => {
  const res = await fetch(srv.baseUrl + "/api/me", {
    headers: { Cookie: "connect.sid=" + alice.c.cookie(), Origin: FOREIGN },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("a socket handshake from a sibling site is refused", async () => {
  await assert.rejects(connectSocket(srv.baseUrl, alice.c.cookie(), { Origin: FOREIGN }));
  await assert.rejects(connectSocket(srv.baseUrl, alice.c.cookie(), { Origin: "null" }));
});

test("a socket handshake from LorChess's own page connects", async () => {
  const socket = await connectSocket(srv.baseUrl, alice.c.cookie(), { Origin: own });
  assert.equal(socket.connected, true);
  socket.close();
});
