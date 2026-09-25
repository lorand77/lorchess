"use strict";

// Wide tables scroll within their panel; names, sorting and friend controls
// must stay usable without pushing the entire mobile page off screen.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const queries = require("../../src/db/queries");

let srv, browser;
before(async () => {
  srv = await startServer();
  browser = await openBrowser();
  for (const name of ["AveryLongUsername1234", "AnotherLongName123456"]) {
    const id = queries.createUser.run(name, "not-a-password-hash", 1200).lastInsertRowid;
    queries.updateRating.run(12345, id);
  }
});
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

test("leaderboard contains overflow and keeps controls reachable on mobile", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/leaderboard.html");
  await page.locator(".lb-table tbody tr").nth(2).waitFor();
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    const size = await page.evaluate(() => {
      const host = document.querySelector(".table-scroll");
      return { page: document.documentElement.scrollWidth, viewport: innerWidth, panel: host.clientWidth, table: host.scrollWidth };
    });
    assert.ok(size.page <= size.viewport, JSON.stringify(size));
    if (width <= 375) assert.ok(size.table > size.panel, "table scrolls inside the panel");
    const friend = page.locator(".friend-cell button").first();
    await friend.scrollIntoViewIfNeeded();
    const box = await friend.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
    assert.equal(await page.evaluate(() => scrollX), 0);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const sorted = page.waitForResponse(r => r.url().includes("/api/leaderboard?sort=player"));
  await page.getByRole("button", { name: "Player", exact: true }).click();
  await sorted;
  await page.locator(".friend-cell button").first().click();
  await page.locator(".friend-cell .pending").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
