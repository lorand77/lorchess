"use strict";

const config = require("./config");
const rooms = require("./game/rooms");
const { startChatRetention } = require("./db/retention");
const { createServer } = require("./app");

// Games left 'active' by a previous run are NOT discarded: the position lives
// in `moves` and the clocks in the games row, so the first player back rebuilds
// the room and play continues where it stopped. Anything nobody returns for is
// aborted by a sweep scheduled in attachSockets().
const resumable = rooms.resumableGames().length;
if (resumable > 0) {
  const window = config.RESUME_WINDOW_MS >= 60000
    ? `${Math.round(config.RESUME_WINDOW_MS / 60000)} min`
    : `${Math.round(config.RESUME_WINDOW_MS / 1000)}s`;
  console.log(
    `${resumable} game(s) in progress from a previous run; ` +
    `players have ${window} to reconnect.`
  );
}

// Drop chat from long-finished games, now and once a day after.
startChatRetention();

const { server } = createServer();

server.listen(config.PORT, () => {
  console.log(`LorChess listening on http://localhost:${config.PORT}`);
  console.log(`  → login:  http://localhost:${config.PORT}/login.html`);
});
