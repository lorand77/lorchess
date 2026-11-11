"use strict";

// King of the Hill over the socket: always casual, from the standard setup; a
// king that reaches the centre ends the game there, recorded as "king in the
// centre", a centre square the enemy holds is refused like any move into
// check, and a room rebuilt after a restart keeps the rule. The lobby only
// starts from the standard setup, so an endgame is set up by rewriting the
// game's start before a move is played and forgetting the room, as a restart
// would.

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

// A quick-matched King of the Hill game — asked for as rated, which it can't
// be — from `start` if given, with both players seated.
async function hillGame(start) {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "kingofthehill" });
  if (start) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, gameId);
    forgetRoom(gameId);
  }
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

describe("a King of the Hill game from the start", () => {
  let game;
  before(async () => { game = await hillGame(); });
  after(() => { game.white.close(); game.black.close(); });

  test("starts casual, from the standard setup", () => {
    assert.equal(game.state.variant, "kingofthehill");
    assert.equal(game.state.rated, false);
    assert.equal(gameRow(game.gameId).rated, 0, "quick match asked for rated; King of the Hill is casual only");
    assert.equal(game.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });

  test("a king walked up to the centre wins there", async () => {
    const { white, black, gameId } = game;
    for (const [w, b] of [["e2e4", "a7a6"], ["e1e2", "a6a5"], ["e2e3", "a5a4"]]) {
      await play(white, black, gameId, w);
      await play(black, white, gameId, b);
    }
    const over = waitFor(black, "game:over");
    const last = await play(white, black, gameId, "e3d4");
    assert.equal(last.san, "Kd4");
    const end = await over;
    assert.equal(end.result, "1-0");
    assert.equal(end.termination, "king in the centre");
    const row = gameRow(gameId);
    assert.deepEqual([row.status, row.result, row.termination], ["finished", "1-0", "king in the centre"]);
  });
});

describe("a King of the Hill endgame, after a restart", () => {
  // White's king a step from the centre; Black's rook holds the fourth rank.
  const START = "7k/7p/8/8/r7/3K4/P7/8 w - - 0 1";
  let game;
  before(async () => { game = await hillGame(START); });
  after(() => { game.white.close(); game.black.close(); });

  test("a centre square the enemy holds is refused; one it doesn't wins", async () => {
    const { white, black, gameId } = game;
    assert.equal(game.state.fen, START);
    for (const text of ["d3d4", "d3e4"]) {
      assert.deepEqual(await emitAck(white, "move:make", { gameId, ...step(text) }), { ok: false, error: "Illegal move." }, text);
    }
    await play(white, black, gameId, "d3c3");
    await play(black, white, gameId, "a4a3");   // check along the third rank, and the fourth is free
    forgetRoom(gameId);
    const joined = await emitAck(white, "game:join", { gameId });
    assert.equal(joined.ok, true, "the room is rebuilt from the record");
    await emitAck(black, "game:join", { gameId });
    const over = waitFor(black, "game:over");
    await play(white, black, gameId, "c3d4");
    const end = await over;
    assert.deepEqual([end.result, end.termination], ["1-0", "king in the centre"]);
  });
});
