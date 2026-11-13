"use strict";

// A live Bughouse match over the socket: two boards, four players, run by two
// rooms that know each other. A capture on one board arrives in the partner's
// pocket on the other, to be dropped; both boards' clocks start together once
// all four have joined; whatever ends one board — a mate, a resignation, a
// flag, a player who never comes — ends the match for both, the team that won
// there winning both boards; a restart rebuilds both boards from the match's
// moves, captures passed again in order. Always casual, no draws, no rematch.

process.env.GRACE_MS = "400";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");
const rooms = require("../../src/game/rooms");
const matchmaking = require("../../src/game/matchmaking");
const matches = require("../../src/game/matches");

let srv;
const users = [];
before(async () => {
  srv = await startServer();
  for (const name of ["a0", "a1", "b0", "b1"]) users.push(await registerUser(srv.baseUrl, name));
});
after(async () => { await srv.close(); });

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const matchRow = (id) => db().prepare("SELECT * FROM matches WHERE id = ?").get(id);
const step = (text) => (text.includes("@")
  ? { drop: text[0].toLowerCase(), to: sq(text.slice(2, 4)) }
  : { from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)), promo: text[4] || null });

// Start a match: team A is users 0 and 1, team B users 2 and 3, each
// [board 0, board 1]. So board 0 is a0 (White) v b0, board 1 is b1 (White) v
// a1. Returns the sockets by seat, every game:start, and the join states.
async function startMatch({ initialMs = 60000, incrementMs = 0, join = true } = {}) {
  const sockets = await Promise.all(users.map((u) => connectSocket(srv.baseUrl, u.c.cookie())));
  const starts = sockets.map((s) => waitFor(s, "game:start"));
  const seat = (i) => ({ userId: users[i].user.id, username: users[i].user.username });
  const { matchId, boards } = matchmaking.startBughouse(srv.io,
    { teamA: [seat(0), seat(1)], teamB: [seat(2), seat(3)] }, { initialMs, incrementMs });
  const started = await Promise.all(starts);
  const [a0, a1, b0, b1] = sockets;
  const m = { matchId, boards, started, sockets, w0: a0, b0, w1: b1, b1: a1, states: [] };
  if (join) {
    for (const [s, board] of [[a0, 0], [b0, 0], [b1, 1], [a1, 1]]) {
      const joined = await emitAck(s, "game:join", { gameId: boards[board] });
      assert.equal(joined.ok, true, joined.error);
      m.states.push(joined.state);
    }
  }
  return m;
}
const close = (m) => m.sockets.forEach((s) => s.close());

// Play a move on a board, from its player's socket, and return what the
// opponent saw.
async function play(m, board, color, text) {
  const mover = m[`${color}${board}`];
  const opponent = m[`${color === "w" ? "b" : "w"}${board}`];
  const seen = waitFor(opponent, "move:made");
  const res = await emitAck(mover, "move:make", { gameId: m.boards[board], ...step(text) });
  assert.deepEqual(res, { ok: true }, `${text} on board ${board}`);
  return seen;
}

describe("a Bughouse match", () => {
  let m;
  before(async () => { m = await startMatch({ join: false }); });
  after(() => close(m));

  test("each player is sent their board, colour, opponent and partner", () => {
    const [a0, a1, b0, b1] = m.started;
    const name = (i) => users[i].user.username;
    assert.deepEqual([a0.gameId, a0.color, a0.board, a0.opponent.username, a0.partner.username],
      [m.boards[0], "w", 0, name(2), name(1)]);
    assert.deepEqual([a1.gameId, a1.color, a1.board, a1.partner.username], [m.boards[1], "b", 1, name(0)]);
    assert.deepEqual([b0.color, b0.board, b1.color, b1.board], ["b", 0, "w", 1]);
    assert.ok(m.started.every((s) => s.matchId === m.matchId));
  });

  test("the clocks wait for all four, then both boards start together", async () => {
    const first = await emitAck(m.w0, "game:join", { gameId: m.boards[0] });
    assert.equal(first.state.variant, "bughouse");
    assert.equal(first.state.rated, false);
    assert.deepEqual(first.state.match, { id: m.matchId, board: 0, boards: m.boards, team: "A" });
    await emitAck(m.b0, "game:join", { gameId: m.boards[0] });
    await emitAck(m.w1, "game:join", { gameId: m.boards[1] });
    // Board 0 has both its players, but board 1 is still a player short.
    assert.equal(rooms.getRoom(m.boards[0]).started, false);
    const zero = waitFor(m.w0, "clock:started");
    const one = waitFor(m.w1, "clock:started");
    await emitAck(m.b1, "game:join", { gameId: m.boards[1] });
    await Promise.all([zero, one]);
    assert.ok([0, 1].every((b) => rooms.getRoom(m.boards[b]).started));
  });

  test("a capture on one board arrives on the other, where the partner drops it", async () => {
    await play(m, 0, "w", "e2e4");
    await play(m, 0, "b", "d7d5");
    const arrived = waitFor(m.b1, "bughouse:received");
    const took = await play(m, 0, "w", "e4d5");
    assert.deepEqual(took.passed, { t: "p", c: "b" }, "a black pawn, for A's Black on board 1");
    const got = await arrived;
    assert.deepEqual(got.piece, { t: "p", c: "b" });
    assert.match(got.fen, /\[p\]/);
    assert.match(gameRow(m.boards[1]).current_fen, /\[p\]/, "the other board's shown position too");
    await play(m, 1, "w", "g1f3");
    // A drop of a piece not in hand is refused; the pawn that arrived is not.
    assert.deepEqual(await emitAck(m.b1, "move:make", { gameId: m.boards[1], ...step("N@e5") }),
      { ok: false, error: "Illegal move." });
    const dropped = await play(m, 1, "b", "P@e5");
    assert.equal(dropped.san, "P@e5");
    assert.equal(dropped.passed, null);
  });

  test("draw offers go nowhere in Bughouse", async () => {
    const silent = expectNo(m.b0, "draw:offered");
    m.w0.emit("draw:offer", { gameId: m.boards[0] });
    await silent;
  });

  test("a resignation loses the match, both boards, for the resigning team", async () => {
    const overs = m.sockets.map((s) => waitFor(s, "game:over"));
    m.w1.emit("game:resign", { gameId: m.boards[1] });   // b1, team B
    const [a0, a1, b0, b1] = await Promise.all(overs);
    for (const over of [a0, a1, b0, b1]) {
      assert.deepEqual(over.match, { id: m.matchId, result: "A", termination: "resign", decidedOn: 1 });
      assert.equal(over.ratings, null);
    }
    assert.deepEqual([a0.result, a0.termination], ["1-0", matches.OTHER_BOARD], "A's White wins board 0");
    assert.deepEqual([b1.result, b1.termination], ["0-1", "resign"], "A's Black wins board 1");
    assert.deepEqual([matchRow(m.matchId).status, matchRow(m.matchId).result], ["finished", "A"]);
    assert.deepEqual(m.boards.map((id) => gameRow(id).result), ["1-0", "0-1"]);
    assert.ok(m.boards.every((id) => !rooms.getRoom(id)), "both rooms are gone");
  });
});

describe("a Bughouse match decided by mate, after a restart", () => {
  // Board 1 rewritten before a move is played, and both rooms forgotten as a
  // restart would: Black (A's a1) has Nf2, smothered mate on White's king.
  const SMOTHER = "7k/8/8/8/4n3/8/6PP/6RK b - - 0 1";
  let m;
  before(async () => {
    m = await startMatch({ join: false });
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(SMOTHER, SMOTHER, m.boards[1]);
    for (const id of m.boards) { rooms.clearTimers(rooms.getRoom(id)); rooms.deleteRoom(id); }
  });
  after(() => close(m));

  test("both boards come back together, and a mate on one ends both", async () => {
    const joined = await emitAck(m.b1, "game:join", { gameId: m.boards[1] });
    assert.equal(joined.ok, true);
    assert.equal(joined.state.fen, "7k/8/8/8/4n3/8/6PP/6RK[] b - - 0 1");
    assert.ok(rooms.getRoom(m.boards[0]), "the partner board was rebuilt with it");
    for (const [s, b] of [[m.w1, 1], [m.w0, 0], [m.b0, 0]]) await emitAck(s, "game:join", { gameId: m.boards[b] });
    const overs = m.sockets.map((s) => waitFor(s, "game:over"));
    const mate = await play(m, 1, "b", "e4f2");
    assert.equal(mate.san, "Nf2#");
    const [a0, , , b1] = await Promise.all(overs);
    assert.deepEqual(a0.match.result, "A");
    assert.deepEqual([b1.result, b1.termination], ["0-1", "checkmate"]);
    assert.deepEqual([a0.result, a0.termination], ["1-0", matches.OTHER_BOARD]);
    assert.equal(matchRow(m.matchId).termination, "checkmate");
    assert.equal(matchRow(m.matchId).decided_on, 1);
  });
});

describe("a Bughouse match rebuilt mid-game", () => {
  let m;
  before(async () => { m = await startMatch(); });
  after(() => close(m));

  test("replays both boards in order, the passed piece still in hand", async () => {
    await play(m, 0, "w", "e2e4");
    await play(m, 0, "b", "d7d5");
    await play(m, 0, "w", "e4d5");
    for (const id of m.boards) { rooms.clearTimers(rooms.getRoom(id)); rooms.deleteRoom(id); }
    const joined = await emitAck(m.b1, "game:join", { gameId: m.boards[1] });
    assert.equal(joined.state.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[p] w KQkq - 0 1");
    assert.deepEqual(rooms.getRoom(m.boards[0]).sans, ["e4", "d5", "exd5"]);
    // The partner board's players are on the absence clock too.
    assert.ok(rooms.getRoom(m.boards[0]).timers.w, "board 0's White hasn't come back yet");
  });
});

describe("a Bughouse match decided on the clock", () => {
  let m;
  before(async () => { m = await startMatch({ initialMs: 1500, incrementMs: 1000 }); });
  after(() => close(m));

  test("the first flag on either board ends the match for both", async () => {
    // Board 1 keeps moving, earning increments; board 0's White never moves.
    await play(m, 1, "w", "g1f3");
    await play(m, 1, "b", "g8f6");
    const overs = m.sockets.map((s) => waitFor(s, "game:over", 4000));
    const [a0, , b0] = await Promise.all(overs);
    assert.deepEqual([a0.result, a0.termination], ["0-1", "timeout"]);
    assert.equal(b0.match.result, "B");
    assert.equal(matchRow(m.matchId).decided_on, 0);
  });
});

describe("a Bughouse match a player never joins", () => {
  let m;
  before(async () => { m = await startMatch({ join: false }); });
  after(() => close(m));

  test("is aborted, both boards", async () => {
    for (const [s, b] of [[m.w0, 0], [m.b0, 0], [m.w1, 1]]) await emitAck(s, "game:join", { gameId: m.boards[b] });
    const over = await waitFor(m.w0, "game:over", 3000);
    assert.equal(over.result, "*");
    assert.equal(matchRow(m.matchId).status, "aborted");
    assert.deepEqual(m.boards.map((id) => gameRow(id).status), ["aborted", "aborted"]);
  });
});

describe("a Bughouse match one board has moved in", () => {
  let m;
  before(async () => { m = await startMatch(); });
  after(() => close(m));

  test("has been played: resigning on the board nobody moved on loses, not aborts", async () => {
    await play(m, 0, "w", "e2e4");
    const over = waitFor(m.w1, "game:over");
    m.w1.emit("game:resign", { gameId: m.boards[1] });
    const end = await over;
    assert.deepEqual([end.result, end.termination], ["0-1", "resign"]);
    assert.equal(matchRow(m.matchId).result, "A");
  });

  test("rejoined once it is over, its final state comes back and no room stays behind", async () => {
    const joined = await emitAck(m.w0, "game:join", { gameId: m.boards[0] });
    assert.equal(joined.ok, true);
    assert.deepEqual([joined.state.status, joined.state.result], ["finished", "1-0"]);
    assert.ok(m.boards.every((id) => !rooms.getRoom(id)), "neither board is left in memory");
  });
});

describe("a Bughouse match nobody comes back to after a restart", () => {
  test("is aborted whole by the resume sweep", async () => {
    const m = await startMatch({ join: false });
    for (const id of m.boards) { rooms.clearTimers(rooms.getRoom(id)); rooms.deleteRoom(id); }
    rooms.sweepUnresumed();
    assert.equal(matchRow(m.matchId).status, "aborted");
    assert.deepEqual(m.boards.map((id) => [gameRow(id).status, gameRow(id).termination]),
      [["aborted", "server-restart"], ["aborted", "server-restart"]]);
    close(m);
  });
});

describe("a Bughouse match whose record won't replay", () => {
  test("is aborted whole when a player comes back to it", async () => {
    const m = await startMatch({ join: false });
    for (const id of m.boards) { rooms.clearTimers(rooms.getRoom(id)); rooms.deleteRoom(id); }
    // A drop on board 1 with nothing ever captured on board 0 to supply it.
    db().prepare("INSERT INTO moves (game_id, ply, san, uci, fen_after) VALUES (?, 1, 'P@e4', 'P@e4', '-')").run(m.boards[1]);
    const joined = await emitAck(m.w1, "game:join", { gameId: m.boards[1] });
    assert.deepEqual(joined, { ok: false, error: "This game's record could not be replayed, so it was aborted." });
    assert.equal(matchRow(m.matchId).status, "aborted");
    assert.deepEqual(m.boards.map((id) => gameRow(id).termination), ["corrupt-record", "corrupt-record"]);
    assert.ok(m.boards.every((id) => !rooms.getRoom(id)));
    close(m);
  });
});

describe("Bughouse is never a two-player game", () => {
  test("quick match, seeks and challenges refuse it", async () => {
    const s = await connectSocket(srv.baseUrl, users[0].c.cookie());
    const refused = waitFor(s, "lobby:error");
    s.emit("lobby:join", { variant: "bughouse" });
    assert.match((await refused).error, /two teams of two/);
    const seekRefused = waitFor(s, "lobby:error");
    s.emit("seek:create", { variant: "bughouse" });
    assert.match((await seekRefused).error, /two teams of two/);
    assert.throws(() => matchmaking.startMatch(srv.io, { userId: 1 }, { userId: 2 }, { variant: "bughouse" }), /team game/);
    s.close();
  });
});

describe("the other board, as each player sees it", () => {
  let m;
  before(async () => { m = await startMatch(); });
  after(() => close(m));

  test("comes with the join, and follows every move and every piece passed", async () => {
    const view = m.states[0].partner;   // a0's view of board 1
    assert.deepEqual([view.gameId, view.board, view.turn, view.lastMove, view.san],
      [m.boards[1], 1, "w", null, null]);
    assert.deepEqual([view.white, view.black], [users[3].user.username, users[1].user.username]);
    const seen = waitFor(m.b1, "bughouse:partner");   // a1, on board 1, watches board 0
    await play(m, 0, "w", "e2e4");
    const after = await seen;
    assert.deepEqual([after.board, after.san, after.turn, after.lastMove], [0, "e4", "b", { from: sq("e2"), to: sq("e4") }]);
    await play(m, 0, "b", "d7d5");
    // A capture on board 0 fills a pocket on board 1: board 0's players see it.
    const pocketed = waitFor(m.w0, "bughouse:partner");
    await play(m, 0, "w", "e4d5");
    assert.match((await pocketed).fen, /\[p\]/);
  });

  test("a call reaches the partner alone, and only a known one", async () => {
    const heard = waitFor(m.b1, "bughouse:call");   // a1, a0's partner
    const opponents = [expectNo(m.b0, "bughouse:call"), expectNo(m.w1, "bughouse:call")];
    assert.deepEqual(await emitAck(m.w0, "bughouse:call", { gameId: m.boards[0], call: "need-n" }), { ok: true });
    assert.deepEqual(await heard, { gameId: m.boards[1], from: users[0].user.username, call: "need-n" });
    await Promise.all(opponents);
    assert.deepEqual(await emitAck(m.w0, "bughouse:call", { gameId: m.boards[0], call: "resign now" }), { ok: false, error: "Unknown call." });
    assert.deepEqual(await emitAck(m.w0, "bughouse:call", { gameId: m.boards[1], call: "go" }),
      { ok: false, error: "You are not a player in this game." }, "only from your own board");
  });

  test("calls are rate-limited like chat, and need a live match", async () => {
    const replies = [];
    for (let i = 0; i < 6; i++) replies.push(await emitAck(m.b0, "bughouse:call", { gameId: m.boards[0], call: "go" }));
    assert.deepEqual(replies.at(-1), { ok: false, error: "Slow down a little." });
    assert.ok(replies.slice(0, 5).every((r) => r.ok));
    assert.deepEqual(await emitAck(m.b0, "bughouse:call", { gameId: 999999, call: "go" }), { ok: false, error: "No match to call in." });
  });
});
