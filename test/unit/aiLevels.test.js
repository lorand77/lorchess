"use strict";

// The LorFish level catalogue in src/shared/aiLevels.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { LorFish } = require("../../src/shared/lorfish");
const {
  AI_LEVELS, AI_LEVELS_BY_KEY, DEFAULT_AI_LEVEL, resolveAiLevel, aiLevelOf, aiLevelLabel, aiLevelForDepth,
} = require("../../src/shared/aiLevels");

describe("AI level catalogue", () => {
  test("keys are unique and the lookup map mirrors the list", () => {
    const keys = AI_LEVELS.map((l) => l.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(AI_LEVELS_BY_KEY instanceof Map, "a Map, so prototype names cannot match");
    assert.deepEqual([...AI_LEVELS_BY_KEY.keys()], keys);
    assert.ok(AI_LEVELS_BY_KEY.has(DEFAULT_AI_LEVEL));
  });

  test("levels run weakest to strongest, at depths the engine searches as given", () => {
    for (let i = 1; i < AI_LEVELS.length; i++) {
      assert.ok(AI_LEVELS[i].elo > AI_LEVELS[i - 1].elo, AI_LEVELS[i].key);
    }
    for (const l of AI_LEVELS) {
      assert.equal(LorFish.clampDepth(l.depth), l.depth, l.key);
      assert.ok(l.temperature >= 0, l.key);
    }
  });

  test("an unknown key plays the default", () => {
    for (const key of [undefined, null, "", "expert", "__proto__", "constructor", 2]) {
      assert.equal(resolveAiLevel(key), DEFAULT_AI_LEVEL, String(key));
      assert.equal(aiLevelOf(key).key, DEFAULT_AI_LEVEL, String(key));
    }
    assert.equal(aiLevelOf("beginner").key, "beginner");
  });

  test("labels carry the rating", () => {
    assert.equal(aiLevelLabel("novice"), "Novice (~400)");
    assert.equal(aiLevelLabel("beginner"), "Beginner (~800)");
    assert.equal(aiLevelLabel("advanced"), "Advanced (~2000)");
    assert.equal(aiLevelLabel("nonsense"), "Intermediate (~1600)");
  });

  test("a depth from before levels maps to the level it stood for", () => {
    assert.equal(aiLevelForDepth(2), "intermediate");
    assert.equal(aiLevelForDepth("2"), "intermediate");
    assert.equal(aiLevelForDepth(4), "advanced");
    assert.equal(aiLevelForDepth(6), "advanced", "the strongest-setting badge counted 4 and up");
    for (const depth of [1, 3, null, undefined, "x"]) assert.equal(aiLevelForDepth(depth), null, String(depth));
  });
});
