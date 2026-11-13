"use strict";

// Storing Bughouse matches. A match is a `matches` row and two ordinary PvP
// games rows, its boards (games.match_id, games.board), each with its own two
// players, moves and clocks, so a board shows up in its players' history, the
// replay viewer and the win counts like any game. What belongs to the match —
// whether it is over, which team won, how, and on which board — is on the
// match row. Always casual: the boards are unrated. Seats and the replay of
// both boards together are in src/shared/bughouse.js.
//
// The live match (moves, clocks, passing captures between the boards) is the
// match room's business; this is only what it reads and writes.

const queries = require("../db/queries");
const db = require("../db/index");
const config = require("../config");
const { STANDARD_START } = require("../shared/chess");
const { Bughouse } = require("../shared/bughouse");

// The termination recorded on the board that didn't decide the match.
const OTHER_BOARD = "on the other board";

// A new match between two teams, each [player on board 0, player on board 1]
// by user id, at a time control. The reserved LorFish account may hold any
// number of the seats (the server plays them), at `botLevel`, which is kept on
// the boards it plays (games.ai_level) so a restart knows it; every other
// player sits once. Returns { matchId, boards: [gameId, gameId] }.
const createMatch = db.transaction(({ teamA, teamB, initialMs, incrementMs, botLevel }) => {
  const players = [...teamA, ...teamB];
  const ai = queries.getUserByUsername.get(config.AI_USERNAME).id;
  const people = players.filter((id) => id !== ai);
  if (players.length !== 4 || new Set(people).size !== people.length || !people.length) {
    throw new Error("A Bughouse match needs four different players, or LorFish in some seats");
  }
  const matchId = Number(queries.createMatch.run().lastInsertRowid);
  const seat = (board, color) => {
    const team = Bughouse.teamOf(board, color) === "A" ? teamA : teamB;
    return team[board];
  };
  const boards = [0, 1].map((board) => {
    const bot = seat(board, "w") === ai || seat(board, "b") === ai;
    const info = queries.createGame.run(
      seat(board, "w"), seat(board, "b"), "pvp", null, null, bot ? botLevel || null : null,
      STANDARD_START, STANDARD_START, "w", initialMs, incrementMs, 0, "bughouse"
    );
    const gameId = Number(info.lastInsertRowid);
    queries.setGameMatch.run(matchId, board, gameId);
    return gameId;
  });
  return { matchId, boards };
});

// A match as stored: its row, its two boards' rows (board 0's first), both
// boards' moves in the order they were made, and the two positions rebuilt
// from them, pockets and all. Null for no such match.
function loadMatch(matchId) {
  const match = queries.getMatchById.get(matchId);
  if (!match) return null;
  const boards = queries.getMatchBoards.all(matchId);
  const moves = queries.getMovesForMatch.all(matchId);
  return { match, boards, moves, positions: Bughouse.replay(moves) };
}

// End a match: the team that won ('A' or 'B', or 'draw'), how, and on which
// board it was decided. Both boards are finished with the results that follow
// for their players; the board that didn't decide it says so. False if the
// match was already over.
const finishMatch = db.transaction((matchId, { result, termination, decidedOn }) => {
  if (queries.finishMatch.run(result, termination, decidedOn, matchId).changes === 0) return false;
  const results = Bughouse.boardResults(result);
  for (const board of queries.getMatchBoards.all(matchId)) {
    queries.finishGame.run(results[board.board], board.board === decidedOn ? termination : OTHER_BOARD, board.id);
  }
  return true;
});

// End a match without a result (nobody moved, a player never came, ...).
const abortMatch = db.transaction((matchId, reason) => {
  if (queries.abortMatch.run(reason, matchId).changes === 0) return false;
  for (const board of queries.getMatchBoards.all(matchId)) queries.abortGame.run(reason, board.id);
  return true;
});

module.exports = { createMatch, loadMatch, finishMatch, abortMatch, OTHER_BOARD };
