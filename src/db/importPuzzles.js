"use strict";

// Import the Lichess puzzle database (CC0) into the `puzzles` table.
//
//   npm run puzzles:import -- [--file path.csv.zst] [--limit N] [--wipe]
//                             [--max-rd 100] [--min-popularity 50] [--min-plays 100]
//                             [--min-rating 400] [--max-rating 3200]
//
// Without --file the ~300 MB dump is downloaded once to data/ and reused.
// Node's built-in zstd handles decompression, so no extra tooling is needed.
// Rows are streamed and filtered; --limit caps how many are inserted (the
// dump's order is effectively random with respect to rating, so the first N
// matching rows are a fair sample).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const config = require("../config");
const db = require("./index");
const queries = require("./queries");

const URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst";

function parseArgs(argv) {
  const o = {
    file: null, limit: 300000, wipe: false,
    maxRd: 100, minPopularity: 50, minPlays: 100, minRating: 400, maxRating: 3200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--file") { o.file = v; i++; }
    else if (a === "--limit") { o.limit = parseInt(v, 10); i++; }
    else if (a === "--wipe") o.wipe = true;
    else if (a === "--max-rd") { o.maxRd = parseInt(v, 10); i++; }
    else if (a === "--min-popularity") { o.minPopularity = parseInt(v, 10); i++; }
    else if (a === "--min-plays") { o.minPlays = parseInt(v, 10); i++; }
    else if (a === "--min-rating") { o.minRating = parseInt(v, 10); i++; }
    else if (a === "--max-rating") { o.maxRating = parseInt(v, 10); i++; }
    else { console.error("Unknown argument: " + a); process.exit(2); }
  }
  return o;
}

async function download(dest) {
  console.log(`Downloading ${URL} → ${dest}`);
  const res = await fetch(URL);
  if (!res.ok || !res.body) throw new Error("Download failed: HTTP " + res.status);
  const tmp = dest + ".part";
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let file = opts.file;
  if (!file) {
    file = path.join(path.dirname(config.DB_PATH), "lichess_db_puzzle.csv.zst");
    if (!fs.existsSync(file)) await download(file);
    else console.log(`Using existing download ${file}`);
  }

  if (opts.wipe) {
    console.log("Wiping existing puzzles…");
    queries.wipePuzzles.run();
  }

  const input = file.endsWith(".zst")
    ? fs.createReadStream(file).pipe(zlib.createZstdDecompress())
    : fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const insertMany = db.transaction((rows) => {
    for (const r of rows) queries.insertPuzzle.run(...r);
  });

  let header = null;
  let seen = 0, kept = 0, batch = [];
  const col = {};
  const t0 = Date.now();

  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = line.split(",");
      header.forEach((h, i) => { col[h] = i; });
      for (const need of ["PuzzleId", "FEN", "Moves", "Rating"]) {
        if (!(need in col)) throw new Error("Unexpected CSV header: " + line);
      }
      continue;
    }
    seen++;
    // No quoted fields in this dump: a plain split is safe.
    const f = line.split(",");
    const rating = parseInt(f[col.Rating], 10);
    const rd = parseInt(f[col.RatingDeviation], 10) || 0;
    const pop = parseInt(f[col.Popularity], 10) || 0;
    const plays = parseInt(f[col.NbPlays], 10) || 0;
    if (
      !Number.isFinite(rating) || rating < opts.minRating || rating > opts.maxRating ||
      rd > opts.maxRd || pop < opts.minPopularity || plays < opts.minPlays
    ) continue;

    batch.push([
      f[col.PuzzleId], f[col.FEN], f[col.Moves], rating, rd, pop, plays,
      f[col.Themes] || "", f[col.GameUrl] || "", f[col.OpeningTags] || "",
    ]);
    kept++;
    if (batch.length >= 5000) { insertMany(batch); batch = []; }
    if (seen % 500000 === 0) console.log(`  scanned ${seen.toLocaleString()} rows, kept ${kept.toLocaleString()}`);
    if (kept >= opts.limit) break;
  }
  if (batch.length) insertMany(batch);
  rl.close();
  input.destroy();

  const total = queries.countPuzzles.get().n;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${secs}s: scanned ${seen.toLocaleString()}, inserted ${kept.toLocaleString()}; table now holds ${total.toLocaleString()} puzzles.`);
  const buckets = db.prepare(
    "SELECT (rating / 400) * 400 AS lo, COUNT(*) AS n FROM puzzles GROUP BY lo ORDER BY lo"
  ).all();
  console.log("By rating: " + buckets.map((b) => `${b.lo}–${b.lo + 399}: ${b.n}`).join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
