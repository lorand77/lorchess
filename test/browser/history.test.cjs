"use strict";

// The profile's Games tab sorts by its columns: newest first to begin with,
// a click on a heading sorts by it, a second click turns it round, and the
// heading says which way (▲/▼, aria-sort) and keeps the keyboard focus.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const { makeUser, lorfishId, recordGame } = require("../helpers/games");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test("the games list sorts by any column, both ways", async (t) => {
  const { page, user } = await signedInPage(browser, srv.baseUrl, t);
  const me = user.user.id;
  // Oldest first, as the ids will have them: opponents out of alphabetical
  // order, results out of order, two variants, one game against LorFish.
  const zed = makeUser("zed"), amy = makeUser("amy"), max = makeUser("Max");
  recordGame({ white: me, black: zed.id, moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign" });
  recordGame({ white: amy.id, black: me, moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign" });
  recordGame({ white: me, black: max.id, moves: ["e2e4", "e7e5"], result: "1/2-1/2", termination: "agreement", variant: "atomic" });
  recordGame({ white: me, black: lorfishId(), mode: "ai", aiColor: "b", aiLevel: "casual", moves: ["e2e4"], result: "0-1", termination: "resign", initialMs: null, rated: 0 });
  recordGame({ white: amy.id, black: me, moves: ["d2d4"], result: "0-1", termination: "resign" });

  await page.goto(srv.baseUrl + "/profile.html#games");
  const table = page.locator("#historyContent table.history-table");
  await table.waitFor();
  const column = (n) => table.locator(`tbody tr td:nth-child(${n})`).allTextContents();
  const opponents = async () => (await column(5)).map((s) => s.split(" ")[0]);
  const results = async () => (await column(6)).map((s) => s.split(" ")[0]);
  const heading = (name) => table.locator("th", { has: page.locator("button", { hasText: name }) });

  // Newest first, as the server sends them.
  assert.deepEqual(await opponents(), [amy.username, "LorFish", max.username, amy.username, zed.username]);
  assert.equal(await heading("Date").getAttribute("aria-sort"), "descending");
  assert.match(await heading("Date").textContent(), /▼/);

  // Names A to Z, whatever their case; again for Z to A.
  await heading("Opponent").locator("button").click();
  assert.deepEqual(await opponents(), [amy.username, amy.username, "LorFish", max.username, zed.username]);
  assert.equal(await heading("Opponent").getAttribute("aria-sort"), "ascending");
  assert.equal(await heading("Date").getAttribute("aria-sort"), null, "only one column is sorted");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Opponent▲", "focus stays on the heading");
  await heading("Opponent").locator("button").click();
  assert.deepEqual(await opponents(), [zed.username, max.username, "LorFish", amy.username, amy.username]);
  assert.equal(await heading("Opponent").getAttribute("aria-sort"), "descending");

  // Wins first, then the draw, then losses; ties stay newest first.
  await heading("Result").locator("button").click();
  assert.deepEqual(await results(), ["Win", "Win", "Draw", "Loss", "Loss"]);
  assert.deepEqual(await opponents(), [amy.username, zed.username, max.username, "LorFish", amy.username]);

  // Variants by name; the last column (the links) doesn't sort.
  await heading("Variant").locator("button").click();
  assert.deepEqual(await column(3), ["Atomic", "Standard", "Standard", "Standard", "Standard"]);
  assert.equal(await table.locator("th:last-child button").count(), 0);
  // Back to newest first.
  await heading("Date").locator("button").click();
  assert.deepEqual(await opponents(), [amy.username, "LorFish", max.username, amy.username, zed.username]);
});
