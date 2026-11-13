"use strict";

// LorFish in Bughouse seats, played by the server (socket.js botTurn, worker
// threads in bots.js): a player starts a match against LorFish — LorFish their
// partner on board 1, two more LorFish for the other team — and the bots play
// their boards by themselves, answer the player, never forfeit for absence,
// and carry on after a restart at the level the match was started at.

process.env.GRACE_MS = "400";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");
const bots = require("../../src/game/bots");

let srv, me, socket;
before(async () => {
  srv = await startServer();
  me = await registerUser(srv.baseUrl, "solo");
  socket = await connectSocket(srv.baseUrl, me.c.cookie());
});
after(async () => {
  await srv.close();
  await bots.shutdown();
});

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const matchRow = (id) => db().prepare("SELECT * FROM matches WHERE id = ?").get(id);
const lorfish = () => db().prepare("SELECT id FROM users WHERE username = 'LorFish'").get().id;
const boardsOf = (matchId) => db().prepare("SELECT id FROM games WHERE match_id = ? ORDER BY board").all(matchId).map((r) => r.id);
const forget = (ids) => { for (const id of ids) { rooms.clearTimers(rooms.getRoom(id)); rooms.deleteRoom(id); } };

// Wait until `check` holds, polling: the bots move on their own time.
async function until(check, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// The next `n` events of a kind, listened for all at once: a bot's answer can
// follow the player's own move closer than a second listener could be added.
function next(sock, event, n, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const got = [];
    const timer = setTimeout(() => { sock.off(event, on); reject(new Error(`timed out waiting for ${n} ${event}`)); }, timeoutMs);
    function on(msg) {
      got.push(msg);
      if (got.length < n) return;
      clearTimeout(timer);
      sock.off(event, on);
      resolve(got);
    }
    sock.on(event, on);
  });
}

async function startAgainstBots(level = "novice") {
  const started = waitFor(socket, "game:start");
  const res = await emitAck(socket, "bughouse:bots", { level });
  assert.equal(res.ok, true, res.error);
  const start = await started;
  return { ...res, start };
}

describe("a Bughouse match against LorFish", () => {
  let match;
  before(async () => { match = await startAgainstBots(); });

  test("seats the player on board 0 with White, LorFish everywhere else", () => {
    const { start, matchId } = match;
    assert.deepEqual([start.board, start.color, start.opponent.username, start.partner.username], [0, "w", "LorFish", "LorFish"]);
    const [zero, one] = db().prepare("SELECT * FROM games WHERE match_id = ? ORDER BY board").all(matchId);
    assert.deepEqual([zero.white_id, zero.black_id, one.white_id, one.black_id],
      [me.user.id, lorfish(), lorfish(), lorfish()]);
    assert.deepEqual([zero.ai_level, one.ai_level], ["novice", "novice"], "its level, kept for a restart");
    assert.deepEqual([zero.rated, one.rated], [0, 0]);
  });

  test("the player's arrival starts both boards, and LorFish plays board 1 by itself", async () => {
    const joined = await emitAck(socket, "game:join", { gameId: match.gameId });
    assert.equal(joined.ok, true);
    const [zero, one] = joined.state.match.boards.map((id) => rooms.getRoom(id));
    assert.ok(zero.started && one.started, "the bots were seated from the start");
    await until(() => one.sans.length >= 4, "four moves on board 1");
  });

  test("LorFish answers the player's move", async () => {
    const both = next(socket, "move:made", 2);   // the player's own, echoed, then LorFish's
    assert.deepEqual(await emitAck(socket, "move:make", { gameId: match.gameId, from: sq("e2"), to: sq("e4") }), { ok: true });
    const [, reply] = await both;
    assert.equal(reply.ply, 2);
    assert.equal(gameRow(match.gameId).turn, "w");
    const stored = db().prepare("SELECT by_user FROM moves WHERE game_id = ? AND ply = 2").get(match.gameId);
    assert.equal(stored.by_user, null, "LorFish's moves are recorded as the AI's");
  });

  test("never forfeits for absence: nobody is waiting for a bot to arrive", async () => {
    await new Promise((r) => setTimeout(r, 600));   // longer than GRACE_MS
    assert.equal(matchRow(match.matchId).status, "active");
  });

  test("survives a restart: both boards rebuilt, the bots back at their level", async () => {
    const [b0, b1] = boardsOf(match.matchId);
    forget([b0, b1]);
    const before = db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(b1).n;
    assert.equal((await emitAck(socket, "game:join", { gameId: b0 })).ok, true);
    const one = rooms.getRoom(b1);
    assert.equal(one.botLevel, "novice");
    assert.deepEqual(one.bots, { w: true, b: true });
    await until(() => db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(b1).n >= before + 2,
      "board 1 to carry on");
  });

  test("a second match is refused while this one is on", async () => {
    assert.deepEqual(await emitAck(socket, "bughouse:bots", {}), { ok: false, error: "Finish your current game first." });
  });

  test("resigning ends it, for both boards", async () => {
    const over = waitFor(socket, "game:over");
    socket.emit("game:resign", { gameId: match.gameId });
    const end = await over;
    assert.deepEqual([end.result, end.termination, end.match.result], ["0-1", "resign", "B"]);
    assert.equal(matchRow(match.matchId).status, "finished");
    // LorFish thinking when it ended is let go, not played into a finished game.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(boardsOf(match.matchId).every((id) => !rooms.getRoom(id)));
  });
});

describe("a LorFish with no move", () => {
  test("waits for a piece from its partner, then drops it", async () => {
    const { matchId } = await startAgainstBots();
    const [b0, b1] = boardsOf(matchId);
    // Board 1: LorFish (Black, the player's partner) is checked along the back
    // rank with nothing in hand — no move, but not mate: it waits. Board 0:
    // the player can take a knight, which goes to that LorFish.
    const set = db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?");
    set.run("4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", "4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", b0);
    set.run("R6k/6pp/8/8/8/8/8/K7 b - - 0 1", "R6k/6pp/8/8/8/8/8/K7 b - - 0 1", b1);
    forget([b0, b1]);
    assert.equal((await emitAck(socket, "game:join", { gameId: b0 })).ok, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(rooms.getRoom(b1).sans.length, 0, "nothing to play yet");
    assert.equal(rooms.getRoom(b1).chess.isWaiting(), true);
    assert.deepEqual(await emitAck(socket, "move:make", { gameId: b0, from: sq("e4"), to: sq("d5") }), { ok: true });
    await until(() => rooms.getRoom(b1) && rooms.getRoom(b1).sans.length === 1, "the knight to be dropped");
    assert.match(rooms.getRoom(b1).sans[0], /^N@[b-g]8$/, "a knight dropped between rook and king");
    socket.emit("game:resign", { gameId: b0 });
    await waitFor(socket, "game:over");
  });
});
