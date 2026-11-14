"use strict";

// A four-player game seen from outside its game page: under the lobby's live
// games (its four players in two teams, a Watch link to four.html), then, once
// over, in a player's history (their colour, the opponents and the partner, a
// Replay link) and on its replay page (fourReplay.html, which replay.html
// sends it to): the board from your seat, or from the seat of the player
// whose profile you came from, stepped through by key and by click.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, openBrowser, signedInPage, registerUser, connectSocket, emitAck, waitFor,
} = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const { FourPlayer } = require("../../src/shared/fourPlayer");

const COLORS = FourPlayer.COLORS;
const sq = FourPlayer.squareOf;
let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

// One quiet move each, then Red again: five plies.
const MOVES = [["r", "h2", "h4"], ["b", "b8", "d8"], ["y", "g13", "g11"], ["g", "m10", "k10"], ["r", "e2", "e4"]];
const piece = (page, name) => page.locator(`#board .square[data-sq="${sq(name)}"] img`);

test("in the lobby's live games, then a player's history and the replay", async (t) => {
  // Yellow plays from a browser; the other three only over their sockets.
  const yellow = await signedInPage(browser, srv.baseUrl, t);
  const onlooker = await signedInPage(browser, srv.baseUrl, t);
  for (const { page } of [yellow, onlooker]) await page.setViewportSize({ width: 1400, height: 1000 });
  const others = [];
  for (const name of ["red", "blue", "green"]) others.push(await registerUser(srv.baseUrl, name));
  const users = [others[0], others[1], yellow.user, others[2]];
  const sockets = await Promise.all(users.map((u) => connectSocket(srv.baseUrl, u.c.cookie())));
  t.after(() => sockets.forEach((s) => s.close()));
  const by = Object.fromEntries(COLORS.map((c, i) => [c, sockets[i]]));
  const seats = Object.fromEntries(COLORS.map((c, i) => [c, { userId: users[i].user.id, username: users[i].user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs: 300000, incrementMs: 0 });
  for (const c of COLORS) assert.equal((await emitAck(by[c], "game:join", { gameId })).ok, true);
  for (const [c, from, to] of MOVES) assert.deepEqual(await emitAck(by[c], "move:make", { gameId, from, to }), { ok: true });
  const name = (c) => seats[c].username;

  // The lobby: Red & Yellow vs Blue & Green, no preview, a Watch link.
  const lobby = onlooker.page;
  await lobby.goto(srv.baseUrl + "/lobby.html");
  const card = lobby.locator("#gameList .live-game");
  await card.waitFor();
  const rated = (c) => `${name(c)}(1200)`;
  assert.equal(await card.locator(".vs").textContent(), `${rated("r")} & ${rated("y")} vs ${rated("b")} & ${rated("g")}`);
  assert.match(await card.textContent(), /Four-Player Chess/);
  assert.match(await card.textContent(), /move 2/);
  assert.equal(await card.locator(".mini-board").count(), 0);
  await card.locator("button", { hasText: "Watch" }).click();
  await lobby.waitForURL(/\/four\.html\?watch=\d+$/);
  await lobby.waitForFunction(() => game.history.length === 5);

  // Green resigns: Red and Yellow win.
  const over = waitFor(by.r, "game:over");
  by.g.emit("game:resign", { gameId });
  await over;

  // Yellow's history: their colour, the two opponents and the partner.
  const page = yellow.page;
  await page.goto(srv.baseUrl + "/profile.html#games");
  const row = page.locator(".history-table tbody tr");
  await row.waitFor();
  const cells = await row.locator("td").allTextContents();
  assert.deepEqual(cells.slice(2, 6), ["Four-Player Chess", "Yellow", `${name("g")} & ${name("b")} with ${name("r")}`, "Win (resign)"]);
  await row.locator("a", { hasText: "Replay" }).click();
  await page.waitForURL(/\/fourReplay\.html\?id=\d+$/);

  // The replay, at the end, from Yellow's seat.
  const status = page.locator("#replayStatus");
  await status.filter({ hasText: "win" }).waitFor();
  assert.equal(await status.textContent(), "Red & Yellow win — by resignation · your team won");
  assert.equal(await page.locator("#plate-br").getAttribute("data-color"), "y");
  assert.match(await page.locator("#plate-br").textContent(), /\(you\)/);
  assert.match(await page.locator("#plate-tl").textContent(), new RegExp(name("r") + " \\(partner\\)"));
  assert.match(await page.locator("#teams").textContent(), /You played Yellow, with Red/);
  assert.deepEqual(await page.locator("#history > div").allTextContents(),
    ["1. h2-h4 b8-d8 g13-g11+ m10-k10 ", "2. e2-e4+ "]);
  assert.equal(await page.locator("#history .mv.current").textContent(), "e2-e4+");
  assert.equal(await piece(page, "e4").getAttribute("alt"), "rp");

  // Stepping: back a move, to a clicked move, to the start.
  await page.keyboard.press("ArrowLeft");
  assert.equal(await piece(page, "e4").count(), 0);
  assert.equal(await page.locator("#plate-br.to-move").count(), 0);
  assert.equal(await page.locator('[data-color="r"].to-move').count(), 1, "Red to move");
  await page.locator("#history .mv", { hasText: "b8-d8" }).click();
  assert.equal(await piece(page, "d8").getAttribute("alt"), "bp");
  assert.equal(await piece(page, "g11").count(), 0);
  await page.keyboard.press("Home");
  assert.equal(await page.locator("#history .mv.current").count(), 0);
  assert.equal(await page.locator("#board .last-move").count(), 0);
  await page.locator("#lastBtn").click();
  assert.equal(await page.locator("#history .mv.current").textContent(), "e2-e4+");

  // Someone else, from Green's profile: replay.html sends them on, and the
  // board is Green's way up.
  await lobby.goto(`${srv.baseUrl}/replay.html?id=${gameId}&as=${seats.g.userId}`);
  await lobby.waitForURL(/\/fourReplay\.html\?id=\d+&as=\d+$/);
  await lobby.locator("#replayStatus").filter({ hasText: "win" }).waitFor();
  assert.equal(await lobby.locator("#replayStatus").textContent(), "Red & Yellow win — by resignation");
  assert.equal(await lobby.locator("#plate-br").getAttribute("data-color"), "g");
  assert.doesNotMatch(await lobby.locator(".four-plate").allTextContents().then((x) => x.join()), /\(you\)/);
  assert.equal(await lobby.locator("#backLink").textContent(), `← ${name("g")}'s games`);
});
