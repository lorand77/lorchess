"use strict";

// Antichess on the real game page, both players in their own browser: picking
// up a piece that can't capture while a capture is compulsory says so and
// marks the pieces that can; a pawn promotes to a king through the dialog; and
// a side left without a move is told it has won, on the game page and in the
// replay. The game is casual Antichess and says so, with no review on offer.
// The lobby only starts from the catalogue's position, so the endgame is set
// up by rewriting the game's start before anyone joins, as in
// test/integration/antichess.games.test.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, connectSocket, quickMatch, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const SQ = (a) => (a.charCodeAt(0) - 97) + (Number(a[1]) - 1) * 8;
const square = (page, a) => page.locator(`#board [data-sq="${SQ(a)}"]`);
const plies = (page, n) => page.waitForFunction((k) => chess.history.length === k, n);

async function antichessGame(t, start) {
  const first = await signedInPage(browser, srv.baseUrl, t);
  const second = await signedInPage(browser, srv.baseUrl, t);
  const a = await connectSocket(srv.baseUrl, first.user.c.cookie());
  const b = await connectSocket(srv.baseUrl, second.user.c.cookie());
  const { gameId } = await quickMatch(a, b, { tc: "10+0", variant: "antichess" });
  db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, gameId);
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
  return { white, black, gameId };
}

test("a forced capture is explained, a pawn becomes a king, and running out of moves wins", async (t) => {
  // White must take the rook with the a-pawn; the h-pawn is blocked. After
  // axb8=K Black's king must take it, and White, left with the blocked pawn,
  // has no move: White wins.
  const { white, black, gameId } = await antichessGame(t, "1r6/P1k5/8/8/8/7p/7P/8 w - - 0 1");
  const both = async (n) => { await plies(white, n); await plies(black, n); };
  assert.equal(await white.locator("#tcLine").textContent(), "Rapid 10+0 · casual · Antichess");

  // The blocked pawn has nothing to take, and a capture is on the board.
  await square(white, "h2").click();
  assert.equal(await white.locator("#status").textContent(), "You must capture");
  assert.equal(await white.locator("#board .must-capture").count(), 1);
  assert.ok(await square(white, "a7").evaluate((el) => el.classList.contains("must-capture")));
  assert.equal(await white.locator("#board .hint").count(), 0);
  // Being up material is no advantage here, so no "+N" is shown.
  assert.equal(await white.locator(".cap-adv").count(), 0);

  // Picking up the pawn that can capture clears the hint and offers the capture.
  await square(white, "a7").click();
  assert.equal(await white.locator("#status").textContent(), "");
  assert.equal(await white.locator("#board .must-capture").count(), 0);
  assert.equal(await white.locator("#board .hint").count(), 1);
  await square(white, "b8").click();
  assert.equal(await white.locator("#promoOptions .opt").count(), 5, "a king among the choices");
  await white.locator('#promoOptions .opt[title="king"]').click();
  await both(1);
  assert.deepEqual(await black.evaluate(() => chess.squares[57]), { t: "k", c: "w" });

  // Black's king has to take it.
  await square(black, "c7").click();
  await square(black, "b8").click();
  await both(2);

  const won = "Game Over: 1-0 — White wins with no moves left!";
  await white.waitForFunction((text) => document.getElementById("status").textContent === text, won);
  assert.equal(await black.locator("#status").textContent(), won);
  assert.deepEqual(await white.evaluate(() => moveHistory), ["axb8=K", "Kxb8"]);
  assert.ok((await white.locator("#history").textContent()).includes('[Variant "Antichess"]'));
  assert.equal(await white.locator("#reviewLinkWrap").isVisible(), false, "Stockfish can't review it");

  await white.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await white.waitForFunction(() => idx === 2);
  assert.equal(await white.locator("#replayStatus").textContent(), "White wins with no moves left");
  assert.equal(
    await white.locator("#reviewStart").textContent(),
    "Stockfish plays standard chess, so it can't review an Antichess game."
  );
});
