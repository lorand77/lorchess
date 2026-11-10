"use strict";

// LorFish in a variant, through the real pages: the lobby's "Play the
// computer" form offers the variants it plays, and in any but standard chess
// names the levels without their ratings (those were measured in standard);
// the game starts from the variant's own position, recorded by the server,
// LorFish answers a move, and a reload resumes the same game.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const chess960 = require("../../src/shared/chess960");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const ready = (page) => page.waitForFunction(() => gameStore.currentId() != null && !thinking);

test("a Chess960 game against LorFish, from the lobby to a resumed game", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");

  // Only the variants LorFish plays; the levels lose their ratings outside standard.
  const variants = await page.locator("#aiVariantSelect option").evaluateAll((os) => os.map((o) => o.value));
  assert.deepEqual(variants, ["standard", "chess960", "pawnwars"]);
  assert.equal(await page.locator("#aiLevelSelect option[value='casual']").textContent(), "Casual (~1000)");
  await page.locator("#aiVariantSelect").selectOption("chess960");
  assert.equal(await page.locator("#aiLevelSelect option[value='casual']").textContent(), "Casual");
  await page.locator("#aiLevelSelect").selectOption("casual");
  await page.locator("#aiPlayBtn").click();

  await page.waitForURL(/variant=chess960/);
  const id = await (async () => { await ready(page); return page.evaluate(() => gameStore.currentId()); })();
  const start = await page.evaluate(() => startFen);
  assert.ok(chess960.isStartFen(start), start);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Casual · Chess960");
  assert.equal(await page.locator("#loadFenBtn").isDisabled(), true, "a variant starts from its own position");
  const row = db().prepare("SELECT variant, start_fen FROM games WHERE id = ?").get(id);
  assert.deepEqual(row, { variant: "chess960", start_fen: start });

  // A move of ours; LorFish answers (from the worker, told the variant).
  await page.locator('#board [data-sq="8"]').click();   // a2
  await page.locator('#board [data-sq="16"]').click();  // a3
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  const pgn = await page.locator("#history").textContent();
  assert.match(pgn, /\[Variant "Chess960"\]/);
  assert.ok(pgn.includes(`[FEN "${start}"]`), pgn);

  // A reload resumes it: same variant, same start, same moves.
  const fen = await page.evaluate(() => chess.fen());
  await page.waitForLoadState("networkidle");
  await page.reload();
  await ready(page);
  assert.deepEqual(
    await page.evaluate(() => [gameStore.currentId(), gameVariant, startFen, chess.fen(), chess.history.length]),
    [id, "chess960", start, fen, 2]
  );
  assert.equal(await page.locator("#aiLevelText").textContent(), "Casual · Chess960");
});

test("a Pawn Wars game against LorFish starts from its own position, and LorFish answers", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("pawnwars");
  await page.locator("#aiLevelSelect").selectOption("intermediate");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=pawnwars/);
  await ready(page);
  const PAWN_WARS = "pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1";
  assert.equal(await page.evaluate(() => chess.fen()), PAWN_WARS);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Intermediate · Pawn Wars");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.deepEqual(db().prepare("SELECT variant, start_fen FROM games WHERE id = ?").get(id),
    { variant: "pawnwars", start_fen: PAWN_WARS });

  await page.locator('#board [data-sq="3"]').click();   // d1
  await page.locator('#board [data-sq="19"]').click();  // d3, a double step
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => chess.pawnCount("w") + chess.pawnCount("b")), 16);
  assert.match(await page.locator("#history").textContent(), /\[Variant "Pawn Wars"\]/);

  // How a won game reads: put the last black pawn's capture on the board.
  await page.evaluate(() => { chess.loadFen("8/8/8/8/8/8/8/P7 b - - 0 1"); render(); });
  assert.equal(await page.locator("#status").textContent(), "Game Over: 1-0 — White wins: no black pawns left!");
});

