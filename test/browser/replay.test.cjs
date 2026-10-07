"use strict";

// The review page names the LorFish level an AI game was played at.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const { moveOf } = require("../helpers/board");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

// A finished fool's mate against LorFish (White), the user winning as Black.
async function finishedAiGame(client, level) {
  const { gameId } = (await client.post("/api/games", { humanColor: "b", level })).body;
  const chess = new Chess();
  const ucis = ["f2f3", "e7e5", "g2g4", "d8h4"];
  for (const [i, uci] of ucis.entries()) {
    const m = moveOf(chess, uci);
    const san = chess.moveToSan(m);
    chess.makeMove(m);
    const res = await client.post(`/api/games/${gameId}/moves`, {
      ply: i + 1, san, uci, fenAfter: chess.fen(), byColor: i % 2 === 0 ? "w" : "b",
    });
    assert.equal(res.status, 201);
  }
  assert.equal((await client.post(`/api/games/${gameId}/end`, { result: "0-1", termination: "checkmate" })).status, 200);
  return gameId;
}

test("the title and the review summary name LorFish's level", async (t) => {
  const { page, user: account } = await signedInPage(browser, srv.baseUrl, t);
  const id = await finishedAiGame(account.c, "casual");
  // Game review is a membership perk.
  db().prepare("UPDATE users SET member_since = datetime('now') WHERE id = ?").run(account.user.id);
  await page.goto(`${srv.baseUrl}/replay.html?id=${id}`);
  await page.waitForFunction(() => document.getElementById("replayTitle").textContent !== "Replay");
  assert.equal(await page.locator("#replayTitle").textContent(), "vs LorFish · Casual (~1200)");

  await page.locator("#reviewBtn").click();
  await page.locator("#reviewSummary .review-name").first().waitFor({ timeout: 60000 });
  const names = await page.locator("#reviewSummary .review-name").allTextContents();
  assert.deepEqual(names, ["LorFish (Casual)", account.user.username]);
});

test("a game from before levels shows its depth, or nothing if it has none", async (t) => {
  const { page, user: account } = await signedInPage(browser, srv.baseUrl, t);
  const id = await finishedAiGame(account.c, "intermediate");
  const title = async () => {
    await page.goto(`${srv.baseUrl}/replay.html?id=${id}`);
    await page.waitForFunction(() => document.getElementById("replayTitle").textContent !== "Replay");
    return page.locator("#replayTitle").textContent();
  };
  db().prepare("UPDATE games SET ai_level = NULL, ai_depth = 3 WHERE id = ?").run(id);
  assert.equal(await title(), "vs LorFish · depth 3");
  db().prepare("UPDATE games SET ai_depth = NULL WHERE id = ?").run(id);
  assert.equal(await title(), "vs LorFish");
});
