"use strict";

// Duck Chess over the socket: casual, from the standard setup. A turn comes
// as the move and the duck together and is checked whole: a missing duck, one
// left where it was, or one on a piece is refused. Each turn goes out with
// the duck's square and is stored as "g1f3@d5"; a restart rebuilds the duck
// from the moves. Taking the king needs no duck and wins.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db } = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

async function duckGame(one = alice, two = bob) {
  const a = await connectSocket(srv.baseUrl, one.c.cookie());
  const b = await connectSocket(srv.baseUrl, two.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "duck" });
  const joined = await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black, state: joined.state };
}
const turn = (s, gameId, from, to, duck, extra) =>
  emitAck(s, "move:make", { gameId, from: sq(from), to: sq(to), duck: duck == null ? undefined : sq(duck), ...extra });
const DUCK_ERROR = { ok: false, error: "Put the duck on an empty square other than the one it is on." };

describe("a Duck Chess game", () => {
  let g;
  before(async () => { g = await duckGame(); });
  after(() => { g.white.close(); g.black.close(); });

  test("starts casual, from the standard setup, no duck yet", () => {
    assert.equal(g.state.variant, "duck");
    assert.equal(g.state.rated, false);
    assert.equal(g.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });

  test("a turn without its duck, or with one on a piece, is refused", async () => {
    assert.deepEqual(await turn(g.white, g.gameId, "g1", "f3", null), DUCK_ERROR);
    assert.deepEqual(await turn(g.white, g.gameId, "g1", "f3", "e2"), DUCK_ERROR);
    assert.deepEqual(await turn(g.white, g.gameId, "g1", "f3", "f3"), DUCK_ERROR, "where the knight lands");
  });

  test("a whole turn goes out with the duck, and is stored with it", async () => {
    const seen = waitFor(g.black, "move:made");
    assert.deepEqual(await turn(g.white, g.gameId, "g1", "f3", "d5"), { ok: true });
    const m = await seen;
    assert.equal(m.san, "Nf3@d5");
    assert.equal(m.duck, sq("d5"));
    assert.equal(m.fen, "rnbqkbnr/pppppppp/8/3*4/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1");
    const row = db().prepare("SELECT uci, san FROM moves WHERE game_id = ? AND ply = 1").get(g.gameId);
    assert.deepEqual(row, { uci: "g1f3@d5", san: "Nf3@d5" });
  });

  test("the duck blocks, and must move: not left where it was", async () => {
    assert.deepEqual(await turn(g.black, g.gameId, "d7", "d5", "a6"), { ok: false, error: "Illegal move." });
    assert.deepEqual(await turn(g.black, g.gameId, "d7", "d6", "d5"), DUCK_ERROR);
    assert.deepEqual(await turn(g.black, g.gameId, "d7", "d6", "d7"), { ok: true }, "onto the square just left");
  });

  test("a restart rebuilds the duck from the moves", async () => {
    const before = rooms.getRoom(g.gameId).chess.fen();
    rooms.clearTimers(rooms.getRoom(g.gameId));
    rooms.deleteRoom(g.gameId);
    const back = await emitAck(g.white, "game:join", { gameId: g.gameId });
    assert.equal(back.state.fen, before);
    assert.deepEqual(back.state.moves, ["g1f3@d5", "d7d6@d7"]);
    assert.equal(rooms.getRoom(g.gameId).chess.duck, sq("d7"));
    await emitAck(g.black, "game:join", { gameId: g.gameId });
  });
});

test("taking the king needs no duck, and wins", async () => {
  const g = await duckGame(await registerUser(srv.baseUrl, "carol"), await registerUser(srv.baseUrl, "dave"));
  const plays = [
    [g.white, "e2", "e4", "a6"], [g.black, "f7", "f6", "a5"],
    [g.white, "d1", "h5", "c3"], [g.black, "a7", "a5", "b6"],
  ];
  for (const [s, from, to, duck] of plays) assert.deepEqual(await turn(s, g.gameId, from, to, duck), { ok: true }, `${from}${to}`);
  const over = waitFor(g.black, "game:over");
  assert.deepEqual(await turn(g.white, g.gameId, "h5", "e8", null), { ok: true });
  const o = await over;
  assert.equal(o.result, "1-0");
  assert.equal(o.termination, "king captured");
  assert.equal(db().prepare("SELECT termination FROM games WHERE id = ?").get(g.gameId).termination, "king captured");
  g.white.close();
  g.black.close();
});
