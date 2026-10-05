"use strict";

// The vendored Stockfish as a child process, for tests of the browser code
// that drives it (gameReview.js, liveEval.js). The same file the browser runs
// in a Web Worker also runs under Node, reading UCI on stdin; this wraps it in
// the Worker's shape: postMessage(cmd) in, onmessage({ data: line }) out.

const { spawn } = require("node:child_process");
const path = require("node:path");

const STOCKFISH = path.join(__dirname, "../../public/js/vendor/stockfish/stockfish-19-lite-single.js");

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

module.exports = { stockfishProcess };
