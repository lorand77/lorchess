"use strict";

// Crazyhouse on the real game page, both players in their own browser: the
// strips show the pockets, a pocket piece is dropped by a click and by a drag,
// and nothing in hand can be picked up while the opponent is on move. The
// variant is not in the catalogue yet, so the game is matched as an ordinary
// one and its row marked Crazyhouse before anyone joins (as in
// test/integration/crazyhouse.games.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, connectSocket, quickMatch, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const SQ = (a) => (a.charCodeAt(0) - 97) + (Number(a[1]) - 1) * 8;
const square = (page, a) => page.locator(`#board [data-sq="${SQ(a)}"]`);
const plies = (page, n) => page.waitForFunction((k) => chess.history.length === k, n);

async function crazyhouseGame(t) {
  const first = await signedInPage(browser, srv.baseUrl, t);
  const second = await signedInPage(browser, srv.baseUrl, t);
  const a = await connectSocket(srv.baseUrl, first.user.c.cookie());
  const b = await connectSocket(srv.baseUrl, second.user.c.cookie());
  const { gameId } = await quickMatch(a, b, { tc: "10+0" });
  db().prepare("UPDATE games SET variant = 'crazyhouse' WHERE id = ?").run(gameId);
  const rooms = require("../../src/game/rooms");
  rooms.clearTimers(rooms.getRoom(gameId));
  rooms.deleteRoom(gameId);
  a.close(); b.close();
  // Colours were drawn at random; each page knows its own once it has joined.
  const pages = [first.page, second.page];
  for (const page of pages) await page.goto(srv.baseUrl + "/game.html?id=" + gameId);
  for (const page of pages) await page.waitForFunction(() => moveSource && moveSource.kind === "remote");
  const colours = await Promise.all(pages.map((p) => p.evaluate(() => humanColor)));
  const white = colours[0] === "w" ? pages[0] : pages[1];
  const black = colours[0] === "w" ? pages[1] : pages[0];
  return { white, black };
}

async function clickMove(page, from, to) {
  await square(page, from).click();
  await square(page, to).click();
}

test("pockets fill from captures, and pieces drop by click and by drag", async (t) => {
  const { white, black } = await crazyhouseGame(t);
  assert.equal(await white.evaluate(() => chess.variant), "crazyhouse");
  assert.equal(await white.locator(".pocket-piece").count(), 0, "nothing in hand yet");

  await clickMove(white, "e2", "e4"); await plies(black, 1);
  await clickMove(black, "d7", "d5"); await plies(white, 2);
  await clickMove(white, "e4", "d5"); await plies(black, 3);
  await clickMove(black, "d8", "d5"); await plies(white, 4);

  // White holds a pawn, shown at the bottom of White's page and the top of Black's.
  const whitePawn = white.locator('#capturedBottom .pocket-piece[data-drag-from="@p"]');
  assert.equal(await whitePawn.count(), 1);
  assert.ok(await whitePawn.evaluate((el) => el.classList.contains("usable")));
  assert.equal(await black.locator("#capturedTop .pocket-piece").count(), 1);
  assert.equal(await black.locator("#capturedTop [data-drag-from]").count(), 0, "the opponent's pocket is not yours to drag");

  // No pre-drops: Black's pawn cannot be picked up on White's move.
  const blackPawn = black.locator('#capturedBottom .pocket-piece[data-drag-from="@p"]');
  assert.equal(await blackPawn.evaluate((el) => el.classList.contains("usable")), false);
  await blackPawn.click();
  assert.equal(await black.evaluate(() => dropSelected), null);

  // White drops by clicking the pawn, then the square; the hints are the drop squares.
  await whitePawn.click();
  assert.equal(await white.evaluate(() => dropSelected), "p");
  assert.equal(await white.locator("#board .hint").count(), 33);
  await square(white, "e4").click();
  await plies(black, 5);
  assert.equal(await black.evaluate(() => chess.history[4].move.drop), "p");
  assert.equal(await white.locator("#capturedBottom .pocket-piece").count(), 0, "the pocket is empty again");

  // Black drops by dragging the pawn from the pocket onto d6.
  const from = await blackPawn.boundingBox();
  const to = await square(black, "d6").boundingBox();
  await black.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await black.mouse.down();
  await black.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 - 20, { steps: 3 });
  await black.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await black.mouse.up();
  await plies(white, 6);
  assert.deepEqual(await white.evaluate(() => chess.squares[43]), { t: "p", c: "b" });
  assert.equal(await black.evaluate(() => chess.pocketText()), "");
  assert.deepEqual(await white.evaluate(() => moveHistory.slice(-2)), ["P@e4", "P@d6"]);
});
