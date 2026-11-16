"use strict";

// Four-player chess in the lobby: picked in the Play panel it opens a table
// (no quick match, offer or colour), listed under Open challenges with its
// four colours in two teams, LorFish at the table's level for the empty seats
// and "Start now" for the host. "Play the computer" starts a game at once: you
// as Red, LorFish as the other three, played by the server.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const bots = require("../../src/game/bots");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
  await bots.shutdown();
});

test("a four-player table, opened and seen from the lobby", async (t) => {
  const host = await signedInPage(browser, srv.baseUrl, t);
  const friend = await signedInPage(browser, srv.baseUrl, t);
  for (const { page } of [host, friend]) {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(srv.baseUrl + "/lobby.html");
  }
  await host.page.locator("#variantSelect").selectOption("fourplayer");
  for (const id of ["quickMatchBtn", "seekBtn", "colorSelect", "ratedCheck"]) {
    assert.equal(await host.page.locator("#" + id).isVisible(), false, id);
  }
  assert.equal(await host.page.locator("#tableLevelSelect").isVisible(), true, "LorFish fills empty seats");
  assert.equal(await host.page.locator("#tablePaceSelect").inputValue(), "normal", "at the normal pace unless asked");
  await host.page.locator("#tableLevelSelect").selectOption("novice");
  await host.page.locator("#tableOpenBtn").click();

  const row = friend.page.locator("#tableList .table-row");
  await row.waitFor();
  assert.match(await row.textContent(), /Four-Player Chess/);
  assert.match(await row.textContent(), /empty seats: LorFish Novice/);
  const teams = await row.locator(".table-seats > span.muted").allTextContents();
  assert.deepEqual(teams, ["Red & Yellow", "Blue & Green"]);
  assert.match(await row.locator('[data-seat="r"]').textContent(), new RegExp(host.user.user.username));
  const sit = row.locator('[data-seat="y"] button');
  assert.equal(await sit.textContent(), "Sit: Yellow");
  await sit.click();
  const hostRow = host.page.locator("#tableList .table-row");
  await hostRow.locator('[data-seat="y"]', { hasText: friend.user.user.username }).waitFor();
  assert.equal(await hostRow.locator("button", { hasText: "Start now" }).count(), 1);
  await hostRow.locator("button", { hasText: "Close" }).click();
  await row.waitFor({ state: "detached" });
});

test("a game against LorFish, from Play the computer", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.baseUrl + "/lobby.html");
  assert.equal(await page.locator("#aiPaceSelect").isVisible(), false, "no pace for an AI game");
  await page.locator("#aiVariantSelect").selectOption("fourplayer");
  assert.equal(await page.locator("#aiPaceSelect").isVisible(), true);
  await page.locator("#aiPaceSelect").selectOption("quick");
  assert.equal(await page.locator("#aiColorSelect").isVisible(), false);
  assert.equal(await page.locator("#aiClockSelect").isVisible(), true);
  assert.match(await page.locator("#aiNote").textContent(), /You as Red, LorFish your partner as Yellow/);
  await page.locator("#aiLevelSelect").selectOption("novice");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/\/four\.html\?id=\d+$/);
  await page.waitForFunction(() => me === "r" && running);

  // LorFish's three plates: its name, no profile link.
  for (const corner of ["bl", "tl", "tr"]) {
    const plate = page.locator("#plate-" + corner);
    assert.match(await plate.textContent(), /LorFish/);
    assert.equal(await plate.locator("a").count(), 0, corner);
  }
  // Red moves; LorFish answers as Blue, Yellow and Green by itself.
  await page.locator(`#board .square[data-sq="18"]`).click();   // e2
  await page.locator(`#board .square[data-sq="46"]`).click();   // e4
  await page.waitForFunction(() => game.history.length >= 4 && game.turn === "r", null, { timeout: 20000 });
  assert.match(await page.locator("#turn").textContent(), /Turn: Red — your move/);
  page.once("dialog", (d) => d.accept());
  await page.locator("#resignBtn").click();
  await page.locator("#status", { hasText: "Blue & Green win" }).waitFor();
});
