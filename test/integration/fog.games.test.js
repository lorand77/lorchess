"use strict";

// Fog of War over the socket: casual, from the standard setup, won by taking
// the king. While the game is on, each player, and each spectator through the
// side they chose, is sent only that side's view: the move as that side sees
// it, the view's position, its own moves' SAN. Whole games are played between
// two players and two spectators (one through each side's eyes), and every
// message each receives is checked against what its side could see. Once the
// game is over, everything is shown. The game API, the game lists and the
// lobby's previews keep a live game's board to themselves too.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const rooms = require("../../src/game/rooms");
const { Chess } = require("../../src/shared/chess");

let srv, alice, bob, carol, dave;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
  dave = await registerUser(srv.baseUrl, "dave");
});
after(async () => { await srv.close(); });

// A FEN's board field anywhere in a message: the thing that must never show
// more than the recipient sees.
const BOARD = /[1-8pnbrqkPNBRQK]{1,8}(?:\/[1-8pnbrqkPNBRQK]{1,8}){7}/g;
const boardOf = (fen) => fen.split(" ")[0];
const MOVE_KEYS = ["clocks", "drop", "fen", "from", "ply", "promo", "san", "to", "turn", "view"];

// Every message a socket receives, in order.
function record(socket) {
  const got = [];
  socket.onAny((event, payload) => got.push({ event, payload }));
  return got;
}

async function fogGame() {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc: "10+0", rated: true, variant: "fog" });
  const seen = { w: record(white), b: record(black) };
  const joined = { w: await emitAck(white, "game:join", { gameId }), b: await emitAck(black, "game:join", { gameId }) };
  return { gameId, white, black, by: { w: white, b: black }, seen, joined };
}

async function watcher(user, gameId, side) {
  const s = await connectSocket(srv.baseUrl, user.c.cookie());
  const got = record(s);
  const r = await emitAck(s, "game:watch", { gameId, side });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { s, got, state: r.state };
}

// A seeded generator, so a failing game can be replayed.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("a Fog of War game, start to finish, for each of its four audiences", () => {
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: everything each one is sent is what its side sees`, async () => {
      const g = await fogGame();
      const spect = { w: await watcher(carol, g.gameId, "w"), b: await watcher(dave, g.gameId, "b") };
      const sockets = [g.white, g.black, spect.w.s, spect.b.s];
      const shadow = new Chess().setVariant("fog");
      shadow.reset();

      // What each side could see at each point: the boards a message may hold.
      const views = { w: [shadow.fogView("w")], b: [shadow.fogView("b")] };
      for (const side of ["w", "b"]) {
        const join = side === "w" ? g.joined.w.state : g.joined.b.state;
        assert.equal(join.variant, "fog");
        assert.equal(join.rated, false, "always casual");
        assert.deepEqual(join.view, views[side][0]);
        assert.equal(join.fen, views[side][0].fen);
        assert.equal(join.moves, null);
        assert.deepEqual(spect[side].state.view, views[side][0], "the spectator sees as that side");
      }

      const rand = rng(seed);
      let over = null;
      for (let ply = 1; ply <= 300 && !over; ply++) {
        const legal = shadow.legalMoves();
        const caps = legal.filter((m) => m.capture);
        const pool = caps.length && rand() < 0.6 ? caps : legal;
        const m = pool[Math.floor(rand() * pool.length)];
        const mover = shadow.turn;
        const before = { w: shadow.visibleSquares("w"), b: shadow.visibleSquares("b") };
        const san = shadow.moveToSan(m);
        shadow.makeMove(m);
        const expected = { w: shadow.fogView("w"), b: shadow.fogView("b") };
        views.w.push(expected.w);
        views.b.push(expected.b);

        const arrivals = sockets.map((s) => waitFor(s, "move:made"));
        const ended = shadow.isGameOver() ? sockets.map((s) => waitFor(s, "game:over")) : null;
        const res = await emitAck(g.by[mover], "move:make", { gameId: g.gameId, from: m.from, to: m.to, promo: m.promo || null });
        assert.deepEqual(res, { ok: true }, `${san} at ply ${ply}`);
        const [w, b, sw, sb] = await Promise.all(arrivals);
        for (const [side, msg] of [["w", w], ["b", b], ["w", sw], ["b", sb]]) {
          assert.deepEqual(Object.keys(msg).sort(), MOVE_KEYS, "nothing else rides along");
          assert.deepEqual(msg.view, expected[side]);
          assert.equal(msg.fen, expected[side].fen);
          assert.equal(msg.ply, ply);
          if (side === mover) {
            assert.equal(msg.san, san);
            assert.equal(msg.from, m.from);
            assert.equal(msg.to, m.to);
          } else {
            assert.equal(msg.san, null, "the other side's SAN is never sent");
            assert.equal(msg.promo, null);
            assert.equal(msg.from, before[side].has(m.from) ? m.from : null);
            assert.equal(msg.to, expected[side].visible.includes(m.to) ? m.to : null);
          }
        }
        if (ended) over = (await Promise.all(ended))[0];
      }
      assert.ok(over, "the game ended");
      assert.ok(shadow.history.length >= 20, `${shadow.history.length} plies`);

      // The end shows everything, to everyone.
      assert.equal(over.result, shadow.result());
      assert.equal(over.termination, shadow.termination());
      assert.equal(over.final.fen, shadow.fen());
      assert.equal(over.final.sans.length, shadow.history.length);
      assert.ok(over.final.sans.every((s) => typeof s === "string"));
      assert.equal(over.final.moves.length, shadow.history.length);

      // Every board in every message before the end is one its side could see.
      const scan = (got, side) => {
        for (const { event, payload } of got) {
          if (event === "game:over") break;
          for (const board of JSON.stringify(payload).match(BOARD) || []) {
            assert.ok(views[side].some((v) => boardOf(v.fen) === board), `${event} sent ${board} to ${side}`);
          }
        }
      };
      scan(g.seen.w, "w");
      scan(g.seen.b, "b");
      scan(spect.w.got, "w");
      scan(spect.b.got, "b");

      // Afterwards the game is whole: rejoined, replayed, and in the list.
      const back = await emitAck(g.white, "game:join", { gameId: g.gameId });
      assert.equal(back.state.fen, shadow.fen());
      assert.deepEqual(back.state.sans, over.final.sans);
      assert.equal(back.state.view, undefined);
      const replay = await carol.c.get(`/api/games/${g.gameId}`);
      assert.equal(replay.body.moves.length, shadow.history.length);
      const row = db().prepare("SELECT result, termination, rated FROM games WHERE id = ?").get(g.gameId);
      assert.deepEqual(row, { result: shadow.result(), termination: shadow.termination(), rated: 0 });
      for (const s of sockets) s.close();
    });
  }
});

describe("a Fog of War game in progress, from outside the board", () => {
  let g;
  before(async () => {
    g = await fogGame();
    // 1. e4 d5: Black's pawn is in sight of White's (exd5), White's in sight
    // of Black's (dxe4).
    await emitAck(g.white, "move:make", { gameId: g.gameId, from: 12, to: 28 });
    await emitAck(g.black, "move:make", { gameId: g.gameId, from: 51, to: 35 });
  });
  after(() => { g.white.close(); g.black.close(); });

  test("a player rejoining gets their view: their own SAN, null for the other side's", async () => {
    const r = await emitAck(g.black, "game:join", { gameId: g.gameId });
    assert.deepEqual(r.state.sans, [null, "d5"]);
    assert.equal(r.state.sees, "b");
    assert.deepEqual(r.state.view, rooms.getRoom(g.gameId).chess.fogView("b"));
    assert.equal(r.state.moves, null);
  });

  test("a spectator chooses the side to watch through, and may switch", async () => {
    const { s, state } = await watcher(carol, g.gameId, "b");
    assert.deepEqual(state.sans, [null, "d5"]);
    const asWhite = await emitAck(s, "game:watch", { gameId: g.gameId, side: "w" });
    assert.deepEqual(asWhite.state.sans, ["e4", null]);
    // Through White's eyes only now: White's next move comes as White sees it.
    const next = waitFor(s, "move:made");
    await emitAck(g.white, "move:make", { gameId: g.gameId, from: 6, to: 21 });   // Nf3
    const m = await next;
    assert.equal(m.san, "Nf3");
    assert.equal(m.fen, rooms.getRoom(g.gameId).chess.fogView("w").fen);
    // Unasked, a spectator watches through White's.
    const plain = await connectSocket(srv.baseUrl, dave.c.cookie());
    assert.equal((await emitAck(plain, "game:watch", { gameId: g.gameId })).state.sees, "w");
    s.close();
    plain.close();
  });

  test("the game API shows its player their view and no moves; the lists, no position", async () => {
    const real = rooms.getRoom(g.gameId).chess;
    const mine = await bob.c.get(`/api/games/${g.gameId}`);
    const player = mine.body.white_id === bob.user.id ? "w" : "b";
    assert.deepEqual(mine.body.fog_view, real.fogView(player));
    assert.equal(mine.body.current_fen, real.fogView(player).fen);
    assert.deepEqual(mine.body.moves, []);
    assert.equal((await carol.c.get(`/api/games/${g.gameId}`)).status, 403, "a live game is its players' alone");
    for (const who of [alice, bob]) {
      const row = (await who.c.get("/api/games")).body.find((x) => x.id === g.gameId);
      assert.equal(row.current_fen, null);
    }
    const onProfile = (await carol.c.get(`/api/games/user/${alice.user.id}`)).body.find((x) => x.id === g.gameId);
    assert.equal(onProfile.current_fen, null);
  });

  test("the lobby lists it without a board", async () => {
    const s = await connectSocket(srv.baseUrl, carol.c.cookie());
    const state = waitFor(s, "lobby:state");
    s.emit("lobby:enter");
    const live = (await state).games.find((x) => x.gameId === g.gameId);
    assert.ok(live, "listed");
    assert.equal(live.fen, null);
    assert.equal(live.last, null);
    s.close();
  });

  test("a restart keeps the fog: the rebuilt room sends views", async () => {
    const real = rooms.getRoom(g.gameId).chess.fen();
    rooms.clearTimers(rooms.getRoom(g.gameId));
    rooms.deleteRoom(g.gameId);
    const r = await emitAck(g.white, "game:join", { gameId: g.gameId });
    const shadow = new Chess().setVariant("fog");
    shadow.loadFen(real);
    assert.deepEqual(r.state.view, shadow.fogView("w"));
    assert.deepEqual(r.state.sans, ["e4", null, "Nf3"]);
    await emitAck(g.black, "game:join", { gameId: g.gameId });
  });

  test("a resignation ends it, and shows the whole game", async () => {
    const over = waitFor(g.white, "game:over");
    g.black.emit("game:resign", { gameId: g.gameId });
    const o = await over;
    assert.equal(o.result, "1-0");
    assert.deepEqual(o.final.sans, ["e4", "d5", "Nf3"]);
    assert.equal(o.final.fen, db().prepare("SELECT current_fen FROM games WHERE id = ?").get(g.gameId).current_fen);
    assert.match(o.final.fen, /^rnbqkbnr\/ppp1pppp\/8\/3p4\/4P3\/5N2\/PPPP1PPP\/RNBQKB1R b /);
  });
});

describe("a Fog of War game against LorFish", () => {
  test("is created, records its moves whole (the page holds the game) and ends by taking the king", async () => {
    const created = await alice.c.post("/api/games", { humanColor: "w", level: "beginner", variant: "fog" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.gameId;
    const shadow = new Chess().setVariant("fog");
    shadow.reset();
    const m = shadow.findMove(12, 28);
    const san = shadow.moveToSan(m);
    shadow.makeMove(m);
    const rec = await alice.c.post(`/api/games/${id}/moves`, { ply: 1, san, uci: "e2e4", fenAfter: shadow.fen(), byColor: "w" });
    assert.equal(rec.status, 201);
    const game = (await alice.c.get(`/api/games/${id}`)).body;
    assert.equal(game.current_fen, shadow.fen(), "no view: against LorFish nothing is hidden from the page");
    assert.equal(game.moves.length, 1);
    const end = await alice.c.post(`/api/games/${id}/end`, { result: "1-0", termination: "king captured" });
    assert.equal(end.status, 200, JSON.stringify(end.body));
    assert.equal(db().prepare("SELECT termination FROM games WHERE id = ?").get(id).termination, "king captured");
  });
});
