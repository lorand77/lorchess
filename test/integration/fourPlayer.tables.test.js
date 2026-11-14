"use strict";

// Four-player tables in the lobby (src/game/lobby.js): a table of the
// variant's own seats, Red, Blue, Yellow and Green, its host in Red. LorFish
// can't take a seat, so there is no level and no starting early: the fourth
// to sit starts the game, everyone in the colour they sat in, on the table's
// clock. The winning team's players earn the variant's win badge.

process.env.GRACE_MS = "400";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, db,
} = require("../helpers/server");

let srv;
const users = [];
before(async () => {
  srv = await startServer();
  for (const name of ["host", "p1", "p2", "p3"]) users.push(await registerUser(srv.baseUrl, name));
});
after(async () => { await srv.close(); });

// A lobby socket for user i, with the latest lobby:state kept on it.
async function lobbySocket(i) {
  const s = await connectSocket(srv.baseUrl, users[i].c.cookie());
  s.state = null;
  s.on("lobby:state", (st) => { s.state = st; });
  const first = waitFor(s, "lobby:state");
  s.emit("lobby:enter");
  await first;
  return s;
}
const id = (i) => users[i].user.id;
function stateWhere(s, check, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (s.state && check(s.state)) return resolve(s.state);
    const timer = setTimeout(() => { s.off("lobby:state", on); reject(new Error("timed out waiting for lobby state")); }, timeoutMs);
    function on(st) {
      if (!check(st)) return;
      clearTimeout(timer);
      s.off("lobby:state", on);
      resolve(st);
    }
    s.on("lobby:state", on);
  });
}
const tableOf = (st, hostId) => st.tables.find((t) => t.hostId === hostId);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

describe("a four-player table", () => {
  let socks;
  before(async () => { socks = await Promise.all([0, 1, 2, 3].map(lobbySocket)); });
  after(() => socks.forEach((s) => s.close()));

  test("opens with its host in Red and the other colours free, with no LorFish level", async () => {
    socks[0].emit("table:create", { variant: "fourplayer", tc: "5+0", level: "advanced" });
    const t = tableOf(await stateWhere(socks[1], (x) => tableOf(x, id(0))), id(0));
    assert.deepEqual([t.variant, t.tc, t.level], ["fourplayer", "5+0", null]);
    assert.deepEqual(Object.keys(t.seats), ["r", "b", "y", "g"]);
    assert.deepEqual([t.seats.r.userId, t.seats.b, t.seats.y, t.seats.g], [id(0), null, null, null]);
  });

  test("takes its own seats only, and its host can't start it short of four", async () => {
    const t = tableOf(socks[1].state, id(0));
    socks[1].emit("table:sit", { id: t.id, seat: "A1" });   // a Bughouse seat
    socks[1].emit("table:sit", { id: t.id, seat: "y" });    // Red's partner
    const st = await stateWhere(socks[0], (x) => tableOf(x, id(0)).seats.y);
    assert.equal(tableOf(st, id(0)).seats.A1, undefined);
    socks[2].emit("table:sit", { id: t.id, seat: "b" });
    await stateWhere(socks[0], (x) => tableOf(x, id(0)).seats.b);
    socks[0].emit("table:start", { id: t.id });
    await pause(200);
    assert.ok(tableOf(socks[0].state, id(0)), "still waiting for Green");
  });

  test("the fourth to sit starts the game, everyone in the colour they sat in", async () => {
    const t = tableOf(socks[0].state, id(0));
    const starts = socks.map((s) => waitFor(s, "game:start"));
    socks[3].emit("table:sit", { id: t.id, seat: "g" });
    const started = await Promise.all(starts);
    assert.deepEqual(started.map((s) => s.color), ["r", "y", "b", "g"]);
    const gameId = started[0].gameId;
    assert.ok(started.every((s) => s.gameId === gameId));
    const row = db().prepare("SELECT * FROM games WHERE id = ?").get(gameId);
    assert.deepEqual([row.variant, row.initial_ms, row.increment_ms], ["fourplayer", 300000, 0], "the table's clock");
    const seats = db().prepare("SELECT color, user_id FROM game_seats WHERE game_id = ?").all(gameId);
    assert.deepEqual(Object.fromEntries(seats.map((s) => [s.color, s.user_id])), { r: id(0), y: id(1), b: id(2), g: id(3) });
    const st = await stateWhere(socks[1], (x) => !tableOf(x, id(0)));
    assert.equal(st.tables.length, 0, "the table is gone once it starts");
  });

  test("the winning team earns the win badge; the losers don't", async () => {
    const gameId = db().prepare("SELECT game_id FROM game_seats WHERE user_id = ? ORDER BY game_id DESC").get(id(0)).game_id;
    for (const s of socks) await emitAck(s, "game:join", { gameId });
    const move = await emitAck(socks[0], "move:make", { gameId, from: "e2", to: "e4" });
    assert.deepEqual(move, { ok: true });
    const earned = [waitFor(socks[0], "achievements:earned"), waitFor(socks[1], "achievements:earned")];
    socks[2].emit("game:resign", { gameId });   // Blue
    const [red, yellow] = await Promise.all(earned);
    for (const got of [red, yellow]) assert.ok(got.list.some((a) => a.key === "fourplayer_wins"), JSON.stringify(got.list));
    const badge = (i) => db().prepare("SELECT tier FROM user_achievements WHERE user_id = ? AND key = 'fourplayer_wins'").get(id(i));
    assert.ok(badge(0) && badge(1), "Red and Yellow");
    assert.ok(!badge(2) && !badge(3), "not Blue and Green");
  });
});

describe("a table asked for as anything else", () => {
  test("is a Bughouse table, as an old page's is", async () => {
    const s = await lobbySocket(0);
    for (const variant of ["atomic", "nope", undefined]) {
      s.emit("table:create", { variant });
      const t = tableOf(await stateWhere(s, (x) => tableOf(x, id(0)) && tableOf(x, id(0)).variant), id(0));
      assert.deepEqual([t.variant, Object.keys(t.seats)], ["bughouse", ["A0", "A1", "B0", "B1"]], String(variant));
      s.emit("table:leave");
      await stateWhere(s, (x) => !tableOf(x, id(0)));
    }
    s.close();
  });
});
