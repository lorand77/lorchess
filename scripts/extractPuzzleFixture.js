"use strict";

// Build test/fixtures/puzzles.json, the tactical puzzle set that
// test/unit/lorfish.puzzles.test.js runs LorFish against.
//
//   npm run puzzles:import               (once; fills the puzzles table)
//   node scripts/extractPuzzleFixture.js
//
// Selection, from the imported Lichess puzzle database (CC0): well-rated easy
// puzzles (rating <= 1300, popularity >= 90, at least 500 plays, rating
// deviation <= 80), in dump order, which is effectively random. "oneMove"
// puzzles have a single solution move; "short" ones have two.
//
// The script also records how the engine does on each puzzle today. The test
// treats the puzzles it solved as a known-solvable set that must stay solved,
// and the overall two-move rate as the baseline for the opt-in full run.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");
const { solvePuzzle } = require("../test/helpers/puzzles");

const OUT = path.join(__dirname, "..", "test", "fixtures", "puzzles.json");
const BASE = "rating <= 1300 AND popularity >= 90 AND nb_plays >= 500 AND rating_deviation <= 80";

const db = new Database(config.DB_PATH, { readonly: true });
if (db.prepare("SELECT COUNT(*) AS n FROM puzzles").get().n === 0) {
  console.error("The puzzles table is empty. Run `npm run puzzles:import` first.");
  process.exit(1);
}
const pick = (extra, n) =>
  db.prepare(`SELECT id, fen, moves, rating, themes FROM puzzles WHERE ${extra} AND ${BASE} ORDER BY id LIMIT ?`).all(n);

const oneMove = pick("themes LIKE '%oneMove%'", 60);
const twoMove = pick("themes LIKE '%short%' AND themes NOT LIKE '%oneMove%'", 100);

console.log(`Probing ${oneMove.length} one-move puzzles at depth 1 ...`);
for (const p of oneMove) p.solvedAtDepth1 = solvePuzzle(p, 1).ok;
console.log(`Probing ${twoMove.length} two-move puzzles at depth 2 ...`);
for (const p of twoMove) {
  const r = solvePuzzle(p, 2);
  p.solvedAtDepth2 = r.ok;
  p.msAtDepth2 = Math.round(r.ms);
}

const solved1 = oneMove.filter((p) => p.solvedAtDepth1).length;
const solved2 = twoMove.filter((p) => p.solvedAtDepth2).length;
const quick2 = twoMove.filter((p) => p.solvedAtDepth2 && p.msAtDepth2 <= 400).length;
const fixture = {
  source: "Lichess puzzle database (CC0), via `npm run puzzles:import`; regenerate with scripts/extractPuzzleFixture.js",
  criteria: BASE,
  generated: new Date().toISOString().slice(0, 10),
  twoMoveBaseline: Math.round((100 * solved2) / twoMove.length),
  oneMove,
  twoMove,
};
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(`one-move: ${solved1}/${oneMove.length} solved at depth 1`);
console.log(`two-move: ${solved2}/${twoMove.length} solved at depth 2 (${fixture.twoMoveBaseline}%), ${quick2} of them within 400 ms`);
console.log(`wrote ${OUT}`);
