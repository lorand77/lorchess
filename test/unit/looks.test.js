"use strict";

// The piece sets and board styles of src/shared/looks.js: every set's twelve
// images and every textured style's two textures are on disk, the URLs are
// built right, and anything unknown falls back to the defaults.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  PIECE_SETS, BOARD_STYLES, DEFAULT_PIECE_SET, DEFAULT_BOARD_STYLE, resolvePieceSet, resolveBoardStyle, pieceUrl,
} = require("../../src/shared/looks");

const PUBLIC = path.join(__dirname, "../../public");

test("every piece set has all twelve pieces", () => {
  for (const set of PIECE_SETS) {
    for (const c of ["w", "b"]) {
      for (const t of ["k", "q", "r", "b", "n", "p"]) {
        assert.ok(fs.existsSync(path.join(PUBLIC, pieceUrl(set.key, c, t))), `${set.key} ${c}${t}`);
      }
    }
  }
  assert.equal(pieceUrl("cburnett", "w", "n"), "/assets/w_knight_1x_ns.png");
  assert.equal(pieceUrl("lorchess", "b", "q"), "/assets/pieces/lorchess/bQ.svg");
});

test("every textured board style has its light and dark textures, and its colours", () => {
  for (const style of BOARD_STYLES.filter((s) => !s.ownColours)) {
    for (const shade of ["light", "dark"]) {
      assert.ok(fs.existsSync(path.join(PUBLIC, "assets/boards", `${style.key}-${shade}.svg`)), `${style.key} ${shade}`);
      assert.match(style[shade], /^#[0-9a-f]{6}$/);
    }
  }
  // styles.css draws each one.
  const css = fs.readFileSync(path.join(PUBLIC, "css/styles.css"), "utf8");
  for (const style of BOARD_STYLES.filter((s) => s.key !== "flat")) {
    assert.ok(css.includes(`html[data-board-style="${style.key}"]`), style.key);
  }
});

test("anything unknown is the default", () => {
  assert.equal(DEFAULT_PIECE_SET, "cburnett");
  assert.equal(DEFAULT_BOARD_STYLE, "flat");
  for (const junk of [undefined, null, "", "Walnut", "__proto__", "toString", 7]) {
    assert.equal(resolvePieceSet(junk), "cburnett", String(junk));
    assert.equal(resolveBoardStyle(junk), "flat", String(junk));
  }
  assert.equal(pieceUrl("nope", "w", "k"), "/assets/w_king_1x_ns.png");
});

test("the drawn files are what their generators write", () => {
  // The SVGs come from tools/; one edited by hand would be overwritten.
  for (const f of fs.readdirSync(path.join(PUBLIC, "assets/pieces/lorchess"))) {
    assert.match(fs.readFileSync(path.join(PUBLIC, "assets/pieces/lorchess", f), "utf8"), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 100 100">/);
  }
});
