"use strict";

// Starred games in the browser. A game page shows the star once its game is
// over; the replay shows it starred, and a reload keeps it. Your Games tab has
// a star in each finished row and a "Starred only" box, which lists a game you
// didn't play with its players and result too; unstarring there leaves the
// row, its star off. A four-player game has the star on four.html once over,
// and on fourReplay.html.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, openBrowser, signedInPage, registerUser, connectSocket, emitAck, waitFor,
} = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const { FourPlayer } = require("../../src/shared/fourPlayer");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

const starText = (page) => page.locator("#starBtn").textContent();

test("a two-player game: starred on its game page, on its replay and on the Games tab", async (t) => {
  const white = await signedInPage(browser, srv.baseUrl, t);
  const black = await registerUser(srv.baseUrl, "rival");
  const onlooker = await signedInPage(browser, srv.baseUrl, t);
  const gameId = matchmaking.startMatch(srv.io,
    { userId: white.user.user.id, username: white.user.user.username },
    { userId: black.user.id, username: black.user.username },
    { variant: "standard", initialMs: 300000, incrementMs: 0 });
  const sock = await connectSocket(srv.baseUrl, black.c.cookie());
  t.after(() => sock.close());
  await emitAck(sock, "game:join", { gameId });

  // No star while it is being played; a move each, Black resigns, and it
  // appears.
  const page = white.page;
  await page.goto(srv.baseUrl + "/game.html?id=" + gameId);
  await page.waitForFunction(() => pvpMode);
  assert.equal(await page.locator("#starLine").isVisible(), false);
  const square = (name) => page.locator(`#board [data-sq="${(Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97}"]`);
  const moved = waitFor(sock, "move:made");
  await square("e2").click();
  await square("e4").click();
  await moved;
  assert.deepEqual(await emitAck(sock, "move:make", { gameId, from: 52, to: 36 }), { ok: true });   // e7e5
  await page.waitForFunction(() => chess.history.length === 2);
  const over = waitFor(sock, "game:over");
  sock.emit("game:resign", { gameId });
  await over;
  await page.locator("#starLine").waitFor();
  assert.equal(await starText(page), "☆ Star");
  await page.locator("#starBtn").click();
  await page.waitForFunction(() => document.getElementById("starBtn").textContent === "★ Starred");

  // The replay knows, and a reload keeps it.
  await page.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await page.locator("#starLine").waitFor();
  assert.equal(await starText(page), "★ Starred");

  // Someone who didn't play it stars it from its replay.
  await onlooker.page.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await onlooker.page.locator("#starLine").waitFor();
  assert.equal(await starText(onlooker.page), "☆ Star", "White's star is White's own");
  await onlooker.page.locator("#starBtn").click();
  await onlooker.page.waitForFunction(() => document.getElementById("starBtn").textContent === "★ Starred");

  // White's Games tab: the row's star is on.
  await page.goto(srv.baseUrl + "/profile.html#games");
  const rowStar = page.locator(`.history-table button[data-star="${gameId}"]`);
  await rowStar.waitFor();
  assert.equal(await rowStar.textContent(), "★");

  // The onlooker's tab: no games of their own, but "Starred only" has it,
  // with its players and its result from no one's side.
  const o = onlooker.page;
  await o.goto(srv.baseUrl + "/profile.html#games");
  await o.locator("#starredOnly").waitFor();
  assert.match(await o.locator("#historyContent").textContent(), /No games yet/);
  await o.locator("#starredOnly").check();
  const row = o.locator(".history-table tbody tr");
  await row.first().waitFor();
  assert.equal(await row.count(), 1);
  const cells = await row.locator("td").allTextContents();
  assert.equal(cells[3], "—");
  assert.equal(cells[4], `${white.user.user.username} vs ${black.user.username}`);
  assert.equal(cells[5], "White won");
  assert.match(await row.locator("a.replay-link").getAttribute("href"), new RegExp(`/replay.html\\?id=${gameId}$`));

  // Unstarred there, the row stays with its star off; untick and tick again
  // and it is gone.
  await row.locator("button[data-star]").click();
  await o.waitForFunction(() => document.querySelector(".history-table button[data-star]").textContent === "☆");
  await o.locator("#starredOnly").uncheck();
  await o.locator("#starredOnly").check();
  await o.waitForFunction(() => /No starred games yet/.test(document.getElementById("historyContent").textContent));
});

test("a four-player game: the star on its game page once over, and on its replay", async (t) => {
  const yellow = await signedInPage(browser, srv.baseUrl, t);
  await yellow.page.setViewportSize({ width: 1400, height: 1000 });
  const others = [];
  for (const name of ["red", "blue", "green"]) others.push(await registerUser(srv.baseUrl, name));
  const users = [others[0], others[1], yellow.user, others[2]];
  const sockets = await Promise.all(users.map((u) => connectSocket(srv.baseUrl, u.c.cookie())));
  t.after(() => sockets.forEach((s) => s.close()));
  const seats = Object.fromEntries(FourPlayer.COLORS.map((c, i) => [c, { userId: users[i].user.id, username: users[i].user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs: 300000, incrementMs: 0 });
  for (const s of sockets) assert.equal((await emitAck(s, "game:join", { gameId })).ok, true);

  const page = yellow.page;
  await page.goto(srv.baseUrl + "/four.html?id=" + gameId);
  await page.waitForFunction(() => typeof game !== "undefined" && game);
  assert.equal(await page.locator("#starLine").isVisible(), false);
  sockets[1].emit("game:resign", { gameId });   // Blue: Blue & Green lose
  await page.locator("#starLine").waitFor();
  await page.locator("#starBtn").click();
  await page.waitForFunction(() => document.getElementById("starBtn").textContent === "★ Starred");

  await page.goto(srv.baseUrl + "/fourReplay.html?id=" + gameId);
  await page.locator("#starLine").waitFor();
  assert.equal(await starText(page), "★ Starred");
  await page.locator("#starBtn").click();
  await page.waitForFunction(() => document.getElementById("starBtn").textContent === "☆ Star");
});
