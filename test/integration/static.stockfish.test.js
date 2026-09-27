"use strict";

// The game review's Stockfish is two static files under /js/vendor/stockfish/.
// The browser compiles the .wasm while it downloads only when it arrives as
// application/wasm; anything else means waiting for all ~1.8 MB first.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

const BASE = "/js/vendor/stockfish/stockfish-19-lite-single";

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test("the engine's wasm is served as application/wasm", async () => {
  const res = await fetch(srv.baseUrl + BASE + ".wasm");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/wasm");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], "the \\0asm magic");
});

test("the engine's worker script is served as JavaScript", async () => {
  const res = await fetch(srv.baseUrl + BASE + ".js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
});
