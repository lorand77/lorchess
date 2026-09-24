"use strict";

// The achievement catalogue in src/shared/achievements.js: display data the
// achievements page renders and the server's evaluator looks up by key.

const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ACHIEVEMENTS, GROUPS, BY_KEY, TIER_NAMES, maxTier, describe: describeTier, tierName,
} = require("../../src/shared/achievements");

const byKey = (key) => {
  const a = BY_KEY[key];
  assert.ok(a, `no achievement ${key}`);
  return a;
};

describe("achievement catalogue", () => {
  test("keys are unique snake_case and names are unique", () => {
    const keys = ACHIEVEMENTS.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.match(key, /^[a-z][a-z0-9_]*$/);
    const names = ACHIEVEMENTS.map((a) => a.name);
    assert.equal(new Set(names).size, names.length);
  });

  test("the lookup table mirrors the list", () => {
    assert.equal(Object.keys(BY_KEY).length, ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) assert.equal(BY_KEY[a.key], a);
  });

  test("groups are unique, titled, and all in use", () => {
    const groupKeys = GROUPS.map((g) => g.key);
    assert.equal(new Set(groupKeys).size, groupKeys.length);
    for (const g of GROUPS) {
      assert.equal(typeof g.title, "string");
      assert.ok(ACHIEVEMENTS.some((a) => a.group === g.key), `group ${g.key} is empty`);
    }
    for (const a of ACHIEVEMENTS) assert.ok(groupKeys.includes(a.group), `${a.key}: group ${a.group}`);
  });

  test("every entry has a name, an icon and a description", () => {
    for (const a of ACHIEVEMENTS) {
      assert.ok(a.name.length > 0, a.key);
      assert.ok(typeof a.icon === "string" && a.icon.length > 0, a.key);
      assert.ok(a.desc || a.tierDescs, `${a.key} has no description`);
    }
  });

  test("tiers are increasing thresholds, at most one per tier name", () => {
    for (const a of ACHIEVEMENTS.filter((x) => x.tiers)) {
      assert.ok(a.tiers.length >= 1 && a.tiers.length <= TIER_NAMES.length, a.key);
      for (let i = 0; i < a.tiers.length; i++) {
        assert.equal(typeof a.tiers[i], "number", a.key);
        if (i > 0) assert.ok(a.tiers[i] > a.tiers[i - 1], `${a.key}: tiers not increasing`);
      }
      if (a.tierDescs) {
        assert.equal(a.tierDescs.length, a.tiers.length, `${a.key}: one description per tier`);
      } else {
        assert.ok(a.desc.includes("{n}"), `${a.key}: tiered description needs {n}`);
      }
    }
    for (const a of ACHIEVEMENTS.filter((x) => !x.tiers)) {
      assert.ok(!a.desc.includes("{n}"), `${a.key}: one-shot description must not use {n}`);
      assert.equal(a.tierDescs, undefined, a.key);
    }
  });

  test("hidden achievements are exactly the hidden group", () => {
    for (const a of ACHIEVEMENTS) {
      assert.equal(!!a.hidden, a.group === "hidden", a.key);
    }
  });

  test("every key is handled by the server's evaluator", () => {
    // The evaluator opens the database when loaded, so read its source: each
    // key must appear as a whole word, as a check-table property or a literal.
    const source = fs.readFileSync(path.join(__dirname, "../../src/achievements/service.js"), "utf8");
    const unhandled = ACHIEVEMENTS.map((a) => a.key).filter((k) => !new RegExp(`\\b${k}\\b`).test(source));
    assert.deepEqual(unhandled, []);
  });

  test("maxTier", () => {
    assert.equal(maxTier(byKey("games_played")), 4);
    assert.equal(maxTier(byKey("sharpshooter")), 3);
    assert.equal(maxTier(byKey("anniversary")), 1);
  });

  test("describe fills in the tier's threshold and clamps the tier", () => {
    const games = byKey("games_played");
    assert.equal(describeTier(games, 1), "Finish 1 games.");
    assert.equal(describeTier(games, 2), "Finish 10 games.");
    assert.equal(describeTier(games, 4), "Finish 1000 games.");
    assert.equal(describeTier(games), "Finish 1 games.", "no tier means the first");
    assert.equal(describeTier(games, 0), "Finish 1 games.");
    assert.equal(describeTier(games, 99), "Finish 1000 games.");
    assert.equal(describeTier(byKey("giving_odds"), 3), "Win a game after giving a rook.");
    assert.equal(describeTier(byKey("anniversary"), 3), "One year since you joined LorChess.");
  });

  test("tierName names the tier, clamped, and is null for one-shots", () => {
    assert.deepEqual(TIER_NAMES, ["Bronze", "Silver", "Gold", "Diamond"]);
    const games = byKey("games_played");
    assert.equal(tierName(games, 1), "Bronze");
    assert.equal(tierName(games, 4), "Diamond");
    assert.equal(tierName(games, 0), "Bronze");
    assert.equal(tierName(games, 9), "Diamond");
    assert.equal(tierName(byKey("sharpshooter"), 9), "Gold", "a three-tier achievement tops out at Gold");
    assert.equal(tierName(byKey("anniversary"), 1), null);
  });
});
