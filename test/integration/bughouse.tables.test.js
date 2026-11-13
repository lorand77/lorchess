"use strict";

// Bughouse tables in the lobby (src/game/lobby.js): a table seats four, its
// host in A0 (White on board 0); others pick a seat, one seat each anywhere;
// the fourth to sit starts the match, with everyone where they sat; the host
// may start sooner, LorFish taking the empty seats; and a seat or a table
// goes with its owner's leaving, going offline, or sitting elsewhere.

process.env.GRACE_MS = "400";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, db,
} = require("../helpers/server");
const bots = require("../../src/game/bots");

let srv;
const users = [];
before(async () => {
  srv = await startServer();
  for (const name of ["host", "p1", "p2", "p3", "p4"]) users.push(await registerUser(srv.baseUrl, name));
});
after(async () => {
  await srv.close();
  await bots.shutdown();
});

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
// The next lobby:state in which `check` holds.
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
const finishMatch = (socket, gameId) => socket.emit("game:resign", { gameId });

describe("a table of four people", () => {
  let socks;
  before(async () => { socks = await Promise.all([0, 1, 2, 3].map(lobbySocket)); });
  after(() => socks.forEach((s) => s.close()));

  test("opens with its host in A0, and everyone in the lobby sees it", async () => {
    socks[0].emit("table:create", { tc: "3+0", level: "casual" });
    const st = await stateWhere(socks[1], (x) => tableOf(x, id(0)));
    const t = tableOf(st, id(0));
    assert.deepEqual([t.tc, t.level, t.seats.A0.userId, t.seats.A1, t.seats.B0, t.seats.B1],
      ["3+0", "casual", id(0), null, null, null]);
  });

  test("a taken seat is refused; one seat each, moving round the table", async () => {
    const t = tableOf(socks[1].state, id(0));
    const refused = waitFor(socks[1], "lobby:error");
    socks[1].emit("table:sit", { id: t.id, seat: "A0" });
    assert.equal((await refused).error, "That seat is taken.");
    socks[1].emit("table:sit", { id: t.id, seat: "B0" });
    await stateWhere(socks[0], (x) => tableOf(x, id(0)).seats.B0);
    socks[1].emit("table:sit", { id: t.id, seat: "B1" });
    const st = await stateWhere(socks[0], (x) => tableOf(x, id(0)).seats.B1);
    assert.equal(tableOf(st, id(0)).seats.B0, null, "moved, not doubled");
    // The host may move too, without closing the table: and back again.
    socks[0].emit("table:sit", { id: t.id, seat: "A1" });
    const moved = tableOf(await stateWhere(socks[1], (x) => tableOf(x, id(0)) && tableOf(x, id(0)).seats.A1), id(0));
    assert.deepEqual([moved.seats.A0, moved.seats.A1.userId], [null, id(0)]);
    socks[0].emit("table:sit", { id: t.id, seat: "A0" });
    await stateWhere(socks[1], (x) => tableOf(x, id(0)) && tableOf(x, id(0)).seats.A0);
  });

  test("the fourth to sit starts the match, everyone where they sat", async () => {
    const t = tableOf(socks[0].state, id(0));
    const starts = socks.map((s) => waitFor(s, "game:start"));
    socks[2].emit("table:sit", { id: t.id, seat: "A1" });   // the host's partner
    await stateWhere(socks[0], (x) => tableOf(x, id(0)).seats.A1);
    socks[3].emit("table:sit", { id: t.id, seat: "B0" });
    const [h, p1, p2, p3] = await Promise.all(starts);
    assert.deepEqual([h.board, h.color, p2.board, p2.color], [0, "w", 1, "b"], "team A: board 0 White, board 1 Black");
    assert.deepEqual([p3.board, p3.color, p1.board, p1.color], [0, "b", 1, "w"], "team B: the other two");
    assert.equal(h.partner.username, users[2].user.username);
    assert.equal(p1.partner.username, users[3].user.username);
    const row = db().prepare("SELECT * FROM games WHERE id = ?").get(h.gameId);
    assert.deepEqual([row.initial_ms, row.increment_ms], [180000, 0], "the table's clock");
    const st = await stateWhere(socks[0], (x) => !tableOf(x, id(0)));
    assert.equal(st.tables.length, 0, "the table is gone once it starts");
    for (const [s, start] of [[socks[0], h], [socks[2], p2]]) await emitAck(s, "game:join", { gameId: start.gameId });
    finishMatch(socks[0], h.gameId);
    await waitFor(socks[0], "game:over");
  });
});

describe("a host who starts early", () => {
  test("gets LorFish in the empty seats, at the table's level", async () => {
    const [host, friend] = await Promise.all([0, 4].map(lobbySocket));
    host.emit("table:create", { level: "beginner" });
    const t = tableOf(await stateWhere(friend, (x) => tableOf(x, id(0))), id(0));
    friend.emit("table:sit", { id: t.id, seat: "A1" });
    await stateWhere(host, (x) => tableOf(x, id(0)).seats.A1);
    // Only the host may start it.
    friend.emit("table:start", { id: t.id });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(tableOf(host.state, id(0)), "still waiting");
    const starts = [waitFor(host, "game:start"), waitFor(friend, "game:start")];
    host.emit("table:start", { id: t.id });
    const [h, f] = await Promise.all(starts);
    assert.equal(f.partner.username, users[0].user.username);
    assert.deepEqual([h.opponent.username, f.opponent.username], ["LorFish", "LorFish"]);
    const levels = db().prepare("SELECT ai_level FROM games WHERE match_id = ? ORDER BY board").all(h.matchId);
    assert.deepEqual(levels.map((r) => r.ai_level), ["beginner", "beginner"]);
    await emitAck(host, "game:join", { gameId: h.gameId });
    finishMatch(host, h.gameId);
    await waitFor(host, "game:over");
    host.close();
    friend.close();
  });
});

describe("seats and tables that go", () => {
  test("a seat with its sitter leaving or going offline, a table with its host", async () => {
    const [host, a, b] = await Promise.all([0, 1, 2].map(lobbySocket));
    host.emit("table:create", {});
    const t = tableOf(await stateWhere(a, (x) => tableOf(x, id(0))), id(0));
    a.emit("table:sit", { id: t.id, seat: "B0" });
    b.emit("table:sit", { id: t.id, seat: "B1" });
    await stateWhere(host, (x) => tableOf(x, id(0)).seats.B0 && tableOf(x, id(0)).seats.B1);
    a.emit("table:leave");
    await stateWhere(host, (x) => !tableOf(x, id(0)).seats.B0);
    b.close();   // b's only socket: offline
    await stateWhere(host, (x) => !tableOf(x, id(0)).seats.B1);
    // Opening another table gives up the old one; leaving your own closes it.
    host.emit("table:create", { tc: "1+0" });
    const st = await stateWhere(a, (x) => x.tables.length === 1 && tableOf(x, id(0)).tc === "1+0");
    assert.equal(st.tables.length, 1);
    host.emit("table:leave");
    await stateWhere(a, (x) => !tableOf(x, id(0)));
    host.close();
    a.close();
  });

  test("a seat goes with its sitter starting another game", async () => {
    const [host, a] = await Promise.all([0, 1].map(lobbySocket));
    host.emit("table:create", {});
    const t = tableOf(await stateWhere(a, (x) => tableOf(x, id(0))), id(0));
    a.emit("table:sit", { id: t.id, seat: "B0" });
    await stateWhere(host, (x) => tableOf(x, id(0)).seats.B0);
    const started = waitFor(a, "game:start");
    assert.equal((await emitAck(a, "bughouse:bots", {})).ok, true);
    const { gameId } = await started;
    await stateWhere(host, (x) => !tableOf(x, id(0)).seats.B0);
    await emitAck(a, "game:join", { gameId });
    finishMatch(a, gameId);
    await waitFor(a, "game:over");
    host.emit("table:leave");
    host.close();
    a.close();
  });

  test("a player in a live game can't open a table or sit at one", async () => {
    const [p, other] = await Promise.all([3, 4].map(lobbySocket));
    const started = waitFor(p, "game:start");
    assert.equal((await emitAck(p, "bughouse:bots", {})).ok, true);
    const { gameId } = await started;
    const err = waitFor(p, "lobby:error");
    p.emit("table:create", {});
    assert.equal((await err).error, "Finish your current game first.");
    other.emit("table:create", {});
    const t = tableOf(await stateWhere(p, (x) => tableOf(x, id(4))), id(4));
    const err2 = waitFor(p, "lobby:error");
    p.emit("table:sit", { id: t.id, seat: "B0" });
    assert.equal((await err2).error, "Finish your current game first.");
    const gone = waitFor(p, "lobby:error");
    p.emit("table:sit", { id: "nope", seat: "B0" });
    assert.equal((await gone).error, "That table is gone.");
    await emitAck(p, "game:join", { gameId });
    finishMatch(p, gameId);
    await waitFor(p, "game:over");
    p.close();
    other.close();
  });
});
