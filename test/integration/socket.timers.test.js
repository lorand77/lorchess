"use strict";

// Everything time-driven in PvP: disconnect grace and forfeit, clock flags,
// the resume window after a restart, and the draw and rematch flows.
//
// Real timers, made short. The grace period and the resume window come from
// the environment (set here, before the server loads its config), and a clock
// flag is provoked by setting a live room's remaining time directly. Mock
// timers would also freeze Socket.IO's heartbeats in this same process.

process.env.GRACE_MS = "400";
process.env.RESUME_WINDOW_MS = "600";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, quickMatch, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");

const mv = (from, to) => ({ from: sq(from), to: sq(to), promo: null });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rooms = () => require("../../src/game/rooms");
const gameRow = (gameId) =>
  db().prepare("SELECT status, result, termination, clock_w_ms, clock_b_ms FROM games WHERE id = ?").get(gameId);

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

// A quick-matched game with both players joined. `fresh` registers two new
// users so rating assertions can start from 1200.
async function joinedGame(payload = { tc: "10+0" }, { fresh = false } = {}) {
  const u1 = fresh ? await registerUser(srv.baseUrl, "p1") : alice;
  const u2 = fresh ? await registerUser(srv.baseUrl, "p2") : bob;
  const a = await connectSocket(srv.baseUrl, u1.c.cookie());
  const b = await connectSocket(srv.baseUrl, u2.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, payload);
  await emitAck(white, "game:join", { gameId });
  await emitAck(black, "game:join", { gameId });
  const whiteUser = white === a ? u1 : u2;
  const blackUser = white === a ? u2 : u1;
  return { gameId, white, black, whiteUser, blackUser };
}

async function play(socket, gameId, from, to) {
  const seen = waitFor(socket, "move:made");
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...mv(from, to) }), { ok: true });
  return seen;
}

// End a game so no forfeit or flag timer outlives the test.
async function resign(socket, other, gameId) {
  const over = waitFor(other, "game:over");
  socket.emit("game:resign", { gameId });
  await over;
  socket.close();
  other.close();
}

describe("disconnect grace", () => {
  test("the opponent is told at once, and a player who stays away forfeits", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "10+0" }, { fresh: true });
    await play(white, gameId, "a2", "a3");
    const gone = waitFor(white, "opponent:disconnected");
    const over = waitFor(white, "game:over");
    black.close();
    assert.deepEqual(await gone, { color: "b", graceMs: 400 });
    const result = await over;
    assert.equal(result.result, "1-0");
    assert.equal(result.termination, "disconnect");
    assert.equal(result.ratings.w.delta, 16);
    assert.equal(result.ratings.b.delta, -16);
    const row = gameRow(gameId);
    assert.equal(row.status, "finished");
    assert.equal(row.result, "1-0");
    assert.equal(row.termination, "disconnect");
    white.close();
  });

  test("a game abandoned before any move is aborted, not lost", async () => {
    const { gameId, white, black } = await joinedGame();
    const over = waitFor(white, "game:over");
    black.close();
    const result = await over;
    assert.equal(result.result, "*");
    assert.equal(result.termination, "aborted");
    assert.equal(result.ratings, null);
    const row = gameRow(gameId);
    assert.equal(row.status, "aborted");
    assert.equal(row.result, null);
    white.close();
  });

  test("coming back within the grace period cancels the forfeit", async () => {
    const { gameId, white, black, blackUser } = await joinedGame();
    await play(white, gameId, "a2", "a3");
    const gone = waitFor(white, "opponent:disconnected");
    black.close();
    await gone;

    const back = waitFor(white, "opponent:reconnected");
    const again = await connectSocket(srv.baseUrl, blackUser.c.cookie());
    const rejoin = await emitAck(again, "game:join", { gameId });
    assert.equal(rejoin.ok, true);
    assert.deepEqual(rejoin.state.sans, ["a3"]);
    assert.equal(rejoin.state.turn, "b");
    assert.deepEqual(await back, { color: "b" });

    assert.equal(await expectNo(white, "game:over", 700), true, "no forfeit after the grace period");
    assert.equal(gameRow(gameId).status, "active");
    await play(again, gameId, "a7", "a6");
    await resign(again, white, gameId);
  });

  test("closing one tab while another is open is not a disconnect", async () => {
    const { gameId, white, black, blackUser } = await joinedGame();
    const tab2 = await connectSocket(srv.baseUrl, blackUser.c.cookie());
    await emitAck(tab2, "game:join", { gameId });
    const quiet = expectNo(white, "opponent:disconnected", 300);
    black.close();
    assert.equal(await quiet, true);
    await resign(tab2, white, gameId);
  });
});

describe("turning up", () => {
  test("a game neither player joins is aborted after the grace period, freeing both", async () => {
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const b = await connectSocket(srv.baseUrl, bob.c.cookie());
    const { gameId } = await quickMatch(a, b, { tc: "10+0" });
    assert.equal(rooms().liveGameOf(alice.user.id), gameId);
    await sleep(600); // nobody sends game:join
    assert.equal(gameRow(gameId).status, "aborted");
    assert.equal(gameRow(gameId).termination, "aborted");
    assert.equal(rooms().getRoom(gameId), undefined);
    assert.equal(rooms().liveGameOf(alice.user.id), null);
    assert.equal(rooms().liveGameOf(bob.user.id), null);
    a.close(); b.close();
  });

  test("a player who never turned up cannot lose to moves made while waiting", async () => {
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const b = await connectSocket(srv.baseUrl, bob.c.cookie());
    const { gameId, white } = await quickMatch(a, b, { tc: "10+0" });
    await emitAck(white, "game:join", { gameId });
    const over = waitFor(white, "game:over");
    assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
    const res = await over;
    assert.equal(res.result, "*", "aborted, not a forfeit");
    assert.equal(res.termination, "aborted");
    assert.equal(res.ratings, null);
    assert.equal(gameRow(gameId).status, "aborted");
    a.close(); b.close();
  });

  test("when only one player turns up, the game is aborted for them too", async () => {
    const a = await connectSocket(srv.baseUrl, alice.c.cookie());
    const b = await connectSocket(srv.baseUrl, bob.c.cookie());
    const { gameId, white } = await quickMatch(a, b, { tc: "10+0" });
    const over = waitFor(white, "game:over");
    assert.equal((await emitAck(white, "game:join", { gameId })).ok, true);
    const res = await over;
    assert.equal(res.result, "*");
    assert.equal(res.termination, "aborted");
    assert.equal(res.ratings, null);
    a.close(); b.close();
  });
});

describe("clocks", () => {
  test("the side to move is flagged when their time runs out", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "1+0" }, { fresh: true });
    rooms().getRoom(gameId).clock.b = 150;
    const overW = waitFor(white, "game:over");
    const overB = waitFor(black, "game:over");
    const made = await play(white, gameId, "a2", "a3");
    assert.ok(made.clocks.b <= 150, `black shows ${made.clocks.b} ms`);
    const [w, b] = await Promise.all([overW, overB]);
    assert.deepEqual(w, b);
    assert.equal(w.result, "1-0");
    assert.equal(w.termination, "timeout");
    assert.equal(w.clocks.b, 0);
    assert.equal(w.ratings.w.delta, 16);
    const row = gameRow(gameId);
    assert.equal(row.termination, "timeout");
    assert.equal(row.clock_b_ms, 0);
    white.close(); black.close();
  });

  test("flagging against a side that cannot mate is a draw, not a loss", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "1+0" }, { fresh: true });
    // Black has king and rook, White a bare king. When Black runs out of time
    // White has no way to have won, so the game is drawn.
    const room = rooms().getRoom(gameId);
    room.chess.loadFen("k6r/8/8/8/8/8/8/K7 w - - 0 1");
    room.clock.b = 150;
    const overW = waitFor(white, "game:over");
    await play(white, gameId, "a1", "b1");
    const w = await overW;
    assert.equal(w.result, "1/2-1/2");
    assert.equal(w.termination, "timeout");
    assert.equal(w.ratings.w.delta, 0);
    assert.equal(w.clocks.b, 0);
    const row = gameRow(gameId);
    assert.equal(row.result, "1/2-1/2");
    assert.equal(row.termination, "timeout");
    white.close(); black.close();
  });

  test("a move that arrives after the clock hit zero is refused and loses on time", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "1+0" });
    const room = rooms().getRoom(gameId);
    room.clock.w = 1;
    room.turnStartedAt = Date.now() - 50;
    const over = waitFor(black, "game:over");
    const quiet = expectNo(black, "move:made", 300);
    assert.deepEqual(await emitAck(white, "move:make", { gameId, ...mv("a2", "a3") }), { ok: false, error: "Out of time." });
    const result = await over;
    assert.equal(result.result, "0-1");
    assert.equal(result.termination, "timeout");
    assert.equal(await quiet, true);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(gameId).n, 0);
    white.close(); black.close();
  });

  test("thinking time is charged to the mover and stored with the game", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "10+0" });
    await sleep(120);
    const made = await play(white, gameId, "a2", "a3");
    assert.ok(made.clocks.w <= 600000 - 100, `white was charged: ${made.clocks.w}`);
    assert.ok(made.clocks.b > 600000 - 100, `black was not: ${made.clocks.b}`);
    const row = gameRow(gameId);
    assert.ok(row.clock_w_ms <= 600000 - 100 && row.clock_b_ms === 600000, `${row.clock_w_ms} / ${row.clock_b_ms}`);
    await resign(white, black, gameId);
  });
});

describe("draw offers", () => {
  test("offer, decline, offer again, accept", async () => {
    const { gameId, white, black } = await joinedGame({ tc: "3+0" }, { fresh: true });
    const offered = waitFor(black, "draw:offered");
    white.emit("draw:offer", { gameId });
    assert.deepEqual(await offered, { from: "w" });

    const selfAnswer = expectNo(white, "game:over", 200);
    white.emit("draw:respond", { gameId, accept: true });
    assert.equal(await selfAnswer, true, "the offerer cannot accept their own offer");

    const declined = waitFor(white, "draw:declined");
    black.emit("draw:respond", { gameId, accept: false });
    assert.deepEqual(await declined, { by: "b" });

    const reoffered = waitFor(white, "draw:offered");
    black.emit("draw:offer", { gameId });
    assert.deepEqual(await reoffered, { from: "b" });
    const overW = waitFor(white, "game:over");
    const overB = waitFor(black, "game:over");
    white.emit("draw:respond", { gameId, accept: true });
    const [w, b] = await Promise.all([overW, overB]);
    assert.deepEqual(w, b);
    assert.equal(w.result, "1/2-1/2");
    assert.equal(w.termination, "agreement");
    assert.equal(w.ratings.w.delta, 0, "equal players draw: no change");
    assert.equal(w.ratings.b.delta, 0);
    assert.deepEqual(gameRow(gameId).result, "1/2-1/2");
    white.close(); black.close();
  });

  test("a move withdraws a pending offer", async () => {
    const { gameId, white, black } = await joinedGame();
    const offered = waitFor(black, "draw:offered");
    white.emit("draw:offer", { gameId });
    await offered;
    const cleared = waitFor(black, "draw:cleared");
    await play(white, gameId, "a2", "a3");
    await cleared;
    const late = expectNo(white, "game:over", 200);
    black.emit("draw:respond", { gameId, accept: true });
    assert.equal(await late, true, "nothing left to accept");
    assert.equal((await emitAck(black, "game:join", { gameId })).state.drawOffer, null);
    await resign(black, white, gameId);
  });

  test("crossed offers are an agreement", async () => {
    const { gameId, white, black } = await joinedGame();
    const over = waitFor(white, "game:over");
    white.emit("draw:offer", { gameId });
    black.emit("draw:offer", { gameId });
    const result = await over;
    assert.equal(result.result, "1/2-1/2");
    assert.equal(result.termination, "agreement");
    white.close(); black.close();
  });
});

describe("rematch", () => {
  test("when both offer, a new game starts with the colours swapped", async () => {
    const { gameId, white, black, whiteUser, blackUser } = await joinedGame({ tc: "3+0" });
    const over = waitFor(black, "game:over");
    white.emit("game:resign", { gameId });
    await over;

    const offered = waitFor(black, "rematch:offered");
    white.emit("rematch:offer", { gameId });
    assert.deepEqual(await offered, { username: whiteUser.user.username });

    const startW = waitFor(white, "game:start");
    const startB = waitFor(black, "game:start");
    black.emit("rematch:offer", { gameId });
    const [sw, sb] = await Promise.all([startW, startB]);
    assert.equal(sw.gameId, sb.gameId);
    assert.notEqual(sw.gameId, gameId);
    assert.equal(sw.color, "b", "the old White is now Black");
    assert.equal(sb.color, "w");
    const row = db().prepare("SELECT white_id, black_id, rated, initial_ms, status FROM games WHERE id = ?").get(sw.gameId);
    assert.equal(row.white_id, blackUser.user.id);
    assert.equal(row.black_id, whiteUser.user.id);
    assert.equal(row.rated, 1);
    assert.equal(row.initial_ms, 180000);
    assert.equal(row.status, "active");
    // Clean up the new game.
    await emitAck(black, "game:join", { gameId: sw.gameId });
    await emitAck(white, "game:join", { gameId: sw.gameId });
    await resign(black, white, sw.gameId);
  });

  test("a declined offer is withdrawn, and offers mean nothing while a game is live", async () => {
    const { gameId, white, black, blackUser } = await joinedGame();
    const ignored = expectNo(black, "rematch:offered", 200);
    white.emit("rematch:offer", { gameId });
    assert.equal(await ignored, true, "the game is still active");

    const over = waitFor(black, "game:over");
    white.emit("game:resign", { gameId });
    await over;
    const offered = waitFor(black, "rematch:offered");
    white.emit("rematch:offer", { gameId });
    await offered;
    const declined = waitFor(white, "rematch:declined");
    black.emit("rematch:decline", { gameId });
    assert.deepEqual(await declined, { username: blackUser.user.username });
    const noGame = expectNo(white, "game:start", 300);
    black.emit("rematch:offer", { gameId });
    assert.equal(await noGame, true, "White's earlier offer no longer stands");
    white.close(); black.close();
  });
});

describe("restart", () => {
  test("a game in progress is rebuilt from the database, and one nobody resumes is aborted", async () => {
    const resumed = await joinedGame({ tc: "3+0" });
    await play(resumed.white, resumed.gameId, "a2", "a3");
    await play(resumed.black, resumed.gameId, "a7", "a6");
    // Alice and Bob are in a game now, so the second one needs other players.
    const abandoned = await joinedGame({ tc: "3+0" }, { fresh: true });
    await play(abandoned.white, abandoned.gameId, "h2", "h3");
    const stored = gameRow(resumed.gameId);

    // A restart: the process forgets every room, the database remembers.
    await srv.close();
    for (const room of rooms().listRooms()) rooms().deleteRoom(room.gameId);
    srv = await startServer();
    assert.deepEqual(
      rooms().resumableGames().map((g) => g.id).sort(),
      [resumed.gameId, abandoned.gameId].sort()
    );

    const w = await connectSocket(srv.baseUrl, resumed.whiteUser.c.cookie());
    const first = await emitAck(w, "game:join", { gameId: resumed.gameId });
    assert.equal(first.ok, true);
    assert.deepEqual(first.state.sans, ["a3", "a6"]);
    assert.equal(first.state.fen, "rnbqkbnr/1ppppppp/p7/8/8/P7/1PPPPPPP/RNBQKBNR w KQkq - 0 2");
    assert.equal(first.state.running, false, "clocks wait for both players");
    assert.deepEqual(first.state.clocks, { w: stored.clock_w_ms, b: stored.clock_b_ms }, "resumes on the stored clocks");

    const started = waitFor(w, "clock:started");
    const b = await connectSocket(srv.baseUrl, resumed.blackUser.c.cookie());
    const second = await emitAck(b, "game:join", { gameId: resumed.gameId });
    assert.equal(second.state.running, true);
    await started;
    const made = await play(w, resumed.gameId, "a3", "a4");
    assert.equal(made.ply, 3);
    assert.equal(made.san, "a4");

    await sleep(800); // past the resume window
    assert.equal(gameRow(resumed.gameId).status, "active", "the resumed game carries on");
    const swept = gameRow(abandoned.gameId);
    assert.equal(swept.status, "aborted");
    assert.equal(swept.termination, "server-restart");
    await resign(w, b, resumed.gameId);
  });
});
