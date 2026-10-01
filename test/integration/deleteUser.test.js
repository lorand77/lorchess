"use strict";

// `npm run user:delete`: after the confirmation, the account is an empty,
// deactivated `deleted-<id>` row. PvP games and the opponent's records stay
// (without the name); everything else about the person is gone, games against
// LorFish included. Without the confirmation, or during a live game, nothing
// changes.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { startServer, client, registerUser } = require("../helpers/server");
const { lorfishId, recordGame } = require("../helpers/games");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");

const CLI = path.join(__dirname, "../../src/db/deleteUser.js");

// Run the command against the test database, typing `input` at the prompt.
function cli(args, input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: process.env, input, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const count = (sql, ...params) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params).n;
const row = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const MATE = { moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate" };

let srv;
before(async () => {
  srv = await startServer();
  db.prepare("INSERT OR IGNORE INTO puzzles (id, fen, moves, rating) VALUES ('del01', '8/8/8/8/8/8/8/8 w - - 0 1', 'a1a2', 1500)").run();
});
after(async () => { await srv.close(); });

// alice with something in every table that can point at her, and bob, whose
// own records must come through untouched.
async function populated() {
  const alice = await registerUser(srv.baseUrl, "alice");
  const bob = await registerUser(srv.baseUrl, "bob");
  const a = alice.user.id;
  const b = bob.user.id;

  const pvp = recordGame({ white: a, black: b, ...MATE });
  const ai = recordGame({ white: a, black: lorfishId(), mode: "ai", aiColor: "b", rated: 0, ...MATE });
  queries.insertChat.run(pvp, a, "w", "hi from alice");
  queries.insertChat.run(pvp, b, "b", "hi from bob");
  queries.insertChat.run(ai, a, "w", "talking to LorFish");
  queries.createFriendRequest.run(b, a);
  db.prepare("INSERT INTO user_assets (user_id, kind, mime, data, updated_at) VALUES (?, 'bg', 'image/png', x'00', datetime('now'))").run(a);
  queries.insertAttempt.run(a, "del01", 1, 1500, 1510, 1);
  queries.insertPuzzleSkip.run(a, "del01");
  for (const [userId, gameId] of [[a, ai], [b, pvp]]) {
    queries.awardAchievement.run({ userId, key: "first_win", tier: 1, at: null, gameId, puzzleId: null });
  }
  queries.insertRatingHistory.run(a, pvp, 1200, 1190);
  queries.insertRatingHistory.run(b, pvp, 1200, 1210);
  queries.insertPromoCode.run("987654321");
  db.prepare("UPDATE promo_codes SET redeemed_by = ?, redeemed_at = datetime('now') WHERE code = '987654321'").run(a);
  db.prepare("UPDATE users SET member_since = datetime('now'), prefs = '{}', chat_count = 2 WHERE id = ?").run(a);
  return { alice, bob, a, b, pvp, ai };
}

describe("after confirmation", () => {
  let f, run;
  before(async () => {
    f = await populated();
    run = cli([f.alice.user.username], f.alice.user.username + "\n");
  });

  test("shows what it will do, then reports it", () => {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /kept, without the name: 1 PvP game\(s\)/);
    assert.match(run.out, /deleted: 1 game\(s\) against LorFish, 2 chat message\(s\), 1 friendship/);
    assert.match(run.out, new RegExp(`now deleted-${f.a} .*; 1 session\\(s\\) ended`));
  });

  test("leaves an empty, deactivated row named deleted-<id>", () => {
    const u = row(f.a);
    assert.equal(u.username, `deleted-${f.a}`);
    assert.equal(u.password_hash, null);
    assert.equal(u.prefs, null);
    assert.equal(u.member_since, null);
    assert.equal(u.chat_count, 0);
    assert.ok(u.deactivated_at);
  });

  test("ends the sessions, and the old name no longer logs in but can be registered again", async () => {
    assert.equal((await f.alice.c.get("/api/me")).status, 401);
    const login = await client(srv.baseUrl).post("/api/login", { username: f.alice.user.username, password: f.alice.password });
    assert.equal(login.status, 401);
    const again = await client(srv.baseUrl).post("/api/register", { username: f.alice.user.username, password: "another1" });
    assert.equal(again.status, 201);
    assert.notEqual(again.body.id, f.a);
  });

  test("keeps the PvP game, its moves and the opponent's records", () => {
    assert.equal(count("games WHERE id = ? AND white_id = ?", f.pvp, f.a), 1);
    assert.equal(count("moves WHERE game_id = ?", f.pvp), 4);
    assert.equal(count("chat_messages WHERE user_id = ?", f.b), 1);
    assert.equal(count("rating_history WHERE user_id = ?", f.b), 1);
    assert.equal(count("user_achievements WHERE user_id = ? AND game_id = ?", f.b, f.pvp), 1);
    // Cleared, the code would be redeemable again.
    assert.equal(queries.getPromoCode.get("987654321").redeemed_by, f.a);
  });

  test("deletes everything else about her, games against LorFish included", () => {
    assert.equal(count("games WHERE id = ?", f.ai), 0);
    assert.equal(count("moves WHERE game_id = ?", f.ai), 0);
    for (const table of ["chat_messages", "user_assets", "puzzle_attempts", "puzzle_skips", "user_achievements", "rating_history"]) {
      assert.equal(count(`${table} WHERE user_id = ?`, f.a), 0, table);
    }
    assert.equal(count("friendships WHERE requester_id = ? OR addressee_id = ?", f.a, f.a), 0);
  });
});

describe("without confirmation", () => {
  test("a wrong or missing answer changes nothing", async () => {
    const f = await populated();
    const name = f.alice.user.username;
    for (const input of ["", "nope\n", name.toUpperCase() + "\n"]) {
      const r = cli([name], input);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /not confirmed; nothing deleted/);
    }
    assert.equal(row(f.a).username, name);
    assert.equal(count("games WHERE id = ?", f.ai), 1);
    assert.equal(count("chat_messages WHERE user_id = ?", f.a), 2);
    assert.equal((await f.alice.c.get("/api/me")).status, 200);
  });

  test("a live PvP game is refused before the prompt", async () => {
    const carol = await registerUser(srv.baseUrl, "carol");
    const dave = await registerUser(srv.baseUrl, "dave");
    const live = recordGame({ white: carol.user.id, black: dave.user.id, moves: ["e2e4"] });
    const r = cli([carol.user.username], carol.user.username + "\n");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`playing game #${live}; nothing deleted`));
    assert.doesNotMatch(r.out, /Type /);
    assert.equal(row(carol.user.id).username, carol.user.username);
  });

  test("refuses bad arguments, unknown users, the AI account and deleted names", () => {
    assert.equal(cli([]).code, 2);
    assert.equal(cli(["a", "b"]).code, 2);
    assert.equal(cli(["no_such_user_x"]).code, 2);
    assert.equal(cli(["LorFish"]).code, 2);
    assert.match(cli(["deleted-1"]).out, /already been deleted/);
  });
});
