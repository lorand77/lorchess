"use strict";

// Storing four-player chess games (src/shared/fourPlayer.js, Teams). A game is
// one ordinary PvP games row, variant 'fourplayer', with its moves in `moves`
// like any game's, and four `game_seats` rows: who plays each colour and the
// time each has left. The games row's two-player columns stay out of it:
// white_id and black_id are NULL, and `turn` holds the team to move ('w' for
// Red and Yellow, 'b' for Blue and Green), as `result` holds the team's.
// Always casual.
//
// The live game (moves, clocks, the four players coming and going) is the
// room's business (rooms.js, socket.js); this is only what it reads and writes.

const queries = require("../db/queries");
const db = require("../db/index");
const config = require("../config");
const { FourPlayer } = require("../shared/fourPlayer");

const VARIANT = "fourplayer";
const START = new FourPlayer().fen();

// A new game: `seats` maps each colour to a user id, four different people.
// LorFish can't take a seat until it plays four-player chess. Returns the
// game id.
const createGame = db.transaction(({ seats, initialMs, incrementMs }) => {
  const ids = FourPlayer.COLORS.map((c) => seats && seats[c]);
  const ai = queries.getUserByUsername.get(config.AI_USERNAME).id;
  if (!ids.every(Number.isInteger) || new Set(ids).size !== 4 || ids.includes(ai)) {
    throw new Error("A four-player game needs four different players");
  }
  const info = queries.createGame.run(
    null, null, "pvp", null, null, null, START, START, FourPlayer.sideOf("r"),
    initialMs, incrementMs, 0, VARIANT
  );
  const gameId = Number(info.lastInsertRowid);
  FourPlayer.COLORS.forEach((c, i) => queries.insertSeat.run(gameId, c, ids[i]));
  return gameId;
});

// A game's seats: { r: { userId, clockMs }, ... }, clockMs null where never
// recorded.
function seatsOf(gameId) {
  const seats = {};
  for (const row of queries.getSeats.all(gameId)) seats[row.color] = { userId: row.user_id, clockMs: row.clock_ms };
  return seats;
}

// The colour a user plays in a game, or null.
function colorIn(gameId, userId) {
  const row = queries.isSeated.get(gameId, userId);
  return row ? row.color : null;
}

// Write all four clocks, { r: ms, ... }. Inside the caller's transaction when
// there is one (a move, the end of a game).
function saveClocks(gameId, clocks) {
  for (const c of FourPlayer.COLORS) queries.updateSeatClock.run(clocks[c], gameId, c);
}

module.exports = { VARIANT, START, createGame, seatsOf, colorIn, saveClocks };
