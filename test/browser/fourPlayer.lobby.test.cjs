"use strict";

// Four-player chess in the lobby: picked in the Play panel it opens a table
// (no quick match, offer or colour, and no LorFish level, since LorFish can't
// take a seat), listed under Open challenges with its four colours in two
// teams; the host has no "Start now". "Play the computer" doesn't offer it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test("a four-player table, opened and seen from the lobby", async (t) => {
  const host = await signedInPage(browser, srv.baseUrl, t);
  const friend = await signedInPage(browser, srv.baseUrl, t);
  for (const { page } of [host, friend]) {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(srv.baseUrl + "/lobby.html");
  }
  assert.equal(await host.page.locator("#aiVariantSelect option[value='fourplayer']").count(), 0,
    "LorFish doesn't play it");
  await host.page.locator("#variantSelect").selectOption("fourplayer");
  for (const id of ["quickMatchBtn", "seekBtn", "colorSelect", "ratedCheck", "tableLevelSelect"]) {
    assert.equal(await host.page.locator("#" + id).isVisible(), false, id);
  }
  // Back to Bughouse, the level comes back; then four-player again.
  await host.page.locator("#variantSelect").selectOption("bughouse");
  assert.equal(await host.page.locator("#tableLevelSelect").isVisible(), true);
  await host.page.locator("#variantSelect").selectOption("fourplayer");
  await host.page.locator("#tableOpenBtn").click();

  const row = friend.page.locator("#tableList .table-row");
  await row.waitFor();
  assert.match(await row.textContent(), /Four-Player Chess/);
  assert.match(await row.textContent(), /starts when all four seats are taken/);
  const teams = await row.locator(".table-seats > span.muted").allTextContents();
  assert.deepEqual(teams, ["Red & Yellow", "Blue & Green"]);
  assert.match(await row.locator('[data-seat="r"]').textContent(), new RegExp(host.user.user.username));
  const sit = row.locator('[data-seat="y"] button');
  assert.equal(await sit.textContent(), "Sit: Yellow");
  await sit.click();
  const hostRow = host.page.locator("#tableList .table-row");
  await hostRow.locator('[data-seat="y"]', { hasText: friend.user.user.username }).waitFor();
  assert.equal(await hostRow.locator("button", { hasText: "Start now" }).count(), 0, "it waits for four");
  assert.equal(await hostRow.locator("button", { hasText: "Close" }).count(), 1);
});
