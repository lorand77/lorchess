"use strict";

// Fog of War on the game page. Each player's board shows only what their side
// sees, the rest fogged; the other side's moves are "?" in the move list; a
// piece offers only its moves in sight. A spectator watches through White's
// eyes to begin with and can switch to Black's. When the game ends, every page
// shows the whole game. In the lobby it is offered between people, not
// against LorFish.
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

test("the lobby offers Fog of War between people, not against LorFish", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#variantSelect").waitFor();
  const labels = (sel) => page.locator(`${sel} option`).allTextContents();
  assert.ok((await labels("#variantSelect")).includes("Fog of War"));
  assert.ok(!(await labels("#aiVariantSelect")).includes("Fog of War"));
});
