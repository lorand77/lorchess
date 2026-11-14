"use strict";

// Four-player chess on its game page (four.html), four people in four browsers
// and a spectator: game.html sends each there; each sees their own army at the
// bottom and the four plates by the kings; the clocks start once all four are
// in; moves go round by click and by drag, check is reported for whoever is
// in it, a pawn on its 11th rank promotes through the dialog, and a
// resignation ends it for both teams.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const rooms = require("../../src/game/rooms");
const { FourPlayer } = require("../../src/shared/fourPlayer");

const COLORS = FourPlayer.COLORS;
const sq = FourPlayer.squareOf;
let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

// Four signed-in pages, Red to Green, in a game started for them.
async function seated(t) {
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await signedInPage(browser, srv.baseUrl, t));
  for (const { page } of players) await page.setViewportSize({ width: 1200, height: 900 });
  const seats = Object.fromEntries(COLORS.map((c, i) => [c, { userId: players[i].user.user.id, username: players[i].user.user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs: 300000, incrementMs: 0 });
  const by = Object.fromEntries(COLORS.map((c, i) => [c, players[i]]));
  return { gameId, by, players };
}
const cell = (page, name) => page.locator(`#board .square[data-sq="${sq(name)}"]`);
const at = (page, name) => page.evaluate((n) => {
  const el = document.querySelector(`#board .square[data-sq="${n}"]`);
  return [Math.round(el.offsetLeft / el.offsetWidth), Math.round(el.offsetTop / el.offsetHeight)];
}, sq(name));
const plies = (page, n) => page.waitForFunction((k) => game.history.length === k, n);
async function click(page, from, to) {
  await cell(page, from).click();
  await cell(page, to).click();
}

test("four players and a spectator, from the game page's link to a resignation", async (t) => {
  const { gameId, by } = await seated(t);
  // Every way into a game is a game.html link; it sends a four-player game on.
  for (const c of COLORS) await by[c].page.goto(srv.baseUrl + "/game.html?id=" + gameId);
  for (const c of COLORS) {
    await by[c].page.waitForURL(/\/four\.html\?id=\d+$/);
    await by[c].page.waitForFunction(() => me !== null && running);
  }

  // Each army at the bottom of its own player's board, the king right of
  // centre; each plate by its king, the player's own bottom right.
  for (const c of COLORS) {
    const king = FourPlayer.nameOf(new FourPlayer().kingOf(c));
    assert.deepEqual(await at(by[c].page, king), [7, 13], c);
    const plate = by[c].page.locator("#plate-br");
    assert.equal(await plate.getAttribute("data-color"), c);
    assert.match(await plate.textContent(), new RegExp(by[c].user.user.username + ".*\\(you\\)"));
  }
  const red = by.r.page;
  assert.equal(await red.locator("#plate-tl").getAttribute("data-color"), "y", "the partner opposite");
  assert.match(await red.locator("#plate-tl").textContent(), /\(partner\)/);
  assert.equal(await red.locator("#plate-bl").getAttribute("data-color"), "b", "Blue on Red's left");
  assert.match(await red.locator("#tcLine").textContent(), /^5:00|5\+0|casual · Four-Player Chess/);
  assert.match(await red.locator("#teams").textContent(), /You play Red, with Yellow: Red & Yellow/);
  assert.match(await red.locator("#turn").textContent(), /Turn: Red — your move/);
  assert.equal(await red.locator("#plate-br.to-move .clock.active").count(), 1, "Red's clock runs");

  // Not your turn: nothing to pick up.
  await cell(by.b.page, "b7").click();
  assert.equal(await by.b.page.locator("#board .hint").count(), 0);

  // Red by click, with hints; then Blue by drag.
  await cell(red, "e2").click();
  assert.equal(await red.locator("#board .hint").count(), 2, "e3 and e4");
  await cell(red, "e4").click();
  for (const c of COLORS) await plies(by[c].page, 1);
  assert.equal(await cell(by.g.page, "e4").locator("img").getAttribute("alt"), "rp");
  assert.match(await by.y.page.locator("#turn").textContent(), /Turn: Blue — waiting/);
  assert.match(await by.g.page.locator("#turn").textContent(), /Turn: Blue — your partner/);
  const blue = by.b.page;
  const from = await cell(blue, "b7").boundingBox(), to = await cell(blue, "d7").boundingBox();
  await blue.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await blue.mouse.down();
  await blue.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await blue.mouse.up();
  for (const c of COLORS) await plies(by[c].page, 2);
  assert.equal(await red.locator("#history").textContent(), "1. e2-e4  b7-d7");

  // A spectator: sent on from game.html too, Red's side up, their own chat.
  const watcher = await signedInPage(browser, srv.baseUrl, t);
  await watcher.page.setViewportSize({ width: 1200, height: 900 });
  await watcher.page.goto(srv.baseUrl + "/game.html?watch=" + gameId);
  await watcher.page.waitForURL(/\/four\.html\?watch=\d+$/);
  await plies(watcher.page, 2);
  assert.deepEqual(await at(watcher.page, "h1"), [7, 13]);
  assert.equal(await watcher.page.locator("#controls").isVisible(), false);
  assert.equal(await watcher.page.locator("#chatTitle").textContent(), "Spectator chat");
  await red.locator("#watchInfo", { hasText: "1 spectator" }).waitFor();

  // Players' chat reaches all four.
  await by.y.page.locator("#chatInput").fill("hello partner");
  await by.y.page.locator("#chatForm button").click();
  for (const c of COLORS) await by[c].page.locator("#chatLog", { hasText: "hello partner" }).waitFor();
  assert.equal(await watcher.page.locator("#chatLog").textContent(), "");

  // Green resigns: Red and Yellow win, everyone is told.
  by.g.page.once("dialog", (d) => d.accept());
  await by.g.page.locator("#resignBtn").click();
  for (const p of [red, by.g.page, watcher.page]) {
    await p.locator("#status", { hasText: "Game over: Red & Yellow win — resign" }).waitFor();
  }
  assert.match(await red.locator("#status").textContent(), /your team wins$/);
  assert.match(await by.g.page.locator("#status").textContent(), /your team loses$/);
  assert.equal(await red.locator("#controls").isVisible(), false);
});

test("check from one side, then a promotion through the dialog", async (t) => {
  const { gameId, by } = await seated(t);
  // Red to move: a pawn a step from its 11th rank, whose queen will check
  // Blue's king; Yellow's rook ready to check Green's.
  const pieces = { h1: "rK", a7: "bK", g14: "yK", n8: "gK", e10: "rP", j12: "yR", m6: "gP" };
  const g = new FourPlayer();
  g.squares.fill(null);
  for (const [name, p] of Object.entries(pieces)) g.squares[sq(name)] = { c: p[0], t: p[1].toLowerCase() };
  g.castling = Object.fromEntries(COLORS.map((c) => [c, { k: false, q: false }]));
  const start = g.fen();
  db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, gameId);
  const room = rooms.getRoom(gameId);
  rooms.clearTimers(room);
  rooms.deleteRoom(gameId);
  for (const c of COLORS) await by[c].page.goto(srv.baseUrl + "/four.html?id=" + gameId);
  for (const c of COLORS) await by[c].page.waitForFunction(() => me !== null && running);

  const red = by.r.page;
  await click(red, "e10", "e11");
  await red.locator("#promo.show").waitFor();
  const options = red.locator("#promoOptions img");
  assert.equal(await options.count(), 4);
  assert.equal(await options.first().getAttribute("class"), "four-r", "in Red's colour");
  await options.first().click();   // the queen
  for (const c of COLORS) await plies(by[c].page, 1);
  assert.equal(await cell(by.b.page, "e11").locator("img").getAttribute("alt"), "rq");
  assert.match(await by.b.page.locator("#status").textContent(), /^Check!$/, "Blue, in check, is told so");
  assert.match(await by.g.page.locator("#status").textContent(), /^Check: Blue$/);
  assert.equal(await by.y.page.locator("#board .square.check").getAttribute("data-sq"), String(sq("a7")));
  assert.match(await red.locator("#history").textContent(), /^1\. e10-e11=Q\+$/);
  by.r.page.once("dialog", (d) => d.accept());
  await by.r.page.locator("#resignBtn").click();
  await red.locator("#status", { hasText: "Blue & Green win" }).waitFor();
  await red.screenshot({ path: process.env.FOUR_SHOT || "/tmp/four-game.png" });
});
