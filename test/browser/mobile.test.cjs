"use strict";

// The clocks on a phone, at the screen a phone's browser leaves for the page
// (its own bars take the rest). On the game page the side panel stacks under
// the board there, so its clocks move beside the board: the opponent's above,
// yours below, both on screen with the board; back into the panel when the
// window is wide again, and never in an AI game, which has none. On the
// four-player page each corner plate keeps its clock in view, the name
// giving way.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, registerUser, connectSocket, quickMatch } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const { FourPlayer } = require("../../src/shared/fourPlayer");

const PHONES = [{ width: 390, height: 664 }, { width: 360, height: 640 }];
let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

// Where an element is, in the window as first shown (no scrolling).
const box = (page, selector) => page.locator(selector).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
});

test("a PvP game on a phone: the clocks above and below the board, on screen", async (t) => {
  const me = await signedInPage(browser, srv.baseUrl, t);
  const them = await registerUser(srv.baseUrl, "rival");
  const sockets = [await connectSocket(srv.baseUrl, me.user.c.cookie()), await connectSocket(srv.baseUrl, them.c.cookie())];
  t.after(() => sockets.forEach((s) => s.close()));
  const { gameId } = await quickMatch(sockets[0], sockets[1], { tc: "5+0" });
  const page = me.page;
  for (const phone of PHONES) {
    await page.setViewportSize(phone);
    await page.goto(srv.baseUrl + "/game.html?id=" + gameId);
    await page.locator("#clockTop", { hasText: /\d:\d\d/ }).waitFor();
    const top = await box(page, "#clockTop"), bottom = await box(page, "#clockBottom");
    const board = await box(page, "#board");
    assert.ok(top.bottom <= board.top, `${phone.width}: the opponent's clock above the board`);
    assert.ok(bottom.top >= board.bottom, `${phone.width}: yours below it`);
    assert.ok(top.top >= 0 && bottom.bottom <= phone.height, `${phone.width}: both on screen ${JSON.stringify([top, bottom])}`);
    assert.equal(await page.locator(".board-wrap #clockTopWho").textContent(), them.user.username);
  }
  // Wide again: back in the panel beside the board.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator("#clocks #clockTop").waitFor();
  assert.equal(await page.locator(".board-wrap .clock-row").count(), 0);
});

test("an AI game on a phone has no clocks beside the board", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.setViewportSize(PHONES[0]);
  await page.goto(srv.baseUrl + "/game.html?mode=ai&level=beginner&color=w");
  await page.locator("#board .square").first().waitFor();
  assert.equal(await page.locator(".board-wrap .clock-row").count(), 0);
  assert.equal(await page.locator("#clockTop").isVisible(), false);
});

test("a four-player game on a phone: every plate shows its clock", async (t) => {
  const me = await signedInPage(browser, srv.baseUrl, t);
  const seats = { r: { userId: me.user.user.id, username: me.user.user.username } };
  for (const c of ["b", "y", "g"]) {
    const u = await registerUser(srv.baseUrl, "longername");
    seats[c] = { userId: u.user.id, username: u.user.username };
  }
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs: 300000, incrementMs: 0 });
  const page = me.page;
  for (const phone of PHONES) {
    await page.setViewportSize(phone);
    await page.goto(srv.baseUrl + "/four.html?id=" + gameId);
    await page.locator('.four-plate .clock[data-clock="r"]', { hasText: /\d:\d\d/ }).waitFor();
    for (const c of FourPlayer.COLORS) {
      const plate = await box(page, `.four-plate[data-color="${c}"]`);
      const clock = await box(page, `.four-plate .clock[data-clock="${c}"]`);
      assert.ok(clock.top >= plate.top && clock.bottom <= plate.bottom, `${phone.width} ${c}: ${JSON.stringify([plate, clock])}`);
      assert.ok(clock.bottom <= phone.height, `${phone.width} ${c}: on screen`);
    }
  }
});
