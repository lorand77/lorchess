"use strict";

// One-off: award achievements for everything that already happened. Feats are
// replayed game by game (stamped with the game's finish time); the counters are
// evaluated once per user at the end, so a milestone points at the state of
// the account now rather than at whichever game happened to be replayed first.
// Safe to re-run: awarding never lowers a tier or double-counts.
//
//   npm run achievements:backfill

const queries = require("../db/queries");
const svc = require("./service");

const games = queries.listFinishedGameIds.all();
let feats = 0;
for (const { id } of games) {
  const game = queries.getGameById.get(id);
  const earned = svc.onGameFinished(id, { skipStats: true, at: game.finished_at });
  for (const list of Object.values(earned)) feats += list.length;
}
console.log(`Replayed ${games.length} finished game(s): ${feats} feat(s) awarded.`);

let stats = 0;
const users = queries.listHumanUserIds.all();
for (const { id } of users) stats += svc.evaluateStats(id, {}).length;
console.log(`Evaluated ${users.length} user(s): ${stats} milestone(s) awarded.`);
