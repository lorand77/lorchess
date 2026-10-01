"use strict";

// Light and dark square images on /api/settings/assets: uploaded, listed with
// the other assets, served back only to their owner, limited to 1 MB, and
// dropped by a delete or a reset.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");

// The smallest valid PNG header is enough: the server sniffs the first bytes.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let srv, me, other;
before(async () => {
  srv = await startServer();
  ({ c: me } = await registerUser(srv.baseUrl, "squares"));
  ({ c: other } = await registerUser(srv.baseUrl, "nosy"));
});
after(async () => { await srv.close(); });

// The test client only sends JSON; an upload is a raw body.
function upload(client, kind, body) {
  return fetch(srv.baseUrl + "/api/settings/assets/" + kind, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", Cookie: "connect.sid=" + client.cookie() },
    body,
  });
}

test("both square images upload, list and come back to their owner only", async () => {
  for (const kind of ["sqLight", "sqDark"]) {
    const res = await upload(me, kind, PNG);
    assert.equal(res.status, 200, kind);
    assert.ok((await res.json()).assets[kind], kind);
  }
  const settings = await me.get("/api/settings");
  assert.deepEqual(Object.keys(settings.body.assets).sort(), ["sqDark", "sqLight"]);

  const mine = await fetch(srv.baseUrl + "/api/settings/assets/sqLight", {
    headers: { Cookie: "connect.sid=" + me.cookie() },
  });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), PNG);
  assert.equal((await other.get("/api/settings/assets/sqLight")).status, 404);
});

test("a square image over 1 MB is refused, though a background that size is fine", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  const res = await upload(me, "sqDark", big);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /max 1024 KB/);
  assert.equal((await upload(me, "bg", big)).status, 200);
});

test("anything that is not an image is refused", async () => {
  const res = await upload(me, "sqLight", Buffer.from("not an image"));
  assert.equal(res.status, 415);
});

test("delete removes one, reset removes the rest", async () => {
  const del = await me.del("/api/settings/assets/sqLight");
  assert.equal(del.status, 200);
  assert.equal(del.body.assets.sqLight, undefined);
  assert.ok(del.body.assets.sqDark);

  const reset = await me.post("/api/settings/reset");
  assert.deepEqual(reset.body.assets, {});
});
