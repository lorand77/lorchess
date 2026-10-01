"use strict";

// `npm run user:delete -- <username>` — delete an account for good, as the
// privacy policy promises on request (ops use; there is no self-serve button).
//
// The users row cannot simply go: PvP games, their moves and the opponents'
// rating history point at it, and those are the opponents' record too. So the
// row stays, emptied and renamed `deleted-<id>`, and is deactivated. That alone
// refuses logins, hides it from the leaderboard, friends lists and profiles,
// and lets the server's deactivation sweep close its open sockets (see
// deactivate.js). Everything else about the person is deleted: chat they wrote
// anywhere, friendships, uploaded images, puzzle attempts and skips,
// achievements, rating history, sessions, and their games against LorFish,
// which are in nobody else's history. The old username can be registered again.
//
// There is no undo, so it shows what it will remove and asks for the username
// to be typed back. A player in a live PvP game is refused: run
// `user:deactivate` first and delete once the game has been forfeited.
// Safe to run while the server is up (WAL handles the write).

const readline = require("readline");
const config = require("../config");

const DELETED_NAME = /^deleted-\d+$/;

function usage(msg) {
  if (msg) console.error("error:", msg);
  console.error("usage: npm run user:delete -- <username>");
  process.exit(2);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
    // stdin ended without an answer (Ctrl-D, or nothing piped in).
    rl.on("close", () => resolve(""));
  }).finally(() => rl.close());
}

function liveGameMessage(user, game) {
  return `${user.username} is playing game #${game.id}; nothing deleted. ` +
    "Run `npm run user:deactivate` first, and delete once the game is over.";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) usage();
  const username = args[0];
  if (username.toLowerCase() === config.AI_USERNAME.toLowerCase()) {
    usage(`${config.AI_USERNAME} is the reserved AI account`);
  }
  if (DELETED_NAME.test(username)) usage(`${username} has already been deleted`);

  // Open the DB only after argument checks so a typo doesn't touch the file.
  const db = require("./index");
  const queries = require("./queries");
  const user = queries.getUserByUsernameNoCase.get(username);
  if (!user) usage(`no such user: ${username}`);

  const live = queries.liveGameForUser.get(user.id, user.id);
  if (live) {
    console.error(liveGameMessage(user, live));
    process.exit(1);
  }

  const n = queries.deletionSummary.get({ id: user.id });
  console.log(`${user.username} (id ${user.id}), joined ${user.created_at.slice(0, 10)}`);
  console.log(`  kept, without the name: ${n.pvpGames} PvP game(s)`);
  console.log(`  deleted: ${n.aiGames} game(s) against ${config.AI_USERNAME}, ${n.chat} chat message(s), ` +
    `${n.friendships} friendship(s) and request(s), ${n.images} uploaded image(s), ` +
    `${n.puzzles} puzzle attempt(s) and skip(s), ${n.achievements} achievement(s), ` +
    `${n.ratingChanges} rating change(s), and every session`);
  console.log(`The account becomes deleted-${user.id} and the name ${user.username} is freed. There is no undo.`);

  const answer = await ask(`Type ${user.username} to delete it: `);
  if (answer !== user.username) {
    console.log("not confirmed; nothing deleted");
    process.exit(1);
  }

  // Overwrite deleted content with zeros instead of leaving it in free pages
  // of the database file.
  db.pragma("secure_delete = ON");
  // The sessions table belongs to the session store and may not exist yet;
  // see deactivate.js for why this statement is not in queries.js.
  const hasSessions = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get();
  const remove = db.transaction(() => {
    // Again inside the transaction: a game may have started during the prompt.
    const started = queries.liveGameForUser.get(user.id, user.id);
    if (started) return { started };
    for (const stmt of queries.deleteAccountRows) stmt.run({ id: user.id });
    const ended = hasSessions
      ? db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(user.id).changes
      : 0;
    queries.scrubDeletedUser.run({ id: user.id });
    return { ended };
  });
  const { started, ended } = remove();
  if (started) {
    console.error(liveGameMessage(user, started));
    process.exit(1);
  }
  // Fold the write into the database file now, so the old content does not
  // linger in the WAL. Best effort: the server's open reads can postpone it.
  db.pragma("wal_checkpoint(TRUNCATE)");
  console.log(`deleted ${user.username}: now deleted-${user.id} in ${config.DB_PATH}; ${ended} session(s) ended`);
}

main();
