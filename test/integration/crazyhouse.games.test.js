"use strict";

// A Crazyhouse game over the socket: always casual, however it was asked for;
// drops sent as { drop, to }, checked by the server, broadcast and stored as
// "P@e4", and replayed when the room is rebuilt after a restart.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const storedMoves = (id) =>
  db().prepare("SELECT san, uci FROM moves WHERE game_id = ? ORDER BY ply").all(id);

// What a restart does to a live game: the room is gone, the database remains.
function forgetRoom(gameId) {
  rooms.clearTimers(rooms.getRoom(gameId));
  rooms.deleteRoom(gameId);
}

const step = (text) =>
  text.includes("@")
    ? { drop: text[0].toLowerCase(), to: sq(text.slice(2)) }
    : { from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)), promo: null };

// Play a move and return what the opponent was told.
async function play(socket, other, gameId, text) {
  const seen = waitFor(other, "move:made");
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...step(text) }), { ok: true }, text);
  return seen;
}

describe("a posted Crazyhouse seek", () => {
  test("is casual, even when the form asked for a rated game", async () => {
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const state = new Promise((resolve) => {
      a.on("lobby:state", (s) => { if (s.seeks.length) resolve(s); });
    });
    a.emit("lobby:enter");
    a.emit("seek:create", { tc: "5+0", rated: true, variant: "crazyhouse" });
    const seek = (await state).seeks[0];
    assert.equal(seek.variant, "crazyhouse");
    assert.equal(seek.rated, false);
    a.emit("seek:cancel", { id: seek.id });
    a.close();
  });
});

describe("a Crazyhouse game", () => {
  let white, black, gameId;
  before(async () => {
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const b = await connectSocket(srv.baseUrl, bob.c.cookie());
    ({ gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "crazyhouse" }));
  });
  after(() => { white.close(); black.close(); });

  test("starts casual, from the standard setup with empty pockets", async () => {
    assert.equal(gameRow(gameId).variant, "crazyhouse");
    assert.equal(gameRow(gameId).rated, 0, "quick match asked for rated; Crazyhouse is casual only");
    const joined = await emitAck(white, "game:join", { gameId });
    assert.equal(joined.ok, true);
    assert.equal(joined.state.variant, "crazyhouse");
    assert.equal(joined.state.rated, false);
    assert.equal(joined.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1");
    await emitAck(black, "game:join", { gameId });
  });

  test("captures fill the pockets, and a drop goes out and is stored as P@e4", async () => {
    await play(white, black, gameId, "e2e4");
    await play(black, white, gameId, "d7d5");
    await play(white, black, gameId, "e4d5");
    const took = await play(black, white, gameId, "d8d5");
    assert.match(took.fen, /\[Pp\] w /);

    const dropped = await play(white, black, gameId, "P@e4");
    assert.equal(dropped.from, null);
    assert.equal(dropped.to, sq("e4"));
    assert.equal(dropped.promo, null);
    assert.equal(dropped.drop, "p");
    assert.equal(dropped.san, "P@e4");
    assert.match(dropped.fen, /\[p\] b /);

    const check = await play(black, white, gameId, "d5e4");
    assert.equal(check.san, "Qxe4+");
    assert.equal(check.drop, null, "an ordinary move says so");
    assert.deepEqual(storedMoves(gameId)[4], { san: "P@e4", uci: "P@e4" });
  });

  test("survives a restart: the room replays the drop", async () => {
    forgetRoom(gameId);
    const joined = await emitAck(white, "game:join", { gameId });
    assert.equal(joined.ok, true);
    assert.equal(joined.state.fen, "rnb1kbnr/ppp1pppp/8/8/4q3/8/PPPP1PPP/RNBQKBNR[pp] w KQkq - 0 4");
    assert.deepEqual(joined.state.moves, ["e2e4", "d7d5", "e4d5", "d8d5", "P@e4", "d5e4"]);
    assert.deepEqual(joined.state.sans, ["e4", "d5", "exd5", "Qxd5", "P@e4", "Qxe4+"]);
    await emitAck(black, "game:join", { gameId });
  });

  test("refuses a drop from an empty pocket, of a king, or with no piece named", async () => {
    for (const payload of [
      { drop: "p", to: sq("e3") },            // White's pocket is empty
      { drop: "k", to: sq("e3") },
      { drop: {}, to: sq("e3") },
      { from: null, to: sq("e3"), promo: null }, // findMove never answers with a drop
    ]) {
      const res = await emitAck(white, "move:make", { gameId, ...payload });
      assert.deepEqual(res, { ok: false, error: "Illegal move." }, JSON.stringify(payload));
    }
  });

  test("goes on after the restart, drops and all, until it ends", async () => {
    await play(white, black, gameId, "g1e2");
    const dropped = await play(black, white, gameId, "P@d3");
    assert.equal(dropped.san, "P@d3");
    assert.match(dropped.fen, /\[p\] w /);
    assert.equal(storedMoves(gameId).at(-1).uci, "P@d3");

    const over = waitFor(black, "game:over");
    white.emit("game:resign", { gameId });
    assert.equal((await over).result, "0-1");
    assert.equal(gameRow(gameId).status, "finished");
    assert.equal(gameRow(gameId).variant, "crazyhouse");
  });
});
