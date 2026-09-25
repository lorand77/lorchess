"use strict";

// Puzzle navigation must update the bookmark as well as the rendered board.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const queries = require("../../src/db/queries");
const fixtures = require("../fixtures/puzzles.json");

let srv, browser;
before(async () => {
  srv = await startServer();
  browser = await openBrowser();
  for (const p of [...fixtures.oneMove, ...fixtures.twoMove].slice(0, 20)) {
    queries.insertPuzzle.run(p.id, p.fen, p.moves, p.rating, 70, 90, 100, p.themes, null, null);
  }
});
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

for (const action of ["next", "skip"]) {
  test(`refresh after ${action} keeps the new held puzzle`, async (t) => {
    const { page, user } = await signedInPage(browser, srv.baseUrl, t);
    if (action === "skip") {
      db().prepare("UPDATE users SET member_since = datetime('now') WHERE id = ?").run(user.user.id);
    }
    const first = (await user.c.get("/api/puzzles/next")).body.puzzle.id;
    await page.goto(srv.baseUrl + "/puzzles.html?id=" + first);
    await page.locator("#giveUpBtn").waitFor({ state: "visible" });
    if (action === "next") {
      await page.locator("#giveUpBtn").click();
      await page.locator("#nextBtn").waitFor({ state: "visible" });
    }
    const response = page.waitForResponse(r => r.url().endsWith(action === "next" ? "/api/puzzles/next" : "/skip"));
    await page.locator(action === "next" ? "#nextBtn" : "#skipBtn").click();
    const data = await (await response).json();
    const next = data.puzzle.id;
    assert.notEqual(next, first);
    await page.waitForURL(url => url.searchParams.get("id") === next);
    const reloaded = page.waitForResponse(r => new URL(r.url()).pathname === "/api/puzzles/" + next);
    await page.reload();
    const restored = await (await reloaded).json();
    assert.equal(restored.puzzle.id, next);
    assert.equal(restored.held, true);
    assert.equal(restored.repeat, false);
  });
}
