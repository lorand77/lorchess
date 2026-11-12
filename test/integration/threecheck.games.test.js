"use strict";

// Three-check over the socket: always casual, from the standard setup; every
// check is counted, the third ends the game, recorded as "three checks", and a
// room rebuilt after a restart counts the checks again from the moves.

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

function forgetRoom(gameId) {
  rooms.clearTimers(rooms.getRoom(gameId));
  rooms.deleteRoom(gameId);
}

// A quick-matched Three-check game — asked for as rated, which it can't be —
// with both players seated.
async function threeCheckGame() {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "threecheck" });
  const joined = await emitAck(white, "game:join", { gameId });
  assert.equal(joined.ok, true);
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black, state: joined.state };
}

const step = (text) => ({ from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)), promo: text[4] || null });

async function play(socket, other, gameId, text) {
  const seen = waitFor(other, "move:made");
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...step(text) }), { ok: true }, text);
  return seen;
}

describe("a Three-check game", () => {
  let game;
  before(async () => { game = await threeCheckGame(); });
  after(() => { game.white.close(); game.black.close(); });

  test("starts casual, from the standard setup with no checks given", () => {
    assert.equal(game.state.variant, "threecheck");
    assert.equal(game.state.rated, false);
    assert.equal(gameRow(game.gameId).rated, 0, "quick match asked for rated; Three-check is casual only");
    assert.equal(game.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1");
  });

  test("counts the checks, keeps them through a restart, and the third wins", async () => {
    const { white, black, gameId } = game;
    for (const [w, b] of [["e2e4", "e7e5"], ["f1c4", "a7a6"], ["c4f7", "e8f7"], ["d1h5", "g7g6"]]) {
      await play(white, black, gameId, w);
      await play(black, white, gameId, b);
    }
    assert.match(gameRow(gameId).current_fen, / 1\+3 /, "two checks given: one left to give");
    forgetRoom(gameId);
    const joined = await emitAck(white, "game:join", { gameId });
    assert.equal(joined.ok, true);
    assert.match(joined.state.fen, / 1\+3 /, "replayed, and counted again");
    await emitAck(black, "game:join", { gameId });
    const over = waitFor(black, "game:over");
    const last = await play(white, black, gameId, "h5g6");
    assert.equal(last.san, "Qxg6+");
    const end = await over;
    assert.deepEqual([end.result, end.termination], ["1-0", "three checks"]);
    const row = gameRow(gameId);
    assert.deepEqual([row.status, row.result, row.termination], ["finished", "1-0", "three checks"]);
  });
});
