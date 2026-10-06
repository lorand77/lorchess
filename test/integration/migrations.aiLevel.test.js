"use strict";

// The games.ai_level migration in src/db/index.js, run against a database in
// the shape it had before levels existed: AI games with only a depth.

require("../helpers/server");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

test("old AI games get the level their depth stood for", () => {
  // Today's schema minus the column, with a game at every depth the pickers
  // ever offered and a PvP game, written before src/db/index.js first loads.
  const old = new Database(process.env.DB_PATH);
  old.exec(fs.readFileSync(path.join(__dirname, "../../src/db/schema.sql"), "utf8"));
  old.exec("ALTER TABLE games DROP COLUMN ai_level");
  const insert = old.prepare("INSERT INTO games (mode, ai_color, ai_depth) VALUES (?, ?, ?)");
  const ids = {};
  for (const [name, mode, depth] of [["d2", "ai", 2], ["d3", "ai", 3], ["d4", "ai", 4], ["pvp", "pvp", null]]) {
    ids[name] = Number(insert.run(mode, mode === "ai" ? "b" : null, depth).lastInsertRowid);
  }
  old.close();

  const db = require("../../src/db");
  const levelOf = (id) => db.prepare("SELECT ai_level FROM games WHERE id = ?").get(id).ai_level;
  assert.equal(levelOf(ids.d2), "intermediate");
  assert.equal(levelOf(ids.d3), null, "depth 3 was neither level");
  assert.equal(levelOf(ids.d4), "advanced");
  assert.equal(levelOf(ids.pvp), null);
});
