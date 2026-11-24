"use strict";

// Piece sets and board styles: chosen under Customize, previewed there before
// saving, and once saved used on the game page, where a textured style gives
// each square its own patch of the texture and its own shade.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test("LorChess Staunton on walnut: previewed, saved, and on the game page", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/settings.html");
  await page.locator('input[name="boardStyle"][value="flat"]:checked').waitFor();
  assert.ok(await page.locator('input[name="pieceSet"][value="cburnett"]').isChecked());

  // Tried: the preview changes, nothing is saved yet.
  await page.locator('input[name="pieceSet"][value="lorchess"]').check();
  await page.locator('input[name="boardStyle"][value="walnut"]').check();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boardStyle), "walnut");
  assert.match(await page.locator("#previewBoard img").first().getAttribute("src"), /\/pieces\/lorchess\/bR\.svg$/);
  assert.equal(await page.locator("#saveBtn").isDisabled(), false);

  await page.locator("#saveBtn").click();
  await page.locator(".settings-msg.ok").waitFor();

  await page.goto(srv.baseUrl + "/game.html?variant=standard&level=beginner");
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boardStyle), "walnut");
  assert.match(await page.locator('#board [data-sq="4"] img').getAttribute("src"), /\/pieces\/lorchess\/wK\.svg$/);
  const tiles = await page.evaluate(() => [...document.querySelectorAll("#board .square")].slice(0, 6).map((s) => {
    const cs = getComputedStyle(s);
    return { image: cs.backgroundImage, position: cs.backgroundPosition };
  }));
  assert.match(tiles[0].image, /walnut-(light|dark)\.svg/);
  assert.equal(new Set(tiles.map((x) => x.position)).size, 6, "six squares, six patches");
  assert.equal(new Set(tiles.map((x) => x.image)).size, 6, "and six shades");
});

test("Flat is the board as it always was", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html?variant=standard&level=beginner");
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boardStyle), "flat");
  assert.match(await page.locator('#board [data-sq="4"] img').getAttribute("src"), /w_king_1x_ns\.png$/);
  const image = await page.locator('#board [data-sq="0"]').evaluate((s) => getComputedStyle(s).backgroundImage);
  assert.doesNotMatch(image, /url|gradient/, "no texture, no shade");
});

test("the Clouds fog: chosen under Customize, drawn on a fogged square", async (t) => {
  const { page, user } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/settings.html");
  await page.locator('input[name="fogStyle"][value="simple"]:checked').waitFor();
  await page.locator('input[name="fogStyle"][value="clouds"]').check();
  await page.locator("#saveBtn").click();
  await page.locator(".settings-msg.ok").waitFor();

  // A finished Fog of War game, replayed as White saw it.
  const { recordGame, makeUser } = require("../helpers/games");
  const id = recordGame({
    white: user.user.id, black: makeUser("foe").id, variant: "fog",
    moves: ["e2e4", "d7d5"], result: "1-0", termination: "resign",
  });
  await page.goto(srv.baseUrl + "/replay.html?id=" + id);
  await page.locator('#fogView button[data-view="w"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fogStyle), "clouds");
  const fog = page.locator("#board .square.fog");
  assert.ok(await fog.count() > 0);
  const cloud = await fog.evaluateAll((els) => els.slice(0, 3).map((s) => {
    const cs = getComputedStyle(s, "::before");
    return { image: cs.backgroundImage, position: cs.backgroundPosition };
  }));
  assert.match(cloud[0].image, /fog-clouds\.svg/);
  assert.equal(new Set(cloud.map((c) => c.position)).size, 3, "each square its own part of the bank");
});
