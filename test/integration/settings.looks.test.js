"use strict";

// The piece set and board style on /api/settings: stored with the colours,
// only keys of src/shared/looks.js accepted, and back to the defaults on reset.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");

let srv, me;
before(async () => {
  srv = await startServer();
  me = (await registerUser(srv.baseUrl, "looks")).c;
});
after(async () => { await srv.close(); });

test("the defaults: the classic pieces on a flat board", async () => {
  const res = await me.get("/api/settings");
  assert.equal(res.body.pieceSet, "cburnett");
  assert.equal(res.body.boardStyle, "flat");
});

test("a set and a style are kept, alongside the colours", async () => {
  let res = await me.put("/api/settings", { pieceSet: "lorchess", boardStyle: "walnut", light: "#eeeeee" });
  assert.equal(res.status, 200);
  assert.equal(res.body.pieceSet, "lorchess");
  assert.equal(res.body.boardStyle, "walnut");
  res = await me.put("/api/settings", { boardStyle: "shaded" });
  assert.equal(res.body.pieceSet, "lorchess", "untouched");
  res = await me.get("/api/settings");
  assert.deepEqual([res.body.pieceSet, res.body.boardStyle, res.body.light], ["lorchess", "shaded", "#eeeeee"]);
});

test("anything not in the catalogue is refused, and nothing changes", async () => {
  for (const [k, v] of [["pieceSet", "alpha"], ["pieceSet", ""], ["boardStyle", "Walnut"], ["boardStyle", "__proto__"], ["boardStyle", 3], ["pieceSet", null]]) {
    const res = await me.put("/api/settings", { [k]: v, dark: "#000000" });
    assert.equal(res.status, 400, `${k}=${JSON.stringify(v)}`);
    assert.match(res.body.error, new RegExp(k));
  }
  const res = await me.get("/api/settings");
  assert.equal(res.body.boardStyle, "shaded");
  assert.notEqual(res.body.dark, "#000000");
});

test("reset puts both back", async () => {
  const res = await me.post("/api/settings/reset");
  assert.equal(res.body.pieceSet, "cburnett");
  assert.equal(res.body.boardStyle, "flat");
});
