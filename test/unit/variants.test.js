"use strict";

// The variant catalogue in src/shared/variants.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const {
  VARIANTS, VARIANTS_BY_KEY, resolveVariant, variantLabel, usesStandardSetup, isReviewable, isRateable,
  hasMaterialBadges, hasMoveBadges, hasBot, startOf,
} = require("../../src/shared/variants");
const { PAWN_WARS_START, ANTICHESS_START } = require("../../src/shared/chess");
const { InfiniteChess } = require("../../src/shared/infiniteChess");
const { createEngine } = require("../../src/shared/engines");

describe("variant catalogue", () => {
  test("keys are unique and the lookup map mirrors the list", () => {
    const keys = VARIANTS.map((v) => v.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(VARIANTS_BY_KEY instanceof Map, "a Map, so prototype names cannot match");
    assert.deepEqual([...VARIANTS_BY_KEY.keys()], keys);
    for (const v of VARIANTS) {
      assert.equal(typeof v.label, "string", v.key);
      assert.equal(typeof v.standardSetup, "boolean", v.key);
      assert.equal(typeof v.reviewable, "boolean", v.key);
      assert.equal(typeof v.rateable, "boolean", v.key);
      assert.equal(typeof v.materialBadges, "boolean", v.key);
      assert.equal(typeof v.moveBadges, "boolean", v.key);
      assert.equal(typeof v.bot, "boolean", v.key);
    }
  });

  test("every catalogue key selects a rule set an engine knows", () => {
    for (const v of VARIANTS) {
      if (v.key === "infinite") {
        assert.ok(createEngine(v.key) instanceof InfiniteChess);
        continue;
      }
      const rules = new Chess().setVariant(v.key).variant;
      const expected = ["atomic", "pawnwars", "crazyhouse", "antichess"].includes(v.key) ? v.key : "standard";
      assert.equal(rules, expected, v.key);
    }
  });

  test("known keys resolve to themselves", () => {
    for (const v of VARIANTS) assert.equal(resolveVariant(v.key), v.key);
  });

  test("anything else resolves to standard", () => {
    const junk = [
      "bughouse", "Atomic", "", undefined, null, 42, {},
      "__proto__", "constructor", "toString", "hasOwnProperty",
    ];
    for (const value of junk) assert.equal(resolveVariant(value), "standard", String(value));
  });

  test("labels", () => {
    assert.equal(variantLabel("standard"), "Standard");
    assert.equal(variantLabel("chess960"), "Chess960");
    assert.equal(variantLabel("atomic"), "Atomic");
    assert.equal(variantLabel("pawnwars"), "Pawn Wars");
    assert.equal(variantLabel("crazyhouse"), "Crazyhouse");
    assert.equal(variantLabel("antichess"), "Antichess");
    assert.equal(variantLabel("infinite"), "Infinite Chess");
    assert.equal(variantLabel("nope"), "Standard");
  });

  test("only variants that open from the ordinary setup can take a handicap", () => {
    assert.equal(usesStandardSetup("standard"), true);
    assert.equal(usesStandardSetup("atomic"), true);
    assert.equal(usesStandardSetup("chess960"), false);
    assert.equal(usesStandardSetup("pawnwars"), false);
    assert.equal(usesStandardSetup("crazyhouse"), false, "not until odds have been tried with pockets");
    assert.equal(usesStandardSetup("antichess"), false, "no castling rights: a start of its own");
    assert.equal(usesStandardSetup("infinite"), false);
    assert.equal(usesStandardSetup("nope"), true, "unknown means standard");
  });

  test("says where each variant opens, and Pawn Wars, Antichess and Infinite Chess agree with their engines", () => {
    assert.equal(startOf("standard"), null);
    assert.equal(startOf("atomic"), null);
    assert.equal(startOf("chess960"), "shuffled");
    assert.equal(startOf("pawnwars"), PAWN_WARS_START);
    assert.equal(startOf("crazyhouse"), null, "the ordinary setup, with empty pockets");
    assert.equal(startOf("antichess"), ANTICHESS_START);
    assert.equal(startOf("infinite"), new InfiniteChess().fen(), "the Classical setup, in ICN");
    assert.equal(startOf("nope"), null, "unknown means standard");
    for (const v of VARIANTS) {
      assert.ok(!(v.shuffled && v.startFen), `${v.key}: shuffled or a fixed start, not both`);
      assert.ok(!(v.standardSetup && (v.shuffled || v.startFen)), `${v.key}: the standard setup is not a start of its own`);
    }
  });

  test("only variants played by the ordinary rules are reviewable", () => {
    assert.equal(isReviewable("standard"), true);
    assert.equal(isReviewable("chess960"), true);
    assert.equal(isReviewable("atomic"), false);
    assert.equal(isReviewable("pawnwars"), false);
    assert.equal(isReviewable("crazyhouse"), false);
    assert.equal(isReviewable("antichess"), false);
    assert.equal(isReviewable("infinite"), false);
    assert.equal(isReviewable("nope"), true, "unknown means standard");
  });

  test("only Crazyhouse, Antichess and Infinite Chess are casual-only", () => {
    for (const v of VARIANTS) assert.equal(isRateable(v.key), !["crazyhouse", "antichess", "infinite"].includes(v.key), v.key);
    assert.equal(isRateable("nope"), true, "unknown means standard");
  });

  test("material badges are off where material doesn't mean what it usually does", () => {
    for (const v of VARIANTS) {
      assert.equal(hasMaterialBadges(v.key), !["crazyhouse", "antichess", "infinite"].includes(v.key), v.key);
    }
    assert.equal(hasMaterialBadges("nope"), true, "unknown means standard");
  });

  test("LorFish plays standard chess, Chess960 and Pawn Wars so far", () => {
    for (const v of VARIANTS) assert.equal(hasBot(v.key), ["standard", "chess960", "pawnwars"].includes(v.key), v.key);
    assert.equal(hasBot("nope"), true, "unknown means standard");
  });

  test("only Infinite Chess has no move badges: they replay moves on an 8x8 board", () => {
    for (const v of VARIANTS) assert.equal(hasMoveBadges(v.key), v.key !== "infinite", v.key);
    assert.equal(hasMoveBadges("nope"), true, "unknown means standard");
  });
});
