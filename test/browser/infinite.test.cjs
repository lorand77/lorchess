"use strict";

// Infinite chess on the real game page, watched by a spectator while two
// players move over the socket: the board is a window onto the board with no
// edges, framed on the pieces, labelled with coordinates; a move far off
// brings the window to it; pieces off screen are markers on the edge, one of
// which brings the window back; zoom and drag-to-pan move it about; clicking
// selects nothing (the view is read-only for now). Infinite chess is not in
// the variant catalogue yet, so the game is matched as an ordinary one and
// its row marked infinite before anyone joins (as in
// test/integration/infinite.games.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, openBrowser, signedInPage, registerUser, connectSocket, quickMatch, emitAck, waitFor, db,
} = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

async function infiniteGame() {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
  db().prepare("UPDATE games SET variant = 'infinite' WHERE id = ?").run(gameId);
  const rooms = require("../../src/game/rooms");
  rooms.clearTimers(rooms.getRoom(gameId));
  rooms.deleteRoom(gameId);
  await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black };
}

async function play(socket, gameId, from, to) {
  const res = await emitAck(socket, "move:make", { gameId, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } });
  assert.deepEqual(res, { ok: true }, `${from} > ${to}`);
}

const camera = (page) => page.evaluate(() => boardView.camera());
const square = (page, x, y) => page.locator(`#board .square[data-sq="${x},${y}"]`);
const pieceOn = (page, x, y) => square(page, x, y).locator("img.piece").getAttribute("alt");

test("a spectator's window onto the board follows, frames, zooms and pans", async (t) => {
  const { gameId, white, black } = await infiniteGame();
  t.after(() => { white.close(); black.close(); });
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.baseUrl + "/game.html?watch=" + gameId);
  await page.waitForFunction(() => moveSource && moveSource.kind === "spectator" && chess instanceof InfiniteChess);

  // Framed on the pieces: x and y from 0 to 9, labelled with coordinates.
  assert.deepEqual(await camera(page), { left: 0, bottom: 0, size: 10 });
  assert.equal(await page.locator("#board .square").count(), 100);
  assert.equal(await pieceOn(page, 1, 1), "wr");
  assert.equal(await pieceOn(page, 5, 8), "bk");
  assert.equal(await square(page, 0, 0).locator(".coord.rank").textContent(), "0");
  assert.equal(await square(page, 9, 0).locator(".coord.file").textContent(), "9");
  assert.equal(await page.locator(".edge-marker").count(), 0, "everything is on screen");

  // A bishop flies a thousand squares off: the window goes with it.
  await play(white, gameId, [5, 2], [5, 4]);
  await play(black, gameId, [5, 7], [5, 5]);
  const seen = page.waitForFunction(() => chess.history.length === 3);
  await play(white, gameId, [6, 1], [-994, 1001]);
  await seen;
  await page.waitForTimeout(300);
  assert.equal(await pieceOn(page, -994, 1001), "wb");
  assert.ok(await square(page, -994, 1001).evaluate((el) => el.classList.contains("last-move")));
  // Everything else is back home: markers on the edge, towards it, with a count.
  const markers = page.locator(".edge-marker");
  assert.ok(await markers.count() >= 1);
  const counted = await page.locator(".edge-marker .edge-count").allTextContents();
  assert.equal(counted.reduce((n, c) => n + Number(c), 0) + (await markers.count()) - counted.length, 31,
    "the 31 other pieces are all accounted for");
  await page.screenshot({ path: "/tmp/infinite-follow.png" });

  // Frame the pieces again: too spread out, so those around White's king.
  await page.locator(".infinite-tools button[title='Frame the pieces']").click();
  assert.deepEqual(await camera(page), { left: 0, bottom: 0, size: 10 });
  const bishop = page.locator(".edge-marker[data-target='-994,1001']");
  assert.equal(await bishop.count(), 1);
  assert.match(await bishop.getAttribute("title"), /B at -994,1001/);
  await page.screenshot({ path: "/tmp/infinite-home.png" });
  // Its marker takes the window there.
  await bishop.click();
  assert.equal(await pieceOn(page, -994, 1001), "wb");

  // Zoom in and out, about the middle of the window.
  await page.locator(".infinite-tools button[title='Frame the pieces']").click();
  await page.locator(".infinite-tools button[title='Zoom in']").click();
  assert.equal((await camera(page)).size, 8, "no closer than 8 squares");
  await page.locator(".infinite-tools button[title='Zoom out']").click();
  await page.locator(".infinite-tools button[title='Zoom out']").click();
  assert.equal((await camera(page)).size, 16);
  assert.equal(await page.locator("#board .square").count(), 256);

  // Drag to pan: two squares' worth to the right moves the window two left.
  const before = await camera(page);
  const box = await page.locator("#board").boundingBox();
  const sq = box.width / before.size;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 2 * sq, box.y + box.height / 2 + sq, { steps: 6 });
  await page.mouse.up();
  const after = await camera(page);
  assert.deepEqual([after.left, after.bottom], [before.left - 2, before.bottom + 1]);

  // Read-only: a click selects nothing, and nothing breaks.
  await page.locator(".infinite-tools button[title='Frame the pieces']").click();
  await square(page, 5, 1).click();
  assert.equal(await page.evaluate(() => selected), null);
  assert.equal(await page.locator("#board .selected").count(), 0);
});
