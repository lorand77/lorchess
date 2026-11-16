"use strict";

// LorFish's pace in a team game's seats (socket.js botTurn, botPace.js). At
// the normal pace, the default, it holds the move it found until it has taken
// about as long as a person would, on its own clock; at the quick pace it
// plays at once. The pace is kept on the game, so a restart keeps it, and a
// game that ends while LorFish holds a move never sees that move.

process.env.BOT_MAX_DEPTH = "1";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, emitAck, waitFor, db } = require("../helpers/server");
const rooms = require("../../src/game/rooms");
const bots = require("../../src/game/bots");
const { MIN_MS } = require("../../src/game/botPace");

let srv;
before(async () => { srv = await startServer(); });
after(async () => {
  await srv.close();
  await bots.shutdown();
});

const moveRow = (gameId, ply) => db().prepare("SELECT think_ms FROM moves WHERE game_id = ? AND ply = ?").get(gameId, ply);
const moveCount = (gameId) => db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(gameId).n;

// A four-player game against LorFish at 1+0 (the player as Red), joined.
async function start(pace) {
  const me = await registerUser(srv.baseUrl, "pacer");
  const socket = await connectSocket(srv.baseUrl, me.c.cookie());
  const started = waitFor(socket, "game:start");
  const res = await emitAck(socket, "fourplayer:bots", { tc: "1+0", level: "novice", pace });
  assert.equal(res.ok, true, res.error);
  await started;
  assert.equal((await emitAck(socket, "game:join", { gameId: res.gameId })).ok, true);
  return { socket, gameId: res.gameId };
}

// Red's move, then Blue's (LorFish's) answer as everyone hears it.
async function redThenBlue(g) {
  const blue = new Promise((resolve) => {
    const on = (m) => { if (m.ply === 2) { g.socket.off("move:made", on); resolve(m); } };
    g.socket.on("move:made", on);
  });
  assert.deepEqual(await emitAck(g.socket, "move:make", { gameId: g.gameId, from: "e2", to: "e4" }), { ok: true });
  return blue;
}

describe("LorFish at the normal pace, the default", () => {
  test("takes its time over a move, on its own clock", async () => {
    const g = await start(undefined);
    assert.equal(db().prepare("SELECT bot_pace FROM games WHERE id = ?").get(g.gameId).bot_pace, "normal");
    const blue = await redThenBlue(g);
    const { think_ms: took } = moveRow(g.gameId, 2);
    assert.ok(took >= MIN_MS, `Blue took ${took} ms`);
    assert.ok(blue.clocks.b <= 60000 - took + 50, `charged to Blue's clock: ${blue.clocks.b}`);
    g.socket.emit("game:resign", { gameId: g.gameId });
    await waitFor(g.socket, "game:over");
    g.socket.close();
  });

  test("drops the move it holds when the game ends meanwhile", async () => {
    const g = await start("normal");
    const room = rooms.getRoom(g.gameId);
    assert.deepEqual(await emitAck(g.socket, "move:make", { gameId: g.gameId, from: "e2", to: "e4" }), { ok: true });
    const over = waitFor(g.socket, "game:over");
    g.socket.emit("game:resign", { gameId: g.gameId });
    await over;
    await new Promise((r) => setTimeout(r, 2000));   // longer than any think at 1+0
    assert.equal(moveCount(g.gameId), 1, "no move after the end");
    assert.deepEqual([room.botTimer, room.botThinking], [null, false]);
    g.socket.close();
  });
});

describe("LorFish at the quick pace", () => {
  test("plays at once, and keeps the pace over a restart", async () => {
    const g = await start("quick");
    assert.equal(db().prepare("SELECT bot_pace FROM games WHERE id = ?").get(g.gameId).bot_pace, "quick");
    await redThenBlue(g);
    const { think_ms: took } = moveRow(g.gameId, 2);
    assert.ok(took < MIN_MS, `Blue took ${took} ms`);
    // Rebuilt from the database, still quick.
    const room = rooms.getRoom(g.gameId);
    rooms.clearTimers(room);
    rooms.deleteRoom(g.gameId);
    assert.equal((await emitAck(g.socket, "game:join", { gameId: g.gameId })).ok, true);
    assert.equal(rooms.getRoom(g.gameId).botPace, "quick");
    g.socket.emit("game:resign", { gameId: g.gameId });
    await waitFor(g.socket, "game:over");
    g.socket.close();
  });
});
