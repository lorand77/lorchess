"use strict";

// The daily puzzle over HTTP: "done" and the streak agree, whichever way the
// puzzle was first attempted, and a retry never moves the streak.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const queries = require("../../src/db/queries");
const svc = require("../../src/puzzles/service");
const fixture = require("../fixtures/puzzles.json");

const ONE = fixture.oneMove[0];

function insert(p) {
  queries.insertPuzzle.run(
    p.id, p.fen, p.moves, p.rating, 75, 95, 1000, p.themes ?? "", p.game_url ?? "", ""
  );
  return queries.getPuzzle.get(p.id);
}

let srv, me, user;
before(async () => {
  srv = await startServer();
  ({ c: me, user } = await registerUser(srv.baseUrl, "solver"));
});
after(async () => { await srv.close(); });

describe("the puzzle of the day", () => {
  test("solved earlier through the rated stream: done, credited on view, and a retry changes nothing", async () => {
    const today = svc.todayUtc();
    const puzzle = insert({ ...ONE, id: "daily_seen", rating: 1500 });
    queries.insertDaily.run(today, puzzle.id);
    // Yesterday, say, it came up in the rated stream and was solved.
    queries.insertAttempt.run(user.id, puzzle.id, 1, 1200, 1216);

    // A retry (giving up here) is unrated and does not touch the streak.
    const retry = await me.post(`/api/puzzles/${puzzle.id}/giveup`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.rating, null);
    assert.equal(retry.body.streak, 0);

    // Viewing today's puzzle says it is done — and the streak agrees.
    const daily = await me.get("/api/puzzles/daily");
    assert.equal(daily.status, 200);
    assert.equal(daily.body.puzzle.id, puzzle.id);
    assert.equal(daily.body.done, true);
    assert.equal(daily.body.solved, true);
    assert.equal(daily.body.streak, 1);
    assert.equal(queries.getPuzzleUser.get(user.id).daily_last_date, today);

    // Still one after another look, and after another retry.
    assert.equal((await me.get("/api/puzzles/daily")).body.streak, 1);
    assert.equal((await me.post(`/api/puzzles/${puzzle.id}/giveup`)).body.streak, 1);
  });
});
