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
  assert.deepEqual(variants, ["standard", "chess960", "atomic", "pawnwars", "crazyhouse", "antichess"]);
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

test("an Antichess game against LorFish: it must take what it is given", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("antichess");
  await page.locator("#aiLevelSelect").selectOption("advanced");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=antichess/);
  await ready(page);
  const ANTICHESS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1";
  assert.equal(await page.evaluate(() => chess.fen()), ANTICHESS);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Advanced · Antichess");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.deepEqual(db().prepare("SELECT variant, start_fen FROM games WHERE id = ?").get(id),
    { variant: "antichess", start_fen: ANTICHESS });

  // e4, then (unless LorFish's reply left us something we must take) Ba6
  // offers the bishop: a capture on the board is compulsory for LorFish too.
  await page.locator('#board [data-sq="12"]').click();  // e2
  await page.locator('#board [data-sq="28"]').click();  // e4
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  const mustTake = await page.evaluate(() => chess.legalMoves().some((m) => m.capture));
  if (!mustTake) {
    await page.locator('#board [data-sq="5"]').click();   // f1
    await page.locator('#board [data-sq="40"]').click();  // a6
    await page.waitForFunction(() => chess.history.length === 4 && !thinking, null, { timeout: 15000 });
    const reply = await page.evaluate(() => chess.history[3].move);
    assert.ok(reply.capture, "a capture on the board must be made");
  }
  assert.match(await page.locator("#history").textContent(), /\[Variant "Antichess"\]/);
});

test("an Atomic game against LorFish starts from the standard position, and LorFish answers", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("atomic");
  await page.locator("#aiLevelSelect").selectOption("intermediate");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=atomic/);
  await ready(page);
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.equal(await page.evaluate(() => chess.fen()), START);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Intermediate · Atomic");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.deepEqual(db().prepare("SELECT variant, start_fen FROM games WHERE id = ?").get(id),
    { variant: "atomic", start_fen: START });

  // 1.Nf3, and LorFish answers on an Atomic board.
  await page.locator('#board [data-sq="6"]').click();   // g1
  await page.locator('#board [data-sq="21"]').click();  // f3
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => chess.isAtomic), true);
  assert.match(await page.locator("#history").textContent(), /\[Variant "Atomic"\]/);
});

test("a Crazyhouse game against LorFish, and the worker drops a piece to mate", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("crazyhouse");
  await page.locator("#aiLevelSelect").selectOption("casual");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=crazyhouse/);
  await ready(page);
  assert.equal(await page.evaluate(() => chess.fen()), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1");
  assert.equal(await page.locator("#aiLevelText").textContent(), "Casual · Crazyhouse");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.equal(db().prepare("SELECT variant FROM games WHERE id = ?").get(id).variant, "crazyhouse");

  await page.locator('#board [data-sq="12"]').click();  // e2
  await page.locator('#board [data-sq="28"]').click();  // e4
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.match(await page.locator("#history").textContent(), /\[Variant "Crazyhouse"\]/);

  // The worker itself, asked for Black's move with a knight in hand beside a
  // boxed-in king: N@f2 mates, and comes back as a drop.
  const move = await page.evaluate(() => new Promise((resolve) => {
    const w = new Worker("/js/engineWorker.js");
    w.onmessage = (e) => { w.terminate(); resolve(e.data.move); };
    w.postMessage({ id: 1, variant: "crazyhouse", startFen: "4k3/8/8/8/8/8/6PP/6RK[n] b - - 0 1", moves: [], depth: 1, temperature: 0 });
  }));
  assert.deepEqual(move, { from: null, to: 13, promo: null, drop: "n" });
});
