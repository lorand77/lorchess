"use strict";

// Import the Lichess puzzle database (CC0) into the `puzzles` table.
//
//   npm run puzzles:import -- [--file path.csv.zst] [--limit N] [--wipe]
//                             [--max-rd 100] [--min-popularity 50] [--min-plays 100]
//                             [--min-rating 400] [--max-rating 3200]
//
// Without --file the ~300 MB dump is downloaded once to data/ and reused.
// Node's built-in zstd handles decompression, so no extra tooling is needed.
// The dump is written by pzstd: 30-odd independent zstd frames, each preceded
// by a "skippable" frame whose 4-byte payload is the size of the frame that
// follows. Node's streaming decompressor rejects skippable frames ("Unknown
// frame descriptor"), so decompressZst() walks the frames itself.
// Rows are streamed and filtered; --limit caps how many are inserted (the
// dump's order is effectively random with respect to rating, so the first N
// matching rows are a fair sample).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { pipeline } = require("stream/promises");
const { Readable, Transform, PassThrough } = require("stream");
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

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

// Readable of decompressed bytes for a .zst file, whether it's a plain
// single-frame file or a pzstd multi-frame file (see header comment).
function decompressZst(file) {
  const out = new PassThrough();
  const fd = fs.openSync(file, "r");
  const size = fs.statSync(file).size;
  const read = (pos, n) => {
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, pos);
    return got === n ? b : b.subarray(0, got);
  };

  const head = read(0, 4);
  if (head.length < 4) {
    out.destroy(new Error("File is empty or truncated."));
    return out;
  }
  const first = head.readUInt32LE(0);
  if (first === ZSTD_MAGIC) {
    // Plain zstd: hand the whole file to the streaming decompressor, and
    // surface its errors on our output (readline would otherwise swallow them).
    fs.closeSync(fd);
    const d = zlib.createZstdDecompress();
    d.on("error", (e) => out.destroy(e));
    return fs.createReadStream(file).pipe(d).pipe(out);
  }
  if ((first & SKIPPABLE_MASK) !== SKIPPABLE_MAGIC) {
    out.destroy(new Error("Not a zstd file (bad magic number). Is the download complete?"));
    return out;
  }

  // pzstd layout: [skippable(len=4: frameSize)][frame] ... repeated.
  let pos = 0;
  (async () => {
    try {
      while (pos < size) {
        const h = read(pos, 8);
        const magic = h.readUInt32LE(0);
        if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
          const len = h.readUInt32LE(4);
          const payload = read(pos + 8, len);
          pos += 8 + len;
          if (len !== 4) continue; // some other metadata frame: ignore it
          const frameLen = payload.readUInt32LE(0);
          const frame = read(pos, frameLen);
          pos += frameLen;
          const plain = zlib.zstdDecompressSync(frame);
          if (!out.write(plain)) await new Promise((r) => out.once("drain", r));
        } else if (magic === ZSTD_MAGIC) {
          // A frame without a size hint: stream the rest of the file.
          const d = zlib.createZstdDecompress();
          d.on("error", (e) => out.destroy(e));
          await pipeline(fs.createReadStream(file, { start: pos }), d, out, { end: true });
          return;
        } else {
          throw new Error(`Unexpected data at byte ${pos} (magic 0x${magic.toString(16)}).`);
        }
      }
      out.end();
    } catch (e) {
      out.destroy(e);
    } finally {
      fs.closeSync(fd);
    }
  })();
  return out;
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

  const input = file.endsWith(".zst") ? decompressZst(file) : fs.createReadStream(file);
  // readline does not forward errors from its input stream; fail loudly instead
  // of finishing with "0 rows" as if nothing happened.
  let inputError = null;
  input.on("error", (e) => { inputError = e; });
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
  if (inputError) throw inputError;
  if (seen === 0) throw new Error("No rows read from " + file + " — is it a complete Lichess puzzle dump?");

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
