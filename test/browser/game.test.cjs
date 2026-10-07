"use strict";

// Exercise board lifecycle through the real page, API, database and worker.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser, signedInPage, db } = require("./helpers.cjs");

let srv, browser;
before(async () => { srv = await startServer(); browser = await openBrowser(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

async function ready(page) {
  await page.waitForFunction(() => gameStore.currentId() != null && !thinking);
  return page.evaluate(() => gameStore.currentId());
}

test("refresh resumes the displayed AI game after each way of starting one", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  let id = await ready(page);
  await page.locator('#board [data-sq="12"]').click();
  await page.locator('#board [data-sq="28"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  await page.waitForLoadState("networkidle");
  await page.reload();
  assert.equal(await ready(page), id);
  assert.equal(await page.evaluate(() => chess.history.length), 2);

  // New Game and Load FEN keep the level and colour the game was set up with.
  for (const [action, settings] of [
    [() => page.locator("#resetBtn").click(), { humanColor: "w", aiLevel: "intermediate" }],
    [() => page.goto(srv.baseUrl + "/game.html?mode=ai&level=advanced&color=b"), { humanColor: "b", aiLevel: "advanced" }],
    [async () => {
      await page.locator("#loadFenBtn").click();
      await page.locator("#fenText").fill("7k/7p/8/8/8/8/P7/K7 b - - 0 1");
      await page.locator("#fenLoadBtn").click();
    }, { humanColor: "b", aiLevel: "advanced" }],
  ]) {
    await action();
    await page.waitForFunction(old => gameStore.currentId() && gameStore.currentId() !== old && !thinking, id);
    id = await ready(page);
    assert.equal(new URL(page.url()).searchParams.get("id"), String(id));
    await page.waitForLoadState("networkidle");
    const fen = await page.evaluate(() => chess.fen());
    await page.reload();
    assert.equal(await ready(page), id);
    assert.equal(await page.evaluate(() => chess.fen()), fen);
    assert.deepEqual(await page.evaluate(() => ({ humanColor, aiLevel })), settings);
    assert.equal(db().prepare("SELECT status FROM games WHERE id = ?").get(id).status, "active");
  }
});

test("moves played during game creation survive its response", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  await ready(page);
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route("**/api/games", async (route) => {
    if (route.request().method() === "POST") {
      arrived.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await page.locator("#resetBtn").click();
  await arrived.promise;
  await page.locator('#board [data-sq="12"]').click();
  await page.locator('#board [data-sq="28"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  const before = await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() }));
  assert.equal(before.pgn.length, 2);
  const saved = page.waitForResponse(r => r.url().endsWith("/moves") && r.request().postDataJSON().ply === 2);
  release.resolve();
  const id = await ready(page);
  assert.equal((await saved).status(), 201);
  assert.deepEqual(await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() })), before);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(id).n, 2);
});

test("an earlier creation response cannot reset a newer board or its URL", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  await ready(page);
  const pending = Array.from({ length: 2 }, () => ({ arrived: Promise.withResolvers(), release: Promise.withResolvers() }));
  t.after(() => pending.forEach(p => p.release.resolve()));
  let index = 0;
  await page.route("**/api/games", async (route) => {
    if (route.request().method() === "POST") {
      const p = pending[index++];
      p.arrived.resolve();
      await p.release.promise;
    }
    await route.continue();
  });
  await page.locator("#resetBtn").click();
  await pending[0].arrived.promise;
  await page.locator("#loadFenBtn").click();
  await page.locator("#fenText").fill("7k/7p/8/8/8/8/P7/K7 w - - 0 1");
  await page.locator("#fenLoadBtn").click();
  await pending[1].arrived.promise;
  pending[1].release.resolve();
  const id = await ready(page);
  await page.locator('#board [data-sq="8"]').click();
  await page.locator('#board [data-sq="16"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  const state = await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() }));
  pending[0].release.resolve();
  await page.waitForLoadState("networkidle");
  assert.equal(await ready(page), id);
  assert.equal(new URL(page.url()).searchParams.get("id"), String(id));
  assert.deepEqual(await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice() })), state);
});

test("the lobby's level and colour set a game that cannot change them", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.addInitScript(() => {
    window.requested = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (data, ...args) {
      window.requested.push({ depth: data.depth, temperature: data.temperature });
      return post.call(this, data, ...args);
    };
  });
  // Black's reply leaves e7e5 legal whatever LorFish opened with.
  const cases = [
    { level: "advanced", color: "w", depth: 4, temperature: 0, label: "Advanced (~1800)", move: [12, 28] },
    { level: "beginner", color: "b", depth: 1, temperature: 120, label: "Beginner (~700)", move: [52, 36] },
  ];
  let lastLevel = "intermediate";
  for (const { level, color, depth, temperature, label, move } of cases) {
    // The picker starts at the level of the previous game (the default at first).
    await page.goto(srv.baseUrl + "/lobby.html");
    await page.waitForFunction(l => document.getElementById("aiLevelSelect").value === l, lastLevel);
    lastLevel = level;
    await page.locator("#aiLevelSelect").selectOption(level);
    await page.locator("#aiColorSelect").selectOption(color);
    await page.locator("#aiPlayBtn").click();
    await page.waitForURL(/\/game\.html\?/);
    const id = await ready(page);
    const url = new URL(page.url()).searchParams;
    assert.deepEqual([url.get("level"), url.get("color"), url.get("id")], [level, color, String(id)]);
    assert.deepEqual({ ...db().prepare("SELECT ai_level, ai_depth, ai_color FROM games WHERE id = ?").get(id) },
      { ai_level: level, ai_depth: depth, ai_color: color === "w" ? "b" : "w" });
    // The page reports the settings and offers nothing to change them with.
    assert.equal(await page.locator("#aiControls select").count(), 0);
    assert.equal(await page.locator("#aiLevelText").textContent(), label);
    assert.equal(await page.locator("#humanColorText").textContent(), color === "w" ? "White" : "Black");

    await page.waitForLoadState("networkidle");
    await page.reload();
    assert.equal(await ready(page), id);
    assert.equal(await page.locator("#aiLevelText").textContent(), label);
    const plies = await page.evaluate(() => chess.history.length);
    await page.locator(`#board [data-sq="${move[0]}"]`).click();
    await page.locator(`#board [data-sq="${move[1]}"]`).click();
    await page.waitForFunction(n => chess.history.length === n + 2 && !thinking, plies);
    assert.deepEqual(await page.evaluate(() => window.requested), [{ depth, temperature }]);
  }
  await page.goto(srv.baseUrl + "/lobby.html");
  await page.waitForFunction(l => document.getElementById("aiLevelSelect").value === l, lastLevel);
});

test("premoves resolve rook-target castling and queen promotion through legal moves", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  await ready(page);
  const cases = [
    { fen: "4k3/8/8/8/8/8/8/4K2R w K - 0 1", from: 4, to: 7, castle: "K" },
    { fen: "4k3/8/8/8/8/8/8/4K2R w K - 0 1", from: 4, to: 6, castle: "K" },
    { fen: "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", from: 4, to: 0, castle: "Q" },
    { fen: "4k3/8/8/8/8/8/8/5K1R w K - 0 1", from: 5, to: 7, castle: "K", variant: "chess960" },
    { fen: "4k3/8/8/8/8/8/8/6KR w K - 0 1", from: 6, to: 7, castle: "K", variant: "chess960" },
    // The king's one-square gesture in Chess960 is an ordinary move.
    { fen: "4k3/8/8/8/8/8/8/5K1R w K - 0 1", from: 5, to: 6, castle: null, variant: "chess960" },
    { fen: "4kr2/8/8/8/8/8/8/4K2R w K - 0 1", from: 4, to: 7, illegal: true },
    { fen: "7k/P7/8/8/8/8/8/K7 w - - 0 1", from: 48, to: 56, promo: "q" },
  ];
  for (const spec of cases) {
    const result = await page.evaluate(spec => {
      if (moveSource.cancel) moveSource.cancel();
      chess.setVariant(spec.variant || "standard");
      chess.loadFen(spec.fen);
      humanColor = "w";
      thinking = false;
      let submitted = null;
      moveSource = {
        kind: "ai", canHumanMoveNow: () => true,
        submitMove: (move, opts) => { submitted = { castle: move.castle || null, promo: move.promo || null, premove: opts.premove }; },
      };
      const offered = premoveTargets(spec.from).includes(spec.to);
      playPremove({ from: spec.from, to: spec.to });
      return { offered, submitted };
    }, spec);
    assert.equal(result.offered, true);
    if (spec.illegal) assert.equal(result.submitted, null);
    else assert.deepEqual(result.submitted, { castle: spec.castle || null, promo: spec.promo || null, premove: true });
  }
});

test("loading a terminal FEN preserves the current game and creates no record", async (t) => {
  const { page } = await signedInPage(browser, srv.baseUrl, t);
  await page.goto(srv.baseUrl + "/game.html");
  const id = await ready(page);
  await page.locator('#board [data-sq="12"]').click();
  await page.locator('#board [data-sq="28"]').click();
  await page.waitForFunction(() => chess.history.length === 2 && !thinking);
  await page.waitForLoadState("networkidle");
  const before = await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice(), url: location.href }));
  const count = db().prepare("SELECT COUNT(*) AS n FROM games").get().n;
  for (const fen of [
    "7k/8/8/8/8/8/8/K7 w - - 0 1",
    "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1",
    "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1",
    "7k/7p/8/8/8/8/P7/K7 w - - 100 51",
  ]) {
    await page.locator("#loadFenBtn").click();
    await page.locator("#fenText").fill(fen);
    await page.locator("#fenLoadBtn").click();
    assert.match(await page.locator("#fenError").innerText(), /already over/);
    await page.locator("#fenCancelBtn").click();
    assert.equal(await page.evaluate(() => gameStore.currentId()), id);
    assert.deepEqual(await page.evaluate(() => ({ fen: chess.fen(), pgn: moveHistory.slice(), url: location.href })), before);
  }
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM games").get().n, count);
  assert.equal(db().prepare("SELECT status FROM games WHERE id = ?").get(id).status, "active");
  await page.locator("#resetBtn").click();
  await page.waitForFunction(old => gameStore.currentId() && gameStore.currentId() !== old, id);
  await page.waitForLoadState("networkidle");
  assert.equal(db().prepare("SELECT status FROM games WHERE id = ?").get(id).status, "aborted");
});
