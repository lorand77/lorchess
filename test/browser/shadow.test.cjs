"use strict";

// Shadow Chess on the game page, against LorFish: a move leaves a faded copy
// of the piece on the square it left, with the moves it still blocks, and the
// piece can't be sent back there until the shadow has lifted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

const square = (page, name) => page.locator(`#board [data-sq="${(Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97}"]`);

test("shadows drawn with their count, and no move onto one", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("shadow");
  await page.locator("#aiLevelSelect").selectOption("beginner");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=shadow/);
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);

  await square(page, "g1").click();
  await square(page, "f3").click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });

  // White's shadow on g1 blocks one more move; LorFish's two.
  const g1 = square(page, "g1");
  assert.equal(await g1.locator("img.shadow-piece").count(), 1);
  assert.equal(await g1.locator(".shadow-left").textContent(), "1");
  const theirs = await page.evaluate(() => chess.history[1].move.from);
  assert.equal(await page.locator(`#board [data-sq="${theirs}"] .shadow-left`).textContent(), "2");

  // The knight can't go back: no hint on g1.
  await square(page, "f3").click();
  assert.equal(await g1.locator(".hint").count(), 0);
  assert.ok(await page.locator("#board .hint").count() > 0, "it has other moves");
});
