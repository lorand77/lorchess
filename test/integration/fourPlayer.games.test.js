"use strict";

// A live four-player game (Teams) over the socket: one room, four seats, Red
// and Yellow against Blue and Green. Each player is sent their colour; the
// clocks wait for all four, then run one at a time in turn order; moves are
// the engine's and only on your turn; a mate counts on the mated player's
// turn; a resignation, a flag or a player who never comes back loses for the
// team; a game nobody moved in aborts; a restart rebuilds the room from the
// moves and the seats' clocks. Casual, no draws, no rematch; one game at a
// time holds for all four.

process.env.GRACE_MS = "400";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db,
} = require("../helpers/server");
const rooms = require("../../src/game/rooms");
const matchmaking = require("../../src/game/matchmaking");
const { FourPlayer } = require("../../src/shared/fourPlayer");

const COLORS = FourPlayer.COLORS;
const sq = FourPlayer.squareOf;
let srv, outsider;
const users = [];
before(async () => {
  srv = await startServer();
  for (const name of ["red", "blue", "yellow", "green"]) users.push(await registerUser(srv.baseUrl, name));
  outsider = await registerUser(srv.baseUrl, "watcher");
});
after(async () => { await srv.close(); });

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const seatRows = (id) => db().prepare("SELECT color, user_id, clock_ms FROM game_seats WHERE game_id = ? ORDER BY color").all(id);

// Start a game with users 0-3 as Red, Blue, Yellow and Green. Returns the
// game id, the sockets by colour, every game:start and (with `join`) the join
// states by colour.
async function start({ initialMs = 60000, incrementMs = 0, join = true } = {}) {
  const sockets = await Promise.all(users.map((u) => connectSocket(srv.baseUrl, u.c.cookie())));
  const starts = sockets.map((s) => waitFor(s, "game:start"));
  const seats = Object.fromEntries(COLORS.map((c, i) => [c, { userId: users[i].user.id, username: users[i].user.username }]));
  const gameId = matchmaking.startFourPlayer(srv.io, seats, { initialMs, incrementMs });
  const g = { gameId, started: await Promise.all(starts), sockets, by: {}, states: {} };
  COLORS.forEach((c, i) => { g.by[c] = sockets[i]; });
  if (join) await joinAll(g);
  return g;
}
async function joinAll(g) {
  for (const c of COLORS) {
    const joined = await emitAck(g.by[c], "game:join", { gameId: g.gameId });
    assert.equal(joined.ok, true, joined.error);
    g.states[c] = joined.state;
  }
}
const close = (g) => g.sockets.forEach((s) => s.close());

// A move from `color`'s socket; returns the move:made everyone is sent, as
// the mover hears it. Picked by its ply: the previous move's may still be on
// its way to this socket.
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
// One quiet move each, in turn, from the start: a pawn step two squares.
// (Not Green's m7: Red's h2-h4 opens the g1 queen's diagonal, pinning it.)
const OPENING = { r: ["h2", "h4"], b: ["b8", "d8"], y: ["g13", "g11"], g: ["m10", "k10"] };

// A FEN4 from a map of squares to pieces ({ h1: "rK", ... }), no castling.
function fen4(turn, pieces) {
  const rows = [];
  for (let y = 13; y >= 0; y--) {
    const cells = [];
    let empty = 0;
    for (let x = 0; x < 14; x++) {
      const piece = pieces[String.fromCharCode(97 + x) + (y + 1)];
      if (!piece) { empty++; continue; }
      if (empty) cells.push(String(empty));
      empty = 0;
      cells.push(piece);
    }
    if (empty) cells.push(String(empty));
    rows.push(cells.join(","));
  }
  return `${turn.toUpperCase()}-0,0,0,0-0,0,0,0-0,0,0,0-0,0,0,0-0-${rows.join("/")}`;
}

// As the restart tests need: forget the room, so the next join rebuilds it.
function forgetRoom(gameId) {
  const room = rooms.getRoom(gameId);
  rooms.clearTimers(room);
  rooms.deleteRoom(gameId);
}

describe("a four-player game", () => {
  let g;
  before(async () => { g = await start({ join: false }); });
  after(() => close(g));

  test("each player is sent their colour and the four names", () => {
    const names = Object.fromEntries(COLORS.map((c, i) => [c, users[i].user.username]));
    g.started.forEach((s, i) => assert.deepEqual(s, { gameId: g.gameId, color: COLORS[i], players: names }));
  });

  test("is stored as one casual game with four seats and no white or black", () => {
    const row = gameRow(g.gameId);
    assert.deepEqual([row.variant, row.white_id, row.black_id, row.rated, row.turn, row.status],
      ["fourplayer", null, null, 0, "w", "active"]);
    assert.equal(row.start_fen, new FourPlayer().fen());
    assert.deepEqual(seatRows(g.gameId).map((s) => [s.color, s.user_id]).sort(),
      COLORS.map((c, i) => [c, users[i].user.id]).sort());
  });

  test("all four are in a game: no second one, and the lobby shows them playing", async () => {
    for (const u of users) assert.equal(rooms.liveGameOf(u.user.id), g.gameId);
    const refused = waitFor(g.by.y, "lobby:error");
    g.by.y.emit("lobby:join", {});
    assert.equal((await refused).error, "Finish your current game first.");
    const state = waitFor(g.by.g, "lobby:state");
    g.by.g.emit("lobby:enter");
    const lobby = await state;
    for (const u of users) {
      const p = lobby.players.find((x) => x.userId === u.user.id);
      assert.deepEqual([p.playing, p.gameId], [true, g.gameId], u.user.username);
    }
    assert.ok(!lobby.games.some((x) => x.gameId === g.gameId), "not in the two-player live list");
  });

  test("only its players may join; the clocks wait for all four", async () => {
    const stranger = await connectSocket(srv.baseUrl, outsider.c.cookie());
    assert.deepEqual(await emitAck(stranger, "game:join", { gameId: g.gameId }),
      { ok: false, error: "You are not a player in this game." });
    stranger.close();
    for (const c of ["r", "b", "y"]) await emitAck(g.by[c], "game:join", { gameId: g.gameId });
    assert.equal(rooms.getRoom(g.gameId).started, false);
    const running = waitFor(g.by.r, "clock:started");
    const joined = await emitAck(g.by.g, "game:join", { gameId: g.gameId });
    const { clocks } = await running;
    assert.deepEqual(Object.keys(clocks), COLORS);
    const s = joined.state;
    assert.deepEqual([s.yourColor, s.turn, s.variant, s.rated, s.fen], ["g", "r", "fourplayer", false, new FourPlayer().fen()]);
    assert.deepEqual(Object.keys(s.seats), COLORS);
    assert.deepEqual(s.seats.y, { id: users[2].user.id, name: users[2].user.username, member: false });
    assert.equal(s.white, undefined);
  });

  test("moves go round in turn, by square number or name; the server stores them", async () => {
    assert.deepEqual(await emitAck(g.by.b, "move:make", { gameId: g.gameId, from: "b7", to: "c7" }),
      { ok: false, error: "Not your turn." });
    const seen = await play(g, "r", sq("e2"), sq("e4"));
    assert.deepEqual([seen.from, seen.to, seen.san, seen.turn, seen.ply], [sq("e2"), sq("e4"), "e2-e4", "b", 1]);
    assert.deepEqual(Object.keys(seen.clocks), COLORS);
    const named = await play(g, "b", "b7", "c7");
    assert.deepEqual([named.from, named.to], [sq("b7"), sq("c7")], "the engine's numbers, whatever was sent");
    const row = gameRow(g.gameId);
    assert.equal(row.turn, "w", "Yellow to move: Red and Yellow's side");
    assert.match(row.current_fen, /^Y-/);
    const moves = db().prepare("SELECT ply, uci, san, by_user FROM moves WHERE game_id = ? ORDER BY ply").all(g.gameId);
    assert.deepEqual(moves.map((m) => [m.ply, m.uci, m.san, m.by_user]),
      [[1, "e2e4", "e2-e4", users[0].user.id], [2, "b7c7", "b7-c7", users[1].user.id]]);
    assert.ok(seatRows(g.gameId).every((s) => Number.isInteger(s.clock_ms)), "every seat's clock written");
  });

  test("its record is its four players' while it lasts, with the seats", async () => {
    const yellow = await users[2].c.get(`/api/games/${g.gameId}`);
    assert.equal(yellow.status, 200);
    assert.equal(yellow.body.variant, "fourplayer");
    assert.deepEqual(yellow.body.seats, Object.fromEntries(COLORS.map((c, i) => [c, { id: users[i].user.id, username: users[i].user.username }])));
    assert.equal((await outsider.c.get(`/api/games/${g.gameId}`)).status, 403);
  });

  test("anything but a legal move of the right shape is refused", async () => {
    const bad = [
      { from: sq("g13"), to: sq("g13") },
      { from: "a1", to: "a2" },                      // a corner
      { from: 0, to: 1 },                            // a corner's numbers
      { from: { x: 6, y: 12 }, to: { x: 6, y: 11 } },
      { from: sq("g13"), to: sq("g12"), promo: "k" },
      { drop: "p", to: sq("g12") },
      { from: "g13", to: "g12", drop: "p" },
      {},
    ];
    for (const move of bad) {
      assert.deepEqual(await emitAck(g.by.y, "move:make", { gameId: g.gameId, ...move }),
        { ok: false, error: "Illegal move." }, JSON.stringify(move));
    }
  });

  test("players' chat reaches all four, as their team's side; a watcher hears none of it", async () => {
    const watcher = await connectSocket(srv.baseUrl, outsider.c.cookie());
    const watching = await emitAck(watcher, "game:watch", { gameId: g.gameId });
    assert.equal(watching.ok, true);
    assert.equal(watching.state.yourColor, null);
    assert.equal(watching.state.seats.r.name, users[0].user.username);
    const heard = COLORS.map((c) => waitFor(g.by[c], "chat:message"));
    const unheard = expectNo(watcher, "chat:message");
    assert.deepEqual(await emitAck(g.by.y, "chat:send", { gameId: g.gameId, text: "go left" }), { ok: true });
    for (const msg of await Promise.all(heard)) assert.deepEqual([msg.text, msg.role], ["go left", "w"]);
    assert.equal(await unheard, true);
    const stored = db().prepare("SELECT role FROM chat_messages WHERE game_id = ?").get(g.gameId);
    assert.equal(stored.role, "w", "Yellow speaks for Red and Yellow");
    watcher.close();
  });

  test("no draw offers and no rematch offers", async () => {
    const quiet = expectNo(g.by.b, "draw:offered");
    g.by.y.emit("draw:offer", { gameId: g.gameId });
    assert.equal(await quiet, true);
    assert.equal(rooms.getRoom(g.gameId).drawOffer, null);
  });

  test("a resignation loses for the resigning player's team, and frees all four", async () => {
    const over = COLORS.map((c) => waitFor(g.by[c], "game:over"));
    g.by.g.emit("game:resign", { gameId: g.gameId });
    for (const o of await Promise.all(over)) {
      assert.deepEqual([o.result, o.termination, o.ratings], ["1-0", "resign", null]);
      assert.deepEqual(Object.keys(o.clocks), COLORS);
    }
    const row = gameRow(g.gameId);
    assert.deepEqual([row.status, row.result, row.termination], ["finished", "1-0", "resign"]);
    for (const u of users) assert.equal(rooms.liveGameOf(u.user.id), null);
    assert.equal(rooms.getRoom(g.gameId), undefined);
    const quiet = expectNo(g.by.r, "rematch:offered");
    g.by.b.emit("rematch:offer", { gameId: g.gameId });
    assert.equal(await quiet, true);
  });
});

describe("a four-player game ended by mate", () => {
  test("counts on the mated player's turn, after the others have moved", async () => {
    const g = await start({ join: false });
    // Red's rook will check Green's king down the n-file, its pawns in its way.
    const mate = fen4("r", { h1: "rK", a7: "bK", g14: "yK", n8: "gK", m7: "gP", m8: "gP", m9: "gP", n7: "gP", e11: "rR" });
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(mate, mate, g.gameId);
    forgetRoom(g.gameId);
    await joinAll(g);
    assert.equal(g.states.r.fen, mate);
    const check = await play(g, "r", "e11", "n11");
    assert.equal(check.san, "Re11-n11+");
    // Blue, Green's partner, has nothing to block with; then Yellow; then
    // Green is to move, and mated.
    const over = waitFor(g.by.g, "game:over");
    await play(g, "b", "a7", "a6");
    await emitAck(g.by.y, "move:make", { gameId: g.gameId, from: "g14", to: "f14" });
    const o = await over;
    assert.deepEqual([o.result, o.termination], ["1-0", "checkmate"]);
    assert.deepEqual([gameRow(g.gameId).result, gameRow(g.gameId).termination], ["1-0", "checkmate"]);
    close(g);
  });
});

describe("a four-player game on the clock", () => {
  test("the first flag loses for that player's team", async () => {
    const g = await start({ initialMs: 1000 });
    await play(g, "r", ...OPENING.r);
    const over = waitFor(g.by.r, "game:over", 3000);
    const o = await over;   // Blue never moves
    assert.deepEqual([o.result, o.termination], ["1-0", "timeout"]);
    assert.equal(o.clocks.b, 0);
    assert.equal(seatRows(g.gameId).find((s) => s.color === "b").clock_ms, 0);
    close(g);
  });
});

describe("a four-player game a player never joins", () => {
  test("is aborted", async () => {
    const g = await start({ join: false });
    for (const c of ["r", "b", "y"]) await emitAck(g.by[c], "game:join", { gameId: g.gameId });
    const o = await waitFor(g.by.r, "game:over", 3000);
    assert.deepEqual([o.result, o.termination], ["*", "aborted"]);
    assert.equal(gameRow(g.gameId).status, "aborted");
    close(g);
  });
});

describe("a four-player game a player leaves", () => {
  test("is lost for their team once the grace runs out", async () => {
    const g = await start();
    await play(g, "r", ...OPENING.r);
    await play(g, "b", ...OPENING.b);
    const gone = waitFor(g.by.r, "opponent:disconnected");
    const over = waitFor(g.by.r, "game:over", 3000);
    g.by.y.close();
    assert.equal((await gone).color, "y");
    const o = await over;
    assert.deepEqual([o.result, o.termination], ["0-1", "disconnect"]);
    close(g);
  });
});

describe("a four-player game after a restart", () => {
  test("comes back from its moves and its seats' clocks, and plays on", async () => {
    const g = await start();
    for (const c of COLORS) await play(g, c, ...OPENING[c]);
    const before = rooms.getRoom(g.gameId).chess.fen();
    db().prepare("UPDATE game_seats SET clock_ms = 4321 WHERE game_id = ? AND color = 'y'").run(g.gameId);
    forgetRoom(g.gameId);
    const back = await emitAck(g.by.b, "game:join", { gameId: g.gameId });
    assert.equal(back.state.fen, before);
    assert.deepEqual(back.state.moves, ["h2h4", "b8d8", "g13g11", "m10k10"]);
    assert.equal(back.state.clocks.y, 4321);
    for (const c of ["r", "y", "g"]) await emitAck(g.by[c], "game:join", { gameId: g.gameId });
    await play(g, "r", "e2", "e3");
    assert.equal(rooms.getRoom(g.gameId).chess.history.length, 5);
    g.by.r.emit("game:resign", { gameId: g.gameId });
    await waitFor(g.by.b, "game:over");
    close(g);
  });

  test("whose record won't replay is aborted when a player comes back", async () => {
    const g = await start();
    await play(g, "r", ...OPENING.r);
    db().prepare("UPDATE moves SET uci = 'h2h5' WHERE game_id = ?").run(g.gameId);
    forgetRoom(g.gameId);
    const back = await emitAck(g.by.y, "game:join", { gameId: g.gameId });
    assert.equal(back.ok, false);
    assert.match(back.error, /could not be replayed/);
    assert.deepEqual([gameRow(g.gameId).status, gameRow(g.gameId).termination], ["aborted", "corrupt-record"]);
    close(g);
  });
});

describe("a seat, looked at from outside", () => {
  test("counts among its player's PvP games, as account deletion reports them", () => {
    const queries = require("../../src/db/queries");
    const seated = db().prepare("SELECT COUNT(*) AS n FROM game_seats WHERE user_id = ?").get(users[2].user.id).n;
    assert.ok(seated > 0);
    assert.equal(queries.deletionSummary.get({ id: users[2].user.id }).pvpGames, seated);
  });
});

describe("four-player games are built from four different people", () => {
  test("anything else is refused before a game is stored", () => {
    const seat = (i) => ({ userId: users[i].user.id, username: users[i].user.username });
    const count = () => db().prepare("SELECT COUNT(*) AS n FROM games").get().n;
    const n = count();
    assert.throws(() => matchmaking.startFourPlayer(srv.io, { r: seat(0), b: seat(1), y: seat(0), g: seat(3) }), /four different/);
    const lorfish = db().prepare("SELECT id, username FROM users WHERE username = ?").get(require("../../src/config").AI_USERNAME);
    assert.throws(() => matchmaking.startFourPlayer(srv.io,
      { r: seat(0), b: seat(1), y: seat(2), g: { userId: lorfish.id, username: lorfish.username } }), /four different/);
    assert.equal(count(), n);
  });
});
