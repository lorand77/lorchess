"use strict";

// Chat retention. In-game chat exists so the two players can talk during a game
// and for the few minutes afterwards while they arrange a rematch — the room
// object is already gone by then, which is why the messages are in the database
// at all. None of that needs them a month later, and keeping every message ever
// sent means they also live in every backup, for ever.
//
// So: sweep the conversation once a game has been over for CHAT_RETENTION_DAYS;
// set it to -1 to keep chat forever.
// Live games have finished_at IS NULL and are never touched. The "Chatty"
// achievement counts users.chat_count, which this never decrements, so progress
// survives the sweep.

const queries = require("./queries");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the number of messages removed (0 when chat is kept forever).
function sweepOldChat(days) {
  const keepDays = days == null ? config.CHAT_RETENTION_DAYS : days;
  // -1 (any negative) means "keep everything"; 0 sweeps as soon as a game ends.
  if (!Number.isFinite(keepDays) || keepDays < 0) return 0;
  return queries.deleteChatForOldGames.run(`-${keepDays} days`).changes;
}

// Sweep now, then once a day. Unref'd so it never holds the process open on its
// own, and wrapped so a failure here can't take the server down with it.
function startChatRetention() {
  const run = () => {
    try {
      const removed = sweepOldChat();
      if (removed > 0) {
        console.log(
          `[chat] removed ${removed} message(s) from games finished over ` +
          `${config.CHAT_RETENTION_DAYS} days ago`
        );
      }
    } catch (err) {
      console.error("[chat] retention sweep failed:", err.message);
    }
  };
  run();
  const timer = setInterval(run, DAY_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { sweepOldChat, startChatRetention };
