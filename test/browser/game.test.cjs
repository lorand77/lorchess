"use strict";

// Exercise board lifecycle through the real page, API, database and worker.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

async function ready(page) {
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);
  return page.evaluate(() => gameStore.currentId());
}

test("refresh resumes the displayed AI game after each way of starting one", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  let id = await ready(page);
  await page.locator('#board [data-sq="12"]').click();
  await page.locator('#board [data-sq="28"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  await page.waitForLoadState("networkidle");
  await page.reload();
  assert.equal(await ready(page), id);
  assert.equal(await page.evaluate(() => chess.history.length), 2);

  for (const action of [
    () => page.locator("#resetBtn").click(),
    () => page.locator("#humanColor").selectOption("b"),
    async () => {
      await page.locator("#loadFenBtn").click();
      await page.locator("#fenText").fill("7k/7p/8/8/8/8/P7/K7 b - - 0 1");
      await page.locator("#fenLoadBtn").click();
    },
  ]) {
    await action();
    await page.waitForFunction(old => gameStore.currentId() && gameStore.currentId() !== old && !thinking, id);
    id = await ready(page);
    assert.equal(new URL(page.url()).searchParams.get("id"), String(id));
    await page.waitForLoadState("networkidle");
    const fen = await page.evaluate(() => chess.fen());
    await page.reload();
    assert.equal(await ready(page), id);
    assert.equal(await page.evaluate(() => chess.fen()), fen);
    assert.equal(db().prepare("SELECT status FROM games WHERE id = ?").get(id).status, "active");
  }
});
