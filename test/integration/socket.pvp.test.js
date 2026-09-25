"use strict";

// Authoritative PvP over Socket.IO: authenticated handshake, quick-match,
// joining a game, the server validating every move, and the conclusion of a
// game with its result, ratings and persistence.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, quickMatch, db,
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

describe("handshake", () => {
  test("a socket without a session is refused", async () => {
    await assert.rejects(connectSocket(srv.baseUrl, null), /unauthorized/);
    await assert.rejects(connectSocket(srv.baseUrl, "s%3Aforged.sig"), /unauthorized/);
  });

  test("a socket with a session is welcomed as that user", async () => {
    const s = await connectAs(alice);
    assert.deepEqual(await s.welcome, { userId: alice.user.id, username: alice.user.username });
    s.close();
  });
});

describe("quick-match", () => {
  test("pairs two different users with opposite colours in one game", async () => {
    const a = await connectAs(alice);
    const b = await connectAs(bob);
    const waiting = waitFor(a, "lobby:waiting");
    const { gameId, white, black, starts } = await quickMatch(a, b, { tc: "3+0" });
    assert.deepEqual(await waiting, { tc: "3+0", rated: true, variant: "standard" });
    assert.ok(Number.isInteger(gameId));
    assert.notEqual(white, black);
    assert.equal(starts.w.opponent.username, black === a ? alice.user.username : bob.user.username);
    assert.equal(starts.b.opponent.username, white === a ? alice.user.username : bob.user.username);

    const game = db().prepare("SELECT * FROM games WHERE id = ?").get(gameId);
    assert.equal(game.mode, "pvp");
    assert.equal(game.status, "active");
    assert.equal(game.rated, 1);
    assert.equal(game.initial_ms, 180000);
    assert.equal(game.increment_ms, 0);
    assert.equal(game.start_fen, START_FEN);
    assert.equal(game.white_id, white === a ? alice.user.id : bob.user.id);
    assert.equal(game.black_id, black === a ? alice.user.id : bob.user.id);

    // Leave nothing live behind: a player in a game cannot be matched again.
    await emitAck(white, "game:join", { gameId });
    const over = waitFor(white, "game:over");
    white.emit("game:resign", { gameId });
    assert.equal((await over).result, "*", "resigning before any move aborts");
    a.close(); b.close();
  });

  test("never pairs a user with themself", async () => {
    const tab1 = await connectAs(alice);
    const tab2 = await connectAs(alice);
    const none1 = expectNo(tab1, "game:start");
    const none2 = expectNo(tab2, "game:start");
    tab1.emit("lobby:join", { tc: "5+0" });
    tab2.emit("lobby:join", { tc: "5+0" });
    assert.equal(await none1, true);
    assert.equal(await none2, true);
    tab1.emit("lobby:leave"); tab2.emit("lobby:leave");
    tab1.close(); tab2.close();
  });
});

describe("a game", () => {
  let a, b, gameId, white, black, ids;
  before(async () => {
    a = await connectAs(alice);
    b = await connectAs(bob);
    ({ gameId, white, black } = await quickMatch(a, b, { tc: "10+0" }));
    ids = { w: white === a ? alice.user.id : bob.user.id, b: black === a ? alice.user.id : bob.user.id };
  });

  test("joining returns the state; the clock starts once both are in", async () => {
    const first = await emitAck(white, "game:join", { gameId });
    assert.equal(first.ok, true);
    const s = first.state;
    assert.equal(s.gameId, gameId);
    assert.equal(s.fen, START_FEN);
    assert.deepEqual(s.sans, []);
    assert.equal(s.yourColor, "w");
    assert.equal(s.turn, "w");
    assert.equal(s.status, "active");
    assert.equal(s.running, false, "one player in: clock not running");
    assert.deepEqual(s.clocks, { w: 600000, b: 600000 });
    assert.equal(s.rated, true);
    assert.equal(s.whiteId, ids.w);
    assert.equal(s.blackId, ids.b);

    const started = waitFor(white, "clock:started");
    const second = await emitAck(black, "game:join", { gameId });
    assert.equal(second.ok, true);
    assert.equal(second.state.yourColor, "b");
    assert.equal(second.state.running, true);
    assert.ok((await started).clocks.w <= 600000);
  });

  test("a stranger cannot join as a player", async () => {
    const { c } = await registerUser(srv.baseUrl, "carol");
    const s = await connectSocket(srv.baseUrl, c.cookie());
    assert.deepEqual(await emitAck(s, "game:join", { gameId }), { ok: false, error: "You are not a player in this game." });
    assert.deepEqual(await emitAck(s, "game:join", { gameId: 999999 }), { ok: false, error: "Game not found." });
    assert.deepEqual(await emitAck(s, "game:join", {}), { ok: false, error: "Missing gameId." });
    s.close();
  });

  test("out-of-turn, illegal and foreign moves are refused and change nothing", async () => {
    const quietW = expectNo(white, "move:made");
    const quietB = expectNo(black, "move:made");
    assert.deepEqual(await emitAck(black, "move:make", { gameId, ...mv("e7", "e5") }), { ok: false, error: "Not your turn." });
    assert.deepEqual(await emitAck(white, "move:make", { gameId, ...mv("e2", "e5") }), { ok: false, error: "Illegal move." });
    assert.deepEqual(await emitAck(white, "move:make", { gameId, ...mv("e7", "e5") }), { ok: false, error: "Illegal move." });
    assert.deepEqual(await emitAck(white, "move:make", { gameId, from: "e2", to: "e4" }), { ok: false, error: "Illegal move." });
    assert.deepEqual(await emitAck(white, "move:make", { gameId }), { ok: false, error: "Illegal move." });
    assert.deepEqual(await emitAck(white, "move:make", {}), { ok: false, error: "Game not found." });
    const { c } = await registerUser(srv.baseUrl, "mallory");
    const stranger = await connectSocket(srv.baseUrl, c.cookie());
    assert.deepEqual(await emitAck(stranger, "move:make", { gameId, ...mv("e2", "e4") }), { ok: false, error: "You are not a player in this game." });
    stranger.close();
    assert.equal(await quietW, true);
    assert.equal(await quietB, true);
    const state = (await emitAck(white, "game:join", { gameId })).state;
    assert.equal(state.fen, START_FEN);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM moves WHERE game_id = ?").get(gameId).n, 0);
  });

  test("legal moves are confirmed, relayed to both players, and persisted", async () => {
    const onW = waitFor(white, "move:made");
    const onB = waitFor(black, "move:made");
    assert.deepEqual(await emitAck(white, "move:make", { gameId, ...mv("a2", "a3") }), { ok: true });
    const [w, b] = await Promise.all([onW, onB]);
    assert.deepEqual(w, b);
    assert.equal(w.san, "a3");
    assert.equal(w.from, sq("a2"));
    assert.equal(w.to, sq("a3"));
    assert.equal(w.promo, null);
    assert.equal(w.ply, 1);
    assert.equal(w.turn, "b");
    assert.equal(w.fen, "rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1");
    // The snapshot already charges the new side to move for the elapsed time.
    assert.ok(w.clocks.w <= 600000 && w.clocks.w > 590000, `white clock ${w.clocks.w}`);
    assert.ok(w.clocks.b <= 600000 && w.clocks.b > 590000, `black clock ${w.clocks.b}`);

    const reply = waitFor(white, "move:made");
    assert.deepEqual(await emitAck(black, "move:make", { gameId, ...mv("a7", "a6") }), { ok: true });
    assert.equal((await reply).san, "a6");

    const rows = db().prepare("SELECT ply, san, uci, fen_after, by_user, think_ms FROM moves WHERE game_id = ? ORDER BY ply").all(gameId);
    assert.deepEqual(rows.map((r) => [r.ply, r.san, r.uci, r.by_user]), [[1, "a3", "a2a3", ids.w], [2, "a6", "a7a6", ids.b]]);
    assert.ok(rows.every((r) => Number.isInteger(r.think_ms) && r.think_ms >= 0), "server-measured think time");
    const game = db().prepare("SELECT current_fen, turn FROM games WHERE id = ?").get(gameId);
    assert.equal(game.current_fen, rows[1].fen_after);
    assert.equal(game.turn, "w");
  });

  test("a player who reconnects gets the full position back", async () => {
    const again = await connectSocket(srv.baseUrl, (white === a ? alice : bob).c.cookie());
    const { state } = await emitAck(again, "game:join", { gameId });
    assert.deepEqual(state.sans, ["a3", "a6"]);
    assert.deepEqual(state.moves, ["a2a3", "a7a6"], "the record to replay from");
    assert.equal(state.fen, "rnbqkbnr/1ppppppp/p7/8/8/P7/1PPPPPPP/RNBQKBNR w KQkq - 0 2");
    assert.equal(state.yourColor, "w");
    assert.equal(state.running, true);
    again.close();
  });

  test("checkmate ends the game for both, writes the result, and moves the ratings", async () => {
    // After 1.a3 a6 the fool's mate still works: 2.f3 e5 3.g4 Qh4#.
    for (const [socket, from, to] of [[white, "f2", "f3"], [black, "e7", "e5"], [white, "g2", "g4"]]) {
      const seen = waitFor(black, "move:made");
      assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...mv(from, to) }), { ok: true });
      await seen;
    }
    const overW = waitFor(white, "game:over");
    const overB = waitFor(black, "game:over");
    const lastMove = waitFor(white, "move:made");
    const earned = waitFor(black, "achievements:earned");
    assert.deepEqual(await emitAck(black, "move:make", { gameId, ...mv("d8", "h4") }), { ok: true });
    assert.equal((await lastMove).san, "Qh4#");
    const [ow, ob] = await Promise.all([overW, overB]);
    assert.deepEqual(ow, ob);
    assert.equal(ow.result, "0-1");
    assert.equal(ow.termination, "checkmate");
    assert.deepEqual(ow.ratings, {
      w: { id: ids.w, before: 1200, after: 1184, delta: -16 },
      b: { id: ids.b, before: 1200, after: 1216, delta: 16 },
    });
    // Mate came on move 3 (after 1.a3 a6), so not Fool's Mate, but a queen mate and a win.
    const keys = (await earned).list.map((x) => x.key);
    assert.ok(keys.includes("mate_queen") && keys.includes("wins"), `earned ${keys}`);

    const game = db().prepare("SELECT status, result, termination, finished_at FROM games WHERE id = ?").get(gameId);
    assert.equal(game.status, "finished");
    assert.equal(game.result, "0-1");
    assert.equal(game.termination, "checkmate");
    assert.ok(game.finished_at);
    // The lobby's player list carries the new rating straight away, without a reconnect.
    const entered = waitFor(black, "lobby:state");
    black.emit("lobby:enter");
    const lobbyState = await entered;
    assert.equal(lobbyState.players.find((p) => p.userId === ids.b).rating, 1216);
    assert.equal(lobbyState.players.find((p) => p.userId === ids.w).rating, 1184);
    const rating = (id) => db().prepare("SELECT rating FROM users WHERE id = ?").get(id).rating;
    assert.equal(rating(ids.w), 1184);
    assert.equal(rating(ids.b), 1216);
    const history = db().prepare("SELECT user_id, rating_before, rating_after FROM rating_history WHERE game_id = ? ORDER BY user_id").all(gameId);
    assert.deepEqual(history, [
      { user_id: Math.min(ids.w, ids.b), rating_before: 1200, rating_after: ids.w < ids.b ? 1184 : 1216 },
      { user_id: Math.max(ids.w, ids.b), rating_before: 1200, rating_after: ids.w < ids.b ? 1216 : 1184 },
    ]);
    // The loser's own view agrees, over REST.
    const me = await (white === a ? alice : bob).c.get("/api/me");
    assert.equal(me.body.rating, 1184);

    const late = await emitAck(white, "move:make", { gameId, ...mv("a2", "a3") });
    assert.equal(late.ok, false);
    a.close(); b.close();
  });
});

describe("a casual game", () => {
  test("resigning ends it without touching the ratings", async () => {
    const a = await connectAs(alice);
    const b = await connectAs(bob);
    const { gameId, white, black } = await quickMatch(a, b, { tc: "1+0", rated: false });
    const joined = (await emitAck(white, "game:join", { gameId })).state;
    await emitAck(black, "game:join", { gameId });
    assert.equal(joined.rated, false);
    assert.equal(joined.initialMs, 60000);
    const ratingsBefore = db().prepare("SELECT id, rating FROM users WHERE id IN (?, ?) ORDER BY id").all(alice.user.id, bob.user.id);

    // A resignation only counts once a move has been played; before that it
    // is an abort (see socket.hardening.test.js).
    assert.equal((await emitAck(white, "move:make", { gameId, ...mv("e2", "e4") })).ok, true);
    const overB = waitFor(black, "game:over");
    white.emit("game:resign", { gameId });
    const over = await overB;
    assert.equal(over.result, "0-1");
    assert.equal(over.termination, "resign");
    assert.equal(over.ratings, null);
    const game = db().prepare("SELECT status, result, termination, rated FROM games WHERE id = ?").get(gameId);
    assert.deepEqual(game, { status: "finished", result: "0-1", termination: "resign", rated: 0 });
    const ratingsAfter = db().prepare("SELECT id, rating FROM users WHERE id IN (?, ?) ORDER BY id").all(alice.user.id, bob.user.id);
    assert.deepEqual(ratingsAfter, ratingsBefore);
    a.close(); b.close();
  });
});
