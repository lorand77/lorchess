"use strict";

// The logo (public/assets/logo.svg): served as an SVG image, the icon of
// every page, and in the top bar and on the sign-in page.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startServer, client } = require("../helpers/server");

const PUBLIC = path.join(__dirname, "../../public");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test("the logo is served as an SVG image", async () => {
  const res = await client(srv.baseUrl).get("/assets/logo.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^image\/svg\+xml/);
  assert.match(res.body, /^<svg /);
  assert.doesNotMatch(res.body, /<script|\son\w+=/i, "a plain drawing, nothing that runs");
});

test("every page has it as its icon", () => {
  for (const f of fs.readdirSync(PUBLIC).filter((n) => n.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/assets\/logo\.svg">/, f);
  }
});

test("the top bar and the sign-in page show it", () => {
  assert.match(fs.readFileSync(path.join(PUBLIC, "js/shell.js"), "utf8"), /logo\.src = "\/assets\/logo\.svg"/);
  assert.match(fs.readFileSync(path.join(PUBLIC, "login.html"), "utf8"), /<img class="auth-logo" src="\/assets\/logo\.svg"/);
});
