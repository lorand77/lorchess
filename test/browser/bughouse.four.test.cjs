"use strict";

// A whole Bughouse match between four people, each in their own browser. A
// table fills seat by seat and starts itself; each player lands on their own
// board; a capture on board 1 goes to the partner on board 2, who drops it by
// clicking; partners call to each other; a resignation ends the match for all
// four, each told their team's result; and the match replays.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const bots = require("../../src/game/bots");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
  await bots.shutdown();
});

const click = (page, sq) => page.locator(`#board [data-sq="${sq}"]`).click();
const SQ = { e2: 12, e4: 28, d7: 51, d5: 35, d8: 59, g1: 6, f3: 21, e5: 36 };

test("four people: a table that starts itself, a piece passed and dropped, a call, a resignation", async (t) => {
  // Seats: A0 (host, White on board 1), A1 (Black on board 2, the host's
  // partner), B0 (Black on board 1), B1 (White on board 2).
  const seats = {};
  for (const seat of ["A0", "A1", "B0", "B1"]) {
    seats[seat] = await signedInPage(browser, srv.baseUrl, t);
    await seats[seat].page.setViewportSize({ width: 1300, height: 950 });
    await seats[seat].page.goto(srv.baseUrl + "/lobby.html");
  }
  const name = (seat) => seats[seat].user.user.username;
  await seats.A0.page.locator("#variantSelect").selectOption("bughouse");
  await seats.A0.page.locator("#tableOpenBtn").click();
  for (const seat of ["A1", "B0", "B1"]) {
    const sit = seats[seat].page.locator(`#tableList [data-seat="${seat}"] button`);
    await sit.waitFor();
    await sit.click();
    if (seat !== "B1") await seats.A0.page.locator(`#tableList [data-seat="${seat}"]`, { hasText: name(seat) }).waitFor();
  }
  // The fourth to sit started it: everyone is on their own board.
  for (const [seat, board, colour] of [["A0", 0, "w"], ["B0", 0, "b"], ["B1", 1, "w"], ["A1", 1, "b"]]) {
    const { page } = seats[seat];
    await page.waitForURL(/game\.html\?id=\d+/);
    await page.waitForFunction(() => chess.isBughouse && partner && lastPvpState);
    assert.deepEqual(await page.evaluate(() => [lastPvpState.match.board, humanColor]), [board, colour], seat);
  }
  assert.equal(await seats.A0.page.locator("#partnerBottomWho").textContent(), name("A1"));
  assert.equal(await seats.B1.page.locator("#partnerBottomWho").textContent(), name("B0"));
  for (const seat of ["A0", "B0", "B1", "A1"]) await seats[seat].page.waitForFunction(() => clockRunning);

  // Board 1: 1.e4 d5 2.exd5 — a black pawn for A's Black on board 2.
  const plies = (page, n) => page.waitForFunction((k) => chess.history.length === k, n);
  await click(seats.A0.page, SQ.e2); await click(seats.A0.page, SQ.e4);
  await plies(seats.B0.page, 1);
  await click(seats.B0.page, SQ.d7); await click(seats.B0.page, SQ.d5);
  await plies(seats.A0.page, 2);
  await click(seats.A0.page, SQ.e4); await click(seats.A0.page, SQ.d5);
  await seats.A1.page.waitForFunction(() => chess.pockets.b.p === 1);
  assert.match(await seats.A1.page.locator("#pvpNotice").textContent(), /Your partner sent you a pawn/);
  // Board 1 as board 2's players see it beside theirs, pockets and all.
  await seats.B1.page.waitForFunction(() => partner && partner.san === "exd5");

  // Board 2: 1.Nf3, and A's Black drops the pawn: P@e5.
  await click(seats.B1.page, SQ.g1); await click(seats.B1.page, SQ.f3);
  await plies(seats.A1.page, 1);
  await seats.A1.page.locator('#capturedBottom .pocket-piece[data-drag-from="@p"]').click();
  await click(seats.A1.page, SQ.e5);
  await plies(seats.B1.page, 2);
  assert.equal(await seats.B1.page.evaluate(() => chess.history[1].move.drop), "p");

  // Partners call to each other; the other team hears nothing.
  await seats.A1.page.locator('#bughouseCalls button[data-call="need-n"]').click();
  await seats.A0.page.waitForFunction((who) => document.getElementById("bughouseHeard").textContent === `${who}: Need a knight`, name("A1"));
  assert.equal(await seats.B0.page.locator("#bughouseHeard").textContent(), "");

  // B's Black on board 1 resigns: the match is A's, as all four are told.
  seats.B0.page.once("dialog", (d) => d.accept());
  await seats.B0.page.locator("#resignBtn").click();
  const outcome = {
    A0: /^Game Over: 1-0 — resign · your team wins the match$/,
    B0: /^Game Over: 1-0 — resign · your team loses the match$/,
    B1: /^Game Over: 0-1 — on the other board · your team loses the match$/,
    A1: /^Game Over: 0-1 — on the other board · your team wins the match$/,
  };
  for (const seat of Object.keys(outcome)) {
    await seats[seat].page.waitForFunction(() => pvpResult && pvpResult.match);
    assert.match(await seats[seat].page.locator("#status").textContent(), outcome[seat], seat);
  }
  const gameId = Number(new URL(seats.A1.page.url()).searchParams.get("id"));
  const match = db().prepare("SELECT m.* FROM matches m JOIN games g ON g.match_id = m.id WHERE g.id = ?").get(gameId);
  assert.deepEqual([match.status, match.result, match.termination, match.decided_on], ["finished", "A", "resign", 0]);

  // Board 2 replays with the dropped pawn arriving from board 1 in time.
  await seats.A1.page.goto(srv.baseUrl + "/replay.html?id=" + gameId);
  await seats.A1.page.waitForFunction(() => match && other);
  assert.equal(await seats.A1.page.evaluate(() => chess.fen()), "rnbqkbnr/pppppppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R[] w KQkq - 0 2");
  assert.match(await seats.A1.page.locator("#replayStatus").textContent(), /^Black wins on the other board · team A won the match$/);
});
