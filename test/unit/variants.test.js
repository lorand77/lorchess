"use strict";

// The variant catalogue in src/shared/variants.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../../src/shared/chess");
const {
  VARIANTS, BY_KEY, resolveVariant, variantLabel, usesStandardSetup, isReviewable,
} = require("../../src/shared/variants");

describe("variant catalogue", () => {
  test("keys are unique and the lookup map mirrors the list", () => {
    const keys = VARIANTS.map((v) => v.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(BY_KEY instanceof Map, "a Map, so prototype names cannot match");
    assert.deepEqual([...BY_KEY.keys()], keys);
    for (const v of VARIANTS) {
      assert.equal(typeof v.label, "string", v.key);
      assert.equal(typeof v.standardSetup, "boolean", v.key);
      assert.equal(typeof v.reviewable, "boolean", v.key);
    }
  });

  test("every catalogue key selects a rule set the engine knows", () => {
    for (const v of VARIANTS) {
      const rules = new Chess().setVariant(v.key).variant;
      const expected = v.key === "atomic" || v.key === "pawnwars" ? v.key : "standard";
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
    assert.equal(variantLabel("nope"), "Standard");
  });

  test("only variants that open from the ordinary setup can take a handicap", () => {
    assert.equal(usesStandardSetup("standard"), true);
    assert.equal(usesStandardSetup("atomic"), true);
    assert.equal(usesStandardSetup("chess960"), false);
    assert.equal(usesStandardSetup("pawnwars"), false);
    assert.equal(usesStandardSetup("nope"), true, "unknown means standard");
  });

  test("only variants played by the ordinary rules are reviewable", () => {
    assert.equal(isReviewable("standard"), true);
    assert.equal(isReviewable("chess960"), true);
    assert.equal(isReviewable("atomic"), false);
    assert.equal(isReviewable("pawnwars"), false);
    assert.equal(isReviewable("nope"), true, "unknown means standard");
  });
});
