"use strict";

// Handicap games end to end: an odds seek accepted in the lobby, the label the
// room shows for it (and not for a shuffled Chess960 start), and a rematch that
// keeps the odds with the player who gave them.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, db } = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");

const WHITE_NO_QUEEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1";
const BLACK_NO_QUEEN = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

const connectAs = (who) => connectSocket(srv.baseUrl, who.c.cookie());
const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);

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

describe("an odds game", () => {
  let a, b, gameId;
  before(async () => {
    a = await connectAs(alice);
    b = await connectAs(bob);
    const entered = waitFor(b, "lobby:state");
    b.emit("lobby:enter");
    await entered;
    // Alice offers to play White without her queen; Bob takes it.
    const posted = waitForState(b, (s) => s.seeks.length === 1);
    a.emit("seek:create", { tc: "5+0", color: "w", rated: true, handicap: { squares: { [sq("d1")]: null } } });
    const seek = (await posted).seeks[0];
    assert.equal(seek.handicap, "White −Q");
    assert.equal(seek.rated, false, "odds are never rated, whatever the form said");
    const startA = waitFor(a, "game:start");
    const startB = waitFor(b, "game:start");
    b.emit("seek:accept", { id: seek.id });
    const [sa] = await Promise.all([startA, startB]);
    assert.equal(sa.color, "w");
    gameId = sa.gameId;
  });
  after(() => { a.close(); b.close(); });

  test("starts from the handicap position, unrated, and the room says so", async () => {
    const joined = await emitAck(a, "game:join", { gameId });
    assert.equal(joined.ok, true);
    assert.equal(joined.state.startFen, WHITE_NO_QUEEN);
    assert.equal(joined.state.handicap, "White −Q");
    assert.equal(joined.state.rated, false);
    await emitAck(b, "game:join", { gameId });
    assert.equal(gameRow(gameId).start_fen, WHITE_NO_QUEEN);
  });

  test("a rematch swaps the colours and mirrors the odds onto the new side", async () => {
    assert.equal((await emitAck(a, "move:make", { gameId, from: sq("e2"), to: sq("e4"), promo: null })).ok, true);
    const over = waitFor(a, "game:over");
    b.emit("game:resign", { gameId });
    assert.equal((await over).result, "1-0");

    const startA = waitFor(a, "game:start");
    const startB = waitFor(b, "game:start");
    a.emit("rematch:offer", { gameId });
    b.emit("rematch:offer", { gameId });
    const [sa, sb] = await Promise.all([startA, startB]);
    assert.equal(sa.color, "b", "Alice, who gave the odds, is now Black");
    assert.equal(sb.color, "w");
    const row = gameRow(sa.gameId);
    assert.equal(row.start_fen, BLACK_NO_QUEEN, "and still plays without her queen");
    assert.equal(row.rated, 0);
    const joined = await emitAck(a, "game:join", { gameId: sa.gameId });
    assert.equal(joined.state.handicap, "Black −Q");
    // Tidy up: nobody has moved, so resigning aborts.
    const aborted = waitFor(a, "game:over");
    a.emit("game:resign", { gameId: sa.gameId });
    assert.equal((await aborted).result, "*");
  });
});

describe("the handicap label", () => {
  test("is not put on a Chess960 start, however it differs from the standard setup", () => {
    const base = {
      whiteId: alice.user.id, blackId: bob.user.id, whiteName: "a", blackName: "b",
      initialMs: 300000, incrementMs: 0, rated: true,
    };
    // A shuffled back rank with the king on e1: piece for piece it looks like
    // six swaps on each side, but it is a Chess960 start, not a handicap.
    const shuffled = rooms.createRoom(424242, {
      ...base, variant: "chess960", startFen: "nbrnkrbq/pppppppp/8/8/8/8/PPPPPPPP/NBRNKRBQ w KQkq - 0 1",
    });
    const odds = rooms.createRoom(424243, { ...base, variant: "standard", startFen: WHITE_NO_QUEEN });
    const atomicOdds = rooms.createRoom(424244, { ...base, variant: "atomic", startFen: WHITE_NO_QUEEN });
    try {
      assert.equal(shuffled.handicap, null);
      assert.equal(odds.handicap, "White −Q");
      assert.equal(atomicOdds.handicap, "White −Q", "Atomic keeps the standard setup, so odds apply");
    } finally {
      for (const id of [424242, 424243, 424244]) rooms.deleteRoom(id);
    }
  });
});
