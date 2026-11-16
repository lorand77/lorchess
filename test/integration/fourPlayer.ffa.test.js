"use strict";

// A live four-player free-for-all game over the socket (variant
// 'fourplayer_ffa'): the Teams game's room, seats and clocks, with nobody
// partnering anyone. A resignation, a flag or a player gone past the
// reconnect grace puts only that player out: the others play on, the turn
// skips them, and they are free to start another game. So does a mate, on
// the mated player's turn. A player leaving is recorded like a move and the
// game replays from its record after a restart. With two left, a player 21
// points ahead may claim the win; the last player out, or a claim, ends the
// game, each seat's points and place stored, and whoever is first earns the
// badge. LorFish fills seats, claims when it can, and plays on at the quick
// pace once no person is still in.

process.env.GRACE_MS = "400";
process.env.BOT_MAX_DEPTH = "1";   // quick LorFish moves
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db,
} = require("../helpers/server");
const rooms = require("../../src/game/rooms");
const matchmaking = require("../../src/game/matchmaking");
const { FourPlayer } = require("../../src/shared/fourPlayer");
const { position, KINGS } = require("../helpers/fourPlayer");
const queries = require("../../src/db/queries");

const COLORS = FourPlayer.COLORS;
let srv, ai;
const users = [];
before(async () => {
  srv = await startServer();
  for (const name of ["red", "blue", "yellow", "green"]) users.push(await registerUser(srv.baseUrl, name));
  ai = db().prepare("SELECT id, username FROM users WHERE username = ?").get(require("../../src/config").AI_USERNAME);
});
after(async () => {
  await srv.close();
  await require("../../src/game/bots").shutdown();
});

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const seatRows = (id) => Object.fromEntries(db().prepare("SELECT * FROM game_seats WHERE game_id = ?").all(id).map((s) => [s.color, s]));
const uid = (c) => users[COLORS.indexOf(c)].user.id;

// Start a free-for-all game, users 0-3 as Red, Blue, Yellow and Green unless
// `seats` says otherwise; with `fen`, from that position (the room rebuilt
// on it); with `join`, everyone joined.
async function start({ initialMs = 60000, join = true, fen = null, seats = null } = {}) {
  const sockets = await Promise.all(users.map((u) => connectSocket(srv.baseUrl, u.c.cookie())));
  const by = {};
  COLORS.forEach((c, i) => { by[c] = sockets[i]; });
  const who = seats || Object.fromEntries(COLORS.map((c, i) => [c, { userId: users[i].user.id, username: users[i].user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, who, { initialMs, incrementMs: 0, variant: "fourplayer_ffa", botPace: "quick" });
  const g = { gameId, sockets, by, states: {} };
  if (fen) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(fen, fen, gameId);
    forgetRoom(gameId);
  }
  if (join) await joinAll(g, seats ? COLORS.filter((c) => who[c].userId !== ai.id) : COLORS);
  return g;
}
async function joinAll(g, colors = COLORS) {
  for (const c of colors) {
    const joined = await emitAck(g.by[c], "game:join", { gameId: g.gameId });
    assert.equal(joined.ok, true, joined.error);
    g.states[c] = joined.state;
  }
}
const close = (g) => g.sockets.forEach((s) => s.close());
function forgetRoom(gameId) {
  const room = rooms.getRoom(gameId);
  if (!room) return;
  rooms.clearTimers(room);
  rooms.deleteRoom(gameId);
}
// A move from `color`'s socket, resolving with the move:made it hears.
async function play(g, color, from, to, promo) {
  const ply = rooms.getRoom(g.gameId).chess.history.length + 1;
  const seen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no move:made for ply ${ply}`)), 3000);
    const heard = (m) => {
      if (m.ply !== ply) return;
      clearTimeout(timer);
      g.by[color].off("move:made", heard);
      resolve(m);
    };
    g.by[color].on("move:made", heard);
  });
  const res = await emitAck(g.by[color], "move:make", { gameId: g.gameId, from, to, promo });
  assert.deepEqual(res, { ok: true }, `${color} ${from}-${to}`);
  return seen;
}
const ffaFen = (turn, pieces, opts) => position(turn, pieces, Object.assign({ mode: "ffa" }, opts)).fen();

describe("a free-for-all game", () => {
  let g;
  before(async () => { g = await start(); });
  after(() => close(g));

  test("is stored as one casual game of its own variant, with points and nobody out", () => {
    const row = gameRow(g.gameId);
    assert.deepEqual([row.variant, row.white_id, row.black_id, row.rated, row.status], ["fourplayer_ffa", null, null, 0, "active"]);
    assert.deepEqual(g.states.r.points, { r: 0, b: 0, y: 0, g: 0 });
    assert.deepEqual(g.states.r.out, { r: null, b: null, y: null, g: null });
    assert.equal(g.states.r.variant, "fourplayer_ffa");
  });

  test("a resignation puts only that player out: the turn passes them by, and they are free", async () => {
    await play(g, "r", "h2", "h4");
    const outs = COLORS.map((c) => waitFor(g.by[c], "player:out"));
    g.by.b.emit("game:resign", { gameId: g.gameId });
    for (const o of await Promise.all(outs)) {
      assert.deepEqual([o.color, o.how, o.uci, o.san, o.turn, o.ply], ["b", "resign", "resign:b", "Blue resigned", "y", 2]);
    }
    assert.equal(rooms.getRoom(g.gameId).status, "active");
    assert.equal(seatRows(g.gameId).b.eliminated, "resign");
    assert.equal(rooms.liveGameOf(uid("b")), null, "Blue may play another game");
    assert.equal(rooms.liveGameOf(uid("r")), g.gameId);
    const refused = await emitAck(g.by.b, "move:make", { gameId: g.gameId, from: "b8", to: "d8" });
    assert.equal(refused.ok, false);
    // Out once is out: resigning again records nothing.
    const quiet = expectNo(g.by.r, "player:out");
    g.by.b.emit("game:resign", { gameId: g.gameId });
    assert.equal(await quiet, true);
    assert.equal(rooms.getRoom(g.gameId).chess.history.length, 2);
    await play(g, "y", "g13", "g11");
    await play(g, "g", "m10", "k10");
    await play(g, "r", "e2", "e3");
    assert.equal(rooms.getRoom(g.gameId).chess.turn, "y", "Red, then Yellow: Blue is skipped");
  });

  test("after a restart it comes back from its record, the player out included", async () => {
    forgetRoom(g.gameId);
    const back = await emitAck(g.by.r, "game:join", { gameId: g.gameId });
    assert.deepEqual(back.state.moves, ["h2h4", "resign:b", "g13g11", "m10k10", "e2e3"]);
    assert.equal(back.state.sans[1], "Blue resigned");
    assert.deepEqual([back.state.out.b.how, back.state.turn], ["resign", "y"]);
    await joinAll(g, ["y", "g"]);
    await play(g, "y", "g11", "g10");
  });

  test("a player resigning off their turn leaves the turn where it was", async () => {
    const out = waitFor(g.by.r, "player:out");
    g.by.y.emit("game:resign", { gameId: g.gameId });
    assert.equal((await out).turn, "g");
    assert.equal(rooms.getRoom(g.gameId).chess.turn, "g");
  });

  test("the last player out ends it: placings by points, stored per seat, and everyone free", async () => {
    const over = waitFor(g.by.r, "game:over");
    g.by.g.emit("game:resign", { gameId: g.gameId });
    const o = await over;
    assert.deepEqual([o.result, o.termination, o.ratings], ["r=b=y=g", "resign", null]);
    assert.deepEqual(o.standings.map((s) => [s.color, s.points, s.place]), [["r", 0, 1], ["b", 0, 1], ["y", 0, 1], ["g", 0, 1]]);
    assert.deepEqual([gameRow(g.gameId).status, gameRow(g.gameId).result], ["finished", "r=b=y=g"]);
    const seats = seatRows(g.gameId);
    assert.deepEqual(COLORS.map((c) => [seats[c].eliminated, seats[c].points, seats[c].place]),
      [[null, 0, 1], ["resign", 0, 1], ["resign", 0, 1], ["resign", 0, 1]]);
    for (const c of COLORS) assert.equal(rooms.liveGameOf(uid(c)), null);
  });

  test("its record has the players leaving and each seat's place", async () => {
    const mine = (await users[0].c.get("/api/games")).body.find((x) => x.id === g.gameId);
    assert.equal(mine.seat, "r");
    assert.deepEqual(mine.seats.b, { id: uid("b"), username: users[1].user.username, bot: false, eliminated: "resign", points: 0, place: 1 });
    const replay = await users[3].c.get(`/api/games/${g.gameId}`);
    assert.deepEqual(replay.body.moves.map((m) => m.uci),
      ["h2h4", "resign:b", "g13g11", "m10k10", "e2e3", "g11g10", "resign:y", "resign:g"]);
    assert.equal(replay.body.moves[1].by_user, null, "a player leaving is no move of theirs");
  });
});

describe("a free-for-all game with a mate", () => {
  test("puts the mated player out on their turn, 20 points to the mater, and plays on", async () => {
    // Red's rook will check Green's king down the n-file, its pawns in its way.
    const fen = ffaFen("r", { ...KINGS, m7: "gP", m8: "gP", m9: "gP", n7: "gP", e11: "rR" });
    const g = await start({ fen });
    await play(g, "r", "e11", "n11");
    await play(g, "b", "a7", "a6");
    const mated = await play(g, "y", "g14", "f14");
    assert.equal(mated.turn, "r", "Green is out: Red is next");
    const room = rooms.getRoom(g.gameId);
    assert.deepEqual([room.status, room.chess.points.r, room.chess.out.g], ["active", 20, { how: "checkmate", by: "r" }]);
    assert.equal(seatRows(g.gameId).g.eliminated, "checkmate");
    assert.equal(rooms.liveGameOf(uid("g")), null);
    // Red resigns: Red's rook is dead, Blue and Yellow have bare kings, and
    // the game is drawn, 10 points to each still in.
    const over = waitFor(g.by.y, "game:over");
    g.by.r.emit("game:resign", { gameId: g.gameId });
    const o = await over;
    assert.deepEqual([o.result, o.termination], ["r,b=y,g", "insufficient"]);
    assert.deepEqual(o.standings.map((s) => s.points), [20, 10, 10, 0]);
    close(g);
  });
});

describe("a free-for-all game on the clock", () => {
  test("each flag puts that player out, and the clocks run on for the rest", async () => {
    const g = await start({ initialMs: 700 });
    await play(g, "r", "h2", "h4");
    const outs = [];
    g.by.r.on("player:out", (o) => outs.push(o));
    const o = await waitFor(g.by.r, "game:over", 4000);   // nobody else moves
    assert.deepEqual(outs.map((x) => [x.color, x.how]), [["b", "timeout"], ["y", "timeout"], ["g", "timeout"]]);
    assert.deepEqual([o.result, o.termination], ["r=b=y=g", "timeout"]);
    const seats = seatRows(g.gameId);
    for (const c of ["b", "y", "g"]) assert.deepEqual([seats[c].clock_ms, seats[c].eliminated], [0, "timeout"], c);
    assert.ok(seats.r.clock_ms > 0);
    close(g);
  });
});

describe("a free-for-all game a player leaves", () => {
  test("puts them out once the grace runs out, and the others play on", async () => {
    const g = await start();
    await play(g, "r", "h2", "h4");
    await play(g, "b", "b8", "d8");
    const out = waitFor(g.by.r, "player:out", 3000);
    g.by.y.close();
    const o = await out;
    assert.deepEqual([o.color, o.how, o.turn], ["y", "disconnect", "g"]);
    assert.equal(rooms.getRoom(g.gameId).status, "active");
    await play(g, "g", "m10", "k10");
    for (const c of ["r", "b", "g"]) g.by[c].emit("game:resign", { gameId: g.gameId });
    await waitFor(g.by.r, "game:over");
    close(g);
  });
});

describe("claiming the win", () => {
  test("only with two left and 21 points ahead: the game ends, the other gets 20, the first earns the badge", async () => {
    const fen = ffaFen("b", { ...KINGS, d4: "rR", k12: "bR" }, { out: "yg", points: { r: 30, b: 9 } });
    const g = await start({ fen });
    const wins = (c) => (queries.achievementWinsByVariant.all({ me: uid(c) }).find((r) => r.variant === "fourplayer_ffa") || { n: 0 }).n;
    const before = { r: wins("r"), b: wins("b") };
    const early = await emitAck(g.by.b, "four:claim", { gameId: g.gameId });
    assert.deepEqual(early, { ok: false, error: "You can't claim the win now." });
    const outsider = await emitAck(g.by.y, "four:claim", { gameId: 999999 });
    assert.equal(outsider.ok, false);
    const over = waitFor(g.by.b, "game:over");
    assert.deepEqual(await emitAck(g.by.r, "four:claim", { gameId: g.gameId }), { ok: true });
    const o = await over;
    assert.deepEqual([o.result, o.termination], ["r,b,y=g", "claim"]);
    const seats = seatRows(g.gameId);
    assert.deepEqual(COLORS.map((c) => [seats[c].points, seats[c].place]), [[30, 1], [29, 2], [0, 3], [0, 3]]);
    assert.equal(seats.r.eliminated, "claim");
    assert.deepEqual([wins("r"), wins("b")], [before.r + 1, before.b], "a win for first place only");
    const badge = db().prepare("SELECT 1 FROM user_achievements WHERE user_id = ? AND key = 'fourplayer_ffa_wins'").get(uid("r"));
    assert.ok(badge);
    close(g);
  });
});

describe("LorFish in a free-for-all game", () => {
  const bot = () => ({ userId: ai.id, username: ai.username });
  const me = () => ({ userId: users[0].user.id, username: users[0].user.username });

  test("claims the win the moment it may", async () => {
    const fen = ffaFen("b", { ...KINGS, d4: "rR", k12: "bR" }, { out: "yg", points: { b: 30 } });
    const g = await start({ fen, seats: { r: me(), b: bot(), y: bot(), g: bot() }, join: false });
    const over = waitFor(g.by.r, "game:over", 5000);
    await joinAll(g, ["r"]);   // the clocks start, Blue to move
    const o = await over;
    assert.deepEqual([o.result, o.termination], ["b,r,y=g", "claim"]);
    close(g);
  });

  test("from \"Play the computer\": three LorFish, which play on at the quick pace once the person is out", async () => {
    const s = await connectSocket(srv.baseUrl, users[0].c.cookie());
    const res = await emitAck(s, "fourplayer:bots", { variant: "fourplayer_ffa", tc: "5+0", pace: "normal" });
    assert.equal(res.ok, true, res.error);
    assert.equal(gameRow(res.gameId).variant, "fourplayer_ffa");
    await emitAck(s, "game:join", { gameId: res.gameId });
    await emitAck(s, "move:make", { gameId: res.gameId, from: "h2", to: "h4" });
    // Blue has its move and holds it, at the normal pace, for seconds (an
    // even share of 5 minutes); Red resigns meanwhile, and Blue plays at once.
    const room = rooms.getRoom(res.gameId);
    const until0 = Date.now() + 3000;
    while (!room.botTimer && Date.now() < until0) await new Promise((r) => setTimeout(r, 20));
    assert.ok(room.botTimer, "Blue holding its move");
    const out = waitFor(s, "player:out");
    const blue = new Promise((resolve) => s.on("move:made", (m) => { if (m.ply === 3) resolve(Date.now()); }));
    const resigned = Date.now();
    s.emit("game:resign", { gameId: res.gameId });
    await out;
    assert.equal(rooms.liveGameOf(users[0].user.id), null);
    assert.ok((await blue) - resigned < 1000, "played at once");
    const until = Date.now() + 8000;
    while (room.chess.history.length < 8 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(room.chess.history.length >= 8, `${room.chess.history.length} plies`);
    forgetRoom(res.gameId);
    s.close();
  });
});

describe("a free-for-all table", () => {
  test("opens with its host in Red and starts a free-for-all game", async () => {
    const s = await connectSocket(srv.baseUrl, users[1].c.cookie());
    const state = waitFor(s, "lobby:state");
    s.emit("lobby:enter");
    await state;
    const started = waitFor(s, "game:start");
    const opened = waitFor(s, "lobby:state");
    s.emit("table:create", { variant: "fourplayer_ffa", tc: "5+0", level: "beginner", pace: "quick" });
    const mine = (await opened).tables.find((t) => t.hostId === users[1].user.id);
    assert.deepEqual([mine.variant, Object.keys(mine.seats)], ["fourplayer_ffa", ["r", "b", "y", "g"]]);
    s.emit("table:start", { id: mine.id });
    const st = await started;
    assert.equal(st.color, "r");
    assert.equal(gameRow(st.gameId).variant, "fourplayer_ffa");
    forgetRoom(st.gameId);
    s.close();
  });
});
