"use strict";

// Storing a Bughouse match (src/game/matches.js): a matches row and two
// casual PvP boards with the right players in the right seats; both boards'
// moves read back in the order they were made, and the positions rebuilt from
// them with what was passed between them; the end of a match finishing both
// boards with the results that follow for each player.

require("../helpers/server"); // points the database at a temporary file
const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");
const matches = require("../../src/game/matches");
const { Bughouse } = require("../../src/shared/bughouse");
const { moveFromUci } = require("../../src/shared/uci");
const { makeUser } = require("../helpers/games");

const four = () => [makeUser("a0"), makeUser("a1"), makeUser("b0"), makeUser("b1")].map((u) => u.id);
const newMatch = () => {
  const [a0, a1, b0, b1] = four();
  return { ids: { a0, a1, b0, b1 }, ...matches.createMatch({ teamA: [a0, a1], teamB: [b0, b1], initialMs: 180000, incrementMs: 0 }) };
};

test("a match is two casual Bughouse boards, team A White on board 0 and Black on board 1", () => {
  const { matchId, boards, ids } = newMatch();
  const match = queries.getMatchById.get(matchId);
  assert.deepEqual([match.kind, match.status, match.result], ["bughouse", "active", null]);
  const rows = queries.getMatchBoards.all(matchId);
  assert.deepEqual(rows.map((r) => r.id), boards);
  assert.deepEqual(rows.map((r) => [r.board, r.white_id, r.black_id]), [[0, ids.a0, ids.b0], [1, ids.b1, ids.a1]]);
  for (const r of rows) {
    assert.deepEqual([r.mode, r.variant, r.rated, r.status, r.match_id, r.initial_ms], ["pvp", "bughouse", 0, "active", matchId, 180000]);
  }
  // Each board is in its players' history like any game.
  assert.ok(queries.listGamesForUser.all(ids.a1, ids.a1).some((g) => g.id === boards[1]));
});

test("needs four different players", () => {
  const [a, b, c] = four();
  assert.throws(() => matches.createMatch({ teamA: [a, b], teamB: [c, a], initialMs: 1, incrementMs: 0 }), /four different players/);
  assert.throws(() => matches.createMatch({ teamA: [a, b], teamB: [c], initialMs: 1, incrementMs: 0 }), /four different players/);
});

test("both boards' moves come back in the order they were made, and replay with what was passed", () => {
  const { matchId, boards } = newMatch();
  const live = Bughouse.createBoards();
  const ply = [0, 0];
  // Interleaved as they might be played: the drop on board 1 needs the pawn
  // taken on board 0 a moment before.
  const order = [[0, "e2e4"], [1, "g1f3"], [0, "d7d5"], [0, "e4d5"], [1, "P@e5"], [0, "d8d5"]];
  for (const [board, uci] of order) {
    const chess = live[board];
    const move = moveFromUci(chess, uci);
    const san = chess.moveToSan(move);
    Bughouse.play(live, board, move);
    queries.insertMoveTimed.run(boards[board], ++ply[board], san, uci, chess.fen(), null, 0, 0);
  }
  const { match, moves, positions } = matches.loadMatch(matchId);
  assert.equal(match.id, matchId);
  assert.deepEqual(moves.map((m) => [m.board, m.uci]), order);
  assert.deepEqual(positions.map((p) => p.fen()), live.map((p) => p.fen()));
  assert.equal(positions[1].pocketText(), "P", "board 0's d8xd5 has sent White a pawn on board 1");
  assert.equal(matches.loadMatch(999999), null);
});

test("finishing a match finishes both boards, the deciding one with its own ending", () => {
  const { matchId, boards } = newMatch();
  assert.equal(matches.finishMatch(matchId, { result: "B", termination: "checkmate", decidedOn: 1 }), true);
  const match = queries.getMatchById.get(matchId);
  assert.deepEqual([match.status, match.result, match.termination, match.decided_on], ["finished", "B", "checkmate", 1]);
  const rows = boards.map((id) => queries.getGameById.get(id));
  assert.deepEqual(rows.map((r) => [r.status, r.result, r.termination]), [
    ["finished", "0-1", matches.OTHER_BOARD],   // B's Black wins board 0
    ["finished", "1-0", "checkmate"],           // B's White mated on board 1
  ]);
  assert.equal(matches.finishMatch(matchId, { result: "A", termination: "resign", decidedOn: 0 }), false, "already over");
  assert.equal(queries.getMatchById.get(matchId).result, "B");
});

test("a drawn match draws both boards; an aborted one aborts both", () => {
  const drawn = newMatch();
  matches.finishMatch(drawn.matchId, { result: "draw", termination: "agreement", decidedOn: 0 });
  assert.deepEqual(drawn.boards.map((id) => queries.getGameById.get(id).result), ["1/2-1/2", "1/2-1/2"]);
  const aborted = newMatch();
  assert.equal(matches.abortMatch(aborted.matchId, "no-show"), true);
  assert.equal(queries.getMatchById.get(aborted.matchId).status, "aborted");
  assert.deepEqual(aborted.boards.map((id) => queries.getGameById.get(id).status), ["aborted", "aborted"]);
  assert.equal(matches.abortMatch(aborted.matchId, "again"), false);
});

test("every database has the match columns, and their index", () => {
  const cols = db.prepare("PRAGMA table_info(games)").all().map((c) => c.name);
  assert.ok(cols.includes("match_id") && cols.includes("board"));
  assert.ok(db.prepare("PRAGMA index_list(games)").all().some((i) => i.name === "idx_games_match"));
});
