"use strict";

// Duck Chess on the game page. A chosen move is shown and waits for its duck:
// the squares it may go to are marked, a click on one sends the turn, any
// other click takes the move back. LorFish moves the duck too. Between people
// the other side sees the duck where it was put and is blocked by it; the
// replay shows it at every move.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

const sqOf = (name) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
const square = (page, name) => page.locator(`#board [data-sq="${sqOf(name)}"]`);

test("against LorFish: the move waits for its duck; LorFish moves it; a stray click takes the move back", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("duck");
  await page.locator("#aiLevelSelect").selectOption("beginner");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=duck/);
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);

  await square(page, "e2").click();
  await square(page, "e4").click();
  // Shown, not played: 32 squares for the duck, and nothing sent yet.
  assert.equal(await page.locator("#board .hint.duck").count(), 32);
  assert.match(await page.locator("#turn").textContent(), /put the duck/);
  assert.equal(await square(page, "e4").locator("img.piece").count(), 1);
  assert.equal(await page.evaluate(() => chess.history.length), 0);

  await square(page, "a6").click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  const after = await page.evaluate(() => ({ first: moveHistory[0], duck: chess.duck, lorfish: chess.history[1].move.duck }));
  assert.equal(after.first, "e4@a6");
  assert.notEqual(after.duck, sqOf("a6"), "LorFish moved it");
  assert.equal(after.duck, after.lorfish);
  assert.equal(await page.locator(`#board [data-sq="${after.duck}"] img.duck-piece`).count(), 1);

  // A move chosen, then a click on the knight's own rook: taken back.
  await square(page, "g1").click();
  await square(page, "f3").click();
  assert.ok(await page.locator("#board .hint.duck").count() > 0);
  await square(page, "h1").click();
  assert.equal(await page.locator("#board .hint.duck").count(), 0);
  assert.equal(await square(page, "g1").locator("img.piece").count(), 1, "the knight is back");
  assert.equal(await page.evaluate(() => chess.history.length), 2);
});

test("between people: the other side sees the duck and is blocked by it; the replay shows it", async (t) => {
  const white = await signedInPage(browser, srv.baseUrl, t);
  const black = await signedInPage(browser, srv.baseUrl, t);
  const gameId = matchmaking.startMatch(srv.io,
    { userId: white.user.user.id, username: white.user.user.username },
    { userId: black.user.user.id, username: black.user.user.username },
    { variant: "duck", initialMs: 300000, incrementMs: 0 });
  for (const p of [white.page, black.page]) {
    await p.goto(srv.baseUrl + "/game.html?id=" + gameId);
    await p.waitForFunction(() => pvpMode && chess.isDuck);
  }
  await square(white.page, "e2").click();
  await square(white.page, "e4").click();
  await square(white.page, "d5").click();
  await black.page.waitForFunction(() => chess.history.length === 1);
  assert.equal(await square(black.page, "d5").locator("img.duck-piece").count(), 1);
  // d7-d5 is blocked; d7-d6 isn't.
  await square(black.page, "d7").click();
  assert.equal(await square(black.page, "d5").locator(".hint").count(), 0);
  assert.equal(await square(black.page, "d6").locator(".hint").count(), 1);

  // Over: the replay shows the duck after White's move.
  black.page.once("dialog", (d) => d.accept());
  await black.page.locator("#resignBtn").click();
  await white.page.waitForFunction(() => !!pvpResult);
  await white.page.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await square(white.page, "d5").locator("img.duck-piece").waitFor();
});
