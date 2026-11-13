"use strict";

// The server's LorFish: a small pool of worker threads (botWorker.js) that
// search positions for the Bughouse seats LorFish holds (socket.js botTurn).
// A search can take seconds and the event loop runs every live game, so it is
// never done on the main thread. Workers start on first use, take one job at
// a time, and queue the rest; one that dies fails its job and is replaced.
// They are unref'd, so they never keep the process alive on their own.

const path = require("path");
const { Worker } = require("worker_threads");
const config = require("../config");
const log = require("../log");

const workers = [];   // { worker, job: { id, resolve, reject } | null }
const queue = [];     // jobs waiting for a free worker
let nextId = 1;

function spawn() {
  const slot = { worker: new Worker(path.join(__dirname, "botWorker.js")), job: null };
  slot.worker.unref();
  slot.worker.on("message", (msg) => {
    const job = slot.job;
    slot.job = null;
    if (job && msg.id === job.id) {
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.move);
    }
    next(slot);
  });
  slot.worker.on("error", (err) => {
    log.error("bot.worker_failed", { err });
    const job = slot.job;
    slot.job = null;
    workers.splice(workers.indexOf(slot), 1);
    if (job) job.reject(err);
    drain();
  });
  workers.push(slot);
  return slot;
}

function next(slot) {
  const job = queue.shift();
  if (!job) return;
  slot.job = job;
  slot.worker.postMessage({ id: job.id, ...job.question });
}

function drain() {
  while (queue.length) {
    const free = workers.find((w) => !w.job) || (workers.length < Math.max(1, config.BOT_WORKERS) ? spawn() : null);
    if (!free) return;
    next(free);
  }
}

// The move LorFish plays: { variant, fen, depth, temperature } in, a promise
// of { from, to, promo, drop } (or null with nothing to play) out.
function think(question) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, question, resolve, reject });
    drain();
  });
}

// Stop every worker (tests, and anything that wants a clean exit).
async function shutdown() {
  const all = workers.splice(0);
  queue.splice(0);
  await Promise.all(all.map((w) => w.worker.terminate()));
}

module.exports = { think, shutdown };
