"use strict";

// Crazyhouse on the real pages, both players in their own browser: the game
// page's strips show the pockets, a pocket piece is dropped by a click and by
// a drag, and on the opponent's move queued as a pre-drop, which plays when
// the turn comes if its square is empty then and is dropped if not;
// a spectator sees the pockets and the drops; the page says the game is casual
// Crazyhouse and the exported PGN names the variant; the replay shows what was
// in hand at each point, and says Stockfish cannot review it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, connectSocket, quickMatch, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const SQ = (a) => (a.charCodeAt(0) - 97) + (Number(a[1]) - 1) * 8;
const square = (page, a) => page.locator(`#board [data-sq="${SQ(a)}"]`);
const SQ_E4 = 28;
const plies = (page, n) => page.waitForFunction((k) => chess.history.length === k, n);

async function crazyhouseGame(t) {
  const first = await signedInPage(browser, srv.baseUrl, t);
  const second = await signedInPage(browser, srv.baseUrl, t);
  const a = await connectSocket(srv.baseUrl, first.user.c.cookie());
  const b = await connectSocket(srv.baseUrl, second.user.c.cookie());
  const { gameId } = await quickMatch(a, b, { tc: "10+0", variant: "crazyhouse" });
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

async function clickMove(page, from, to) {
  await square(page, from).click();
  await square(page, to).click();
}

test("pockets fill from captures, and pieces drop by click and by drag", async (t) => {
  const { white, black, gameId } = await crazyhouseGame(t);
  assert.equal(await white.evaluate(() => chess.variant), "crazyhouse");
  assert.equal(await white.locator("#tcLine").textContent(), "Rapid 10+0 · casual · Crazyhouse");
  assert.equal(await white.locator(".pocket-piece").count(), 0, "nothing in hand yet");

  // Each page applies a move when the server echoes it, its own moves
  // included, so every step waits for both pages.
  const both = async (n) => { await plies(white, n); await plies(black, n); };
  await clickMove(white, "e2", "e4"); await both(1);
  await clickMove(black, "d7", "d5"); await both(2);
  await clickMove(white, "e4", "d5"); await both(3);
  await clickMove(black, "d8", "d5"); await both(4);

  // White holds a pawn, shown at the bottom of White's page and the top of Black's.
  const whitePawn = white.locator('#capturedBottom .pocket-piece[data-drag-from="@p"]');
  assert.equal(await whitePawn.count(), 1);
  assert.ok(await whitePawn.evaluate((el) => el.classList.contains("usable")));
  assert.equal(await black.locator("#capturedTop .pocket-piece").count(), 1);
  assert.equal(await black.locator("#capturedTop [data-drag-from]").count(), 0, "the opponent's pocket is not yours to drag");

  // A spectator sees both pockets, White's at the bottom, and can use neither.
  const { page: watcher } = await signedInPage(browser, srv.baseUrl, t);
  await watcher.goto(srv.baseUrl + "/game.html?watch=" + gameId);
  await watcher.waitForFunction(() => moveSource && moveSource.kind === "spectator" && chess.history.length === 4);
  assert.equal(await watcher.locator("#capturedBottom .pocket-piece img[alt='wp']").count(), 1);
  assert.equal(await watcher.locator("#capturedTop .pocket-piece img[alt='bp']").count(), 1);
  assert.equal(await watcher.locator(".pocket-piece.usable").count(), 0);
  await watcher.locator("#capturedBottom .pocket-piece").click();
  assert.equal(await watcher.evaluate(() => dropSelected), null);

  // A pre-drop: on White's move Black picks up the pawn, and the hints are
  // every square that could be empty by Black's turn — none of Black's own,
  // and for a pawn not the first or last rank.
  const blackPawn = black.locator('#capturedBottom .pocket-piece[data-drag-from="@p"]');
  assert.ok(await blackPawn.evaluate((el) => el.classList.contains("usable")), "usable on White's move");
  await blackPawn.click();
  assert.deepEqual(await black.evaluate(() => [dropSelected, premoveSelecting]), ["p", true]);
  assert.equal(await black.locator("#board .hint.premove").count(), 40);
  await square(black, "e4").click();
  assert.deepEqual(await black.evaluate(() => premove), { drop: "p", to: SQ_E4 });
  assert.match(await black.locator("#turn").textContent(), /premove P@e4$/);
  assert.ok(await blackPawn.evaluate((el) => el.classList.contains("premove")));
  assert.ok(await square(black, "e4").evaluate((el) => el.classList.contains("premove")));

  // White drops by clicking the pawn, then the square; the hints are the drop
  // squares. That fills e4, so Black's pre-drop there is dropped, not played.
  await whitePawn.click();
  assert.equal(await white.evaluate(() => dropSelected), "p");
  assert.equal(await white.locator("#board .hint").count(), 33);
  await square(white, "e4").click();
  await both(5);
  assert.equal(await black.evaluate(() => chess.history[4].move.drop), "p");
  assert.equal(await white.locator("#capturedBottom .pocket-piece").count(), 0, "the pocket is empty again");
  assert.deepEqual(await black.evaluate(() => [premove, chess.history.length, chess.turn]), [null, 5, "b"]);
  assert.equal(await blackPawn.count(), 1, "still in hand");

  // Black moves; then, on White's move, drags the pawn onto d6: a pre-drop
  // by drag, played the moment White has moved.
  await clickMove(black, "g8", "f6"); await both(6);
  const from = await blackPawn.boundingBox();
  const to = await square(black, "d6").boundingBox();
  await black.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await black.mouse.down();
  await black.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 - 20, { steps: 3 });
  await black.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await black.mouse.up();
  assert.match(await black.locator("#turn").textContent(), /premove P@d6$/);
  await clickMove(white, "g1", "f3");
  await both(8);
  assert.deepEqual(await white.evaluate(() => chess.squares[43]), { t: "p", c: "b" });
  assert.equal(await black.evaluate(() => chess.pocketText()), "");
  assert.deepEqual(await white.evaluate(() => moveHistory.slice(4)), ["P@e4", "Nf6", "Nf3", "P@d6"]);
  const stored = db().prepare("SELECT san, premove FROM moves WHERE game_id = ? AND ply = 8").get(gameId);
  assert.deepEqual(stored, { san: "P@d6", premove: 1 }, "recorded as a premove");

  // The spectator saw both drops land.
  await plies(watcher, 8);
  assert.deepEqual(await watcher.evaluate(() => chess.squares[43]), { t: "p", c: "b" });

  // The exported PGN says which variant it is, so its drops read as moves.
  const pgn = await white.locator("#history").textContent();
  assert.ok(pgn.includes('[Variant "Crazyhouse"]'), pgn);
  assert.ok(pgn.includes("3. P@e4 Nf6 4. Nf3 P@d6"), pgn);

  // The replay shows what each side held at every point: nothing at the end,
  // a pawn each after move 4.
  await white.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await white.waitForFunction(() => idx === 8 && chess.history.length === 8);
  assert.equal(await white.locator(".pocket-piece").count(), 0);
  await white.evaluate(() => goto(4));
  assert.equal(await white.locator("#capturedBottom .pocket-piece img[alt='wp']").count(), 1);
  assert.equal(await white.locator("#capturedTop .pocket-piece img[alt='bp']").count(), 1);
  assert.equal(await white.locator("[data-drag-from]").count(), 0, "nothing to pick up in a replay");
  assert.equal(
    await white.locator("#reviewStart").textContent(),
    "Stockfish plays standard chess, so it can't review a Crazyhouse game."
  );
});

test("the lobby holds Rated off for Crazyhouse, and gives it back after", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.waitForFunction(() => !document.getElementById("seekBtn").disabled);
  const rated = page.locator("#ratedCheck");
  assert.equal(await rated.isChecked(), true);
  await page.locator("#variantSelect").selectOption("crazyhouse");
  assert.equal(await rated.isChecked(), false);
  assert.equal(await rated.isDisabled(), true);
  assert.equal(await rated.getAttribute("title"), "Crazyhouse games are casual for now");
  await page.locator("#variantSelect").selectOption("atomic");
  assert.equal(await rated.isChecked(), true, "the player's choice comes back");
  assert.equal(await rated.isDisabled(), false);
});
