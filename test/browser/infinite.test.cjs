"use strict";

// Infinite chess on the real pages. A spectator's window onto the board with
// no edges: framed on the pieces, labelled with coordinates, following a move
// far off, with markers for pieces off screen, zoom and drag-to-pan. Two
// players moving by click (with hint dots) and by drag, a promotion through
// the dialog, the game exported as ICN (and read back), its thumbnail in the
// lobby, and its replay.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, openBrowser, signedInPage, registerUser, connectSocket, quickMatch, emitAck, db,
} = require("./helpers.cjs");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
const { moveFromUci } = require("../../src/shared/uci");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const camera = (page) => page.evaluate(() => boardView.camera());
const square = (page, x, y) => page.locator(`#board .square[data-sq="${x},${y}"]`);
const pieceOn = (page, x, y) => square(page, x, y).locator("img.piece").getAttribute("alt");
const plies = (page, n) => page.waitForFunction((k) => chess.history.length === k, n);

// Two players, matched as infinite chess; with `start`, the game's start is
// rewritten and its room forgotten, so it's rebuilt from there.
async function match(cookies, start) {
  const [a, b] = await Promise.all(cookies.map((c) => connectSocket(srv.baseUrl, c)));
  const game = await quickMatch(a, b, { tc: "10+0", variant: "infinite" });
  if (start) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, game.gameId);
    const rooms = require("../../src/game/rooms");
    rooms.clearTimers(rooms.getRoom(game.gameId));
    rooms.deleteRoom(game.gameId);
  }
  return game;
}

// Both players in their own browser, on the game page.
async function twoPages(t, start) {
  const first = await signedInPage(browser, srv.baseUrl, t);
  const second = await signedInPage(browser, srv.baseUrl, t);
  const { gameId, white, black } = await match([first.user.c.cookie(), second.user.c.cookie()], start);
  white.close(); black.close();
  const pages = [first.page, second.page];
  for (const page of pages) {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(srv.baseUrl + "/game.html?id=" + gameId);
  }
  for (const page of pages) await page.waitForFunction(() => moveSource && moveSource.kind === "remote" && chess instanceof InfiniteChess);
  const colours = await Promise.all(pages.map((p) => p.evaluate(() => humanColor)));
  const whiteFirst = colours[0] === "w";
  return {
    gameId,
    white: whiteFirst ? pages[0] : pages[1],
    black: whiteFirst ? pages[1] : pages[0],
    whiteName: (whiteFirst ? first : second).user.user.username,
  };
}

async function drag(page, from, to) {
  const a = await square(page, ...from).boundingBox();
  const b = await square(page, ...to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("a spectator's window onto the board follows, frames, zooms and pans", async (t) => {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const { gameId, white, black } = await match([alice.c.cookie(), bob.c.cookie()]);
  t.after(() => { white.close(); black.close(); });
  await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  const play = async (socket, from, to) => assert.deepEqual(
    await emitAck(socket, "move:make", { gameId, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } }),
    { ok: true });

  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.baseUrl + "/game.html?watch=" + gameId);
  await page.waitForFunction(() => moveSource && moveSource.kind === "spectator" && chess instanceof InfiniteChess);

  // Framed on the pieces: x and y from 0 to 9, labelled with coordinates.
  assert.deepEqual(await camera(page), { left: 0, bottom: 0, size: 10 });
  assert.equal(await page.locator("#board .square").count(), 100);
  assert.equal(await pieceOn(page, 1, 1), "wr");
  assert.equal(await square(page, 0, 0).locator(".coord.rank").textContent(), "0");
  assert.equal(await square(page, 9, 0).locator(".coord.file").textContent(), "9");
  assert.equal(await page.locator(".edge-marker").count(), 0, "everything is on screen");

  // A bishop flies a thousand squares off: the window goes with it, and the
  // 31 pieces left at home are markers on the edge.
  await play(white, [5, 2], [5, 4]);
  await play(black, [5, 7], [5, 5]);
  await play(white, [6, 1], [-994, 1001]);
  await plies(page, 3);
  await page.waitForTimeout(300);
  assert.equal(await pieceOn(page, -994, 1001), "wb");
  const markers = page.locator(".edge-marker");
  const counted = await page.locator(".edge-marker .edge-count").allTextContents();
  assert.equal(counted.reduce((n, c) => n + Number(c), 0) + (await markers.count()) - counted.length, 31);

  // Frame the pieces again — too spread out, so those around White's king —
  // and the bishop's marker leads back to it.
  await page.locator(".infinite-tools button[title='Frame the pieces']").click();
  assert.deepEqual(await camera(page), { left: 0, bottom: 0, size: 10 });
  const bishop = page.locator(".edge-marker[data-target='-994,1001']");
  assert.match(await bishop.getAttribute("title"), /B at -994,1001/);
  await bishop.click();
  assert.equal(await pieceOn(page, -994, 1001), "wb");

  // Zoom (8 to 40 squares) and drag-to-pan.
  await page.locator(".infinite-tools button[title='Frame the pieces']").click();
  await page.locator(".infinite-tools button[title='Zoom in']").click();
  assert.equal((await camera(page)).size, 8);
  await page.locator(".infinite-tools button[title='Zoom out']").click();
  await page.locator(".infinite-tools button[title='Zoom out']").click();
  assert.equal((await camera(page)).size, 16);
  const before = await camera(page);
  const box = await page.locator("#board").boundingBox();
  const sq = box.width / before.size;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 2 * sq, box.y + box.height / 2 + sq, { steps: 6 });
  await page.mouse.up();
  const after = await camera(page);
  assert.deepEqual([after.left, after.bottom], [before.left - 2, before.bottom + 1]);

  // A spectator's click selects nothing.
  await square(page, 5, 1).click();
  assert.equal(await page.evaluate(() => selected), null);
});

test("two players move by click and drag; the game exports as ICN, shows in the lobby and replays", async (t) => {
  const { gameId, white, black, whiteName } = await twoPages(t);
  const both = async (n) => { await plies(white, n); await plies(black, n); };
  assert.equal(await white.locator("#tcLine").textContent(), "Rapid 10+0 · casual · Infinite Chess");
  assert.equal(await white.locator("#historyTitle").textContent(), "ICN");

  // Click to select: the pawn's two moves show as dots; click one to play it.
  await square(white, 5, 2).click();
  assert.ok(await square(white, 5, 3).locator(".hint").count());
  assert.ok(await square(white, 5, 4).locator(".hint").count());
  assert.equal(await white.locator("#board .hint").count(), 2);
  await square(white, 5, 4).click();
  await both(1);

  // Drag: Black's knight out.
  await drag(black, [7, 8], [6, 6]);
  await both(2);
  assert.equal(await pieceOn(white, 6, 6), "bn");

  // Zoom out, and the bishop's diagonal runs far off the usual board.
  for (let i = 0; i < 3; i++) await white.locator(".infinite-tools button[title='Zoom out']").click();
  await square(white, 6, 1).click();
  assert.ok(await square(white, -5, 12).locator(".hint").count(), "a hint eleven squares off the board");
  await square(white, -5, 12).click();
  await both(3);
  assert.deepEqual(await black.evaluate(() => moveHistory), ["P5,2>5,4", "n7,8>6,6", "B6,1>-5,12"]);

  // The ICN export reads back, through our own engine, to the same position.
  const icn = await white.locator("#history").textContent();
  assert.match(icn, /\[Variant "Classical"\]/);
  assert.match(icn, /1\. 5,2>5,4 \| 7,8>6,6 2\. 6,1>-5,12/);
  const lines = icn.split("\n");
  const replayed = new InfiniteChess();
  replayed.loadFen(lines.find((l) => l.startsWith("w ")));
  for (const move of icn.match(/-?\d+,-?\d+>-?\d+,-?\d+[QRBNqrbn]?/g)) replayed.makeMove(moveFromUci(replayed, move));
  assert.equal(replayed.fen(), await white.evaluate(() => chess.fen()));

  // The lobby's live game shows an 8x8 window around the kings.
  const { page: lobby } = await signedInPage(browser, srv.baseUrl, t);
  await lobby.goto(srv.baseUrl + "/lobby.html");
  const card = lobby.locator(".live-game", { hasText: whiteName });
  await card.locator(".mini-board .mini-square").first().waitFor();
  assert.equal(await card.locator(".mini-board .mini-square").count(), 64);
  assert.ok(await card.locator(".mini-board img").count() > 20);

  // Resign, then replay: the same window, read-only, and no review.
  white.once("dialog", (d) => d.accept()); // "Resign this game?"
  const over = black.waitForFunction(() => pvpResult !== null);
  await white.locator("#resignBtn").click();
  await over;
  await white.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await white.waitForFunction(() => idx === 3);
  assert.equal(await pieceOn(white, -5, 12), "wb");
  await white.evaluate(() => goto(2));
  assert.equal(await pieceOn(white, 6, 1), "wb", "back two plies the bishop is home");
  assert.equal(
    await white.locator("#reviewStart").textContent(),
    "Stockfish plays standard chess, so it can't review an Infinite Chess game."
  );
});

test("a pawn promotes through the dialog", async (t) => {
  const { white, black } = await twoPages(t, "w 0/100 1 (8|1) checkmate K1,1|R3,1|k8,8|P1,7|r6,8");
  await drag(white, [1, 7], [1, 8]);
  await white.waitForSelector("#promo.show");
  assert.equal(await white.locator("#promoOptions .opt").count(), 4);
  await white.locator('#promoOptions .opt[title="rook"]').click();
  await plies(black, 1);
  assert.equal(await pieceOn(black, 1, 8), "wr");
  assert.deepEqual(await black.evaluate(() => moveHistory), ["P1,7>1,8=R"]);
});
