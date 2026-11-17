"use strict";

// Gambling Chess on the game page. Against LorFish: the page deals each turn,
// the badge by the board shows what was dealt, only that type can be picked
// up, LorFish moves the type it was dealt, and a reload keeps the deal.
// Between two people: the server deals, both pages show its deal, and a
// premove is played if it uses the type dealt when its turn comes, dropped if
// not.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");
const matchmaking = require("../../src/game/matchmaking");
const rooms = require("../../src/game/rooms");
const { Chess } = require("../../src/shared/chess");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

const ready = (page) => page.waitForFunction(() => gameStore.currentId() != null && !thinking);
const square = (page, name) => page.locator(`#board [data-sq="${(Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97}"]`);
const WORDS = { p: "a pawn", n: "a knight", b: "a bishop", r: "a rook", q: "a queen", k: "the king" };

test("against LorFish: the deal, its badge, only the dealt type to pick up, and a reload that keeps it", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.locator("#aiVariantSelect").selectOption("gambling");
  await page.locator("#aiLevelSelect").selectOption("beginner");
  await page.locator("#aiPlayBtn").click();
  await page.waitForURL(/variant=gambling/);
  await ready(page);

  // White's first deal is a pawn or a knight; the badge says which.
  const first = await page.evaluate(() => chess.dealt);
  assert.ok(["p", "n"].includes(first), first);
  assert.equal(await page.locator("#dealText").textContent(), `You must move ${WORDS[first]}`);
  assert.match(await page.locator("#dealPiece").getAttribute("src"), /w_/);

  // A knight, then: a pawn can't be picked up, a knight can.
  await page.evaluate(() => { chess.deal("n"); render(); });
  await square(page, "e2").click();
  assert.equal(await page.locator("#board .hint").count(), 0);
  await square(page, "g1").click();
  assert.equal(await page.locator("#board .hint").count(), 2, "f3 and h3");
  await square(page, "f3").click();

  // LorFish was dealt its own type, and moved it.
  await page.waitForFunction(() => chess.history.length === 2 && !thinking, null, { timeout: 15000 });
  const reply = await page.evaluate(() => {
    const h = chess.history[1];
    return { dealt: h.dealt, moved: chess.squares[h.move.to].t, next: chess.dealt };
  });
  assert.ok(reply.dealt, "LorFish's turn was dealt");
  assert.equal(reply.moved, reply.dealt);
  assert.ok(reply.next, "and White's next turn");

  // The deal is stored with the position: a reload keeps it.
  const id = await page.evaluate(() => gameStore.currentId());
  const stored = () => Chess.dealtIn(db().prepare("SELECT current_fen FROM games WHERE id = ?").get(id).current_fen);
  for (let i = 0; i < 50 && stored() !== reply.next; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(stored(), reply.next);
  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => chess.dealt), reply.next);
  assert.equal(await page.locator("#dealText").textContent(), `You must move ${WORDS[reply.next]}`);
});

test("between two people: the server's deal on both pages, and a premove played or dropped by it", async (t) => {
  const white = await signedInPage(browser, srv.baseUrl, t);
  const black = await signedInPage(browser, srv.baseUrl, t);
  const gameId = matchmaking.startMatch(srv.io,
    { userId: white.user.user.id, username: white.user.user.username },
    { userId: black.user.user.id, username: black.user.user.username },
    { variant: "gambling", initialMs: 300000, incrementMs: 0 });
  // The server's deals, chosen here: each one in turn, if it can move.
  const deal = rooms.dealTurn;
  const queue = [];
  rooms.dealTurn = (room) => (queue.length && room.chess.deal(queue.shift()) ? room.chess.dealt : deal(room));
  t.after(() => { rooms.dealTurn = deal; });
  rooms.getRoom(gameId).chess.deal("n");

  for (const p of [white, black]) {
    await p.page.goto(srv.baseUrl + "/game.html?id=" + gameId);
    await p.page.waitForFunction(() => pvpMode && chess.dealt != null);
  }
  assert.equal(await white.page.locator("#dealText").textContent(), "You must move a knight");
  assert.equal(await black.page.locator("#dealText").textContent(), "White must move a knight");

  // White: a pawn can't be picked up; the knight goes. Black is dealt a pawn.
  queue.push("p");
  await square(white.page, "e2").click();
  assert.equal(await white.page.locator("#board .hint").count(), 0);
  await square(white.page, "g1").click();
  await square(white.page, "f3").click();
  await black.page.waitForFunction(() => chess.history.length === 1);
  assert.equal(await black.page.locator("#dealText").textContent(), "You must move a pawn");
  assert.equal(await white.page.locator("#dealText").textContent(), "Black must move a pawn");

  // White premoves a pawn; the server deals White a knight: dropped.
  await square(white.page, "e2").click();
  await square(white.page, "e4").click();
  assert.match(await white.page.locator("#turn").textContent(), /premove/);
  queue.push("n");
  await square(black.page, "e7").click();
  await square(black.page, "e5").click();
  await white.page.waitForFunction(() => chess.history.length === 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await white.page.evaluate(() => chess.history.length), 2, "the pawn premove was dropped");
  assert.equal(await white.page.locator("#dealText").textContent(), "You must move a knight");

  // White moves the knight, premoves a pawn again, and is dealt a pawn this
  // time: played the moment Black has moved.
  queue.push("p");
  await square(white.page, "f3").click();
  await square(white.page, "g5").click();
  await black.page.waitForFunction(() => chess.history.length === 3);
  await square(white.page, "e2").click();
  await square(white.page, "e4").click();
  queue.push("p");
  await square(black.page, "d7").click();
  await square(black.page, "d6").click();
  await white.page.waitForFunction(() => chess.history.length === 5);
  assert.equal(await white.page.evaluate(() => moveHistory[4]), "e4");
  const row = db().prepare("SELECT premove FROM moves WHERE game_id = ? AND ply = 5").get(gameId);
  assert.equal(row.premove, 1);
});
