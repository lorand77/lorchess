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
  assert.deepEqual(variants, ["standard", "chess960"]);
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
