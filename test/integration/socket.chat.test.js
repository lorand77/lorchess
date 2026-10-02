"use strict";

// In-game chat and spectating. Chat is for the people in the game: players
// talk to players and spectators to spectators, never across, and messages
// are length-checked and rate-limited per socket. A spectator can watch one
// game at a time, a player cannot watch their own game, and a game with no
// live room cannot be watched. Ends with a threefold repetition, which closes
// a PvP game as a draw without anyone claiming it.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

const mv = (from, to) => ({ from: sq(from), to: sq(to), promo: null });

const connectAs = (who) => connectSocket(srv.baseUrl, who.c.cookie());

// Two live games, both players seated: alice v bob and dave v erin. Carol
// watches.
let srv, alice, bob, carol, dave, erin, g1, g2, c;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
  dave = await registerUser(srv.baseUrl, "dave");
  erin = await registerUser(srv.baseUrl, "erin");
  g1 = await quickMatch(await connectAs(alice), await connectAs(bob), { tc: "10+0" });
  g2 = await quickMatch(await connectAs(dave), await connectAs(erin), { tc: "10+0" });
  for (const g of [g1, g2]) {
    await emitAck(g.white, "game:join", { gameId: g.gameId });
    await emitAck(g.black, "game:join", { gameId: g.gameId });
  }
  c = await connectAs(carol);
});
after(async () => { await srv.close(); });

describe("chat", () => {
  test("is refused to someone neither playing nor watching the game", async () => {
    const res = await emitAck(c, "chat:send", { gameId: g1.gameId, text: "hello" });
    assert.deepEqual(res, { ok: false, error: "You're not in this game." });
    assert.equal((await emitAck(c, "chat:send", { text: "hello" })).ok, false, "no gameId");
  });

  test("must be non-empty and at most 300 characters", async () => {
    const { white, gameId } = g1;
    for (const text of ["", "   \n\t ", null, 42]) {
      assert.deepEqual(await emitAck(white, "chat:send", { gameId, text }), {
        ok: false, error: "Empty message.",
      }, JSON.stringify(text));
    }
    const long = await emitAck(white, "chat:send", { gameId, text: "x".repeat(301) });
    assert.equal(long.ok, false);
    assert.match(long.error, /under 300/);
    // Runs of whitespace collapse before the length is counted.
    const padded = "x".repeat(150) + " ".repeat(200) + "x".repeat(149);
    assert.equal((await emitAck(white, "chat:send", { gameId, text: padded })).ok, true);
  });

  test("is rate-limited to five messages per socket in a burst", async () => {
    // A fresh socket for the same player, so earlier tests don't count.
    const s = await connectAs(alice);
    await emitAck(s, "game:join", { gameId: g1.gameId });
    for (let i = 0; i < 5; i++) {
      assert.equal((await emitAck(s, "chat:send", { gameId: g1.gameId, text: `m${i}` })).ok, true);
    }
    assert.deepEqual(await emitAck(s, "chat:send", { gameId: g1.gameId, text: "one more" }), {
      ok: false, error: "Slow down a little.",
    });
    s.close();
  });
});

describe("spectating", () => {
  test("a player cannot watch their own game, nor an unknown one", async () => {
    const own = await emitAck(g1.white, "game:watch", { gameId: g1.gameId });
    assert.equal(own.ok, false);
    assert.equal(own.player, true);
    assert.match((await emitAck(c, "game:watch", { gameId: 999999 })).error, /not found/);
    assert.match((await emitAck(c, "game:watch", {})).error, /Missing gameId/);
  });

  test("players and spectators each hear only their own side's chat", async () => {
    const counted = waitFor(g1.white, "spectators");
    const watch = await emitAck(c, "game:watch", { gameId: g1.gameId });
    assert.equal(watch.ok, true);
    assert.deepEqual(await counted, { count: 1 });

    // Spectator speaks: no player hears it.
    const playersQuiet = [expectNo(g1.white, "chat:message"), expectNo(g1.black, "chat:message")];
    const echoed = waitFor(c, "chat:message");
    assert.equal((await emitAck(c, "chat:send", { gameId: g1.gameId, text: "nice move" })).ok, true);
    assert.equal((await echoed).text, "nice move");
    assert.deepEqual(await Promise.all(playersQuiet), [true, true]);

    // Player speaks: the spectator doesn't hear it.
    const spectatorQuiet = expectNo(c, "chat:message");
    const heard = waitFor(g1.black, "chat:message");
    assert.equal((await emitAck(g1.white, "chat:send", { gameId: g1.gameId, text: "thanks" })).ok, true);
    assert.equal((await heard).text, "thanks");
    assert.equal(await spectatorQuiet, true);
  });

  test("switching to another game leaves the first one entirely", async () => {
    const dropped = waitFor(g1.white, "spectators");
    assert.equal((await emitAck(c, "game:watch", { gameId: g2.gameId })).ok, true);
    assert.deepEqual(await dropped, { count: 0 });
    assert.equal(rooms.getRoom(g1.gameId).spectators.size, 0);
    assert.equal(rooms.getRoom(g2.gameId).spectators.size, 1);

    // Moves and chat in the old game no longer reach the ex-spectator.
    const quiet = [expectNo(c, "move:made"), expectNo(c, "chat:message")];
    assert.equal((await emitAck(g1.white, "move:make", { gameId: g1.gameId, ...mv("e2", "e4") })).ok, true);
    assert.deepEqual(await Promise.all(quiet), [true, true]);
    assert.equal((await emitAck(c, "chat:send", { gameId: g1.gameId, text: "hi" })).ok, false);
  });

  test("an active game whose room is gone waits for its players, not a spectator", async () => {
    const room = rooms.getRoom(g2.gameId);
    rooms.clearTimers(room);
    rooms.deleteRoom(g2.gameId);
    const other = await connectAs(carol);
    const res = await emitAck(other, "game:watch", { gameId: g2.gameId });
    assert.equal(res.ok, false);
    assert.match(res.error, /waiting for its players/);
    assert.equal(rooms.getRoom(g2.gameId), undefined, "a spectator never rebuilds a room");
    other.close();
  });
});

test("threefold repetition ends a PvP game as a draw", async () => {
  // A fresh pair, so the game starts from the initial position.
  const a = await connectAs(dave);
  const b = await connectAs(erin);
  rooms.sweepUnresumed(); // the room-less game above would keep them busy
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
  await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });

  // Knights out and back twice: the start position stands for the third time.
  const shuffle = [["g1", "f3"], ["g8", "f6"], ["f3", "g1"], ["f6", "g8"]];
  const over = waitFor(white, "game:over");
  for (const [i, [from, to]] of [...shuffle, ...shuffle].entries()) {
    const side = i % 2 === 0 ? white : black;
    const res = await emitAck(side, "move:make", { gameId, ...mv(from, to) });
    assert.equal(res.ok, true, `ply ${i + 1}: ${JSON.stringify(res)}`);
  }
  const result = await over;
  assert.equal(result.result, "1/2-1/2");
  assert.equal(result.termination, "threefold");
  const row = db().prepare("SELECT status, result, termination FROM games WHERE id = ?").get(gameId);
  assert.deepEqual({ ...row }, { status: "finished", result: "1/2-1/2", termination: "threefold" });
});
