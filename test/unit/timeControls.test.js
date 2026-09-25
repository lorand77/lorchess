"use strict";

// The time-control allowlist in src/shared/timeControls.js.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  TIME_CONTROLS, DEFAULT_TC, findTimeControl, resolveTimeControl, describeTimeControl, speedOf,
} = require("../../src/shared/timeControls");

describe("time controls", () => {
  test("keys are unique, spell out the minutes and seconds, and include the default", () => {
    const keys = TIME_CONTROLS.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const t of TIME_CONTROLS) {
      assert.equal(t.key, `${t.initialMs / 60000}+${t.incrementMs / 1000}`);
      assert.ok(t.initialMs > 0, t.key);
      assert.ok(t.incrementMs >= 0, t.key);
      assert.equal(typeof t.label, "string");
    }
    assert.ok(keys.includes(DEFAULT_TC));
  });

  test("findTimeControl returns the entry or null", () => {
    assert.equal(findTimeControl("3+0").initialMs, 180000);
    assert.equal(findTimeControl("3+0").incrementMs, 0);
    for (const bad of ["3+2", "", undefined, null, 42, "__proto__", "constructor"]) {
      assert.equal(findTimeControl(bad), null, String(bad));
    }
  });

  test("resolveTimeControl falls back to the default rather than failing", () => {
    assert.equal(resolveTimeControl("1+0").key, "1+0");
    for (const bad of ["24h", "", undefined, null, {}, "__proto__"]) {
      assert.equal(resolveTimeControl(bad).key, DEFAULT_TC, String(bad));
    }
  });

  test("speedOf classes a clock by its estimated length, and the labels agree", () => {
    assert.equal(speedOf(60000, 0), "bullet");
    assert.equal(speedOf(180000, 0), "blitz");
    assert.equal(speedOf(300000, 0), "blitz");
    assert.equal(speedOf(600000, 0), "rapid");
    assert.equal(speedOf(600000), "rapid", "a missing increment is none");
    assert.equal(speedOf(120000, 1000), "bullet", "2+1 estimates to 160 s");
    assert.equal(speedOf(180000, 2000), "blitz", "3+2");
    assert.equal(speedOf(900000, 10000), "rapid", "15+10 estimates to 1300 s");
    assert.equal(speedOf(1800000, 0), "classical");
    for (const t of TIME_CONTROLS) {
      assert.ok(t.label.toLowerCase().startsWith(speedOf(t.initialMs, t.incrementMs)), t.key);
    }
  });

  test("describeTimeControl renders stored milliseconds back to a label", () => {
    assert.equal(describeTimeControl(600000, 0), "Rapid 10+0");
    assert.equal(describeTimeControl(600000), "Rapid 10+0", "missing increment means none");
    assert.equal(describeTimeControl(60000, 0), "Bullet 1+0");
    assert.equal(describeTimeControl(900000, 10000), "15+10", "not a preset");
    assert.equal(describeTimeControl(120000, 1000), "2+1");
    assert.equal(describeTimeControl(null), "unlimited");
    assert.equal(describeTimeControl(undefined), "unlimited");
  });
});
