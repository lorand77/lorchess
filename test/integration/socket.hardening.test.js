"use strict";

// The server keeps PvP honest on its own: a move needs a seat at the table, a
// player in a live game is seated in no other, a finished game leaves no room
// behind, and resigning before the first move is an abort, not a loss.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

const mv = (from, to, promo = null) => ({ from: sq(from), to: sq(to), promo });

let srv, alice, bob, carol;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
});
after(async () => { await srv.close(); });

const connectAs = (who) => connectSocket(srv.baseUrl, who.c.cookie());
const idOf = (who) => who.user.id;
const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const ratingOf = (who) => db().prepare("SELECT rating FROM users WHERE id = ?").get(idOf(who)).rating;

// lobby:state is broadcast on many occasions; wait for the one that says `pred`.
function waitForState(socket, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const handler = (s) => {
      if (!pred(s)) return;
      clearTimeout(timer);
      socket.off("lobby:state", handler);
      resolve(s);
    };
    const timer = setTimeout(() => {
      socket.off("lobby:state", handler);
      reject(new Error("no matching lobby:state"));
    }, timeoutMs);
    socket.on("lobby:state", handler);
  });
}

describe("moving", () => {
  test("needs a seat: a socket that never joined the game is refused", async () => {
    const a = await connectAs(alice);
    const b = await connectAs(bob);
    const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
    const early = await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") });
    assert.equal(early.ok, false);
    assert.match(early.error, /Join the game/);
    assert.deepEqual(rooms.getRoom(gameId).sans, []);

    await emitAck(white, "game:join", { gameId });
    await emitAck(black, "game:join", { gameId });
    assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
    // Tidy up so alice and bob are free for the next group.
    const over = waitFor(white, "game:over");
    black.emit("game:resign", { gameId });
    await over;
    a.close(); b.close();
  });
});

describe("one game at a time", () => {
  let a, b, c, gameId, oldSeekId;
  before(async () => {
    a = await connectAs(alice);
    b = await connectAs(bob);
    c = await connectAs(carol);
    // Alice has a seek open and Carol has challenged her when Alice is
    // quick-matched with Bob.
    const entered = waitFor(a, "lobby:state");
    a.emit("lobby:enter");
    await entered;
    const posted = waitForState(a, (s) => s.seeks.length === 1);
    a.emit("seek:create", { tc: "5+0" });
    oldSeekId = (await posted).seeks[0].id;
    const challenged = waitFor(c, "challenge:list");
    c.emit("challenge:create", { toUserId: idOf(alice), tc: "5+0" });
    assert.equal((await challenged).outgoing.length, 1);

    const withdrawn = waitFor(c, "challenge:list");
    ({ gameId } = await quickMatch(a, b, { tc: "3+0" }));
    assert.deepEqual((await withdrawn).outgoing, [], "Carol's challenge to Alice is withdrawn");
  });
  after(() => { a.close(); b.close(); c.close(); });

  test("starting a game withdraws the players' open offers", async () => {
    const entered = waitFor(c, "lobby:state");
    c.emit("lobby:enter");
    const state = await entered;
    assert.deepEqual(state.seeks, []);
    assert.equal(state.players.find((p) => p.userId === idOf(alice)).playing, true);
    const stale = waitFor(c, "lobby:error");
    c.emit("seek:accept", { id: oldSeekId });
    assert.match((await stale).error, /no longer open/);
  });

  test("a player in a live game may not seek, quick-match, challenge or be challenged", async () => {
    for (const [event, payload] of [
      ["seek:create", { tc: "5+0" }],
      ["lobby:join", { tc: "5+0" }],
      ["challenge:create", { toUserId: idOf(carol), tc: "5+0" }],
    ]) {
      const err = waitFor(a, "lobby:error");
      a.emit(event, payload);
      assert.match((await err).error, /current game/, event);
    }
    const err = waitFor(c, "lobby:error");
    c.emit("challenge:create", { toUserId: idOf(alice), tc: "5+0" });
    assert.match((await err).error, /in a game/);
    assert.equal(await expectNo(a, "game:start"), true);
    assert.equal(await expectNo(c, "game:start"), true);
  });

  test("a busy player cannot accept a seek", async () => {
    const posted = waitForState(c, (s) => s.seeks.length === 1);
    c.emit("seek:create", { tc: "5+0" });
    const seekId = (await posted).seeks[0].id;
    const err = waitFor(a, "lobby:error");
    a.emit("seek:accept", { id: seekId });
    assert.match((await err).error, /current game/);
    assert.equal(await expectNo(c, "game:start"), true);
    c.emit("seek:cancel", { id: seekId });
  });

  test("resigning before the first move aborts the game, and frees the player", async () => {
    const before = ratingOf(alice);
    await emitAck(a, "game:join", { gameId });
    await emitAck(b, "game:join", { gameId });
    const over = waitFor(b, "game:over");
    a.emit("game:resign", { gameId });
    const res = await over;
    assert.equal(res.result, "*");
    assert.equal(res.termination, "aborted");
    assert.equal(res.ratings, null);
    assert.equal(gameRow(gameId).status, "aborted");
    assert.equal(ratingOf(alice), before);
    assert.equal(rooms.getRoom(gameId), undefined);

    const posted = waitForState(a, (s) => s.seeks.some((s2) => s2.userId === idOf(alice)));
    a.emit("seek:create", { tc: "5+0" });
    await posted;
    a.emit("seek:cancel");
  });
});

describe("a finished game", () => {
  test("keeps no room, yet still answers a rejoin with its final state", async () => {
    const a = await connectAs(alice);
    const b = await connectAs(bob);
    const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
    await emitAck(white, "game:join", { gameId });
    await emitAck(black, "game:join", { gameId });
    assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
    const over = waitFor(white, "game:over");
    black.emit("game:resign", { gameId });
    assert.equal((await over).result, "1-0");
    assert.equal(rooms.getRoom(gameId), undefined);

    // A reload on the result screen: full state back, still no room.
    const again = await emitAck(white, "game:join", { gameId });
    assert.equal(again.ok, true);
    assert.equal(again.state.status, "finished");
    assert.equal(again.state.result, "1-0");
    assert.deepEqual(again.state.sans, ["e4"]);
    assert.equal(rooms.getRoom(gameId), undefined);
    // Post-game chat still works from that socket.
    assert.equal((await emitAck(white, "chat:send", { gameId, text: "gg" })).ok, true);
    // And a would-be spectator is told the game is over.
    const c = await connectAs(carol);
    const watch = await emitAck(c, "game:watch", { gameId });
    assert.equal(watch.ok, false);
    assert.equal(watch.finished, true);
    a.close(); b.close(); c.close();
  });
});
