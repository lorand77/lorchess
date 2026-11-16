"use strict";

// Four-player free-for-all on its pages: Red in a browser, the other three
// over sockets. game.html sends the game to four.html, which shows the
// variant, no partners and each player's points; a player who resigns is
// greyed on their plate and their army grey on the board, the move list
// naming them; the lobby's live card shows everyone with their points, a
// player out struck through. With two left and Red far enough ahead, the
// Claim the win button ends the game, the result is the placings, and the
// replay and the Games tab show them too. "Play the computer" offers it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, registerUser, connectSocket, emitAck, db } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const rooms = require("../../src/game/rooms");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { position, KINGS } = require("../helpers/fourPlayer");

const COLORS = FourPlayer.COLORS;
const sq = FourPlayer.squareOf;
let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

// Red in a browser page, Blue, Yellow and Green on sockets, all joined, in a
// free-for-all game (from `fen` if given).
async function seated(t, fen) {
  const red = await signedInPage(browser, srv.baseUrl, t);
  await red.page.setViewportSize({ width: 1200, height: 900 });
  const others = [];
  for (const name of ["blue", "yellow", "green"]) {
    const u = await registerUser(srv.baseUrl, name);
    const s = await connectSocket(srv.baseUrl, u.c.cookie());
    t.after(() => s.close());
    others.push({ u, s });
  }
  const users = [red.user, ...others.map((o) => o.u)];
  const seats = Object.fromEntries(COLORS.map((c, i) => [c, { userId: users[i].user.id, username: users[i].user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs: 300000, incrementMs: 0, variant: "fourplayer_ffa" });
  if (fen) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(fen, fen, gameId);
    const room = rooms.getRoom(gameId);
    rooms.clearTimers(room);
    rooms.deleteRoom(gameId);
  }
  const by = { r: null };
  others.forEach((o, i) => { by[COLORS[i + 1]] = o.s; });
  for (const c of ["b", "y", "g"]) assert.equal((await emitAck(by[c], "game:join", { gameId })).ok, true);
  await red.page.goto(srv.baseUrl + "/game.html?id=" + gameId);
  await red.page.waitForURL(/\/four\.html\?id=\d+$/);
  await red.page.waitForFunction(() => me !== null && running);
  return { gameId, red, by, users };
}
const cell = (page, name) => page.locator(`#board .square[data-sq="${sq(name)}"]`);
const plies = (page, n) => page.waitForFunction((k) => game.history.length === k, n);

test("a free-for-all game: points, a player out greyed, and the lobby's card", async (t) => {
  const { gameId, red, by } = await seated(t);
  const page = red.page;
  assert.equal(await page.locator("#gameTitle").textContent(), "Four-Player Free-for-All");
  assert.match(await page.locator("#teams").textContent(), /You play Red\. Everyone for themselves/);
  assert.equal(await page.locator(".four-plate", { hasText: "(partner)" }).count(), 0);
  for (const c of COLORS) assert.equal(await page.locator(`[data-points="${c}"]`).textContent(), "0 pts");
  assert.equal(await page.locator("#claimBtn").isVisible(), false);
  assert.equal(await page.locator("#rulesLink").getAttribute("href"), "/rules.html#fourplayer_ffa");

  await cell(page, "e2").click();
  await cell(page, "e4").click();
  await plies(page, 1);
  // Blue resigns: out, greyed, the army grey; the turn goes on to Yellow.
  by.b.emit("game:resign", { gameId });
  await plies(page, 2);
  const blue = page.locator('.four-plate[data-color="b"]');
  assert.match(await blue.getAttribute("class"), /\bout\b/);
  assert.equal(await page.locator('[data-points="b"]').textContent(), "0 pts · resigned");
  assert.equal(await page.locator("#board img.four-dead").count(), 16, "Blue's whole army");
  assert.equal(await page.locator("#board img.four-b").count(), 0);
  assert.match(await page.locator("#pvpNotice").textContent(), /Blue resigned/);
  assert.match(await page.locator("#turn").textContent(), /Turn: Yellow — waiting/);
  assert.equal((await emitAck(by.y, "move:make", { gameId, from: "g13", to: "g11" })).ok, true);
  await plies(page, 3);
  assert.deepEqual(await page.locator("#history div").allTextContents(),
    ["1. Red: e2-e4", "2. Blue resigned", "3. Yellow: g13-g11"]);

  // The lobby's live card: everyone in turn order with their points, Blue
  // struck through.
  const watcher = await signedInPage(browser, srv.baseUrl, t);
  await watcher.page.goto(srv.baseUrl + "/lobby.html");
  const card = watcher.page.locator(".live-game", { hasText: "Four-Player Free-for-All" });
  await card.waitFor();
  assert.equal(await card.locator('[data-seat="b"].four-out').count(), 1);
  assert.equal(await card.locator('[data-seat="r"].four-out').count(), 0);
  assert.match(await card.locator(".vs").textContent(), /0 pts · .*0 pts · .*0 pts · .*0 pts/);
  // "Play the computer" offers free-for-all, against three LorFish.
  await watcher.page.locator("#aiVariantSelect").selectOption("fourplayer_ffa");
  assert.match(await watcher.page.locator("#aiNote").textContent(), /against three LorFish, everyone for themselves/);

  for (const c of ["y", "g"]) by[c].emit("game:resign", { gameId });
  await page.locator("#status.game-over").waitFor();
  assert.match(await page.locator("#status").textContent(), /^Game over — the last player resigned: 1st Red 0 · 1st Blue 0/);
});

test("claiming the win, the placings, the replay and the Games tab", async (t) => {
  const fen = position("r", { ...KINGS, d4: "rR", k12: "bR" }, { mode: "ffa", out: "yg", points: { r: 30, b: 9 } }).fen();
  const { gameId, red } = await seated(t, fen);
  const page = red.page;
  assert.equal(await page.locator('[data-points="r"]').textContent(), "30 pts");
  await page.locator("#claimBtn").waitFor();
  page.once("dialog", (d) => {
    assert.match(d.message(), /Blue gets 20 points/);
    d.accept();
  });
  await page.locator("#claimBtn").click();
  await page.locator("#status.game-over").waitFor();
  assert.equal(await page.locator("#status").textContent(),
    "Game over — Red claimed the win: 1st Red 30 · 2nd Blue 29 · 3rd Yellow 0 · 3rd Green 0 · you finish 1st");
  assert.equal(await page.locator("#controls").isVisible(), false);

  await page.locator("#replayLink").click();
  await page.waitForURL(/\/fourReplay\.html\?id=\d+$/);
  await page.locator("#replayStatus.game-over").waitFor();
  assert.equal(await page.locator("#replayStatus").textContent(),
    "1st Red 30 · 2nd Blue 29 · 3rd Yellow 0 · 3rd Green 0 — Red claimed the win · you finished 1st");
  assert.equal(await page.locator("#replayTitle").textContent(), "Four-Player Free-for-All · replay");
  assert.deepEqual(await page.locator("#history div").allTextContents(), ["1. Red claimed the win"]);
  assert.equal(await page.locator('[data-points="b"]').textContent(), "29 pts");
  await page.locator("#firstBtn").click();
  assert.equal(await page.locator('[data-points="b"]').textContent(), "9 pts", "as it stood before the claim");

  await page.goto(srv.baseUrl + "/profile.html#games");
  const row = page.locator("#historyContent tr", { hasText: "Four-Player Free-for-All" });
  await row.waitFor();
  assert.match(await row.textContent(), /Red.*1st · 30 pts/);
  assert.equal(await row.locator("a.replay-link").getAttribute("href"), `/fourReplay.html?id=${gameId}`);
});
