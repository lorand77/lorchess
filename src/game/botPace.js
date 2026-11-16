"use strict";

// How long LorFish takes over a move at its normal pace, where the server
// plays it (a Bughouse or four-player seat: socket.js botTurn). Its search
// takes a fraction of a second, and a move straight back is not how a person
// plays: it barely touches its clock, and in a team game the clock is part of
// the game. So it spends about what a person would, on its own clock: an even
// share of what it has left, plus most of the increment, varied at random.
// A forced move or a recapture comes quickly, and short of time it hurries.
// The same for every level. The quick pace (aiLevels.js BOT_PACES) skips all
// of this.

// The moves a game is reckoned to have left, whatever the move number: an
// even share of the clock that shrinks as the clock does.
const MOVES_LEFT = 50;
const MIN_MS = 500;
const MAX_MS = 20000;
// Short of time, never more than this share of what is left.
const MAX_SHARE = 0.1;

// The time to take, in ms, from when the turn began. `clockMs` is the bot's
// clock at that moment, `choices` its number of legal moves, `recapture`
// whether the move takes back on the square just captured on, `rng` a
// function returning [0, 1).
function thinkTime({ clockMs, incrementMs = 0, choices, recapture = false, rng = Math.random }) {
  let ms;
  if (choices <= 1 || recapture) ms = MIN_MS * (1 + rng());
  else ms = (clockMs / MOVES_LEFT + incrementMs * 0.8) * (0.5 + rng());
  ms = Math.max(MIN_MS, Math.min(MAX_MS, ms));
  return Math.round(Math.min(ms, clockMs * MAX_SHARE));
}

module.exports = { thinkTime, MOVES_LEFT, MIN_MS, MAX_MS, MAX_SHARE };
