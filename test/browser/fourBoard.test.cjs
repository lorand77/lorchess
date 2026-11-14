"use strict";

// The four-player board view (public/js/fourBoardView.js) on its own, before
// any page uses it: drawn on a plain page from the engine's start position.
// The cross of 160 squares with empty corners, each colour's army at the
// bottom when it is that colour's board, coordinates along the cross's edges,
// pieces tinted in four colours, highlights (two kings in check at once), and
// clicks, drags and arrows all speaking the engine's square numbers.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, openBrowser } = require("./helpers.cjs");
const { FourPlayer } = require("../../src/shared/fourPlayer");

let srv, browser, page;
const errors = [];
before(async () => {
  srv = await startServer();
  browser = await openBrowser();
  page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(srv.baseUrl + "/terms.html");
  for (const f of ["fourPlayer", "boardDrag", "boardArrows", "fourBoardView"]) {
    await page.addScriptTag({ url: `/js/${f}.js` });
  }
  // A board on the page, and a view that records what it was told.
  await page.evaluate(() => {
    document.body.innerHTML = '<div class="board-wrap"><div id="board" class="board"></div></div>';
    window.seen = [];
    window.game = new FourPlayer();
    window.view = FourBoardView.create(document.getElementById("board"), {
      pieceSrc: (p) => Theme.pieceSrc(p.c, p.t),
      onSquareClick: (sq) => seen.push(["click", sq]),
      canDrag: (sq) => !!game.squares[sq],
      onPick: (sq) => seen.push(["pick", sq]),
      onDrop: (from, to) => seen.push(["drop", from, to]),
    });
    window.show = (state) => view.render({ pieces: game.squares, ...state });
  });
});
after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
  assert.deepEqual(errors, [], "browser exceptions");
});

const sq = (name) => FourPlayer.squareOf(name);
const cell = (name) => page.locator(`#board .square[data-sq="${sq(name)}"]`);
// Where a square is on screen, in squares from the board's top left.
const at = (name) => page.evaluate((n) => {
  const el = document.querySelector(`#board .square[data-sq="${n}"]`);
  return [Math.round(el.offsetLeft / el.offsetWidth), Math.round(el.offsetTop / el.offsetHeight)];
}, sq(name));

test("the cross: 160 squares, empty corners, Red's army at the bottom", async () => {
  await page.evaluate(() => show({}));
  assert.equal(await page.locator("#board .square").count(), 160);
  assert.equal(await page.locator("#board .void").count(), 36);
  assert.equal(await page.locator("#board img.piece").count(), 64);
  assert.deepEqual(await at("h1"), [7, 13], "Red's king on the bottom row, right of centre");
  assert.deepEqual(await at("a7"), [0, 7], "Blue's on the left");
  assert.deepEqual(await at("g14"), [6, 0], "Yellow's at the top");
  assert.deepEqual(await at("n8"), [13, 6], "Green's on the right");
  assert.equal(await cell("h1").locator("img").getAttribute("alt"), "rk");
  // Light on the right: k1, Red's corner, is a light square.
  assert.match(await cell("k1").getAttribute("class"), /\blight\b/);
  assert.match(await cell("d1").getAttribute("class"), /\bdark\b/);
  // Files along the bottom of the cross (in page order the side arms' come
  // first, being higher up), ranks up its left side.
  const files = await page.locator("#board .coord.file").allTextContents();
  assert.deepEqual(files, "abclmndefghijk".split(""));
  const ranks = await page.locator("#board .coord.rank").allTextContents();
  assert.deepEqual(ranks, ["14", "13", "12", "11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
  assert.equal(await cell("d1").locator(".coord.file").textContent(), "d", "on the cross's bottom edge");
  assert.equal(await cell("a4").locator(".coord.file").textContent(), "a", "and on its side arm");
});

test("each colour sees its own army at the bottom, its king on its right", async () => {
  for (const c of FourPlayer.COLORS) {
    await page.evaluate((bottom) => show({ bottom }), c);
    const king = FourPlayer.nameOf(new FourPlayer().kingOf(c));
    assert.deepEqual(await at(king), [7, 13], `${c}'s king, ${king}`);
    assert.equal(await page.locator("#board .square").count(), 160);
    assert.equal(await page.locator("#board .void").count(), 36);
  }
  // Blue's board: its back rank is the a-file, so the bottom edge counts ranks
  // (14 down to 1, left to right, as Blue faces the board) and the left edge files.
  await page.evaluate(() => show({ bottom: "b" }));
  const files = await page.locator("#board .coord.file").allTextContents();
  assert.deepEqual(files, ["14", "13", "12", "3", "2", "1", "11", "10", "9", "8", "7", "6", "5", "4"]);
  assert.equal(await cell("a11").locator(".coord.file").textContent(), "11");
  assert.deepEqual(await page.locator("#board .coord.rank").allTextContents(), "nmlkjihgfedcba".split(""));
  // Blue's corner, a4, is dark on Blue's right: a quarter turn swaps the colours.
  assert.deepEqual(await at("a4"), [10, 13]);
  assert.match(await cell("a4").getAttribute("class"), /\bdark\b/);
});

test("pieces in four colours, tinted from the white images", async () => {
  await page.evaluate(() => show({}));
  for (const [name, c] of [["h1", "r"], ["a7", "b"], ["g14", "y"], ["n8", "g"]]) {
    const img = cell(name).locator("img.piece");
    assert.match(await img.getAttribute("src"), /\/assets\/w_king_1x_ns\.png$/);
    assert.equal(await img.evaluate((el) => getComputedStyle(el).filter), `url("#four-tint-${c}")`);
  }
  assert.equal(await page.locator("#four-tints").count(), 1, "the tints once per page");
  // What a tint does to white and to black: white takes the colour, black stays.
  const painted = await page.evaluate(() => Object.entries(FourBoardView.COLOURS).map(([c, hex]) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.filter = `url(#four-tint-${c})`;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(1, 0, 1, 1);
    return [c, hex, [...ctx.getImageData(0, 0, 2, 1).data]];
  }));
  assert.equal(painted.length, 4);
  for (const [c, hex, px] of painted) {
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    px.slice(0, 3).forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2, `${c}: ${px} for ${hex}`));
    assert.deepEqual(px.slice(4, 7), [0, 0, 0], `${c}: black stays black`);
  }
});

test("highlights: the last move, the selection, hints, and two kings in check at once", async () => {
  await page.evaluate((s) => show({
    lastMove: { from: s.e2, to: s.e4 }, selected: s.j1,
    hints: new Map([[s.i3, "move"], [s.k3, "capture"]]),
    check: new Set([s.a7, s.n8]),
  }), { e2: sq("e2"), e4: sq("e4"), j1: sq("j1"), i3: sq("i3"), k3: sq("k3"), a7: sq("a7"), n8: sq("n8") });
  for (const name of ["e2", "e4"]) assert.match(await cell(name).getAttribute("class"), /last-move/);
  assert.match(await cell("j1").getAttribute("class"), /selected/);
  assert.equal(await cell("i3").locator(".hint").count(), 1);
  assert.match(await cell("k3").locator(".hint").getAttribute("class"), /capture/);
  assert.equal(await page.locator("#board .square.check").count(), 2);
  await page.evaluate((h1) => show({ check: h1 }), sq("h1"));
  assert.deepEqual(await page.locator("#board .square.check").evaluateAll((els) => els.map((e) => +e.dataset.sq)), [sq("h1")]);
});

test("clicks, drags and arrows give the engine's square numbers", async () => {
  await page.evaluate(() => { show({ bottom: "y" }); seen.length = 0; });
  await cell("h13").click();
  // The corners take no clicks.
  const corner = page.locator("#board .void").first();
  await corner.click({ force: true });
  assert.deepEqual(await page.evaluate(() => seen), [["click", sq("h13")]]);

  // Yellow's knight dragged from j14 to i12.
  const from = await cell("j14").boundingBox(), to = await cell("i12").boundingBox();
  await page.evaluate(() => { seen.length = 0; });
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => seen.filter((s) => s[0] !== "click")),
    [["pick", sq("j14")], ["drop", sq("j14"), sq("i12")]]);

  // A right-click circle on h12, where it is on screen: units are squares, 14 across.
  const box = await cell("h12").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const ring = await page.evaluate(() => {
    const svg = document.querySelector("#board .board-arrows");
    const c = svg.querySelector("circle");
    return { viewBox: svg.getAttribute("viewBox"), x: +c.getAttribute("cx"), y: +c.getAttribute("cy") };
  });
  const [col, row] = await at("h12");
  assert.deepEqual(ring, { viewBox: "0 0 14 14", x: col + 0.5, y: row + 0.5 });

  await page.screenshot({ path: process.env.FOUR_SHOT || "/tmp/four-board.png" });
});
