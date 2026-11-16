"use strict";

// The Rules page: reached from the rail, a tab for General and one per variant
// named as the catalogue names it, each variant's "at a glance" line filled
// from the catalogue, a tab opened by the URL's hash and by a click.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const { VARIANTS } = require("../../src/shared/variants");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test("the Rules tab: every variant's rules, one tab each", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator(".app-rail a", { hasText: "Rules" }).click();
  await page.waitForURL(/\/rules\.html$/);

  const tabs = page.locator("#rulesTabs a");
  assert.deepEqual(await tabs.allTextContents(), ["General", ...VARIANTS.map((v) => v.label)]);
  assert.equal(await page.locator("#rules-general").isVisible(), true, "General first");
  assert.equal(await page.locator(".rules-section:visible").count(), 1);

  await tabs.filter({ hasText: "Atomic" }).click();
  await page.waitForURL(/#atomic$/);
  await page.locator("#rules-atomic").waitFor();   // shown on hashchange, just after the URL
  assert.equal(await page.locator("#rules-general").isVisible(), false);
  assert.equal(await page.locator("#rules-atomic .rules-glance").textContent(),
    "Two players · rated or casual · play LorFish from the lobby · odds games allowed · no Stockfish review");
  assert.equal(await tabs.filter({ hasText: "Atomic" }).getAttribute("aria-selected"), "true");

  // A link straight to a tab.
  await page.goto(srv.baseUrl + "/rules.html#fourplayer");
  await page.locator("#rules-fourplayer").waitFor();
  assert.equal(await page.locator("#rules-fourplayer .rules-glance").textContent(),
    "Four players, two teams · casual only · LorFish can fill empty seats · no odds games · no Stockfish review");
  await page.goto(srv.baseUrl + "/rules.html#nonsense");
  await page.locator("#rules-general").waitFor();   // an unknown tab shows General
  assert.equal(await page.locator(".rules-section:visible").count(), 1);
});
