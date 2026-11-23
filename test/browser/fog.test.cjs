"use strict";

// Fog of War on the game page. Each player's board shows only what their side
// sees, the rest fogged; the other side's moves are "?" in the move list; a
// piece offers only its moves in sight. A spectator watches through White's
// eyes to begin with and can switch to Black's. When the game ends, every page
// shows the whole game. Against LorFish the page draws only your side until
// the end. The replay shows a finished game whole or as either side saw it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

const square = (page, name) => page.locator(`#board [data-sq="${(Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97}"]`);
const fogged = (page) => page.locator("#board .square.fog").count();
const pieces = (page, colour) => page.locator(`#board img.piece[alt^="${colour}"]`).count();
const pgnMoves = async (page) => (await page.locator("#history").textContent()).split("\n").pop();

test("two players and a spectator, each seeing their own side, and the whole game at the end", async (t) => {
  const white = await signedInPage(browser, srv.baseUrl, t);
  const black = await signedInPage(browser, srv.baseUrl, t);
  const watcher = await signedInPage(browser, srv.baseUrl, t);
  const gameId = matchmaking.startMatch(srv.io,
    { userId: white.user.user.id, username: white.user.user.username },
    { userId: black.user.user.id, username: black.user.user.username },
    { variant: "fog", initialMs: 300000, incrementMs: 0 });
  const w = white.page, b = black.page, s = watcher.page;
  for (const p of [w, b]) {
    await p.goto(srv.baseUrl + "/game.html?id=" + gameId);
    await p.waitForFunction(() => pvpMode && chess.fogVisible);
  }

  // The start: your own half and the two ranks your pieces reach; nothing of
  // the other side's.
  assert.equal(await fogged(w), 32);
  assert.equal(await pieces(w, "b"), 0);
  assert.equal(await pieces(w, "w"), 16);
  assert.equal(await pieces(b, "w"), 0);
  assert.equal(await square(w, "e5").evaluate((el) => el.classList.contains("fog")), true);
  assert.equal(await square(w, "e4").evaluate((el) => el.classList.contains("fog")), false);

  // 1. e4: Black can't see it, and has a "?" in its move list.
  await square(w, "e2").click();
  assert.equal(await w.locator("#board .hint").count(), 2, "e3 and e4");
  await square(w, "e4").click();
  await b.waitForFunction(() => moveHistory.length === 1);
  assert.equal(await pieces(b, "w"), 0);
  assert.equal(await pgnMoves(b), "1. ? *");
  assert.equal(await pgnMoves(w), "1. e4 *");

  // 1... d5: in sight of White's pawn, which can take it.
  await square(b, "d7").click();
  await square(b, "d5").click();
  await w.waitForFunction(() => moveHistory.length === 2);
  assert.equal(await pieces(w, "b"), 1);
  assert.equal(await square(w, "d5").locator("img").getAttribute("alt"), "bp");
  assert.equal(await pgnMoves(w), "1. e4 ? *");

  // A spectator watches through White's eyes, then switches to Black's.
  await s.goto(srv.baseUrl + "/game.html?watch=" + gameId);
  await s.waitForFunction(() => spectating && chess.fogVisible);
  await s.locator("#fogSides").waitFor();
  assert.equal(await pieces(s, "b"), 1, "White's view: the pawn on d5");
  assert.equal(await s.locator('#fogSides button[data-side="w"]').getAttribute("aria-pressed"), "true");
  await s.locator('#fogSides button[data-side="b"]').click();
  await s.waitForFunction(() => humanColor === "b");
  assert.equal(await pieces(s, "w"), 1, "Black's view: the pawn on e4, which d5 can take");
  assert.equal(await pieces(s, "b"), 16);
  assert.equal(await pgnMoves(s), "1. ? d5 *");

  // 2. exd5: the spectator sees it as Black does.
  await square(w, "e4").click();
  await square(w, "d5").click();
  await s.waitForFunction(() => moveHistory.length === 3);
  assert.equal(await pieces(s, "b"), 15);
  assert.equal(await pgnMoves(s), "1. ? d5 2. ? *");

  // Black resigns: every page shows the whole game.
  b.once("dialog", (d) => d.accept());
  await b.locator("#resignBtn").click();
  for (const p of [w, b, s]) {
    await p.waitForFunction(() => !!pvpResult && !chess.fogVisible);
    assert.equal(await fogged(p), 0);
    assert.equal(await pgnMoves(p), "1. e4 d5 2. exd5 1-0");
    assert.equal(await pieces(p, "b"), 15);
    assert.equal(await pieces(p, "w"), 16);
  }
  assert.equal(await s.locator("#fogSides").isVisible(), false);
});

test("the lobby offers Fog of War between people and against LorFish", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#variantSelect").waitFor();
  const labels = (sel) => page.locator(`${sel} option`).allTextContents();
  assert.ok((await labels("#variantSelect")).includes("Fog of War"));
  assert.ok((await labels("#aiVariantSelect")).includes("Fog of War"));
});

test("against LorFish: only your side drawn, its moves \"?\", until the game is over", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("fog");
  await page.locator("#aiLevelSelect").selectOption("beginner");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=fog/);
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);
  assert.equal(await fogged(page), 32);
  assert.equal(await pieces(page, "b"), 0);

  await square(page, "e2").click();
  await square(page, "e4").click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  // The page holds LorFish's move, but draws only the black pieces in sight.
  const inSight = await page.evaluate(() => {
    const seen = chess.visibleSquares(humanColor);
    return chess.squares.filter((p, sq) => p && p.c === "b" && seen.has(sq)).length;
  });
  assert.equal(await pieces(page, "b"), inSight);
  assert.equal(await pgnMoves(page), "1. e4 ? *");

  // Over (here, put over by hand: White takes the king), everything shows.
  await page.evaluate(() => {
    chess.loadFen("4k3/8/8/8/8/8/8/4R1K1 w - - 0 1");
    moveHistory = [];
    applyMove({ from: 4, to: 60 }, false);
  });
  assert.equal(await fogged(page), 0);
  assert.match(await page.locator("#status").textContent(), /White wins: king captured/);
});

test("the replay shows a finished game whole, or as either side saw it", async (t) => {
  const { page, user } = await signedInPage(browser, srv.baseUrl, t);
  const { recordGame, makeUser } = require("../helpers/games");
  const id = recordGame({
    white: user.user.id, black: makeUser("foe").id, variant: "fog",
    moves: ["e2e4", "d7d5"], result: "1-0", termination: "resign",
  });
  // The replay's pieces have no class of their own.
  const shown = (p, colour) => p.locator(`#board img[alt^="${colour}"]`).count();
  await page.goto(srv.baseUrl + "/replay.html?id=" + id);
  await page.locator("#fogView").waitFor();
  assert.equal(await fogged(page), 0, "everything to begin with");
  assert.equal(await shown(page, "b"), 16);

  await page.locator('#fogView button[data-view="w"]').click();
  // White sees its own two ranks, rank 3 but e3, all of rank 4, d5 and e5
  // by its pawn, b5 and a6 by its bishop, h5 by its queen: 36 squares.
  assert.equal(await fogged(page), 28);
  assert.equal(await shown(page, "b"), 1, "the pawn on d5");
  await page.locator('#fogView button[data-view="b"]').click();
  assert.equal(await shown(page, "w"), 1, "the pawn on e4");
  assert.equal(await page.locator("#board .square").first().getAttribute("data-sq"), "7", "Black at the bottom");
  // Stepping back to the start, as Black saw it then.
  await page.keyboard.press("Home");
  assert.equal(await shown(page, "w"), 0);
  await page.locator('#fogView button[data-view=""]').click();
  assert.equal(await fogged(page), 0);
});
