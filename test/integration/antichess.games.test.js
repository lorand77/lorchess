"use strict";

// Antichess over the socket: the server refuses a quiet move while a capture
// is on the board, takes a promotion to a king, replays the game when the room
// is rebuilt after a restart, and records the end as "all pieces lost" when a
// side is left with nothing, or "no moves" when it is left with no move. Antichess is not in the variant catalogue yet, so
// the lobby cannot start one: each game is matched as an ordinary one and its
// row rewritten (variant, and the start for the endgame) before a move is
// played, then the room forgotten, as a restart would.

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

// A quick-matched game turned into Antichess, from `start` if given, with
// both players seated in the rebuilt room.
async function antichessGame(start) {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
  db().prepare("UPDATE games SET variant = 'antichess' WHERE id = ?").run(gameId);
  if (start) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, gameId);
  }
  forgetRoom(gameId);
  const joined = await emitAck(white, "game:join", { gameId });
  assert.equal(joined.ok, true);
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black, state: joined.state };
}

const step = (text) => ({ from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)), promo: text[4] || null });

// Play a move and return what the opponent was told.
async function play(socket, other, gameId, text) {
  const seen = waitFor(other, "move:made");
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...step(text) }), { ok: true }, text);
  return seen;
}

const refused = async (socket, gameId, text) =>
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...step(text) }), { ok: false, error: "Illegal move." }, text);

describe("an Antichess game from the start", () => {
  let game;
  before(async () => { game = await antichessGame(); });
  after(() => { game.white.close(); game.black.close(); });

  test("is rebuilt as Antichess, with no castling rights", () => {
    assert.equal(game.state.variant, "antichess");
    assert.equal(game.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
  });

  test("a capture on the board must be made", async () => {
    const { white, black, gameId } = game;
    await play(white, black, gameId, "e2e4");
    await play(black, white, gameId, "d7d5");
    await refused(white, gameId, "e4e5");
    await refused(white, gameId, "g1f3");
    const took = await play(white, black, gameId, "e4d5");
    assert.equal(took.san, "exd5");
    // Black's queen now has a capture, and so must take.
    await refused(black, gameId, "b8c6");
    await play(black, white, gameId, "d8d5");

    const over = waitFor(black, "game:over");
    white.emit("game:resign", { gameId });
    assert.equal((await over).result, "0-1");
  });
});

describe("an Antichess endgame", () => {
  // White's pawn must take Black's rook; Black's king is far away.
  const START = "1r6/P7/8/8/8/8/8/7k w - - 0 1";
  let game;
  before(async () => { game = await antichessGame(START); });
  after(() => { game.white.close(); game.black.close(); });

  test("refuses a quiet promotion, and takes the capture as a king", async () => {
    const { white, black, gameId } = game;
    assert.equal(game.state.fen, START);
    await refused(white, gameId, "a7a8q");
    const promoted = await play(white, black, gameId, "a7b8k");
    assert.equal(promoted.promo, "k");
    assert.equal(promoted.san, "axb8=K");
    assert.equal(storedMoves(gameId)[0].uci, "a7b8k");
    await play(black, white, gameId, "h1g2");
  });

  test("survives a restart: the room replays the king promotion", async () => {
    const { white, black, gameId } = game;
    forgetRoom(gameId);
    const joined = await emitAck(white, "game:join", { gameId });
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.state.moves, ["a7b8k", "h1g2"]);
    assert.equal(joined.state.fen, "1K6/8/8/8/8/8/6k1/8 w - - 1 2");
    await emitAck(black, "game:join", { gameId });
  });

  test("ends when White loses its last piece: a win, recorded as all pieces lost", async () => {
    const { white, black, gameId } = game;
    await play(white, black, gameId, "b8c7");
    await play(black, white, gameId, "g2f3");
    await play(white, black, gameId, "c7d6");
    await play(black, white, gameId, "f3e4");
    await play(white, black, gameId, "d6d5"); // next to Black's king, which must take
    await refused(black, gameId, "e4f4");
    const over = waitFor(white, "game:over");
    await play(black, white, gameId, "e4d5");
    const end = await over;
    assert.equal(end.result, "1-0");
    assert.equal(end.termination, "all pieces lost");
    const row = gameRow(gameId);
    assert.equal(row.status, "finished");
    assert.equal(row.result, "1-0");
    assert.equal(row.termination, "all pieces lost");
  });
});

describe("an Antichess game where a side is left without a move", () => {
  // White's pawn steps up and blocks Black's only piece.
  const START = "8/8/8/p7/8/P7/8/8 w - - 0 1";
  let game;
  before(async () => { game = await antichessGame(START); });
  after(() => { game.white.close(); game.black.close(); });

  test("Black, to move with no move, wins: recorded as no moves", async () => {
    const { white, black, gameId } = game;
    const over = waitFor(black, "game:over");
    await play(white, black, gameId, "a3a4");
    const end = await over;
    assert.equal(end.result, "0-1");
    assert.equal(end.termination, "no moves");
    assert.equal(gameRow(gameId).termination, "no moves");
  });
});
