"use strict";

// Bughouse on the real pages, against LorFish: the lobby starts a match (you
// and LorFish against two more), the game page shows your board and, beside
// it, the other board as LorFish plays it; a piece arriving from that board
// fills your pocket and drops by click; calls go to your partner; resigning
// says the match is lost.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const rooms = require("../../src/game/rooms");
const bots = require("../../src/game/bots");

let srv, browser;

// LorFish on the other board can end the whole match at any moment (a novice
// LorFish mates, and is mated, quickly). Once a test has seen it play, its
// seats are taken off it, so the steps that follow can't be cut short.
const boardOf = (gameId, board) =>
  db().prepare("SELECT id FROM games WHERE match_id = (SELECT match_id FROM games WHERE id = ?) AND board = ?").get(gameId, board).id;
function stopBots(gameId) {
  const room = rooms.getRoom(gameId);
  if (room) room.bots = null;
}
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
  await bots.shutdown();
});

test("a Bughouse match against LorFish, from the lobby to a lost match", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.baseUrl + "/lobby.html");
  // Bughouse in "Play the computer": no colour to pick, a clock instead, and
  // a match with LorFish rather than an AI game.
  await page.locator("#aiVariantSelect").selectOption("bughouse");
  assert.equal(await page.locator("#aiColorSelect").isVisible(), false);
  assert.equal(await page.locator("#aiClockSelect").isVisible(), true);
  assert.match(await page.locator("#aiNote").textContent(), /two more LorFish/);
  assert.equal(await page.locator("#aiLevelSelect option[value='casual']").textContent(), "Casual", "named, not rated");
  await page.locator("#aiLevelSelect").selectOption("novice");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/game\.html\?id=\d+/);
  const gameId = Number(new URL(page.url()).searchParams.get("id"));

  await page.waitForFunction(() => chess.isBughouse && lastPvpState && lastPvpState.match);
  assert.equal(await page.locator("#bughousePanel").isVisible(), true);
  assert.equal(await page.locator("#partnerTopWho").textContent(), "LorFish");
  assert.equal(await page.locator("#partnerBottomWho").textContent(), "LorFish");
  assert.match(await page.locator("#tcLine").textContent(), /casual · Bughouse/);
  assert.equal(await page.locator("#drawBtn").isVisible(), false, "no draws in Bughouse yet");
  assert.equal(await page.locator("#bughouseCalls button").count(), 10);

  // LorFish plays the other board by itself; it shows beside ours.
  await page.waitForFunction(() => partner && partner.san, null, { timeout: 10000 });
  stopBots(boardOf(gameId, 1));
  assert.ok(await page.locator("#partnerBoard img").count() > 20, "the other board is drawn");
  assert.match(await page.locator("#partnerPockets").textContent(), /^In hand: White .* · Black /);

  // Our move, and LorFish's answer.
  await page.locator('#board [data-sq="12"]').click();  // e2
  await page.locator('#board [data-sq="28"]').click();  // e4
  await page.waitForFunction(() => chess.history.length === 2, null, { timeout: 10000 });

  // A knight arrives from the other board — as the server passes one on — and
  // drops from the pocket by click. LorFish's captures on the other board send
  // pieces too, whenever they happen: counts are taken relative, and the
  // knight is picked by name.
  const knights = await page.evaluate(() => chess.pockets.w.n);
  rooms.getRoom(gameId).chess.receive("w", "n");
  srv.io.to(`game:${gameId}`).emit("bughouse:received", { piece: { t: "n", c: "w" }, fen: rooms.getRoom(gameId).chess.fen() });
  await page.waitForFunction((n) => chess.pockets.w.n > n, knights);
  await page.locator('#capturedBottom .pocket-piece[data-drag-from="@n"]').click();
  await page.locator('#board [data-sq="20"]').click();  // N@e3
  await page.waitForFunction(() => chess.history.some((h) => h.move.drop === "n" && h.turn === "w"), null, { timeout: 10000 });
  const stored = db().prepare("SELECT san FROM moves WHERE game_id = ? AND ply = 3").get(gameId);
  assert.equal(stored.san, "N@e3");

  // A call: to our partner (LorFish, who doesn't listen), shown where calls are.
  await page.locator('#bughouseCalls button[data-call="need-n"]').click();
  await page.waitForFunction(() => document.getElementById("bughouseHeard").textContent === "You: Need a knight");

  // Resigning loses the match, for both boards.
  page.once("dialog", (d) => d.accept());
  await page.locator("#resignBtn").click();
  await page.waitForFunction(() => pvpResult && pvpResult.match);
  assert.match(await page.locator("#status").textContent(), /your team loses the match/);
  assert.equal(await page.locator("#bughouseCalls").isVisible(), false, "no calls once it is over");

  // How a turn with no move reads: White checked along the back rank, with
  // nothing in hand to block (the page's own board, for the status line only).
  const waiting = await page.evaluate(() => {
    const over = pvpResult;
    pvpResult = null;
    chess.loadFen("k7/8/8/8/8/8/6PP/r6K[] w - - 0 1");
    render();
    const text = document.getElementById("status").textContent;
    pvpResult = over;
    return text;
  });
  assert.equal(waiting, "No move: wait for your partner to send a piece. Your clock is running.");
});

test("a table: a friend sits as partner, the host starts, and calls cross between them", async (t) => {
  const host = await signedInPage(browser, srv.baseUrl, t);
  const friend = await signedInPage(browser, srv.baseUrl, t);
  for (const { page } of [host, friend]) {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(srv.baseUrl + "/lobby.html");
  }
  // Bughouse in the Play panel: a table instead of a quick match or an offer,
  // and no one-to-one challenge from the players list either.
  await host.page.locator("#variantSelect").selectOption("bughouse");
  for (const id of ["quickMatchBtn", "seekBtn", "colorSelect", "ratedCheck", "handicapBtn"]) {
    assert.equal(await host.page.locator("#" + id).isVisible(), false, id);
  }
  const challenge = host.page.locator("#playerList button", { hasText: "Challenge" });
  await challenge.waitFor();
  assert.equal(await challenge.isDisabled(), true, "Bughouse isn't offered one to one");
  await host.page.locator("#tableLevelSelect").selectOption("novice");
  await host.page.locator("#tableOpenBtn").click();
  // Listed with the open challenges, which count it.
  await friend.page.locator("#seekCount", { hasText: "(1)" }).waitFor();
  // The friend sees the table and takes the host's partner seat: Black on board 2.
  const seat = friend.page.locator('#tableList [data-seat="A1"] button');
  await seat.waitFor();
  assert.equal(await seat.textContent(), "Sit: Black, team A");
  await seat.click();
  await host.page.locator('#tableList [data-seat="A1"]', { hasText: friend.user.user.username }).waitFor();
  await host.page.locator("#tableList button", { hasText: "Start now" }).click();

  for (const { page } of [host, friend]) {
    await page.waitForURL(/game\.html\?id=\d+/);
    await page.waitForFunction(() => chess.isBughouse && partner);
  }
  assert.deepEqual(await host.page.evaluate(() => [lastPvpState.match.board, humanColor]), [0, "w"]);
  assert.deepEqual(await friend.page.evaluate(() => [lastPvpState.match.board, humanColor]), [1, "b"]);
  // Each sees the other at the bottom of the board beside theirs.
  assert.equal(await host.page.locator("#partnerBottomWho").textContent(), friend.user.user.username);
  assert.equal(await friend.page.locator("#partnerBottomWho").textContent(), host.user.user.username);

  await host.page.locator('#bughouseCalls button[data-call="sit"]').click();
  await friend.page.waitForFunction((name) => document.getElementById("bughouseHeard").textContent === `${name}: I'm stalling`,
    host.user.user.username);

  host.page.once("dialog", (d) => d.accept());
  await host.page.locator("#resignBtn").click();
  await friend.page.waitForFunction(() => pvpResult && pvpResult.match);
  assert.match(await friend.page.locator("#status").textContent(), /on the other board · your team loses the match/);
});

test("a match watched with both boards, and its boards replayed with the match", async (t) => {
  const player = await signedInPage(browser, srv.baseUrl, t);
  const watcher = await signedInPage(browser, srv.baseUrl, t);
  const me = player.user.user.username;
  await player.page.setViewportSize({ width: 1400, height: 1000 });
  await watcher.page.setViewportSize({ width: 1400, height: 1000 });
  await player.page.goto(srv.baseUrl + "/lobby.html");
  await player.page.locator("#aiVariantSelect").selectOption("bughouse");
  await player.page.locator("#aiLevelSelect").selectOption("novice");
  await player.page.locator("#aiPlayBtn").click();
  await player.page.waitForURL(/game\.html\?id=\d+/);
  const board0 = Number(new URL(player.page.url()).searchParams.get("id"));
  const board1 = boardOf(board0, 1);
  await player.page.waitForFunction(() => chess.isBughouse && partner);
  await player.page.locator('#board [data-sq="12"]').click();  // e2
  await player.page.locator('#board [data-sq="28"]').click();  // e4

  // Watching board 2 — LorFish against LorFish — shows board 1 beside it.
  await watcher.page.goto(srv.baseUrl + "/game.html?watch=" + board1);
  await watcher.page.waitForFunction(() => chess.isBughouse && partner && spectating);
  assert.equal(await watcher.page.locator("#partnerBottomWho").textContent(), me, "board 1's White, from White's side");
  assert.equal(await watcher.page.locator("#bughouseCalls").isVisible(), false, "a watcher calls nobody");
  await watcher.page.waitForFunction(() => chess.history.length >= 4, null, { timeout: 15000 });
  stopBots(board1);

  player.page.once("dialog", (d) => d.accept());
  await player.page.locator("#resignBtn").click();
  await watcher.page.waitForFunction(() => pvpResult && pvpResult.match);
  assert.match(await watcher.page.locator("#status").textContent(), /on the other board · team B wins the match/);

  // Both boards replay with the match, to the position the server stored at the end.
  for (const [id, n] of [[board0, 1], [board1, 2]]) {
    await player.page.goto(srv.baseUrl + "/replay.html?id=" + id);
    await player.page.waitForFunction(() => match && other);
    assert.equal(await player.page.locator("#replayTitle").textContent(), `Bughouse · board ${n} of 2`);
    assert.equal(await player.page.locator("#otherBoard").isVisible(), true);
    const stored = db().prepare("SELECT current_fen FROM games WHERE id = ?").get(id).current_fen;
    assert.equal(await player.page.evaluate(() => chess.fen()), stored, `board ${n} ends where the server says`);
    assert.match(await player.page.locator("#replayStatus").textContent(), /team B won the match$/);
    const otherId = n === 1 ? board1 : board0;
    assert.equal(await player.page.locator("#otherBoardLink").getAttribute("href"), "/replay.html?id=" + otherId);
    // Before this board's first move: the starting position, with whatever
    // the other board had already passed across by then.
    await player.page.locator("#firstBtn").click();
    assert.match(await player.page.evaluate(() => chess.fen()), /^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR\[[A-Za-z]*\] w KQkq - 0 1$/);
  }
  assert.match(await player.page.locator("#replayStatus").textContent(), /^White wins on the other board/);
});
