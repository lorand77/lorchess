"use strict";

// Infinite chess over the socket: moves as { from: { x, y }, to: { x, y } },
// a payload of any other shape refused before the engine sees it, moves
// broadcast with the engine's own squares and stored in ICN ("6,1>-994,1001"),
// the game replayed when the room is rebuilt after a restart, and the ends —
// checkmate, a draw by material that can't mate on a board with no edges, and
// running out of time.
// Games are quick-matched as infinite chess, asked for as rated (which it
// can't be); an endgame is set up by rewriting the game's start before a move
// is played and forgetting the room, as a restart would.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, quickMatch, db,
} = require("../helpers/server");
const rooms = require("../../src/game/rooms");
const { InfiniteChess } = require("../../src/shared/infiniteChess");

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
});
after(async () => { await srv.close(); });

const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);
const storedMoves = (id) =>
  db().prepare("SELECT san, uci FROM moves WHERE game_id = ? ORDER BY ply").all(id);

function forgetRoom(gameId) {
  rooms.clearTimers(rooms.getRoom(gameId));
  rooms.deleteRoom(gameId);
}

async function infiniteGame(start, tc = "10+0") {
  const a = await connectSocket(srv.baseUrl, alice.c.cookie());
  const b = await connectSocket(srv.baseUrl, bob.c.cookie());
  const { gameId, white, black } = await quickMatch(a, b, { tc, rated: true, variant: "infinite" });
  if (start) {
    db().prepare("UPDATE games SET start_fen = ?, current_fen = ? WHERE id = ?").run(start, start, gameId);
    forgetRoom(gameId);
  }
  const joined = await emitAck(white, "game:join", { gameId });
  assert.equal(joined.ok, true);
  await emitAck(black, "game:join", { gameId });
  return { gameId, white, black, state: joined.state };
}

// "5,2>5,4" or "1,7>1,8q" as the socket payload.
function payload(text) {
  const m = /^(-?\d+),(-?\d+)>(-?\d+),(-?\d+)([qrbn]?)$/.exec(text);
  return {
    from: { x: Number(m[1]), y: Number(m[2]) },
    to: { x: Number(m[3]), y: Number(m[4]) },
    promo: m[5] || null,
  };
}

async function play(socket, other, gameId, text) {
  const seen = waitFor(other, "move:made");
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...payload(text) }), { ok: true }, text);
  return seen;
}

const refusedPayload = async (socket, gameId, body, why) =>
  assert.deepEqual(await emitAck(socket, "move:make", { gameId, ...body }), { ok: false, error: "Illegal move." }, why);

describe("an infinite chess game from the start", () => {
  let game;
  before(async () => { game = await infiniteGame(); });
  after(() => { game.white.close(); game.black.close(); });

  test("starts casual, at the Classical start, in ICN", () => {
    assert.equal(game.state.variant, "infinite");
    assert.equal(game.state.rated, false);
    assert.equal(gameRow(game.gameId).rated, 0, "asked for rated; infinite chess is casual only");
    assert.equal(game.state.fen, new InfiniteChess().fen());
    assert.equal(gameRow(game.gameId).start_fen, new InfiniteChess().fen(), "the catalogue's start");
  });

  test("refuses any payload that isn't two plain squares on the board", async () => {
    const { white, gameId } = game;
    const ok = payload("5,2>5,4");
    for (const [body, why] of [
      [{ from: 12, to: 28, promo: null }, "squares numbered as on an 8x8 board"],
      [{ from: ok.from }, "no destination"],
      [{ from: { x: 5, y: 2, evil: "x" }, to: ok.to }, "an extra field"],
      [{ from: { x: "5", y: 2 }, to: ok.to }, "a string"],
      [{ from: ok.from, to: { x: 5, y: 4.5 } }, "not a whole number"],
      [{ from: ok.from, to: { x: 5, y: 1000001 } }, "beyond the limit"],
      [{ from: [5, 2], to: ok.to }, "an array"],
      [{ ...ok, drop: "n" }, "a drop"],
      [{ ...ok, promo: "k" }, "promotion to a king"],
      [{ ...ok, promo: "x" }, "promotion to nothing"],
    ]) {
      await refusedPayload(white, gameId, body, why);
    }
    await refusedPayload(white, gameId, payload("5,2>5,5"), "well formed, but not a move");
  });

  test("plays moves off the box, broadcast with the engine's squares and stored in ICN", async () => {
    const { white, black, gameId } = game;
    await play(white, black, gameId, "5,2>5,4");
    await play(black, white, gameId, "5,7>5,5");
    const far = await play(white, black, gameId, "6,1>-994,1001");
    assert.deepEqual(far.from, { x: 6, y: 1 });
    assert.deepEqual(far.to, { x: -994, y: 1001 });
    assert.equal(far.san, "B6,1>-994,1001");
    assert.ok(far.fen.includes("B-994,1001"), far.fen);
    assert.deepEqual(storedMoves(gameId)[2], { san: "B6,1>-994,1001", uci: "6,1>-994,1001" });
  });

  test("survives a restart: the room replays the moves", async () => {
    const { white, black, gameId } = game;
    const before = (await emitAck(white, "game:join", { gameId })).state;
    forgetRoom(gameId);
    const after = (await emitAck(white, "game:join", { gameId })).state;
    await emitAck(black, "game:join", { gameId });
    assert.deepEqual(after.moves, ["5,2>5,4", "5,7>5,5", "6,1>-994,1001"]);
    assert.deepEqual(after.sans, ["P5,2>5,4", "p5,7>5,5", "B6,1>-994,1001"]);
    assert.equal(after.fen, before.fen);

    const over = waitFor(black, "game:over");
    black.emit("game:resign", { gameId });
    assert.equal((await over).result, "1-0");
  });
});

describe("an infinite chess mate", () => {
  // A black king boxed in by four rooks; a fifth comes down to its rank.
  const START = "w 0/100 1 (8|1) checkmate k5,5|R4,100|R6,100|R100,4|R100,6|R150,10|K-50,-50";
  let game;
  before(async () => { game = await infiniteGame(START); });
  after(() => { game.white.close(); game.black.close(); });

  test("ends the game for White, recorded as checkmate", async () => {
    const { white, black, gameId } = game;
    const expected = new InfiniteChess();
    expected.loadFen(START);
    assert.equal(game.state.fen, expected.fen(), "the same position, its pieces in the engine's order");
    const over = waitFor(black, "game:over");
    const mate = await play(white, black, gameId, "150,10>150,5");
    assert.equal(mate.san, "R150,10>150,5#");
    const end = await over;
    assert.deepEqual([end.result, end.termination], ["1-0", "checkmate"]);
    assert.deepEqual([gameRow(gameId).result, gameRow(gameId).termination], ["1-0", "checkmate"]);
  });
});

describe("an infinite chess game that runs out of mating material", () => {
  // White promotes, which still leaves enough to mate with; Black's rook takes
  // the new queen, leaving a rook each — which can't mate on a board with no
  // edges. (Queen against rook can't either: promoting without White's extra
  // rook would end the game on the spot.)
  const START = "w 0/100 1 (8|1) checkmate K-50,-40|R-60,-60|k5,5|P1,7|r20,8";
  let game;
  before(async () => { game = await infiniteGame(START); });
  after(() => { game.white.close(); game.black.close(); });

  test("promotes through the socket, and ends drawn as insufficient material", async () => {
    const { white, black, gameId } = game;
    const promoted = await play(white, black, gameId, "1,7>1,8q");
    assert.equal(promoted.promo, "q");
    assert.equal(promoted.san, "P1,7>1,8=Q");
    assert.equal(storedMoves(gameId)[0].uci, "1,7>1,8Q");
    const over = waitFor(white, "game:over");
    await play(black, white, gameId, "20,8>1,8");
    const end = await over;
    assert.deepEqual([end.result, end.termination], ["1/2-1/2", "insufficient"]);
  });
});

describe("running out of time in infinite chess", () => {
  // White moves; Black's clock, set nearly empty, then runs out.
  async function blackFlags(start) {
    const game = await infiniteGame(start, "1+0");
    rooms.getRoom(game.gameId).clock.b = 150;
    const over = waitFor(game.white, "game:over");
    await play(game.white, game.black, game.gameId, "-50,-40>-50,-39");
    const end = await over;
    game.white.close(); game.black.close();
    return end;
  }

  test("loses, when the side on time could still mate", async () => {
    const end = await blackFlags("w 0/100 1 (8|1) checkmate K-50,-40|Q-60,-61|R-70,-70|k5,5");
    assert.deepEqual([end.result, end.termination], ["1-0", "timeout"]);
  });

  test("draws, when the side on time has only its king", async () => {
    const end = await blackFlags("w 0/100 1 (8|1) checkmate K-50,-40|k5,5|q-60,-61|r-70,-71");
    assert.deepEqual([end.result, end.termination], ["1/2-1/2", "timeout"]);
  });
});

