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

test("moves played during game creation survive its response", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  await ready(page);
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route("**/api/games", async (route) => {
    if (route.request().method() === "POST") {
      arrived.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await page.locator("#resetBtn").click();
  await arrived.promise;
  await page.locator('#board [data-sq="12"]').click();
  await page.locator('#board [data-sq="28"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  const before = await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() }));
  assert.equal(before.pgn.length, 2);
  release.resolve();
  const id = await ready(page);
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() })), before);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(id).n, 2);
});

test("an earlier creation response cannot reset a newer board or its URL", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  await ready(page);
  const pending = Array.from({ length: 2 }, () => ({ arrived: Promise.withResolvers(), release: Promise.withResolvers() }));
  t.after(() => pending.forEach(p => p.release.resolve()));
  let index = 0;
  await page.route("**/api/games", async (route) => {
    if (route.request().method() === "POST") {
      const p = pending[index++];
      p.arrived.resolve();
      await p.release.promise;
    }
    await route.continue();
  });
  await page.locator("#resetBtn").click();
  await pending[0].arrived.promise;
  await page.locator("#loadFenBtn").click();
  await page.locator("#fenText").fill("7k/7p/8/8/8/8/P7/K7 w - - 0 1");
  await page.locator("#fenLoadBtn").click();
  await pending[1].arrived.promise;
  pending[1].release.resolve();
  const id = await ready(page);
  await page.locator('#board [data-sq="8"]').click();
  await page.locator('#board [data-sq="16"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  const state = await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() }));
  pending[0].release.resolve();
  await page.waitForLoadState("networkidle");
  assert.equal(await ready(page), id);
  assert.equal(new URL(page.url()).searchParams.get("id"), String(id));
  assert.deepEqual(await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() })), state);
});
