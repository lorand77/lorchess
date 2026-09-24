"use strict";

// GET /api/leaderboard?sort=&dir= — the ranking is done by the server, one
// column at a time, with the default ranking breaking ties.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { makeUser, recordGame } = require("../helpers/games");
const queries = require("../../src/db/queries");

let srv, me, amy, zed, mia, viewer;
before(async () => {
  srv = await startServer();
  ({ c: me, user: viewer } = await registerUser(srv.baseUrl, "viewer"));
  amy = makeUser("amy", 1500);
  zed = makeUser("zed", 1300);
  mia = makeUser("Mia", 1100);
  for (const [u, r] of [[viewer, 500], [amy, 1000], [zed, 2000], [mia, 1500]]) {
    queries.setPuzzleRating.run(r, u.id);
  }
  // Wins: Mia 2, Amy 1, the rest 0. Losses: Zed 3. Draws: Amy 1, Mia 1.
  recordGame({ white: mia.id, black: zed.id, result: "1-0", termination: "resignation" });
  recordGame({ white: zed.id, black: mia.id, result: "0-1", termination: "resignation" });
  recordGame({ white: amy.id, black: zed.id, result: "1-0", termination: "resignation" });
  recordGame({ white: amy.id, black: mia.id, result: "1/2-1/2", termination: "agreement" });
});
after(async () => { await srv.close(); });

// The order the given query puts our four players in.
async function order(query = "") {
  const res = await me.get("/api/leaderboard" + query);
  assert.equal(res.status, 200);
  const names = new Map([viewer, amy, zed, mia].map((u) => [u.id, u.username]));
  return res.body.filter((r) => names.has(r.id)).map((r) => names.get(r.id));
}
const n = (...users) => users.map((u) => u.username);

test("by default: rating, highest first", async () => {
  assert.deepEqual(await order(), n(amy, zed, viewer, mia));
  assert.deepEqual(await order("?sort=rating&dir=desc"), n(amy, zed, viewer, mia));
});

test("either direction on a numeric column", async () => {
  assert.deepEqual(await order("?sort=rating&dir=asc"), n(mia, viewer, zed, amy));
  assert.deepEqual(await order("?sort=puzzles&dir=desc"), n(zed, mia, amy, viewer));
  assert.deepEqual(await order("?sort=losses&dir=desc"), n(zed, amy, viewer, mia));
});

test("ties fall back to rating", async () => {
  // Zed and the viewer both have no wins; Zed is rated higher.
  assert.deepEqual(await order("?sort=wins&dir=desc"), n(mia, amy, zed, viewer));
  // Zed and Mia have played three games each; Zed is rated higher.
  assert.deepEqual(await order("?sort=games&dir=desc"), n(zed, mia, amy, viewer));
  // Amy and Mia each have one draw; Amy is rated higher.
  assert.deepEqual(await order("?sort=draws&dir=desc"), n(amy, mia, zed, viewer));
});

test("names sort case-insensitively, A to Z unless asked otherwise", async () => {
  const az = n(viewer, amy, zed, mia).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(await order("?sort=player"), az);
  assert.deepEqual(await order("?sort=player&dir=asc"), az);
  assert.deepEqual(await order("?sort=player&dir=desc"), [...az].reverse());
});

test("numbers default to biggest first when no direction is given", async () => {
  assert.deepEqual(await order("?sort=wins"), n(mia, amy, zed, viewer));
});

test("unknown columns and directions fall back instead of failing", async () => {
  const byRating = n(amy, zed, viewer, mia);
  assert.deepEqual(await order("?sort=password_hash"), byRating);
  assert.deepEqual(await order("?sort=rating;DROP%20TABLE%20users"), byRating);
  assert.deepEqual(await order("?sort=constructor"), byRating);
  assert.deepEqual(await order("?sort=rating&dir=sideways"), byRating);
});
