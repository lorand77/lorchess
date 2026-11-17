"use strict";

// A whole four-player free-for-all game between four people, each in their own
// browser, from the lobby to the replay. A free-for-all table fills seat by
// seat and starts itself; every move is a click on the board of whoever is to
// move. Red mates Blue in four moves of its own, which puts Blue out — greyed,
// its army grey, watching — while the other three play on; Yellow resigns;
// Red, 21 points ahead of Green, claims the win. All four see the placings,
// Red gets "Lone Wolf", and the game is in each history and replays to the
// claim.
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

// The Teams game's line (fourPlayer.four.test.cjs), which mates Blue the same
// way here: Red opens the queen's diagonal (f3) and the bishop's (h3), posts
// the bishop on c7 and takes on b6 with the queen. A pawn and a mate: 21.
const LINE = [
  ["r", "f2", "f3"], ["b", "b11", "c11"], ["y", "j13", "j12"], ["g", "m11", "l11"],
  ["r", "h2", "h3"], ["b", "b10", "c10"], ["y", "k13", "k12"], ["g", "m9", "l9"],
  ["r", "i1", "c7"], ["b", "b9", "c9"], ["y", "e13", "e12"], ["g", "m10", "k10"],
  ["r", "g1", "b6"],
];

test("four people, everyone for themselves: a table, a mate that puts Blue out, a resignation, a claim, the placings", async (t) => {
  const by = {};
  for (const c of COLORS) {
    by[c] = await signedInPage(browser, srv.baseUrl, t);
    await by[c].page.setViewportSize({ width: 1300, height: 950 });
    await by[c].page.goto(srv.baseUrl + "/lobby.html");
  }
  const name = (c) => by[c].user.user.username;
  const plies = (c, k) => by[c].page.waitForFunction((n) => game.history.length === n, k);

  // Red opens a free-for-all table: four seats in turn order, no teams.
  await by.r.page.locator("#variantSelect").selectOption("fourplayer_ffa");
  await by.r.page.locator("#tableOpenBtn").click();
  await by.r.page.locator("#tableList", { hasText: "Each for themselves" }).waitFor();
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
    assert.equal(await page.locator("#gameTitle").textContent(), "Four-Player Free-for-All");
  }
  const gameId = Number(new URL(by.r.page.url()).searchParams.get("id"));

  // The game, a click from and a click to on the mover's own board.
  for (const [i, [c, from, to]] of LINE.entries()) {
    const page = by[c].page;
    await page.waitForFunction((k) => game.history.length === k && game.turn === me, i);
    await page.locator(`#board .square[data-sq="${sq(from)}"]`).click();
    await page.locator(`#board .square[data-sq="${sq(to)}"]`).click();
    for (const o of COLORS) await plies(o, i + 1);
  }

  // Blue is mated on its own turn and out; the game goes on, Yellow to move.
  for (const c of COLORS) {
    const page = by[c].page;
    assert.equal(await page.locator('[data-points="r"]').textContent(), "21 pts", c);
    assert.equal(await page.locator('[data-points="b"]').textContent(), "0 pts · checkmated", c);
    assert.match(await page.locator('.four-plate[data-color="b"]').getAttribute("class"), /\bout\b/);
    assert.equal(await page.locator("#board img.piece.four-dead").count(), 15, "Blue's army but the b6 pawn");
  }
  assert.match(await by.b.page.locator("#turn").textContent(), /you are out \(checkmated\), watching/);
  assert.equal(await by.b.page.locator("#controls").isVisible(), false);
  assert.match(await by.y.page.locator("#turn").textContent(), /Turn: Yellow — your move/);
  assert.equal(await by.r.page.locator("#claimBtn").isVisible(), false, "three still in");

  // Yellow resigns from its page.
  by.y.page.once("dialog", (d) => d.accept());
  await by.y.page.locator("#resignBtn").click();
  for (const c of COLORS) await plies(c, 14);
  assert.equal(await by.r.page.locator("#history div").last().textContent(), "14. Yellow resigned");

  // Two left, Red 21 points ahead: Red claims, Green gets 20.
  const claim = by.r.page.locator("#claimBtn");
  await claim.waitFor();
  assert.equal(await by.g.page.locator("#claimBtn").isVisible(), false);
  by.r.page.once("dialog", (d) => d.accept());
  await claim.click();

  const placings = "Game over — Red claimed the win: 1st Red 21 · 2nd Green 20 · 3rd Blue 0 · 3rd Yellow 0";
  const finish = { r: "1st", b: "3rd", y: "3rd", g: "2nd" };
  for (const c of COLORS) {
    await by[c].page.locator("#status.game-over").waitFor();
    assert.equal(await by[c].page.locator("#status").textContent(), `${placings} · you finish ${finish[c]}`);
  }
  const row = db().prepare("SELECT status, result, termination FROM games WHERE id = ?").get(gameId);
  assert.deepEqual(row, { status: "finished", result: "r,g,b=y", termination: "claim" });
  await by.r.page.locator(".ach-toast", { hasText: "Lone Wolf" }).waitFor();
  assert.equal(await by.g.page.locator(".ach-toast", { hasText: "Lone Wolf" }).count(), 0);

  // Green's history: Green, against the other three, second.
  const green = by.g.page;
  await green.goto(srv.baseUrl + "/profile.html#games");
  const entry = green.locator(".history-table tbody tr");
  await entry.waitFor();
  assert.deepEqual((await entry.locator("td").allTextContents()).slice(2, 6),
    ["Four-Player Free-for-All", "Green", `${name("r")}, ${name("b")}, ${name("y")}`, "2nd · 20 pts"]);

  // The replay, from the game page's link: the placings, and the mate a step
  // before Yellow left.
  const red = by.r.page;
  await red.locator("#replayLink").click();
  await red.waitForURL(/\/fourReplay\.html\?id=\d+$/);
  await red.locator("#replayStatus.game-over").waitFor();
  assert.equal(await red.locator("#replayStatus").textContent(),
    "1st Red 21 · 2nd Green 20 · 3rd Blue 0 · 3rd Yellow 0 — Red claimed the win · you finished 1st");
  assert.equal(await red.locator("#history .mv.current").textContent(), "Red claimed the win");
  await red.locator('#history .mv[data-ply="13"]').click();
  assert.equal(await red.locator("#history .mv.current").textContent(), "Qg1xb6#");
  assert.equal(await red.locator('[data-points="b"]').textContent(), "0 pts · checkmated");
  assert.equal(await red.locator('[data-points="y"]').textContent(), "0 pts");
});
