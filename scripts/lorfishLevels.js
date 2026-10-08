"use strict";

// Measure LorFish settings against each other and against Stockfish, to put
// ratings on the playing levels. A tool for choosing the levels, not part of
// the app.
//
//   node scripts/lorfishLevels.js openings [--count 500] [--within 50]
//   node scripts/lorfishLevels.js match d2 d1 [--games 400]
//   node scripts/lorfishLevels.js match casual sf1320 [--games 20] [--movetime 100]
//   node scripts/lorfishLevels.js tournament plan.txt [--out plan.jsonl]
//   node scripts/lorfishLevels.js fit plan.jsonl [more.jsonl...] [--samples 1000]
//   node scripts/lorfishLevels.js profile d1 d1t25 d2t50 [--positions 300] [--judge 3]
//   common options: [--workers N] [--seed 1] [--openings FILE]
//
// A level is a key from src/shared/aiLevels.js ("casual"), or d<depth>,
// optionally followed by t<temperature>: "d2" is the depth-2 bot with its ±10
// jitter, "d1t120" searches depth 1 and picks by temperature 120 (see
// LorFish.sample).
//
// sf<elo> is the vendored Stockfish 19 with UCI_LimitStrength at that UCI_Elo
// (1320 to 3190), thinking --movetime ms a move: an outside anchor, since
// self-play can only measure LorFish against itself. sf<elo>r<pct> plays any
// legal move at random pct% of the time instead, for opponents below
// Stockfish's floor of 1320; only fit can say how strong one is. Stockfish
// plays in match and tournament only, and its own randomness is not seeded, so
// its games do not replay exactly.
//
// openings: the starting positions match and tournament play from, written to
// --openings. Each is OPENING_PLIES moves by a hot depth-1 bot, kept only if
// full-strength Stockfish scores it within --within centipawns, so neither
// side starts out ahead. Every pairing plays the same ones in the same order,
// each twice with colours swapped.
//
// match: the first level plays the second, and the first level's score is
// turned into an Elo gap. A gap of 400 is a 91% score. Games still going after
// MAX_PLIES count as draws.
//
// tournament: the pairings in a plan file, one "a b games [movetime]" a line,
// every game appended to a JSON-lines file as it ends. Running it again on the
// same files carries on after a stop: games already written are skipped.
//
// fit: ratings for everyone in one or more tournament files at once (see
// eloFit.js), plain sf<elo> levels at --movetime pinned at their UCI_Elo, with
// 95% intervals by the bootstrap. Stockfish at another movetime is another
// player, fitted like the rest.
//
// profile: what kind of mistakes each level makes, judged by a deeper LorFish
// search over the same positions: average loss, how often a move gives away
// 100 or 300 centipawns, how often it allows or misses a mate in one, and how
// often two runs on the same position play the same move.
//
// Every run is seeded and can be repeated exactly, Stockfish's moves aside.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseArgs } = require("util");
const { Worker, isMainThread, parentPort } = require("worker_threads");
const { Chess, algOf } = require("../src/shared/chess");
const { LorFish } = require("../src/shared/lorfish");
const { AI_LEVELS_BY_KEY } = require("../src/shared/aiLevels");
const { seeded } = require("../test/helpers/random");
const { fitRatings, bootstrapIntervals } = require("./eloFit");

const MAX_PLIES = 300;
// Openings and profile positions come from a hot depth-1 bot: varied, and
// mostly positions people actually reach.
const OPENING_PLIES = 8;
const SETUP_LEVEL = "d1t80";
// How deep full-strength Stockfish looks to call an opening level.
const OPENING_DEPTH = 16;
const OPENINGS_FILE = path.join(__dirname, "lorfishOpenings.txt");

const STOCKFISH = path.join(__dirname, "../public/js/vendor/stockfish/stockfish-19-lite-single.js");

function parseLevel(spec) {
  const ai = AI_LEVELS_BY_KEY.get(spec);
  if (ai) return { spec, depth: ai.depth, temperature: ai.temperature };
  const sf = /^sf(\d+)(?:r(\d+))?$/.exec(spec);
  if (sf) {
    const elo = Number(sf[1]);
    if (elo < 1320 || elo > 3190) throw new Error(`bad level "${spec}": UCI_Elo runs from 1320 to 3190`);
    const random = sf[2] ? Number(sf[2]) / 100 : 0;
    if (random > 1) throw new Error(`bad level "${spec}": at most 100% random moves`);
    return { spec, stockfish: elo, random };
  }
  const m = /^d(\d+)(?:t(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error(`bad level "${spec}": expected a level key, d<depth>, d<depth>t<temperature>, sf<elo> or sf<elo>r<pct>`);
  return { spec, depth: Number(m[1]), temperature: m[2] ? Number(m[2]) : 0 };
}

// One independent random stream per (run seed, purpose, item).
const rngFor = (seed, purpose, n) =>
  seeded(Math.imul(seed, 0x9e3779b1) ^ Math.imul(n + 1, 0x85ebca6b) ^ Math.imul(purpose, 0xc2b2ae35));

function choose(chess, level, rng) {
  const { best } = LorFish.searchRoot(chess, level.depth, { noise: true, temperature: level.temperature, rng });
  return best ? best.move : null;
}

// A board after `plies` moves of SETUP_LEVEL from the start, or null if the
// game ended on the way.
function setup(rng, plies) {
  const chess = new Chess();
  const level = parseLevel(SETUP_LEVEL);
  for (let i = 0; i < plies; i++) {
    const m = choose(chess, level, rng);
    if (!m) return null;
    chess.makeMove(m);
  }
  return chess.isGameOver() ? null : chess;
}

const key = (m) => `${m.from}-${m.to}-${m.promo || ""}-${m.castle || ""}`;

function hasMateInOne(chess) {
  return chess.legalMoves().some((m) => {
    chess.makeMove(m);
    const mate = chess.isCheckmate();
    chess.undoMove();
    return mate;
  });
}

// Standard games only, so castling is the king's move ("e1g1"), which is
// what Stockfish writes outside UCI_Chess960 and what findMove accepts.
const uci = (m) => algOf(m.from) + algOf(m.to) + (m.promo || "");

const fromUci = (chess, s) => chess.findMove(
  (s.charCodeAt(0) - 97) + (Number(s[1]) - 1) * 8,
  (s.charCodeAt(2) - 97) + (Number(s[3]) - 1) * 8,
  s[4] || null,
);

// --- work done in the workers ---

// Each worker keeps one Stockfish child process for all its games, as
// test/helpers/stockfish.js runs it: UCI over stdin and stdout.
let stockfish = null;

function startStockfish() {
  const child = spawn(process.execPath, [STOCKFISH], { stdio: ["pipe", "pipe", "ignore"] });
  let buffered = "";
  let waiting = null;
  let score = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      // The last score before "bestmove" is the finished search's verdict.
      const s = / score (cp|mate) (-?\d+)/.exec(line);
      if (s) score = { [s[1]]: Number(s[2]) };
      if (waiting && line.startsWith(waiting.prefix)) {
        const { resolve } = waiting;
        waiting = null;
        resolve(line.trim());
      }
    }
  });
  // Send a command and wait for the first line that starts with `prefix`.
  const ask = (cmd, prefix) => new Promise((resolve) => {
    waiting = { prefix, resolve };
    score = null;
    child.stdin.write(cmd + "\n");
  });
  return { child, ask, send: (cmd) => child.stdin.write(cmd + "\n"), score: () => score };
}

// A null elo plays at full strength, to judge openings.
async function newStockfishGame(elo) {
  if (!stockfish) {
    stockfish = startStockfish();
    await stockfish.ask("uci", "uciok");
    stockfish.send("setoption name Hash value 16");
  }
  stockfish.send(`setoption name UCI_LimitStrength value ${elo ? "true" : "false"}`);
  if (elo) stockfish.send(`setoption name UCI_Elo value ${elo}`);
  stockfish.send("ucinewgame");
  await stockfish.ask("isready", "readyok");
}

const position = (moves) => `position startpos${moves.length ? " moves " + moves.join(" ") : ""}`;

async function stockfishMove(chess, moves, movetime) {
  const line = await stockfish.ask(`${position(moves)}\ngo movetime ${movetime}`, "bestmove");
  const reply = line.split(/\s+/)[1];
  const m = fromUci(chess, reply);
  if (!m) throw new Error(`Stockfish played ${reply}, not legal in ${chess.fen()}`);
  return m;
}

// An sf<elo>r<pct> level throws its turn away on any legal move pct% of the time.
async function stockfishTurn(chess, level, moves, movetime, rng) {
  if (level.random && rng() < level.random) {
    const legal = chess.legalMoves();
    return legal[Math.floor(rng() * legal.length)];
  }
  return stockfishMove(chess, moves, movetime);
}

async function playGame({ seed, index, a, b, movetime, opening, openingMoves }) {
  const t0 = Date.now();
  const chess = new Chess();
  // Every move from the start, for Stockfish, so it sees repetitions coming.
  const moves = [];
  for (const s of openingMoves) {
    const m = fromUci(chess, s);
    if (!m) throw new Error(`opening ${opening} plays ${s}, not legal in ${chess.fen()}`);
    chess.makeMove(m);
    moves.push(s);
  }
  // Games 2k and 2k+1 share an opening; the first level is White in the even one.
  const aWhite = index % 2 === 0;
  const rng = rngFor(seed, 2, index);
  for (const level of [a, b]) if (level.stockfish) await newStockfishGame(level.stockfish);
  while (!chess.isGameOver() && chess.history.length < MAX_PLIES) {
    const level = (chess.turn === "w") === aWhite ? a : b;
    const m = level.stockfish ? await stockfishTurn(chess, level, moves, movetime, rng) : choose(chess, level, rng);
    moves.push(uci(m));
    chess.makeMove(m);
  }
  const result = chess.result();
  const white = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  return {
    a: a.spec,
    b: b.spec,
    movetime,
    index,
    opening,
    aWhite,
    score: aWhite ? white : 1 - white,
    plies: chess.history.length,
    capped: result === "*",
    ms: Date.now() - t0,
  };
}

// A candidate opening with full-strength Stockfish's score for it, in
// centipawns for the side to move; no cp if it sees a mate.
async function judgeOpening({ seed, index }) {
  const chess = setup(rngFor(seed, 1, index), OPENING_PLIES);
  if (!chess) return { index, moves: null };
  const moves = chess.history.map((h) => uci(h.move));
  await newStockfishGame(null);
  await stockfish.ask(`${position(moves)}\ngo depth ${OPENING_DEPTH}`, "bestmove");
  return { index, moves, fen: chess.fen(), cp: (stockfish.score() || {}).cp };
}

function profilePosition({ seed, index, levels, judge }) {
  const rng = rngFor(seed, 3, index);
  const chess = setup(rng, 10 + Math.floor(rng() * 50));
  if (!chess) return null;
  const { evals } = LorFish.searchRoot(chess, judge, {});
  const scores = new Map(evals.map((e) => [key(e.move), e.raw]));
  const top = Math.max(...scores.values());
  const canMate = hasMateInOne(chess);
  return levels.map((level, i) => {
    const m = choose(chess, level, rngFor(seed, 10 + 2 * i, index));
    const again = choose(chess, level, rngFor(seed, 11 + 2 * i, index));
    chess.makeMove(m);
    const mated = chess.isCheckmate();
    const allows = !mated && hasMateInOne(chess);
    chess.undoMove();
    return {
      loss: Math.min(1000, top - scores.get(key(m))),
      allows,
      canMate,
      missed: canMate && !mated,
      same: key(m) === key(again),
    };
  });
}

if (!isMainThread) {
  const work = { game: playGame, opening: judgeOpening, profile: profilePosition };
  parentPort.on("message", async (job) => {
    if (job.kind === "quit") {
      if (stockfish) stockfish.child.kill();
      process.exit(0);
    }
    parentPort.postMessage(await work[job.kind](job));
  });
  return;
}

// --- main thread ---

function runPool(jobs, workers, onResult) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let done = 0;
    for (let i = 0; i < Math.min(workers, jobs.length); i++) {
      const w = new Worker(__filename);
      w.on("error", reject);
      w.on("message", (r) => {
        onResult(r, ++done);
        // "quit" rather than terminate(), so the worker can stop its Stockfish.
        w.postMessage(next < jobs.length ? jobs[next++] : { kind: "quit" });
        if (done === jobs.length) resolve();
      });
      w.postMessage(jobs[next++]);
    }
  });
}

const progress = (done, total) => process.stderr.write(`\r  ${done}/${total}`);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const elo = (p) => (p <= 0 ? -Infinity : p >= 1 ? Infinity : -400 * Math.log10(1 / p - 1));
const fmtElo = (x) => (Number.isFinite(x) ? String(Math.round(x)) : x > 0 ? "+inf" : "-inf");

// Lines of a text file with # comments and blank lines dropped.
const contentLines = (file) =>
  fs.readFileSync(file, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);

function loadOpenings(file) {
  if (!fs.existsSync(file)) throw new Error(`no openings in ${file}: run "openings" first`);
  const openings = contentLines(file).map((l) => l.split(/\s+/));
  if (!openings.length) throw new Error(`no openings in ${file}`);
  return openings;
}

// Game i plays opening i/2 (from the top again once they run out), so every
// pairing meets the same positions.
function gameJobs(a, b, games, seed, movetime, openings) {
  if (games / 2 > openings.length) {
    console.log(`${a.spec} vs ${b.spec}: ${games} games need ${games / 2} openings, only ${openings.length} to hand; repeating them`);
  }
  return Array.from({ length: games }, (_, index) => {
    const opening = (index >> 1) % openings.length;
    return { kind: "game", seed, index, a, b, movetime, opening, openingMoves: openings[opening] };
  });
}

async function makeOpenings(opts) {
  // Four candidates for every opening wanted leaves room for the ones that
  // come out lopsided.
  const candidates = 4 * opts.count;
  const jobs = Array.from({ length: candidates }, (_, index) => ({ kind: "opening", seed: opts.seed, index }));
  const judged = [];
  console.log(`judging ${candidates} candidate openings at depth ${OPENING_DEPTH} on ${opts.workers} workers, seed ${opts.seed}`);
  await runPool(jobs, opts.workers, (r, done) => {
    judged.push(r);
    progress(done, candidates);
  });
  process.stderr.write("\n");

  // Candidate order rather than finishing order, so a seed always writes the
  // same file; a position reached twice is kept once.
  judged.sort((x, y) => x.index - y.index);
  const level = judged.filter((j) => j.moves && j.cp !== undefined && Math.abs(j.cp) <= opts.within);
  const distinct = new Map();
  for (const j of level) {
    const board = j.fen.split(" ").slice(0, 4).join(" ");
    if (!distinct.has(board)) distinct.set(board, j.moves.join(" "));
  }
  const kept = [...distinct.values()].slice(0, opts.count);
  const header = [
    `# Openings for scripts/lorfishLevels.js match and tournament, one a line in UCI`,
    `# moves: ${OPENING_PLIES} plies by ${SETUP_LEVEL}, kept when full-strength Stockfish at depth`,
    `# ${OPENING_DEPTH} scores them within ${opts.within} centipawns. Written by`,
    `#   node scripts/lorfishLevels.js openings --count ${opts.count} --within ${opts.within} --seed ${opts.seed}`,
  ];
  fs.writeFileSync(opts.openings, [...header, ...kept, ""].join("\n"));
  console.log(`${level.length} of ${candidates} candidates level, ${distinct.size} different; wrote ${kept.length} to ${opts.openings}`);
  if (kept.length < opts.count) console.log(`fewer than the ${opts.count} asked for: try a larger --within`);
}

async function match(specs, opts) {
  if (specs.length !== 2) throw new Error("match takes two levels");
  const [a, b] = specs.map(parseLevel);
  if (a.stockfish && b.stockfish) throw new Error("match needs at least one LorFish level");
  const games = Math.max(2, opts.games + (opts.games % 2));
  const jobs = gameJobs(a, b, games, opts.seed, opts.movetime, loadOpenings(opts.openings));
  const results = [];
  const t0 = Date.now();
  const sf = a.stockfish || b.stockfish ? `, Stockfish ${opts.movetime} ms a move` : "";
  console.log(`${a.spec} vs ${b.spec}: ${games} games on ${opts.workers} workers, seed ${opts.seed}${sf}`);
  await runPool(jobs, opts.workers, (r, done) => {
    results.push(r);
    progress(done, games);
  });
  process.stderr.write("\n");

  const n = results.length;
  const wins = results.filter((r) => r.score === 1).length;
  const losses = results.filter((r) => r.score === 0).length;
  const p = results.reduce((s, r) => s + r.score, 0) / n;
  const variance = results.reduce((s, r) => s + r.score * r.score, 0) / n - p * p;
  const margin = 1.96 * Math.sqrt(variance / n);
  console.log(`${a.spec}: +${wins} =${n - wins - losses} -${losses}, score ${pct(p)} (95%: ${pct(Math.max(0, p - margin))}–${pct(Math.min(1, p + margin))})`);
  console.log(`${a.spec} is ${fmtElo(elo(p))} Elo above ${b.spec} (95%: ${fmtElo(elo(p - margin))} to ${fmtElo(elo(p + margin))})`);
  const plies = results.reduce((s, r) => s + r.plies, 0) / n;
  const capped = results.filter((r) => r.capped).length;
  const gameSec = results.reduce((s, r) => s + r.ms, 0) / n / 1000;
  console.log(`average ${plies.toFixed(0)} plies, ${capped} stopped at ${MAX_PLIES}, ${gameSec.toFixed(1)} s per game, ${((Date.now() - t0) / 60000).toFixed(1)} min in all`);
}

// A plan is one pairing a line: "a b games [movetime]".
function readPlan(file, movetime) {
  const seen = new Set();
  return contentLines(file).map((line) => {
    const [a, b, games, ms, ...rest] = line.split(/\s+/);
    if (rest.length || !Number.isInteger(Number(games)) || Number(games) < 1 || (ms && !(Number(ms) > 0))) {
      throw new Error(`bad plan line "${line}": expected "a b games [movetime]"`);
    }
    const pair = { a: parseLevel(a), b: parseLevel(b), games: Number(games) + (Number(games) % 2), movetime: ms ? Number(ms) : movetime };
    if (pair.a.stockfish && pair.b.stockfish) throw new Error(`bad plan line "${line}": needs at least one LorFish level`);
    const id = `${a} ${b} ${pair.movetime}`;
    if (seen.has(id)) throw new Error(`plan line "${line}" repeats a pairing`);
    seen.add(id);
    return pair;
  });
}

function readResults(file) {
  if (!fs.existsSync(file)) return [];
  const games = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // A run killed mid-write can leave half a line at the end.
    try {
      games.push(JSON.parse(line));
    } catch {
      console.log(`${file}: skipping a line that is not JSON`);
    }
  }
  return games;
}

const gameKey = (g) => `${g.a} ${g.b} ${g.movetime} ${g.index}`;

// Each pairing draws its own random numbers, or two pairings that share a
// level would make the same choices from the same opening.
function pairingSeed(seed, a, b, movetime) {
  let h = 0x811c9dc5;  // FNV-1a
  for (const ch of `${a.spec} ${b.spec} ${movetime}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (seed ^ h) >>> 0;
}

async function tournament(args, opts) {
  if (args.length !== 1) throw new Error("tournament takes one plan file");
  const [planFile] = args;
  const plan = readPlan(planFile, opts.movetime);
  const openings = loadOpenings(opts.openings);
  const out = opts.out || planFile.replace(/(\.[^./]*)?$/, ".jsonl");
  const done = new Set(readResults(out).map(gameKey));
  const jobs = [];
  let total = 0;
  for (const { a, b, games, movetime } of plan) {
    const seed = pairingSeed(opts.seed, a, b, movetime);
    for (const job of gameJobs(a, b, games, seed, movetime, openings)) {
      total++;
      if (!done.has(gameKey({ a: a.spec, b: b.spec, movetime, index: job.index }))) jobs.push(job);
    }
  }
  console.log(`${plan.length} pairings, ${total} games: ${total - jobs.length} already in ${out}, ${jobs.length} to play on ${opts.workers} workers, seed ${opts.seed}`);
  if (!jobs.length) return;
  const t0 = Date.now();
  await runPool(jobs, opts.workers, (r, n) => {
    fs.appendFileSync(out, JSON.stringify(r) + "\n");
    progress(n, jobs.length);
  });
  process.stderr.write("\n");
  console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min; rate them with: fit ${out}`);
}

function fit(files, opts) {
  if (!files.length) throw new Error("fit takes one or more tournament files");
  const games = files.flatMap(readResults);
  if (!games.length) throw new Error(`no games in ${files.join(", ")}`);
  const name = (spec, movetime) => (spec.startsWith("sf") && movetime !== opts.movetime ? `${spec}@${movetime}ms` : spec);
  const pinned = new Map();
  const played = new Map();
  // Pairing, then opening: the bootstrap resamples an opening's games together.
  const groups = new Map();
  for (const g of games) {
    const a = name(g.a, g.movetime);
    const b = name(g.b, g.movetime);
    for (const p of [a, b]) {
      const sf = /^sf(\d+)$/.exec(p);
      if (sf) pinned.set(p, Number(sf[1]));
      played.set(p, (played.get(p) || 0) + 1);
    }
    const id = `${a} ${b}`;
    if (!groups.has(id)) groups.set(id, { a, b, units: new Map() });
    const { units } = groups.get(id);
    if (!units.has(g.opening)) units.set(g.opening, { n: 0, score: 0 });
    const unit = units.get(g.opening);
    unit.n++;
    unit.score += g.score;
  }
  const byPairing = [...groups.values()].map(({ a, b, units }) => ({ a, b, units: [...units.values()] }));
  const totals = byPairing.map(({ a, b, units }) => ({
    a,
    b,
    n: units.reduce((s, u) => s + u.n, 0),
    score: units.reduce((s, u) => s + u.score, 0),
  }));
  const ratings = fitRatings(totals, pinned);
  const ci = bootstrapIntervals(byPairing, pinned, { samples: opts.samples, rng: seeded(opts.seed) });

  console.log(`${games.length} games; Stockfish at ${opts.movetime} ms a move pinned at its UCI_Elo; ${opts.samples} bootstrap samples\n`);
  const row = (cells, widths) => cells.map((c, i) => (i ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join("");
  const pw = [22, 8, 16, 8];
  console.log(row(["player", "rating", "95%", "games"], pw));
  for (const [p, r] of [...ratings].sort((x, y) => y[1] - x[1])) {
    const range = pinned.has(p) ? "pinned" : `${Math.round(ci.get(p).lo)} to ${Math.round(ci.get(p).hi)}`;
    console.log(row([p, Math.round(r), range, played.get(p)], pw));
  }
  console.log("");
  const gw = [34, 8, 8, 12, 10];
  console.log(row(["pairing", "games", "score", "gap (score)", "gap (fit)"], gw));
  for (const { a, b, n, score } of totals) {
    const fitted = ratings.get(a) - ratings.get(b);
    console.log(row([`${a} vs ${b}`, n, pct(score / n), fmtElo(elo(score / n)), Math.round(fitted)], gw));
  }
}

async function profile(specs, opts) {
  if (!specs.length) throw new Error("profile takes at least one level");
  const levels = specs.map(parseLevel);
  if (levels.some((l) => l.stockfish)) throw new Error("profile takes LorFish levels only");
  const jobs = Array.from({ length: opts.positions }, (_, index) => ({
    kind: "profile", seed: opts.seed, index, levels, judge: opts.judge,
  }));
  const rows = [];
  console.log(`${opts.positions} positions judged at depth ${opts.judge}, seed ${opts.seed}`);
  await runPool(jobs, opts.workers, (r, done) => {
    if (r) rows.push(r);
    progress(done, opts.positions);
  });
  process.stderr.write("\n");

  const mates = rows.filter((r) => r[0].canMate).length;
  console.log(`${rows.length} positions used, ${mates} with a mate in one on the board\n`);
  const header = ["level", "avg loss", "loss>=100", "loss>=300", "allows M1", "misses M1", "same move"];
  const table = levels.map((level, i) => {
    const col = rows.map((r) => r[i]);
    const share = (f) => pct(col.filter(f).length / col.length);
    return [
      level.spec,
      (col.reduce((s, c) => s + c.loss, 0) / col.length).toFixed(0),
      share((c) => c.loss >= 100),
      share((c) => c.loss >= 300),
      share((c) => c.allows),
      mates ? `${col.filter((c) => c.missed).length}/${mates}` : "-",
      share((c) => c.same),
    ];
  });
  for (const line of [header, ...table]) console.log(line.map((s) => String(s).padStart(10)).join(""));
}

async function main() {
  const numbers = {
    games: "400", positions: "300", judge: "3", movetime: "100", count: "500", within: "50", samples: "1000",
    workers: String(Math.max(1, os.availableParallelism() - 1)), seed: "1",
  };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ...Object.fromEntries(Object.entries(numbers).map(([k, v]) => [k, { type: "string", default: v }])),
      openings: { type: "string", default: OPENINGS_FILE },
      out: { type: "string" },
    },
  });
  const opts = { ...values };
  for (const k of Object.keys(numbers)) {
    opts[k] = Number(values[k]);
    if (!Number.isFinite(opts[k])) throw new Error(`--${k} takes a number, not "${values[k]}"`);
  }
  const [command, ...args] = positionals;
  if (command === "openings") await makeOpenings(opts);
  else if (command === "match") await match(args, opts);
  else if (command === "tournament") await tournament(args, opts);
  else if (command === "fit") fit(args, opts);
  else if (command === "profile") await profile(args, opts);
  else throw new Error("usage: lorfishLevels.js openings | match <a> <b> | tournament <plan> | fit <results>... | profile <level>... (see the comment at the top)");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
