"use strict";

// In production the session cookie is __Host-sid. A browser drops a __Host-
// cookie unless it is Secure, has Path=/ and no Domain, both when it is set
// and when logout clears it. Behind Caddy, X-Forwarded-Proto is what makes
// the request secure.

process.env.NODE_ENV = "production";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, uniqueName } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const https = { "X-Forwarded-Proto": "https" };

function assertHostCookie(line) {
  assert.match(line, /^__Host-sid=/);
  assert.match(line, /; Secure/);
  assert.match(line, /; Path=\/(;|$)/);
  assert.doesNotMatch(line, /Domain=/i);
}

test("the session cookie is set and cleared as a valid __Host- cookie", async () => {
  const reg = await fetch(srv.baseUrl + "/api/register", {
    method: "POST",
    headers: { ...https, "Content-Type": "application/json" },
    body: JSON.stringify({ username: uniqueName("alice"), password: "hunter22" }),
  });
  assert.equal(reg.status, 201);
  const [set] = reg.headers.getSetCookie();
  assertHostCookie(set);

  const out = await fetch(srv.baseUrl + "/api/logout", {
    method: "POST",
    headers: { ...https, Cookie: set.split(";")[0] },
  });
  assert.equal(out.status, 200);
  const [cleared] = out.headers.getSetCookie();
  assertHostCookie(cleared);
  assert.match(cleared, /^__Host-sid=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
});
