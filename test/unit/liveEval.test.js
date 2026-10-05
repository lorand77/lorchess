"use strict";

// The analysis board's live evaluation (public/js/liveEval.js). The engine is
// driven by hand here, so the tests can place a position change exactly where
// it hurts: while a search is still running, or after "stop" but before the
// old search's "bestmove" has come back. The last test runs the real Stockfish.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stockfishProcess } = require("../helpers/stockfish");

const PUBLIC_JS = path.join(__dirname, "../../public/js");
// window is the global, as in a browser, so liveEval.js finds GameReview.
const context = { setTimeout, clearTimeout };
context.window = context;
vm.createContext(context);
for (const file of ["gameReview.js", "liveEval.js"]) {
  vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, file), "utf8"), context);
}
const { LiveEval } = context;
const MATE = 100000;
// Objects from the vm context have its prototypes, which deepEqual rejects.
const plain = (x) => JSON.parse(JSON.stringify(x));

// Answers the handshake by itself and nothing else: searches reply only when
// the test calls emit().
function manualEngine() {
  const engine = {
    sent: [],
    terminated: false,
    emit(...lines) { for (const data of lines) engine.onmessage({ data }); },
    postMessage(cmd) {
      engine.sent.push(cmd);
      if (cmd === "uci") queueMicrotask(() => engine.emit("uciok"));
      else if (cmd === "isready") queueMicrotask(() => engine.emit("readyok"));
    },
    terminate() { engine.terminated = true; },
  };
  return engine;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
// The search commands sent after the handshake: positions, go and stop.
const searchCommands = (engine) =>
  engine.sent.filter((c) => c.startsWith("position") || c.startsWith("go") || c === "stop");

function setup() {
  const engine = manualEngine();
  const updates = [];
  const errors = [];
  const live = LiveEval.create({
    createEngine: () => engine,
    onUpdate: (u) => updates.push(plain(u)),
    onError: (e) => errors.push(e),
    depth: 12,
    movetime: 1000,
  });
  return { engine, updates, errors, live };
}

test("scores are reported from White's side, with the line, until the search ends", async () => {
  const { engine, updates, live } = setup();
  live.analyse({ startFen: null, uciMoves: ["e2e4"], turn: "b" });
  await tick();
  assert.deepEqual(searchCommands(engine), ["position startpos moves e2e4", "go depth 12 movetime 1000"]);
  assert.ok(engine.sent.includes("setoption name UCI_Chess960 value true"));

  engine.emit(
    "info depth 1 seldepth 1 multipv 1 score cp -30 nodes 20 pv e7e5 g1f3",
    "info depth 2 seldepth 2 multipv 1 score cp -25 lowerbound nodes 40 pv e7e5",
    "info depth 2 seldepth 2 multipv 2 score cp 10 nodes 40 pv c7c5",
    "info depth 2 seldepth 3 multipv 1 score mate 2 nodes 60 pv d8h4 g2g3 h4g3",
    "bestmove d8h4 ponder g2g3",
  );
  assert.deepEqual(updates, [
    { score: 30, depth: 1, pv: ["e7e5", "g1f3"], done: false },
    { score: -(MATE - 3), depth: 2, pv: ["d8h4", "g2g3", "h4g3"], done: false },
    { done: true },
  ]);
});

test("a position from a FEN is searched from that FEN plus the moves", async () => {
  const { engine, live } = setup();
  const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
  live.analyse({ startFen: fen, uciMoves: [], turn: "w" });
  await tick();
  assert.equal(searchCommands(engine)[0], "position fen " + fen);
});

test("positions asked for while the engine loads collapse into the latest", async () => {
  const { engine, live } = setup();
  live.analyse({ startFen: null, uciMoves: ["e2e4"], turn: "b" });
  live.analyse({ startFen: null, uciMoves: ["d2d4"], turn: "b" });
  await tick();
  assert.deepEqual(searchCommands(engine), ["position startpos moves d2d4", "go depth 12 movetime 1000"]);
});

test("a new position stops the search, and the old search's last lines are dropped", async () => {
  const { engine, updates, live } = setup();
  live.analyse({ startFen: null, uciMoves: [], turn: "w" });
  await tick();
  engine.emit("info depth 5 multipv 1 score cp 20 pv e2e4");
  assert.equal(updates.length, 1);

  live.analyse({ startFen: null, uciMoves: ["e2e4"], turn: "b" });
  assert.equal(engine.sent.at(-1), "stop");
  // Superseded again before the engine has answered the stop.
  live.analyse({ startFen: null, uciMoves: ["d2d4"], turn: "b" });
  assert.equal(searchCommands(engine).filter((c) => c === "stop").length, 1);

  // The old search winds down: none of it may land on the new position.
  engine.emit("info depth 6 multipv 1 score cp 900 pv e2e4", "bestmove e2e4");
  assert.equal(updates.length, 1);
  assert.deepEqual(searchCommands(engine).slice(-2), ["position startpos moves d2d4", "go depth 12 movetime 1000"]);

  engine.emit("info depth 3 multipv 1 score cp -15 pv g8f6");
  assert.deepEqual(updates.at(-1), { score: 15, depth: 3, pv: ["g8f6"], done: false });
});

test("stop() silences the search and starts nothing else", async () => {
  const { engine, updates, live } = setup();
  live.analyse({ startFen: null, uciMoves: [], turn: "w" });
  await tick();
  live.stop();
  assert.equal(engine.sent.at(-1), "stop");
  engine.emit("info depth 4 multipv 1 score cp 25 pv e2e4", "bestmove e2e4");
  assert.deepEqual(updates, []);
  assert.equal(searchCommands(engine).filter((c) => c.startsWith("go")).length, 1);

  // And the engine is still there for the next position.
  live.analyse({ startFen: null, uciMoves: ["e2e4"], turn: "b" });
  assert.equal(engine.sent.at(-2), "position startpos moves e2e4");
  live.destroy();
  assert.ok(engine.terminated);
});

test("an engine that cannot start is reported once", () => {
  const errors = [];
  const live = LiveEval.create({
    createEngine: () => { throw new Error("no Worker"); },
    onUpdate: () => assert.fail("no updates"),
    onError: (e) => errors.push(e.message),
  });
  live.analyse({ startFen: null, uciMoves: [], turn: "w" });
  live.analyse({ startFen: null, uciMoves: ["e2e4"], turn: "b" });
  assert.deepEqual(errors, ["This browser can't run the analysis engine."]);
});

test("the real Stockfish finds a mate for Black and reports it from White's side", async () => {
  const engine = stockfishProcess();
  const updates = [];
  await new Promise((resolve, reject) => {
    const live = LiveEval.create({
      createEngine: () => engine,
      onUpdate(u) {
        if (!u.done) return updates.push(u);
        live.destroy();
        resolve();
      },
      onError: reject,
      depth: 8,
      movetime: 2000,
    });
    live.analyse({ startFen: "r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1", uciMoves: [], turn: "b" });
  });
  const last = updates.at(-1);
  assert.equal(last.score, -(MATE - 1), "mate in one for Black");
  assert.equal(last.pv[0], "a8a1");
});
