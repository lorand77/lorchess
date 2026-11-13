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
  // Not a choice for two-player offers; a panel of its own instead.
  const offerVariants = await page.locator("#variantSelect option").evaluateAll((os) => os.map((o) => o.value));
  assert.ok(!offerVariants.includes("bughouse"), offerVariants.join(" "));
  await page.locator("#bughouseLevelSelect").selectOption("novice");
  await page.locator("#bughousePlayBtn").click();
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
