"use strict";

// Game review drives Stockfish over UCI. Most tests script the engine's replies
// so the scoring, the terminal positions and the commands sent can be checked
// exactly; the last ones run the real vendored Stockfish in a child process,
// which speaks the same text lines as the browser's Web Worker.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Chess } = require("../../src/shared/chess");

const PUBLIC_JS = path.join(__dirname, "../../public/js");
const STOCKFISH = path.join(PUBLIC_JS, "vendor/stockfish/stockfish-19-lite-single.js");
const reviewContext = { window: {}, Chess, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_JS, "gameReview.js"), "utf8"), reviewContext);
const review = reviewContext.window.GameReview;
const MATE = 100000;

// A stand-in engine. `answer(position)` returns the lines to reply to a search
// of that "position ..." command; every command sent is kept in `sent`.
function scriptedEngine(answer) {
  const engine = {
    sent: [],
    terminated: false,
    reply(lines) {
      for (const data of lines) queueMicrotask(() => engine.onmessage({ data }));
    },
    postMessage(cmd) {
      engine.sent.push(cmd);
      if (cmd === "uci") engine.reply(["id name Scripted", "uciok"]);
      else if (cmd === "isready") engine.reply(["readyok"]);
      else if (cmd.startsWith("go")) {
        const position = engine.sent.filter((c) => c.startsWith("position")).at(-1);
        engine.reply(answer(position));
      }
    },
    terminate() { engine.terminated = true; },
  };
  return engine;
}

// The real Stockfish, as a child process: one UCI line per message each way.
function stockfishProcess() {
  const child = spawn(process.execPath, [STOCKFISH], { stdio: ["pipe", "pipe", "ignore"] });
  const engine = {
    postMessage: (cmd) => child.stdin.write(cmd + "\n"),
    terminate: () => child.kill(),
  };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) if (line.trim()) engine.onmessage({ data: line });
  });
  return engine;
}

function runReview({ startFen = null, uciMoves, engine, movetime = 50 }) {
  return new Promise((resolve, reject) => {
    review.run({
      startFen, uciMoves, movetime,
      createEngine: () => engine,
      onDone: resolve,
      onError: reject,
    });
  });
}

const searches = (engine) => engine.sent.filter((c) => c.startsWith("go")).length;

test("throwing away mate by stalemate is a blunder", async () => {
  const engine = scriptedEngine(() => ["info depth 5 score mate 1 pv g5g7", "bestmove g5g7"]);
  const result = await runReview({ startFen: "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", uciMoves: ["g5g6"], engine });
  const move = result.moves[0];
  assert.equal(move.evalBefore, MATE - 1);
  assert.ok(move.evalAfter === 0, "stalemate scores a draw");
  assert.equal(move.kind, "blunder");
  assert.equal(move.loss, 1000);
  assert.ok(move.accuracy < 50);
  assert.equal(move.best.san, "Qg7#");
  assert.equal(move.depth, null, "a mate's search depth means nothing");
  assert.equal(searches(engine), 1, "the finished position is never searched");
  assert.equal(engine.terminated, true);
});

test("mate has an explicit losing score for the side to move", async () => {
  for (const [fen, move] of [
    ["7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", "g5g7"],
    ["8/8/8/8/6q1/8/5k2/7K b - - 0 1", "g4g2"],
  ]) {
    const engine = scriptedEngine(() => ["info depth 5 score mate 1 pv " + move, "bestmove " + move]);
    const result = await runReview({ startFen: fen, uciMoves: [move], engine });
    assert.equal(result.moves[0].evalAfter, MATE);
    assert.equal(result.moves[0].loss, 0);
    assert.equal(result.moves[0].kind, "best");
    assert.equal(searches(engine), 1);
  }
});

test("rule draws are zero even when legal moves remain", async () => {
  // Nxe2 leaves king and knight against a bare king.
  const engine = scriptedEngine(() => ["info depth 5 score cp 400 pv g1e2", "bestmove g1e2"]);
  const result = await runReview({ startFen: "7k/8/8/8/8/8/4R3/K5n1 b - - 0 1", uciMoves: ["g1e2"], engine });
  assert.ok(result.moves[0].evalAfter === 0);
  assert.equal(searches(engine), 1);
});

test("missing evaluations are not fabricated as good moves", async () => {
  assert.equal(review.summarise([{ turn: "w", score: 500 }, null], ["e2e4"]).moves.length, 0);
  // An engine that answers without ever giving a score leaves the move ungraded.
  const engine = scriptedEngine(() => ["bestmove e2e4"]);
  const result = await runReview({ uciMoves: ["e2e4"], engine });
  assert.equal(result.moves.length, 0);
});

test("every position's score is kept from White's side for the eval bar", async () => {
  const scores = review.summarise(
    [{ turn: "w", score: 30 }, { turn: "b", score: 45 }, null, { turn: "w", score: -MATE }],
    ["e2e4", "e7e5", "d1h5"],
  ).scores;
  assert.deepEqual(Array.from(scores), [30, -45, null, -MATE]);
  // Black mated at the end of a real review: the last position is White's win.
  const engine = scriptedEngine(() => ["info depth 5 score mate 1 pv g5g7", "bestmove g5g7"]);
  const result = await runReview({ startFen: "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", uciMoves: ["g5g7"], engine });
  assert.deepEqual(Array.from(result.scores), [MATE - 1, MATE]);
});

test("the eval bar follows winning chances, and a forced mate fills it", () => {
  assert.equal(review.whiteShare(0), 50);
  assert.equal(review.whiteShare(null), 50, "no score leaves it level");
  assert.ok(review.whiteShare(300) > 70 && review.whiteShare(300) < 90);
  assert.equal(review.whiteShare(-300), 100 - review.whiteShare(300));
  assert.ok(review.whiteShare(5000) < 100, "a big material lead is not a mate");
  assert.equal(review.whiteShare(MATE - 7), 100);
  assert.equal(review.whiteShare(-(MATE - 7)), 0);
});

test("a move is judged by the winning chances it gives away", () => {
  const verdict = (before, after) =>
    review.summarise([{ turn: "w", score: before }, { turn: "b", score: -after }], ["e2e4"]).moves[0];
  // The same two pawns: decisive in a level game, a detail when well ahead.
  assert.equal(verdict(0, -200).kind, "blunder");
  assert.equal(verdict(600, 400).kind, "inaccuracy");
  assert.equal(verdict(1500, 1300).kind, "good");
  assert.equal(verdict(0, -200).loss, 200);
});

test("walking into a forced mate, or letting one go, is judged on its own", () => {
  const verdict = (before, after) =>
    review.summarise([{ turn: "w", score: before }, { turn: "b", score: -after }], ["e2e4"]).moves[0].kind;
  // Allowing mate costs less the more lost the position already was. The
  // clamped expected score alone would call the first one an inaccuracy.
  assert.equal(verdict(-680, -(MATE - 1)), "blunder");
  assert.equal(verdict(-800, -(MATE - 1)), "mistake");
  assert.equal(verdict(-1200, -(MATE - 1)), "inaccuracy");
  // Letting a mate slip: by how much is still won afterwards.
  assert.equal(verdict(MATE - 3, 1200), "inaccuracy");
  assert.equal(verdict(MATE - 3, 800), "mistake");
  assert.equal(verdict(MATE - 3, 300), "blunder");
  assert.equal(verdict(MATE - 3, -(MATE - 2)), "blunder");
  // A slower mate is still a mate.
  assert.equal(verdict(MATE - 3, MATE - 5), "good");
});

test("UCI info lines give a score only when it is final", () => {
  // Copied out of the review's vm context, whose Object prototype is its own.
  const parse = (line) => { const r = review.parseInfo(line); return r && { ...r }; };
  assert.deepEqual(
    parse("info depth 12 seldepth 18 multipv 1 score cp -34 nodes 1 nps 1 pv e7e5"),
    { depth: 12, score: -34 });
  assert.deepEqual(parse("info depth 9 score mate 2 pv d1h5"), { depth: 9, score: MATE - 3 });
  assert.deepEqual(parse("info depth 9 score mate -2 pv g7g6"), { depth: 9, score: -(MATE - 4) });
  assert.equal(parse("info depth 19 score cp 30 lowerbound nodes 221215"), null);
  assert.equal(parse("info depth 19 score cp 30 upperbound nodes 221215"), null);
  assert.equal(parse("info depth 10 multipv 2 score cp 5 pv d2d4"), null);
  assert.equal(parse("info string NNUE evaluation using nn-61e7af4bb97d.nnue"), null);
  assert.equal(parse("info depth 10 currmove e2e4 currmovenumber 1"), null);
});

test("the engine is set up for rook-square castling and told the whole game", async () => {
  const engine = scriptedEngine(() => ["info depth 1 score cp 0", "bestmove e2e4"]);
  await runReview({ uciMoves: ["e2e4", "e7e5"], engine });
  const setup = engine.sent.slice(0, engine.sent.indexOf("isready"));
  assert.ok(setup.includes("setoption name UCI_Chess960 value true"), setup.join(" | "));
  const positions = engine.sent.filter((c) => c.startsWith("position"));
  assert.deepEqual(positions, [
    "position startpos",
    "position startpos moves e2e4",
    "position startpos moves e2e4 e7e5",
  ]);
  assert.ok(engine.sent.includes("go movetime 50"));

  const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const fromFen = scriptedEngine(() => ["info depth 1 score cp 0", "bestmove e1h1"]);
  const result = await runReview({ startFen: fen, uciMoves: ["e1h1"], engine: fromFen });
  assert.equal(fromFen.sent.filter((c) => c.startsWith("position")).at(-1), `position fen ${fen} moves e1h1`);
  assert.equal(result.moves[0].best.san, "O-O");
  assert.equal(result.moves[0].kind, "best");
});

test("an illegal move in the record is an error, not a verdict", async () => {
  const engine = scriptedEngine(() => ["info depth 1 score cp 0", "bestmove e2e4"]);
  await assert.rejects(runReview({ uciMoves: ["e2e4", "e2e4"], engine }), /Illegal move/);
  assert.equal(engine.terminated, true);
});

test("cancelling stops the engine", () => {
  const engine = scriptedEngine(() => []);
  const job = review.run({ uciMoves: ["e2e4"], movetime: 50, createEngine: () => engine });
  job.cancel();
  assert.equal(engine.terminated, true);
});

test("real Stockfish: the Scholar's Mate is found and the defence that allowed it is a blunder", async () => {
  const uciMoves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
  const result = await runReview({ uciMoves, engine: stockfishProcess() });
  assert.equal(result.moves.length, uciMoves.length);
  const [nf6, qxf7] = result.moves.slice(-2);
  assert.equal(nf6.kind, "blunder");
  assert.notEqual(nf6.best.uci, "g8f6");
  assert.equal(qxf7.kind, "best");
  assert.equal(qxf7.best.san, "Qxf7#");
  assert.equal(qxf7.evalAfter, MATE);
});

test("real Stockfish: castling spelled by the rook square is understood", async () => {
  const uciMoves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1h1", "g8f6"];
  const result = await runReview({ uciMoves, engine: stockfishProcess() });
  assert.equal(result.moves.length, uciMoves.length);
  // After O-O the engine must still be in the real game: its choices for Black
  // and then White are legal moves there, spelled out in SAN.
  for (const m of result.moves.slice(-2)) assert.ok(m.best && m.best.san, JSON.stringify(m));
  assert.ok(Math.abs(result.moves[6].evalBefore) < 150, "a level Italian opening");
});
