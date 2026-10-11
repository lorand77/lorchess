"use strict";

// Every response carries the Content-Security-Policy from src/app.js, and no
// page needs what it forbids: an inline <script>, an on*= handler or a
// javascript: URL would silently stop working under it.

const fs = require("fs");
const path = require("path");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");

const PUBLIC = path.join(__dirname, "..", "..", "public");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

function assertPolicy(res, what) {
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, `${what} has a CSP`);
  const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.equal(script, "script-src 'self' 'wasm-unsafe-eval'", what);
  assert.match(csp, /frame-ancestors 'none'/, what);
  assert.match(csp, /object-src 'none'/, what);
}

test("pages, scripts and the API all carry the policy", async () => {
  for (const url of ["/login.html", "/game.html", "/js/ui.js", "/js/chess.js", "/api/me"]) {
    assertPolicy(await fetch(srv.baseUrl + url), url);
  }
});

test("an uploaded image keeps its own stricter policy", async () => {
  const { c } = await registerUser(srv.baseUrl, "csp");
  const cookie = "connect.sid=" + c.cookie();
  const put = await fetch(srv.baseUrl + "/api/settings/assets/sqLight", {
    method: "PUT", headers: { "Content-Type": "application/octet-stream", Cookie: cookie }, body: PNG,
  });
  assert.equal(put.status, 200);
  const res = await fetch(srv.baseUrl + "/api/settings/assets/sqLight", { headers: { Cookie: cookie } });
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
});

test("no page has inline script, an inline handler or a javascript: URL", () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length > 10);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
    for (const tag of html.match(/<script\b[^>]*>/g) || []) {
      assert.match(tag, /\ssrc=/, `${page}: inline ${tag}`);
    }
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, `${page}: inline event handler`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: javascript: URL`);
  }
});
