"use strict";

// Measure LorFish settings against each other, to put ratings on weaker
// playing levels. A tool for choosing the levels, not part of the app.
//
//   node scripts/lorfishLevels.js match d2 d1 [--games 400]
//   node scripts/lorfishLevels.js match d2 sf1600 [--games 20] [--movetime 100]
//   node scripts/lorfishLevels.js profile d1 d1t25 d2t50 [--positions 300] [--judge 3]
//   common options: [--workers N] [--seed 1]
//
// A level is d<depth>, optionally followed by t<temperature>: "d2" is today's
// depth-2 bot with its ±10 jitter, "d1t120" searches depth 1 and picks by
// temperature 120 (see LorFish.sample).
//
// sf<elo> is the vendored Stockfish 19 with UCI_LimitStrength at that UCI_Elo
// (1320 to 3190), thinking --movetime ms a move: an outside anchor, since
// self-play can only measure LorFish against itself. It plays in match only,
// and its own randomness is not seeded, so its games do not replay exactly.
//
// match: the first level plays the second, every opening twice with colours
// swapped, and the first level's score is turned into an Elo gap. A gap of
// 400 is a 91% score. Games still going after MAX_PLIES count as draws.
//
// profile: what kind of mistakes each level makes, judged by a deeper LorFish
// search over the same positions: average loss, how often a move gives away
// 100 or 300 centipawns, how often it allows or misses a mate in one, and how
// often two runs on the same position play the same move.
//
// Every run is seeded and can be repeated exactly.

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseArgs } = require("util");
const { Worker, isMainThread, parentPort } = require("worker_threads");
const { Chess, algOf } = require("../src/shared/chess");
const { LorFish } = require("../src/shared/lorfish");
const { seeded } = require("../test/helpers/random");

const MAX_PLIES = 300;
// Openings and profile positions come from a hot depth-1 bot: varied, and
// mostly positions people actually reach.
const OPENING_PLIES = 8;
const SETUP_LEVEL = "d1t80";

const STOCKFISH = path.join(__dirname, "../public/js/vendor/stockfish/stockfish-19-lite-single.js");

function parseLevel(spec) {
  const sf = /^sf(\d+)$/.exec(spec);
  if (sf) {
    const elo = Number(sf[1]);
    if (elo < 1320 || elo > 3190) throw new Error(`bad level "${spec}": UCI_Elo runs from 1320 to 3190`);
    return { spec, stockfish: elo };
  }
  const m = /^d(\d+)(?:t(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error(`bad level "${spec}": expected d<depth>, d<depth>t<temperature> or sf<elo>`);
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

// --- work done in the workers ---

// Each worker keeps one Stockfish child process for all its games, as
// test/helpers/stockfish.js runs it: UCI over stdin and stdout.
let stockfish = null;

function startStockfish() {
  const child = spawn(process.execPath, [STOCKFISH], { stdio: ["pipe", "pipe", "ignore"] });
  let buffered = "";
  let waiting = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) {
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
    child.stdin.write(cmd + "\n");
  });
  return { child, ask, send: (cmd) => child.stdin.write(cmd + "\n") };
}

async function newStockfishGame(elo) {
  if (!stockfish) {
    stockfish = startStockfish();
    await stockfish.ask("uci", "uciok");
    stockfish.send("setoption name Hash value 16");
    stockfish.send("setoption name UCI_LimitStrength value true");
  }
  stockfish.send(`setoption name UCI_Elo value ${elo}`);
  stockfish.send("ucinewgame");
  await stockfish.ask("isready", "readyok");
}

// Standard games only, so castling is the king's move ("e1g1"), which is
// what Stockfish writes outside UCI_Chess960 and what findMove accepts.
const uci = (m) => algOf(m.from) + algOf(m.to) + (m.promo || "");

async function stockfishMove(chess, startFen, moves, movetime) {
  const line = await stockfish.ask(`position fen ${startFen}${moves.length ? " moves " + moves.join(" ") : ""}\ngo movetime ${movetime}`, "bestmove");
  const reply = line.split(/\s+/)[1];
  const m = chess.findMove(
    (reply.charCodeAt(0) - 97) + (Number(reply[1]) - 1) * 8,
    (reply.charCodeAt(2) - 97) + (Number(reply[3]) - 1) * 8,
    reply[4] || null,
  );
  if (!m) throw new Error(`Stockfish played ${reply}, not legal in ${chess.fen()}`);
  return m;
}

async function playGame({ seed, index, a, b, movetime }) {
  const t0 = Date.now();
  // Games 2k and 2k+1 share an opening; the first level is White in the even one.
  let chess = setup(rngFor(seed, 1, index >> 1), OPENING_PLIES);
  for (let retry = 1; !chess; retry++) chess = setup(rngFor(seed, 1, (index >> 1) + retry * 1e6), OPENING_PLIES);
  const aWhite = index % 2 === 0;
  const rng = rngFor(seed, 2, index);
  // Stockfish gets the position after the opening plus every move since, so
  // it sees repetitions coming.
  const startFen = chess.fen();
  const moves = [];
  for (const level of [a, b]) if (level.stockfish) await newStockfishGame(level.stockfish);
  while (!chess.isGameOver() && chess.history.length < MAX_PLIES) {
    const level = (chess.turn === "w") === aWhite ? a : b;
    const m = level.stockfish ? await stockfishMove(chess, startFen, moves, movetime) : choose(chess, level, rng);
    moves.push(uci(m));
    chess.makeMove(m);
  }
  const result = chess.result();
  const white = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  return {
    score: aWhite ? white : 1 - white,
    plies: chess.history.length,
    capped: result === "*",
    ms: Date.now() - t0,
  };
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
  parentPort.on("message", async (job) => {
    if (job.kind === "quit") {
      if (stockfish) stockfish.child.kill();
      process.exit(0);
    }
    parentPort.postMessage(job.kind === "game" ? await playGame(job) : profilePosition(job));
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

async function match(specs, opts) {
  if (specs.length !== 2) throw new Error("match takes two levels");
  const [a, b] = specs.map(parseLevel);
  const games = Math.max(2, opts.games + (opts.games % 2));
  if (a.stockfish && b.stockfish) throw new Error("match needs at least one LorFish level");
  const jobs = Array.from({ length: games }, (_, index) => ({
    kind: "game", seed: opts.seed, index, a, b, movetime: opts.movetime,
  }));
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
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      games: { type: "string", default: "400" },
      positions: { type: "string", default: "300" },
      judge: { type: "string", default: "3" },
      movetime: { type: "string", default: "100" },
      workers: { type: "string", default: String(Math.max(1, os.availableParallelism() - 1)) },
      seed: { type: "string", default: "1" },
    },
  });
  const opts = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
  const [command, ...specs] = positionals;
  if (command === "match") await match(specs, opts);
  else if (command === "profile") await profile(specs, opts);
  else throw new Error("usage: lorfishLevels.js match <a> <b> | profile <level>... (see the comment at the top)");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
