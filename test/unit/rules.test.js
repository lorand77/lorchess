"use strict";

// The Rules page (public/rules.html) has a section for every variant in the
// catalogue and nothing else besides General, so a new variant can't reach the
// lobby with no rules written for it. The tabs and the "at a glance" lines are
// built from the catalogue by rules.js; the text is the page's.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VARIANTS } = require("../../src/shared/variants");

const html = fs.readFileSync(path.join(__dirname, "../../public/rules.html"), "utf8");

test("the Rules page has a section for General and every variant, in the catalogue's order", () => {
  const keys = [...html.matchAll(/<section class="rules-section" id="rules-([a-z0-9]+)" data-key="([a-z0-9]+)"/g)];
  for (const [, id, key] of keys) assert.equal(id, key);
  assert.deepEqual(keys.map((m) => m[2]), ["general", ...VARIANTS.map((v) => v.key)]);
});

test("every variant's section has a glance line and a heading naming it", () => {
  for (const v of VARIANTS) {
    const start = html.indexOf(`data-key="${v.key}"`);
    const end = html.indexOf("</section>", start);
    const section = html.slice(start, end);
    assert.match(section, /<p class="rules-glance"><\/p>/, v.key);
    assert.ok(section.includes(`<h2>${v.label}</h2>`), v.key);
  }
});
