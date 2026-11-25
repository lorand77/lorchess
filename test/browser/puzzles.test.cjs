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

// After giving up, the solution waits at its start and moves only when asked.
test("give up shows the solution one step at a time", async (t) => {
  const { page, user } = await signedInPage(browser, srv.baseUrl, t);
  const first = (await user.c.get("/api/puzzles/next")).body.puzzle.id;
  await page.goto(srv.baseUrl + "/puzzles.html?id=" + first);
  await page.locator("#giveUpBtn").waitFor({ state: "visible" });
  const response = page.waitForResponse(r => r.url().endsWith("/giveup"));
  await page.locator("#giveUpBtn").click();
  const n = (await (await response).json()).solution.length;
  await page.locator("#stepper").waitFor({ state: "visible" });
  const status = page.locator("#statusLine");
  await page.waitForFunction(() => /press ▶/.test(document.getElementById("statusLine").textContent));
  assert.equal(await page.locator("#stepPrev").isDisabled(), true);
  await page.locator("#stepNext").click();
  assert.match(await status.textContent(), new RegExp("Move 1 of " + n));
  await page.keyboard.press("End");
  assert.match(await status.textContent(), /whole solution/);
  assert.equal(await page.locator("#stepNext").isDisabled(), true);
  await page.keyboard.press("ArrowLeft");
  assert.match(await status.textContent(), new RegExp("Move " + (n - 1) + " of " + n + "|press ▶"));
  await page.locator("#retryBtn").click();
  await page.locator("#stepper").waitFor({ state: "hidden" });
});

// Hints (members): the piece ringed, then its square, on the move you're on;
// for others, a locked button to the membership page.
test("a member's hint rings the piece, then its square; others see it locked", async (t) => {
  const { page, user } = await signedInPage(browser, srv.baseUrl, t);
  const p = fixtures.twoMove[0];   // two moves: the square can be shown too
  queries.insertPuzzle.run(p.id, p.fen, p.moves, p.rating, 70, 90, 100, p.themes, null, null);
  const sq = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
  const first = p.moves.split(" ")[1];

  await page.goto(srv.baseUrl + "/puzzles.html?id=" + p.id);
  await page.locator("#giveUpBtn").waitFor({ state: "visible" });
  assert.equal(await page.locator("#hintLocked").isVisible(), true);
  assert.equal(await page.locator("#hintLocked").getAttribute("href"), "/membership.html");

  db().prepare("UPDATE users SET member_since = datetime('now') WHERE id = ?").run(user.user.id);
  await page.reload();
  await page.locator("#hintBtn").waitFor({ state: "visible" });
  assert.equal(await page.locator("#hintBtn").textContent(), "💡 Hint (10 left today)");
  await page.locator("#hintBtn").click();
  await page.locator(`#board [data-sq="${sq(first.slice(0, 2))}"].hint-from`).waitFor();
  assert.match(await page.locator("#statusLine").textContent(), /^Hint: move your \w+\.$/);
  assert.equal(await page.locator("#hintBtn").textContent(), "💡 Show the square");
  await page.locator("#hintBtn").click();
  await page.locator(`#board [data-sq="${sq(first.slice(2, 4))}"].hint-to`).waitFor();
  assert.match(await page.locator("#statusLine").textContent(), new RegExp(`to ${first.slice(2, 4)}\\.$`));
  assert.equal(await page.locator("#hintBtn").isVisible(), false, "nothing more on this puzzle");

  // A reload shows the hint again; the move played, the marks go.
  await page.reload();
  await page.locator(`#board [data-sq="${sq(first.slice(2, 4))}"].hint-to`).waitFor();
  await page.locator(`#board [data-sq="${sq(first.slice(0, 2))}"]`).click();
  await page.locator(`#board [data-sq="${sq(first.slice(2, 4))}"]`).click();
  await page.waitForFunction(() => !document.querySelector("#board .hint-from, #board .hint-to"));
});
