"use strict";

// Standard Elo rating update. `scoreWhite` is White's game result from White's
// perspective: 1 = White win, 0.5 = draw, 0 = Black win. Returns the rounded
// new ratings for both players. Symmetric: the points White gains equal the
// points Black loses (before rounding).

function elo(whiteRating, blackRating, scoreWhite, k) {
  const K = k || 32;
  const expWhite = 1 / (1 + Math.pow(10, (blackRating - whiteRating) / 400));
  const expBlack = 1 - expWhite;
  const newWhite = Math.round(whiteRating + K * (scoreWhite - expWhite));
  const newBlack = Math.round(blackRating + K * (1 - scoreWhite - expBlack));
  return { newWhite, newBlack };
}

module.exports = { elo };
