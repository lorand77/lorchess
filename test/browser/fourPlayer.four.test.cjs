"use strict";

// A whole four-player game between four people, each in their own browser,
// from the lobby to the replay. A table fills seat by seat and starts itself;
// each player lands on four.html with their own army at the bottom; every move
// is a click on the board of whoever is to move, seen by all four; Red mates
// Blue in four moves of its own, Blue's partner unable to help; all four are
// told, the winners get "Four Corners"; the game is in each history and
// replays to the mate.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const { FourPlayer } = require("../../src/shared/fourPlayer");

const COLORS = FourPlayer.COLORS;
const sq = FourPlayer.squareOf;
let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

// Red opens the queen's diagonal to Blue's king (f3), clears its bishop's
// way (h3), posts the bishop on c7 and takes on b6 with the queen, the
// bishop guarding it. The others make quiet pawn moves out of the way.
const LINE = [
  ["r", "f2", "f3"], ["b", "b11", "c11"], ["y", "j13", "j12"], ["g", "m11", "l11"],
  ["r", "h2", "h3"], ["b", "b10", "c10"], ["y", "k13", "k12"], ["g", "m9", "l9"],
  ["r", "i1", "c7"], ["b", "b9", "c9"], ["y", "e13", "e12"], ["g", "m10", "k10"],
  ["r", "g1", "b6"],
];

test("four people: a table that starts itself, a game by clicks, a mate, the badge, history and replay", async (t) => {
  const by = {};
  for (const c of COLORS) {
    by[c] = await signedInPage(browser, srv.baseUrl, t);
    await by[c].page.setViewportSize({ width: 1300, height: 950 });
    await by[c].page.goto(srv.baseUrl + "/lobby.html");
  }
  const name = (c) => by[c].user.user.username;

  // Red opens the table; the others sit, Yellow last, which starts it.
  await by.r.page.locator("#variantSelect").selectOption("fourplayer");
  await by.r.page.locator("#tableOpenBtn").click();
  for (const c of ["b", "g", "y"]) {
    const sit = by[c].page.locator(`#tableList [data-seat="${c}"] button`);
    await sit.waitFor();
    await sit.click();
    if (c !== "y") await by.r.page.locator(`#tableList [data-seat="${c}"]`, { hasText: name(c) }).waitFor();
  }
  for (const c of COLORS) {
    const { page } = by[c];
    await page.waitForURL(/\/four\.html\?id=\d+$/);
    await page.waitForFunction(() => me !== null && running);
    assert.equal(await page.evaluate(() => me), c);
    assert.equal(await page.locator("#plate-br").getAttribute("data-color"), c);
  }
  const gameId = Number(new URL(by.r.page.url()).searchParams.get("id"));

  // The game, a click from and a click to on the mover's own board.
  for (const [i, [c, from, to]] of LINE.entries()) {
    const page = by[c].page;
    await page.waitForFunction((k) => game.history.length === k && game.turn === me, i);
    await page.locator(`#board .square[data-sq="${sq(from)}"]`).click();
    await page.locator(`#board .square[data-sq="${sq(to)}"]`).click();
    if (i < LINE.length - 1) for (const o of COLORS) await by[o].page.waitForFunction((k) => game.history.length === k, i + 1);
  }

  // Mated on Blue's own turn, straight after Red's move.
  const told = {
    r: "Game over: Red & Yellow win — Blue is checkmated · your team wins",
    y: "Game over: Red & Yellow win — Blue is checkmated · your team wins",
    b: "Game over: Red & Yellow win — Blue is checkmated · your team loses",
    g: "Game over: Red & Yellow win — Blue is checkmated · your team loses",
  };
  for (const c of COLORS) await by[c].page.locator("#status", { hasText: told[c] }).waitFor();
  const row = db().prepare("SELECT status, result, termination FROM games WHERE id = ?").get(gameId);
  assert.deepEqual(row, { status: "finished", result: "1-0", termination: "checkmate" });
  for (const c of ["r", "y"]) await by[c].page.locator(".ach-toast", { hasText: "Four Corners" }).waitFor();
  assert.equal(await by.b.page.locator(".ach-toast", { hasText: "Four Corners" }).count(), 0);
  assert.equal(await by.r.page.locator(`#board .square[data-sq="${sq("a7")}"].check`).count(), 1, "Blue's king in check");

  // Green's history: Green, against Red and Yellow with Blue, lost.
  const green = by.g.page;
  await green.goto(srv.baseUrl + "/profile.html#games");
  const entry = green.locator(".history-table tbody tr");
  await entry.waitFor();
  assert.deepEqual((await entry.locator("td").allTextContents()).slice(2, 6),
    ["Four-Player Chess", "Green", `${name("r")} & ${name("y")} with ${name("b")}`, "Loss (checkmate)"]);

  // The replay, from the game page's link, ends on the mate.
  const red = by.r.page;
  await red.locator("#replayLink").click();
  await red.waitForURL(/\/fourReplay\.html\?id=\d+$/);
  await red.locator("#replayStatus", { hasText: "win" }).waitFor();
  assert.equal(await red.locator("#replayStatus").textContent(), "Red & Yellow win — Blue is checkmated · your team won");
  assert.equal(await red.locator("#history .mv.current").textContent(), "Qg1xb6#");
  assert.equal(await red.locator(`#board .square[data-sq="${sq("b6")}"] img`).getAttribute("alt"), "rq");
});
