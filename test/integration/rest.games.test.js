"use strict";

// The AI-game persistence API: /api/games. The browser plays the game and
// reports moves; the server records them and finalises the result.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const { Chess } = require("../../src/shared/chess");
const { moveOf } = require("../helpers/board");
const { makeUser, recordGame } = require("../helpers/games");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Turn a UCI move list into the payloads the browser posts, using the real
// engine for SAN and FEN.
function plies(uciMoves) {
  const chess = new Chess();
  return uciMoves.map((uci, i) => {
    const m = moveOf(chess, uci);
    const san = chess.moveToSan(m);
    chess.makeMove(m);
    return { ply: i + 1, san, uci, fenAfter: chess.fen(), byColor: i % 2 === 0 ? "w" : "b" };
  });
}
const FOOLS_MATE = plies(["f2f3", "e7e5", "g2g4", "d8h4"]);

let srv, me, user;
before(async () => {
  srv = await startServer();
  ({ c: me, user } = await registerUser(srv.baseUrl, "player"));
});
after(async () => { await srv.close(); });

async function newGame(body) {
  const res = await me.post("/api/games", body);
  assert.equal(res.status, 201);
  return res.body;
}

describe("creating games", () => {
  test("a custom start position must be one the rules accept", async () => {
    for (const bad of [
      "not a fen",
      "4k3/8/8/8/8/8/3PP3/4K3 w - e3 0 1",   // an en passant square that would delete White's own pawn
      "8/8/8/8/8/8/8/4K3 w - - 0 1",         // no black king
    ]) {
      const res = await me.post("/api/games", { humanColor: "w", startFen: bad });
      assert.equal(res.status, 400, bad);
      assert.match(res.body.error, /Invalid start position/);
    }
    const fen = "k7/8/8/8/8/8/8/K6R w - - 0 1";
    const created = await me.post("/api/games", { humanColor: "w", startFen: fen });
    assert.equal(created.status, 201);
    assert.equal((await me.get(`/api/games/${created.body.gameId}`)).body.start_fen, fen);
  });

  test("an AI game for the chosen colour", async () => {
    const created = await newGame({ humanColor: "b", depth: 2 });
    assert.deepEqual(created, { gameId: created.gameId, humanColor: "b", aiColor: "w", turn: "w" });
    const res = await me.get(`/api/games/${created.gameId}`);
    assert.equal(res.status, 200);
    const g = res.body;
    assert.equal(g.status, "active");
    assert.equal(g.mode, "ai");
    assert.equal(g.ai_color, "w");
    assert.equal(g.ai_depth, 2);
    assert.equal(g.start_fen, START_FEN);
    assert.equal(g.current_fen, START_FEN);
    assert.equal(g.turn, "w");
    assert.equal(g.rated, 0);
    assert.equal(g.variant, "standard");
    assert.equal(g.white_username, "LorFish");
    assert.equal(g.black_username, user.username);
    assert.equal(g.black_id, user.id);
    assert.deepEqual(g.moves, []);
  });

  test("defaults to white at depth 2, and honours a custom start position", async () => {
    const plain = await newGame({});
    assert.equal(plain.humanColor, "w");
    assert.equal(plain.aiColor, "b");
    assert.equal((await me.get(`/api/games/${plain.gameId}`)).body.ai_depth, 2);

    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const custom = await newGame({ humanColor: "w", depth: "4", startFen: `  ${fen}  ` });
    assert.equal(custom.turn, "b");
    const g = (await me.get(`/api/games/${custom.gameId}`)).body;
    assert.equal(g.start_fen, fen);
    assert.equal(g.ai_depth, 4);
    assert.equal(g.turn, "b");
  });
});

describe("recording and finishing a game", () => {
  test("moves are stored with SAN, UCI and FEN, then the result is finalised", async () => {
    const { gameId } = await newGame({ humanColor: "b", depth: 2 });
    for (const p of FOOLS_MATE) {
      const res = await me.post(`/api/games/${gameId}/moves`, p);
      assert.equal(res.status, 201, p.san);
      assert.deepEqual(res.body, { ok: true, ply: p.ply });
    }

    let g = (await me.get(`/api/games/${gameId}`)).body;
    assert.deepEqual(g.moves.map((m) => m.san), ["f3", "e5", "g4", "Qh4#"]);
    assert.deepEqual(g.moves.map((m) => m.uci), FOOLS_MATE.map((p) => p.uci));
    assert.deepEqual(g.moves.map((m) => m.fen_after), FOOLS_MATE.map((p) => p.fenAfter));
    assert.deepEqual(g.moves.map((m) => m.by_user), [null, user.id, null, user.id], "AI moves record no user");
    assert.equal(g.current_fen, FOOLS_MATE[3].fenAfter);
    assert.equal(g.turn, "w");
    assert.equal(g.status, "active");

    const end = await me.post(`/api/games/${gameId}/end`, { result: "0-1", termination: "checkmate" });
    assert.equal(end.status, 200);
    assert.equal(end.body.ok, true);
    const keys = end.body.achievements.map((a) => a.key);
    assert.ok(keys.includes("fools_mate"), `earned ${keys}`);
    assert.ok(keys.includes("beat_fish_2"), `earned ${keys}`);

    g = (await me.get(`/api/games/${gameId}`)).body;
    assert.equal(g.status, "finished");
    assert.equal(g.result, "0-1");
    assert.equal(g.termination, "checkmate");
    assert.ok(g.finished_at);

    const list = (await me.get("/api/games")).body;
    const row = list.find((x) => x.id === gameId);
    assert.ok(row, "listed under the user's games");
    assert.equal(row.move_count, 4);
    assert.equal(row.white_username, "LorFish");
    assert.equal(row.black_username, user.username);
  });

  test("rejects malformed moves and duplicate plies", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    const good = FOOLS_MATE[0];
    for (const bad of [
      {},
      { ...good, ply: "1" },
      { ...good, san: undefined },
      { ...good, uci: 42 },
      { ...good, fenAfter: null },
      { ...good, byColor: "x" },
    ]) {
      const res = await me.post(`/api/games/${gameId}/moves`, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error, /Invalid move payload/);
    }
    assert.equal((await me.post(`/api/games/${gameId}/moves`, good)).status, 201);
    const dup = await me.post(`/api/games/${gameId}/moves`, good);
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already recorded/);
    assert.equal((await me.get(`/api/games/${gameId}`)).body.moves.length, 1);
  });

  test("a finished game takes no more moves, and only valid results end a game", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    for (const result of ["2-0", "win", "", null]) {
      const res = await me.post(`/api/games/${gameId}/end`, { result });
      assert.equal(res.status, 400, String(result));
    }
    assert.equal((await me.post(`/api/games/${gameId}/end`, { result: "1/2-1/2" })).status, 200);
    const g = (await me.get(`/api/games/${gameId}`)).body;
    assert.equal(g.result, "1/2-1/2");
    assert.equal(g.termination, null);
    const late = await me.post(`/api/games/${gameId}/moves`, FOOLS_MATE[0]);
    assert.equal(late.status, 409);
    assert.match(late.body.error, /not active/);
  });

  test("a finished game cannot be ended again or truncated", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    for (const p of FOOLS_MATE) await me.post(`/api/games/${gameId}/moves`, p);
    assert.equal((await me.post(`/api/games/${gameId}/end`, { result: "0-1", termination: "checkmate" })).status, 200);
    const again = await me.post(`/api/games/${gameId}/end`, { result: "1-0" });
    assert.equal(again.status, 409);
    const cut = await me.post(`/api/games/${gameId}/truncate`, { toPly: 0, fen: START_FEN });
    assert.equal(cut.status, 409);
    const g = (await me.get(`/api/games/${gameId}`)).body;
    assert.equal(g.result, "0-1");
    assert.equal(g.termination, "checkmate");
    assert.equal(g.moves.length, 4);
  });

  test("only the rules engine's own terminations are recorded", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    for (const bad of ["<img src=x onerror=alert(1)>", "resign", "timeout", 42]) {
      const res = await me.post(`/api/games/${gameId}/end`, { result: "1-0", termination: bad });
      assert.equal(res.status, 400, String(bad));
      assert.match(res.body.error, /Invalid termination/);
    }
    assert.equal((await me.get(`/api/games/${gameId}`)).body.status, "active", "nothing was recorded");
    for (const [value, stored] of [["", null], [null, null]]) {
      const { gameId: id } = await newGame({ humanColor: "w" });
      assert.equal((await me.post(`/api/games/${id}/end`, { result: "1-0", termination: value })).status, 200);
      assert.equal((await me.get(`/api/games/${id}`)).body.termination, stored);
    }
    assert.equal((await me.post(`/api/games/${gameId}/end`, { result: "1-0", termination: "fifty-move" })).status, 200);
    assert.equal((await me.get(`/api/games/${gameId}`)).body.termination, "fifty-move");
  });

  test("truncate drops later moves and resets the position", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    for (const p of FOOLS_MATE) await me.post(`/api/games/${gameId}/moves`, p);
    const bad = await me.post(`/api/games/${gameId}/truncate`, { toPly: -1, fen: START_FEN });
    assert.equal(bad.status, 400);
    const res = await me.post(`/api/games/${gameId}/truncate`, { toPly: 2, fen: FOOLS_MATE[1].fenAfter });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, toPly: 2 });
    const g = (await me.get(`/api/games/${gameId}`)).body;
    assert.deepEqual(g.moves.map((m) => m.san), ["f3", "e5"]);
    assert.equal(g.current_fen, FOOLS_MATE[1].fenAfter);
    assert.equal(g.turn, "w");
  });
});

describe("ownership", () => {
  test("another user cannot read my unfinished game, move in it, or end it", async () => {
    const { gameId } = await newGame({ humanColor: "w" });
    const { c: other } = await registerUser(srv.baseUrl, "intruder");
    assert.equal((await other.get(`/api/games/${gameId}`)).status, 403);
    assert.equal((await other.post(`/api/games/${gameId}/moves`, FOOLS_MATE[0])).status, 403);
    assert.equal((await other.post(`/api/games/${gameId}/end`, { result: "1-0" })).status, 403);
    assert.equal((await other.post(`/api/games/${gameId}/truncate`, { toPly: 0, fen: START_FEN })).status, 403);
    assert.equal((await other.get("/api/games")).body.some((g) => g.id === gameId), false);
    assert.equal((await me.get(`/api/games/${gameId}`)).body.moves.length, 0, "nothing got through");
  });

  test("a PvP game cannot be edited through this API, even by its players", async () => {
    // A live PvP game with me as white, written straight into the database.
    const opp = makeUser("opp");
    const live = recordGame({ white: user.id, black: opp.id, moves: ["e2e4"] });
    const next = { ...FOOLS_MATE[1], ply: 2 };
    assert.equal((await me.post(`/api/games/${live}/moves`, next)).status, 403);
    assert.equal((await me.post(`/api/games/${live}/end`, { result: "1-0" })).status, 403);
    assert.equal((await me.post(`/api/games/${live}/truncate`, { toPly: 0, fen: START_FEN })).status, 403);
    const g = (await me.get(`/api/games/${live}`)).body;
    assert.equal(g.status, "active");
    assert.equal(g.moves.length, 1);

    // Nor can a finished rated loss be rewritten into a win.
    const lost = recordGame({
      white: user.id, black: opp.id, moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
      result: "0-1", termination: "checkmate",
    });
    assert.equal((await me.post(`/api/games/${lost}/end`, { result: "1-0" })).status, 403);
    assert.equal((await me.get(`/api/games/${lost}`)).body.result, "0-1");
  });

  test("a game that does not exist is a 404", async () => {
    assert.equal((await me.get("/api/games/999999")).status, 404);
    assert.equal((await me.post("/api/games/999999/end", { result: "1-0" })).status, 404);
  });
});
