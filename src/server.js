"use strict";

// The entry point: builds the app (src/app.js) and listens. Process-level
// concerns live here and only here, because the tests boot app.js directly:
// crash and signal handling, the restart notice, and the chat sweep.

const config = require("./config");
const log = require("./log");
const rooms = require("./game/rooms");
const { startChatRetention } = require("./db/retention");
const { createServer } = require("./app");
const { version } = require("../package.json");

// An uncaught error leaves the process in an unknown state: log it, with its
// stack, and exit so pm2 starts a clean one. Without this the reason would only
// reach Node's own stderr dump, outside the log.
function crash(kind, err) {
  log.error("process.crash", { kind, err });
  process.exit(1);
}
process.on("uncaughtException", (err) => crash("uncaught_exception", err));
process.on("unhandledRejection", (err) => crash("unhandled_rejection", err));

// pm2 stops and restarts with a signal. Exiting at once is safe: every move is
// already in SQLite, and games in progress resume on the next start (below).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log.info("process.stop", { signal });
    process.exit(0);
  });
}

// Games left 'active' by a previous run are NOT discarded: the position lives
// in `moves` and the clocks in the games row, so the first player back rebuilds
// the room and play continues where it stopped. Anything nobody returns for is
// aborted by a sweep scheduled in attachSockets().
const resumable = rooms.resumableGames().length;
if (resumable > 0) {
  log.info("process.resumable", { games: resumable, window_ms: config.RESUME_WINDOW_MS });
}

// Drop chat from long-finished games, now and once a day after.
startChatRetention();

const { server } = createServer();

server.listen(config.PORT, () => {
  log.info("process.start", {
    version,
    node: process.version,
    url: `http://localhost:${config.PORT}/login.html`,
    db: config.DB_PATH,
  });
});
