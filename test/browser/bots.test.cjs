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
  assert.deepEqual(variants, ["standard", "chess960", "atomic", "pawnwars", "crazyhouse", "antichess", "kingofthehill", "threecheck", "infinite"]);
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

test("the worker plays infinite chess: it replays ICN moves and mates from far off", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  const ask = (msg) => page.evaluate((m) => new Promise((resolve) => {
    const w = new Worker("/js/engineWorker.js");
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.postMessage(m);
  }), msg);
  // A boxed-in king and a rook 45 squares off: mate on the king's file or rank.
  const mate = await ask({ id: 1, variant: "infinite", moves: [], depth: 1, temperature: 0,
    startFen: "w 0/100 1 (8|1) checkmate k5,5|R4,100|R6,100|R100,4|R100,6|K-50,-50|R200,50" });
  assert.ok(["5,50", "200,5"].includes(`${mate.move.to.x},${mate.move.to.y}`), JSON.stringify(mate));
  assert.deepEqual([mate.move.from, mate.move.promo, mate.move.drop], [{ x: 200, y: 50 }, null, null]);
  // From the Classical start (no startFen: the engine's own), after two moves.
  const reply = await ask({ id: 2, variant: "infinite", startFen: null, moves: ["5,2>5,4", "5,7>5,5"], depth: 1, temperature: 0 });
  assert.equal(reply.error, undefined);
  const { InfiniteChess } = require("../../src/shared/infiniteChess");
  const inf = new InfiniteChess();
  inf.makeMove(inf.findMove({ x: 5, y: 2 }, { x: 5, y: 4 }));
  inf.makeMove(inf.findMove({ x: 5, y: 7 }, { x: 5, y: 5 }));
  assert.ok(inf.findMove(reply.move.from, reply.move.to, reply.move.promo), JSON.stringify(reply.move));
});

test("an infinite chess game against LorFish, from the lobby to a resumed game", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("infinite");
  await page.locator("#aiLevelSelect").selectOption("casual");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=infinite/);
  await page.waitForFunction(() => chess instanceof InfiniteChess && gameStore.currentId() != null && !thinking);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Casual · Infinite Chess");
  assert.equal(await page.locator("#historyTitle").textContent(), "ICN");
  const id = await page.evaluate(() => gameStore.currentId());
  const START = await page.evaluate(() => new InfiniteChess().fen());
  assert.deepEqual(db().prepare("SELECT variant, start_fen FROM games WHERE id = ?").get(id),
    { variant: "infinite", start_fen: START });

  await page.locator('#board .square[data-sq="5,2"]').click();
  await page.locator('#board .square[data-sq="5,4"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => chess.history[1].move.color), "b");
  assert.match(await page.locator("#history").textContent(), /5,2>5,4/);
  // Stored as ICN, with the turn read from it: White to move again.
  await page.waitForFunction((gid) => fetch("/api/games/" + gid).then((r) => r.json()).then((g) => g.moves.length === 2), id);
  const row = db().prepare("SELECT turn FROM games WHERE id = ?").get(id);
  assert.equal(row.turn, "w");
  assert.deepEqual(db().prepare("SELECT uci FROM moves WHERE game_id = ? ORDER BY ply").all(id)[0], { uci: "5,2>5,4" });

  // Undo takes back both moves, LorFish's included; play on, then reload.
  await page.locator("#undoBtn").click();
  await page.waitForFunction(() => chess.history.length === 0);
  assert.equal(await page.evaluate(() => chess.fen()), START);
  await page.locator('#board .square[data-sq="4,2"]').click();
  await page.locator('#board .square[data-sq="4,4"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  const fen = await page.evaluate(() => chess.fen());
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page.waitForFunction(() => chess instanceof InfiniteChess && gameStore.currentId() != null && !thinking);
  assert.deepEqual(await page.evaluate(() => [gameStore.currentId(), gameVariant, chess.fen(), chess.history.length]),
    [id, "infinite", fen, 2]);

  // Stockfish can't review infinite chess: no review link for it.
  await page.evaluate(() => showReviewLink(gameStore.currentId()));
  assert.equal(await page.locator("#reviewLinkWrap").isVisible(), false);
  // Taking a move back slides its pieces home on the infinite board's own
  // squares ("x,y"), a castling rook included.
  const slides = await page.evaluate(() => {
    planUndoAnimation([{ from: { x: 5, y: 1 }, to: { x: 7, y: 1 }, castle: { rookFrom: { x: 8, y: 1 }, rookTo: { x: 6, y: 1 } } }]);
    return moveAnim && moveAnim.pieces;
  });
  assert.deepEqual(slides, [{ from: "7,1", to: "5,1" }, { from: "6,1", to: "8,1" }]);
});

test("a King of the Hill game against LorFish marks the centre, and a king there wins", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("kingofthehill");
  await page.locator("#aiLevelSelect").selectOption("intermediate");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=kingofthehill/);
  await ready(page);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Intermediate · King of the Hill");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.equal(db().prepare("SELECT variant FROM games WHERE id = ?").get(id).variant, "kingofthehill");
  // d4, e4, d5, e5: squares 27, 28, 35, 36.
  const hill = await page.locator("#board .square.hill").evaluateAll((els) => els.map((e) => Number(e.dataset.sq)).sort((a, b) => a - b));
  assert.deepEqual(hill, [27, 28, 35, 36]);

  await page.locator('#board [data-sq="12"]').click();  // e2
  await page.locator('#board [data-sq="28"]').click();  // e4
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.match(await page.locator("#history").textContent(), /\[Variant "King of the Hill"\]/);

  // How a won game reads: a white king in the centre.
  await page.evaluate(() => { chess.loadFen("7k/7p/8/8/3K4/8/P7/8 b - - 0 1"); render(); });
  assert.equal(await page.locator("#status").textContent(), "Game Over: 1-0 — White wins: king in the centre!");
});

test("a Three-check game against LorFish counts the checks, and the third wins", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("threecheck");
  await page.locator("#aiLevelSelect").selectOption("intermediate");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=threecheck/);
  await ready(page);
  assert.equal(await page.locator("#aiLevelText").textContent(), "Intermediate · Three-check");
  assert.equal(await page.locator("#checksLine").textContent(), "Checks: White 0 of 3 · Black 0 of 3");
  const id = await page.evaluate(() => gameStore.currentId());
  assert.equal(db().prepare("SELECT variant FROM games WHERE id = ?").get(id).variant, "threecheck");

  await page.locator('#board [data-sq="12"]').click();  // e2
  await page.locator('#board [data-sq="28"]').click();  // e4
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  assert.match(await page.locator("#history").textContent(), /\[Variant "Three-check"\]/);

  // Two checks given, then how a won game reads.
  await page.evaluate(() => { chess.loadFen("4k3/8/8/8/8/8/5PPP/4R1K1 w - - 1+3 0 30"); render(); });
  assert.equal(await page.locator("#checksLine").textContent(), "Checks: White 2 of 3 · Black 0 of 3");
  await page.evaluate(() => { chess.loadFen("4k3/8/8/8/8/8/5PPP/4R1K1 b - - 0+3 0 30"); render(); });
  assert.equal(await page.locator("#status").textContent(), "Game Over: 1-0 — White wins: three checks!");
});
