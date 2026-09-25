"use strict";

// A failure inside a socket handler must never take the server down. The
// database refusing a move is the realistic case: the move is rejected, the
// room keeps the position it had, and play goes on once the cause is gone.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const mv = (from, to, promo = null) => ({ from: sq(from), to: sq(to), promo });

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

const connectAs = (who) => connectSocket(srv.baseUrl, who.c.cookie());

describe("a database write that fails mid-move", () => {
  test("rejects the move, keeps the position and clocks, and the server plays on", async () => {
    const a = await connectAs(alice);
    const b = await connectAs(bob);
    const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0" });
    await emitAck(white, "game:join", { gameId });
    const joined = await emitAck(black, "game:join", { gameId });
    assert.equal(joined.ok, true);
    const before = joined.state;

    // Plant a row at the ply the first move will use, so the insert collides.
    db().prepare(
      "INSERT INTO moves (game_id, ply, san, uci, fen_after, by_user) VALUES (?, 1, 'a3', 'a2a3', 'x', ?)"
    ).run(gameId, white === a ? alice.user.id : bob.user.id);

    // The failure is logged as an error; keep it out of the test report.
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args);
    let reply;
    try {
      reply = await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") });
    } finally {
      console.error = realError;
    }
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Server error/);
    assert.equal(errors.length, 1, "the failure was logged once");
    assert.match(String(errors[0][1]), /UNIQUE/);

    // The room rolled back: same position, no move, white still to play, and
    // white's clock still running from the same full allowance.
    const after = (await emitAck(white, "game:join", { gameId })).state;
    assert.equal(after.fen, START_FEN);
    assert.deepEqual(after.sans, []);
    assert.equal(after.turn, "w");
    assert.ok(after.clocks.w <= before.clocks.w && after.clocks.w > before.clocks.w - 5000, "clock keeps ticking, uncharged");
    // The whole transaction was rolled back: position and clocks untouched too.
    const row = db().prepare("SELECT current_fen, clock_w_ms, clock_b_ms FROM games WHERE id = ?").get(gameId);
    assert.equal(row.current_fen, START_FEN);
    assert.equal(row.clock_w_ms, null, "clocks are first written with the first move");
    assert.equal(row.clock_b_ms, null);

    // With the obstacle gone the very same move goes through.
    db().prepare("DELETE FROM moves WHERE game_id = ? AND ply = 1").run(gameId);
    const made = waitFor(black, "move:made");
    assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
    assert.equal((await made).san, "e4");
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(gameId).n, 1);
    a.close(); b.close();
  });
});
