"use strict";

// src/auth/sameOrigin.js: a page on a sibling *.lorand77.dev app gets the Lax
// session cookie, so the Origin header is all that keeps it from acting.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { sameOrigin, requireSameOrigin } = require("../../src/auth/sameOrigin");

const req = (headers, method = "POST") => ({ method, headers });

describe("sameOrigin", () => {
  test("accepts the page's own origin, whatever the scheme or case", () => {
    assert.equal(sameOrigin(req({ origin: "https://lorchess.lorand77.dev", host: "lorchess.lorand77.dev" })), true);
    assert.equal(sameOrigin(req({ origin: "http://localhost:3000", host: "localhost:3000" })), true);
    assert.equal(sameOrigin(req({ origin: "https://LorChess.lorand77.dev", host: "LORCHESS.lorand77.dev" })), true);
  });

  test("accepts a request with no Origin: not a browser page", () => {
    assert.equal(sameOrigin(req({ host: "lorchess.lorand77.dev" })), true);
  });

  test("refuses a sibling subdomain, another port, another site and null", () => {
    const host = "lorchess.lorand77.dev";
    assert.equal(sameOrigin(req({ origin: "https://lorciv.lorand77.dev", host })), false);
    assert.equal(sameOrigin(req({ origin: "https://lorchess.lorand77.dev:8443", host })), false);
    assert.equal(sameOrigin(req({ origin: "https://lorchess.lorand77.dev.evil.com", host })), false);
    assert.equal(sameOrigin(req({ origin: "null", host })), false);
    assert.equal(sameOrigin(req({ origin: "https://lorchess.lorand77.dev" })), false, "no Host matches nothing");
  });
});

describe("requireSameOrigin", () => {
  function run(r) {
    let status = null, body = null, called = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    requireSameOrigin(r, res, () => { called = true; });
    return { status, body, called };
  }
  const foreign = { origin: "https://lorciv.lorand77.dev", host: "lorchess.lorand77.dev" };

  test("lets reads through from anywhere", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) assert.equal(run(req(foreign, m)).called, true, m);
  });

  test("refuses a foreign change with 403", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.deepEqual(run(req(foreign, m)), { status: 403, body: { error: "Cross-origin request refused." }, called: false }, m);
    }
  });
});
