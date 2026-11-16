"use strict";

// Storing four-player chess games (src/shared/fourPlayer.js), Teams (variant
// 'fourplayer') or free-for-all ('fourplayer_ffa'). A game is one ordinary PvP
// games row with its moves in `moves` like any game's, and four `game_seats`
// rows: who plays each colour and the time each has left. The games row's
// two-player columns stay out of it: white_id and black_id are NULL, and
// `turn` holds the team to move ('w' for Red and Yellow, 'b' for Blue and
// Green), as a Teams `result` holds the team's. A free-for-all game's result
// is its placings ('b,r=y,g'); its seats also say how each player went out,
// written as it happens, and their points and places at the end. A player
// leaving a free-for-all game (resigning, out of time, forfeited, claiming
// the win) is a row in `moves` like a move, its text the engine's event
// ("resign:b"), so the record replays whole (FourPlayer.playText).
// LorFish may hold any of the seats but all four, played by the server at the
// level and pace kept on the row (games.ai_level, games.bot_pace), so a
// restart knows them. Always casual.
//
// The live game (moves, clocks, the four players coming and going) is the
// room's business (rooms.js, socket.js); this is only what it reads and writes.

const queries = require("../db/queries");
const db = require("../db/index");
const config = require("../config");
const { FourPlayer } = require("../shared/fourPlayer");
const { resolveBotPace } = require("../shared/aiLevels");

const VARIANT = "fourplayer";
const FFA = "fourplayer_ffa";
const START = new FourPlayer().fen();

// A new game: `seats` maps each colour to a user id. The reserved LorFish
// account may hold any number of seats short of four, at `botLevel` and
// `botPace`; every other player sits once. `variant` is Teams unless it is
// free-for-all. Returns the game id.
const createGame = db.transaction(({ seats, initialMs, incrementMs, botLevel, botPace, variant }) => {
  const ids = FourPlayer.COLORS.map((c) => seats && seats[c]);
  const ai = queries.getUserByUsername.get(config.AI_USERNAME).id;
  const people = ids.filter((id) => id !== ai);
  if (!ids.every(Number.isInteger) || new Set(people).size !== people.length || !people.length) {
    throw new Error("A four-player game needs four different players, or LorFish in some seats");
  }
  const bot = people.length < 4;
  const info = queries.createGame.run(
    null, null, "pvp", null, null, bot ? botLevel || null : null, START, START, FourPlayer.sideOf("r"),
    initialMs, incrementMs, 0, variant === FFA ? FFA : VARIANT
  );
  const gameId = Number(info.lastInsertRowid);
  FourPlayer.COLORS.forEach((c, i) => queries.insertSeat.run(gameId, c, ids[i]));
  if (bot) queries.setBotPace.run(resolveBotPace(botPace), gameId);
  return gameId;
});

// A game's seats: { r: { userId, clockMs, eliminated, points, place }, ... },
// clockMs null where never recorded; the last three free-for-all's, else null.
function seatsOf(gameId) {
  const seats = {};
  for (const row of queries.getSeats.all(gameId)) {
    seats[row.color] = { userId: row.user_id, clockMs: row.clock_ms, eliminated: row.eliminated, points: row.points, place: row.place };
  }
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

// Free-for-all: mark every player the engine has out (`chess.out`) on their
// seat, once. Inside the caller's transaction (a move, an elimination).
function saveOut(gameId, chess) {
  for (const c of FourPlayer.COLORS) if (chess.out[c]) queries.updateSeatOut.run(chess.out[c].how || "out", gameId, c);
}

// Free-for-all, at the end: each seat's points and place.
function saveResults(gameId, chess) {
  for (const s of chess.standings()) queries.updateSeatResult.run(s.points, s.place, gameId, s.color);
}

module.exports = { VARIANT, FFA, START, createGame, seatsOf, colorIn, saveClocks, saveOut, saveResults };
