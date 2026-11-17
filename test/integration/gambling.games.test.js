"use strict";

// Gambling Chess over the socket: always casual, from the standard setup. The
// server deals every turn — White's first as the game starts — from the types
// the side to move can move, sends the deal with the game state and each
// move, and stores it with the position. A move with any other type is
// refused, saying which type was dealt. A restart keeps the deal rather than
// dealing again, unless what was stored can't move.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");
const { Chess } = require("../../src/shared/chess");

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

async function gamblingGame() {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "gambling" });
  const joined = await emitAck(white, "game:join", { gameId });
  assert.equal(joined.ok, true);
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black, state: joined.state, by: { w: white, b: black } };
}

// Deal `t` on the server's board, as its random deal might have.
const rig = (gameId, t) => assert.equal(rooms.getRoom(gameId).chess.deal(t), true, `deal ${t}`);

describe("a Gambling Chess game", () => {
  let game;
  before(async () => { game = await gamblingGame(); });
  after(() => { game.white.close(); game.black.close(); });

  test("starts casual, from the standard setup, White's first turn dealt and stored", () => {
    assert.equal(game.state.variant, "gambling");
    assert.equal(game.state.rated, false);
    assert.equal(gameRow(game.gameId).rated, 0, "asked for rated; Gambling Chess is casual only");
    assert.ok(["p", "n"].includes(game.state.dealt), game.state.dealt);
    assert.equal(game.state.fen, `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 ${game.state.dealt}`);
    assert.equal(Chess.dealtIn(gameRow(game.gameId).current_fen), game.state.dealt);
  });

  test("a move with a type not dealt is refused, saying which; the dealt type plays", async () => {
    const { gameId, white, black } = game;
    rig(gameId, "n");
    const refused = await emitAck(white, "move:make", { gameId, from: sq("e2"), to: sq("e4") });
    assert.deepEqual(refused, { ok: false, error: "This turn you must move a knight." });
    const seen = waitFor(black, "move:made");
    assert.deepEqual(await emitAck(white, "move:make", { gameId, from: sq("g1"), to: sq("f3") }), { ok: true });
    const m = await seen;
    assert.equal(m.san, "Nf3");
    assert.ok(["p", "n"].includes(m.dealt), "Black's deal, from what Black can move");
    assert.equal(Chess.dealtIn(m.fen), m.dealt);
    assert.equal(Chess.dealtIn(gameRow(gameId).current_fen), m.dealt);
  });

  test("every deal is a type the side to move can move", async () => {
    const { gameId, by } = game;
    for (let ply = 0; ply < 24; ply++) {
      const room = rooms.getRoom(gameId);
      if (room.status !== "active") break;
      const c = room.chess;
      assert.ok(c.movableTypes().includes(c.dealt), `${c.fen()}`);
      const moves = c.legalMoves();
      assert.ok(moves.every((mv) => c.squares[mv.from].t === c.dealt));
      const mv = moves[ply % moves.length];
      const side = c.turn, san = c.moveToSan(mv);
      const res = await emitAck(by[side], "move:make", { gameId, from: mv.from, to: mv.castle ? mv.rookFrom : mv.to, promo: mv.promo || null });
      assert.deepEqual(res, { ok: true }, san);
    }
  });

  test("a restart keeps the deal; a stored deal that can't move is dealt again", async () => {
    const { gameId, white, black } = game;
    const before = rooms.getRoom(gameId).chess.dealt;
    forgetRoom(gameId);
    const back = await emitAck(white, "game:join", { gameId });
    assert.equal(back.state.dealt, before);
    await emitAck(black, "game:join", { gameId });

    // Tamper with the stored deal: a type the side to move hasn't got.
    const room = rooms.getRoom(gameId);
    const missing = ["p", "n", "b", "r", "q", "k"].find((t) => !room.chess.movableTypes().includes(t));
    if (!missing) return;   // every type can move: nothing to tamper with
    const fen = gameRow(gameId).current_fen.replace(/ [pnbrqk]$/, " " + missing);
    db().prepare("UPDATE games SET current_fen = ? WHERE id = ?").run(fen, gameId);
    forgetRoom(gameId);
    const again = await emitAck(white, "game:join", { gameId });
    assert.ok(rooms.getRoom(gameId).chess.movableTypes().includes(again.state.dealt));
    assert.notEqual(again.state.dealt, missing);
    assert.equal(Chess.dealtIn(gameRow(gameId).current_fen), again.state.dealt, "and stored");
  });

  test("the server's deals are each movable type about as often", () => {
    const room = rooms.getRoom(game.gameId);
    const counts = {};
    const types = room.chess.movableTypes();
    for (let i = 0; i < 1200; i++) {
      const t = rooms.dealTurn(room);
      counts[t] = (counts[t] || 0) + 1;
    }
    assert.deepEqual(Object.keys(counts).sort(), types.slice().sort());
    const even = 1200 / types.length;
    for (const t of types) assert.ok(Math.abs(counts[t] - even) < even * 0.25, JSON.stringify(counts));
  });
});
