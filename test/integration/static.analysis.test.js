"use strict";

// The analysis board is a static page whose scripts come from two places,
// public/js and src/shared (both served at /js/). Nothing else loads them, so
// check that every script it names is actually there, and that the page sits
// behind the auth guard like the rest of the app.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test("the analysis board and every script it loads are served", async () => {
  const res = await fetch(srv.baseUrl + "/analysis.html");
  assert.equal(res.status, 200);
  const html = await res.text();
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  for (const name of ["shell", "authGuard", "chess", "gameReview", "liveEval", "analysis"]) {
    assert.ok(scripts.includes("/js/" + name + ".js"), name + ".js is loaded");
  }
  for (const src of scripts) {
    const js = await fetch(srv.baseUrl + src);
    assert.equal(js.status, 200, src);
    assert.match(js.headers.get("content-type"), /javascript/, src);
  }
});

test("the navigation rail links to it", async () => {
  const shell = await (await fetch(srv.baseUrl + "/js/shell.js")).text();
  assert.match(shell, /href: "\/analysis\.html"/);
});
