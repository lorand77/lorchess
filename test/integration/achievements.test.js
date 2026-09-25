"use strict";

// The achievements evaluator (src/achievements/service.js) against games
// written straight into a throwaway database: which badges a game earns, the
// aggregate ones, and that awarding never double-counts or goes backwards.

require("../helpers/server"); // points the database at a temporary file
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../src/db/index");
const queries = require("../../src/db/queries");
const achievements = require("../../src/achievements/service");
const handicap = require("../../src/shared/handicap");
const { STANDARD_START, makeUser, lorfishId, recordGame } = require("../helpers/games");

const today = () => new Date().toISOString().slice(0, 10);
const keysOf = (earned, userId) => (earned[userId] || []).map((a) => a.key).sort();
const tiersOf = (userId) => {
  const out = {};
  for (const r of queries.listAchievements.all(userId)) out[r.key] = r.tier;
  return out;
};

// Play a fixture game between two fresh users and return what each earned.
function playAndEvaluate(spec, extra) {
  const w = makeUser("w", spec.whiteRating || 1200);
  const b = makeUser("b", spec.blackRating || 1200);
  const gameId = recordGame({ ...spec, white: w.id, black: b.id });
  const earned = achievements.onGameFinished(gameId, extra);
  return { w: keysOf(earned, w.id), b: keysOf(earned, b.id), gameId, wId: w.id, bId: b.id };
}

const has = (list, ...keys) => keys.every((k) => list.includes(k));
const lacks = (list, ...keys) => keys.every((k) => !list.includes(k));

describe("game feats", () => {
  test("fool's mate: queen mate, blitzkrieg and the first tiers", () => {
    const r = playAndEvaluate({ moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate" });
    assert.ok(has(r.b, "fools_mate", "mate_queen", "blitzkrieg", "games_played", "wins", "checkmates", "rapid_wins"), r.b);
    assert.ok(lacks(r.b, "scholars_mate", "both_colours"), r.b);
    assert.deepEqual(r.w, ["games_played"]);
  });

  test("the same mate one move later is no fool's mate", () => {
    const r = playAndEvaluate({ moves: ["a2a3", "a7a6", "f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate" });
    assert.ok(has(r.b, "mate_queen", "blitzkrieg"), r.b);
    assert.ok(lacks(r.b, "fools_mate"), r.b);
  });

  test("scholar's mate", () => {
    const r = playAndEvaluate({
      moves: ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"], result: "1-0", termination: "checkmate",
    });
    assert.ok(has(r.w, "scholars_mate", "mate_queen", "blitzkrieg"), r.w);
    assert.ok(lacks(r.w, "fools_mate"), r.w);
  });

  test("smothered mate", () => {
    const r = playAndEvaluate({ start: "6rk/6pp/8/4N3/8/8/8/K7 w - - 0 1", moves: ["e5f7"], result: "1-0", termination: "checkmate" });
    assert.ok(has(r.w, "smothered_mate", "mate_knight"), r.w);
  });

  test("back-rank mate, and a rook mate that is not one", () => {
    const yes = playAndEvaluate({ start: "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1", moves: ["a1a8"], result: "1-0", termination: "checkmate" });
    assert.ok(has(yes.w, "back_rank", "mate_rook"), yes.w);
    const no = playAndEvaluate({ start: "k7/8/1K6/8/8/8/8/7R w - - 0 1", moves: ["h1h8"], result: "1-0", termination: "checkmate" });
    assert.ok(has(no.w, "mate_rook") && lacks(no.w, "back_rank"), no.w);
  });

  test("two bishops against a bare king", () => {
    const r = playAndEvaluate({ start: "k7/2K5/8/5B2/8/4B3/8/8 w - - 0 1", moves: ["f5e4"], result: "1-0", termination: "checkmate" });
    assert.ok(has(r.w, "two_bishops", "mate_bishop"), r.w);
  });

  test("the grinder: winning from king and pawn against king", () => {
    const r = playAndEvaluate({ start: "8/8/8/8/8/1k6/7P/K7 w - - 0 1", moves: ["h2h4"], result: "1-0", termination: "resign" });
    assert.ok(has(r.w, "the_grinder"), r.w);
  });

  test("promotion to a knight that mates: pawn power, underpromotion, knight rider", () => {
    const r = playAndEvaluate({ start: "8/1P5R/k7/P7/1K6/8/8/8 w - - 0 1", moves: ["b7b8n"], result: "1-0", termination: "checkmate" });
    assert.ok(has(r.w, "pawn_power", "underpromotion", "knight_rider", "mate_knight"), r.w);
  });

  test("en passant, and en passant with check on the way to a win", () => {
    const r = playAndEvaluate({ start: "8/3pk3/8/4P3/8/8/8/4K3 b - - 0 1", moves: ["d7d5", "e5d6"], result: "1-0", termination: "resign" });
    assert.ok(has(r.w, "en_passant", "holy_hell"), r.w);
    assert.ok(lacks(r.b, "en_passant"), r.b);
  });

  test("forty quiet symmetrical plies: pacifist, full house, mirror match", () => {
    const shuffle = [];
    for (let i = 0; i < 10; i++) shuffle.push("g1f3", "g8f6", "f3g1", "f6g8");
    const r = playAndEvaluate({ moves: shuffle, result: "1-0", termination: "resign" });
    assert.ok(has(r.w, "pacifist", "full_house", "mirror_match", "blitzkrieg"), r.w);
    assert.ok(has(r.b, "mirror_match") && lacks(r.b, "pacifist", "full_house"), r.b);
  });

  test("iron man: a game of a hundred moves, for both players", () => {
    const shuffle = [];
    for (let i = 0; i < 50; i++) shuffle.push("g1f3", "g8f6", "f3g1", "f6g8");
    const r = playAndEvaluate({ moves: shuffle, result: "1/2-1/2", termination: "agreement" });
    assert.ok(has(r.w, "iron_man") && has(r.b, "iron_man"), [r.w, r.b]);
    assert.ok(lacks(r.w, "blitzkrieg", "pacifist"), r.w);
  });

  test("losing the queen for nothing and still winning: comeback kid and queen sacrifice", () => {
    const r = playAndEvaluate({ moves: ["e2e4", "d7d5", "d1g4", "c8g4", "g1f3"], result: "1-0", termination: "resign" });
    assert.ok(has(r.w, "comeback_kid", "queen_sacrifice"), r.w);
  });

  test("winning on time is flag bearer; losing a rapid game on time early is hasty", () => {
    const r = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "timeout" });
    assert.ok(has(r.w, "flag_bearer"), r.w);
    assert.ok(has(r.b, "hasty"), r.b);
    const blitz = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "timeout", initialMs: 180000 });
    assert.ok(lacks(blitz.b, "hasty"), blitz.b);
  });

  test("down to the wire: winning with under a second left", () => {
    const r = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign", clocks: { w: 500, b: 30000 } });
    assert.ok(has(r.w, "down_to_wire"), r.w);
    const calm = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign", clocks: { w: 5000, b: 30000 } });
    assert.ok(lacks(calm.w, "down_to_wire"), calm.w);
  });

  test("a stalemate is sadness for the side up a queen and an escape for the other", () => {
    const r = playAndEvaluate({ start: "k7/8/1K6/8/8/8/2Q5/8 w - - 0 1", moves: ["c2c7"], result: "1/2-1/2", termination: "stalemate" });
    assert.ok(has(r.w, "stalemate_sadness"), r.w);
    assert.ok(has(r.b, "escape_artist"), r.b);
  });

  test("perpetual check while behind is also a fortress", () => {
    const moves = [];
    for (let i = 0; i < 3; i++) moves.push("d3d8", "g8h7", "d8d3", "h7g8");
    const r = playAndEvaluate({ start: "6k1/5pp1/8/8/8/3Q3K/8/rr6 w - - 0 1", moves, result: "1/2-1/2", termination: "threefold" });
    assert.ok(has(r.w, "perpetual_check", "fortress"), r.w);
    assert.ok(lacks(r.b, "perpetual_check", "fortress"), r.b);
  });

  test("underdog and giant slayer depend on the rating gap in a rated game", () => {
    const giant = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign", blackRating: 1700 });
    assert.ok(has(giant.w, "underdog", "giant_slayer"), giant.w);
    const small = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign", blackRating: 1350 });
    assert.ok(lacks(small.w, "underdog", "giant_slayer"), small.w);
    const casual = playAndEvaluate({ moves: ["e2e4", "e7e5"], result: "1-0", termination: "resign", blackRating: 1700, rated: 0 });
    assert.ok(lacks(casual.w, "underdog"), casual.w);
  });

  test("hidden: oops, bongcloud and rage quit", () => {
    const oops = playAndEvaluate({ moves: ["e2e4"], result: "0-1", termination: "resign" });
    assert.ok(has(oops.w, "oops"), oops.w);
    const bong = playAndEvaluate({ moves: ["e2e4", "e7e5", "e1e2", "d7d6"], result: "1-0", termination: "resign" });
    assert.ok(has(bong.w, "bongcloud"), bong.w);
    const rage = playAndEvaluate({ moves: ["e2e4", "d7d5", "e4d5"], result: "1-0", termination: "resign" }, { resignReactionMs: 500 });
    assert.ok(has(rage.b, "rage_quit"), rage.b);
    const slow = playAndEvaluate({ moves: ["e2e4", "d7d5", "e4d5"], result: "1-0", termination: "resign" }, { resignReactionMs: 5000 });
    assert.ok(lacks(slow.b, "rage_quit"), slow.b);
  });

  test("mate by pawn, by a king move, and by castling", () => {
    const pawn = playAndEvaluate({ start: "7k/8/6PK/8/2B5/8/8/8 w - - 0 1", moves: ["g6g7"], result: "1-0", termination: "checkmate" });
    assert.ok(has(pawn.w, "mate_pawn"), pawn.w);
    const king = playAndEvaluate({ start: "7k/6p1/8/8/2B5/8/7K/7R w - - 0 1", moves: ["h2g3"], result: "1-0", termination: "checkmate" });
    assert.ok(has(king.w, "mate_king") && lacks(king.w, "mate_rook"), king.w);
    const castle = playAndEvaluate({ start: "3k2N1/8/2Q5/8/8/8/8/R3K3 w Q - 0 1", moves: ["e1a1"], result: "1-0", termination: "checkmate" });
    assert.ok(has(castle.w, "mate_castle") && lacks(castle.w, "mate_rook", "mate_king"), castle.w);
  });

  test("giving odds: the tier follows the piece given up, and queen odds in PvP is hustling", () => {
    const queen = playAndEvaluate({ start: handicap.buildFen({ 3: null }), moves: ["e2e4"], result: "1-0", termination: "resign" });
    assert.ok(has(queen.w, "giving_odds", "handicap_hustler"), queen.w);
    assert.equal(tiersOf(queen.wId).giving_odds, 4);
    const pawn = playAndEvaluate({ start: handicap.buildFen({ 8: null }), moves: ["e2e4"], result: "1-0", termination: "resign" });
    assert.equal(tiersOf(pawn.wId).giving_odds, 1);
    assert.ok(lacks(pawn.w, "handicap_hustler"), pawn.w);
    const receiver = playAndEvaluate({ start: handicap.buildFen({ 3: null }), moves: ["e2e4"], result: "0-1", termination: "resign" });
    assert.ok(lacks(receiver.b, "giving_odds"), receiver.b);
  });
});

describe("AI games", () => {
  const foolsMateAsBlack = (aiDepth) => ({
    mode: "ai", aiColor: "w", aiDepth, white: lorfishId(), initialMs: null, incrementMs: null, rated: 0,
    moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate",
  });

  test("beating LorFish at depth 2 and at depth 4", () => {
    const me = makeUser("h");
    const g2 = recordGame({ ...foolsMateAsBlack(2), black: me.id });
    const first = keysOf(achievements.onGameFinished(g2), me.id);
    assert.ok(has(first, "beat_fish_2", "fools_mate") && lacks(first, "fish_slayer"), first);
    const g4 = recordGame({ ...foolsMateAsBlack(4), black: me.id });
    const second = keysOf(achievements.onGameFinished(g4), me.id);
    assert.ok(has(second, "fish_slayer"), second);
    assert.ok(lacks(second, "fools_mate", "beat_fish_2"), "already earned, so not reported again");
  });

  test("the AI itself earns nothing", () => {
    const me = makeUser("h");
    const earned = achievements.onGameFinished(recordGame({ ...foolsMateAsBlack(2), black: me.id }));
    assert.deepEqual(Object.keys(earned).map(Number), [me.id]);
  });

  test("a pasted position in an AI game earns no feats, only stats", () => {
    const me = makeUser("h");
    const gameId = recordGame({
      mode: "ai", aiColor: "b", aiDepth: 2, white: me.id, black: lorfishId(), rated: 0, initialMs: null,
      start: "6rk/6pp/8/4N3/8/8/8/K7 w - - 0 1", moves: ["e5f7"], result: "1-0", termination: "checkmate",
    });
    const keys = keysOf(achievements.onGameFinished(gameId), me.id);
    assert.ok(lacks(keys, "smothered_mate", "mate_knight", "beat_fish_2"), keys);
    assert.ok(has(keys, "games_played", "wins", "checkmates"), keys);
  });
});

describe("awarding", () => {
  test("a first award is an unlock, a higher tier later an upgrade, and the same tier again is nothing", () => {
    const me = makeUser("me");
    assert.equal(achievements.award(me.id, "wins", 1).upgraded, false);
    assert.equal(achievements.award(me.id, "wins", 2).upgraded, true);
    assert.equal(achievements.award(me.id, "wins", 2), null);
    assert.equal(achievements.award(me.id, "games_played", 3).upgraded, false, "landing at Gold first time is still an unlock");
  });
});

describe("aggregate achievements", () => {
  test("wins in every time control, both colours, and the tiers", () => {
    const me = makeUser("me");
    const foe = makeUser("foe");
    const win = (initialMs, asWhite = true) => recordGame({
      white: asWhite ? me.id : foe.id, black: asWhite ? foe.id : me.id, initialMs,
      moves: ["e2e4", "e7e5"], result: asWhite ? "1-0" : "0-1", termination: "resign",
    });
    let keys = keysOf(achievements.onGameFinished(win(60000)), me.id);
    assert.ok(has(keys, "bullet_wins") && lacks(keys, "well_rounded", "both_colours"), keys);
    achievements.onGameFinished(win(180000));
    achievements.onGameFinished(win(300000));
    keys = keysOf(achievements.onGameFinished(win(600000, false)), me.id);
    assert.ok(has(keys, "well_rounded", "both_colours", "rapid_wins"), keys);
    const tiers = tiersOf(me.id);
    assert.equal(tiers.blitz_wins, 1);
    assert.equal(tiers.wins, 1, "4 wins: still Bronze (10 for Silver)");
    assert.equal(tiers.games_played, 1);
  });

  test("ten draws in a row make a draw master; games played reaches Silver", () => {
    const me = makeUser("me");
    const foe = makeUser("foe");
    let keys;
    for (let i = 0; i < 10; i++) {
      const gameId = recordGame({ white: me.id, black: foe.id, moves: ["e2e4", "e7e5"], result: "1/2-1/2", termination: "agreement" });
      keys = keysOf(achievements.onGameFinished(gameId), me.id);
      if (i < 9) assert.ok(lacks(keys, "draw_master"), `after ${i + 1} draws`);
    }
    assert.ok(has(keys, "draw_master", "games_played"), keys);
    assert.equal(tiersOf(me.id).games_played, 2);
  });

  test("castling both ways across two games", () => {
    const me = makeUser("me");
    const foe = makeUser("foe");
    const castles = (move) => recordGame({
      white: me.id, black: foe.id, start: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1",
      moves: [move], result: "1/2-1/2", termination: "agreement",
    });
    assert.ok(lacks(keysOf(achievements.onGameFinished(castles("e1g1")), me.id), "castled_both_ways"));
    assert.ok(has(keysOf(achievements.onGameFinished(castles("e1c1")), me.id), "castled_both_ways"));
  });

  test("a daily streak only counts while it is alive", () => {
    const me = makeUser("me");
    queries.setDailyStreak.run(7, today(), me.id);
    assert.ok(has(keysOf({ [me.id]: achievements.onVisit(me.id) }, me.id), "daily_streak"));
    assert.equal(tiersOf(me.id).daily_streak, 2, "7 days is Silver");

    const stale = makeUser("me");
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    queries.setDailyStreak.run(30, twoDaysAgo, stale.id);
    achievements.onVisit(stale.id);
    assert.equal(tiersOf(stale.id).daily_streak, undefined, "a broken streak earns nothing");
  });

  test("the anniversary needs a year", () => {
    const old = makeUser("me");
    db.prepare("UPDATE users SET created_at = datetime('now', '-366 days') WHERE id = ?").run(old.id);
    achievements.onVisit(old.id);
    assert.equal(tiersOf(old.id).anniversary, 1);
    const fresh = makeUser("me");
    achievements.onVisit(fresh.id);
    assert.equal(tiersOf(fresh.id).anniversary, undefined);
  });

  test("the rating rollercoaster: up a hundred and back down within a day", () => {
    const me = makeUser("me");
    for (const [before, after] of [[1200, 1260], [1260, 1310], [1310, 1250], [1250, 1205]]) {
      queries.insertRatingHistory.run(me.id, null, before, after);
    }
    achievements.onVisit(me.id);
    assert.equal(tiersOf(me.id).rating_rollercoaster, 1);
    const climber = makeUser("me");
    for (const [before, after] of [[1200, 1260], [1260, 1330]]) queries.insertRatingHistory.run(climber.id, null, before, after);
    achievements.onVisit(climber.id);
    assert.equal(tiersOf(climber.id).rating_rollercoaster, undefined);
  });
});

describe("awarding", () => {
  test("evaluating the same game twice reports nothing new and changes no row", () => {
    const w = makeUser("w");
    const b = makeUser("b");
    const gameId = recordGame({ white: w.id, black: b.id, moves: ["f2f3", "e7e5", "g2g4", "d8h4"], result: "0-1", termination: "checkmate" });
    const first = achievements.onGameFinished(gameId);
    assert.ok(first[b.id].length > 0);
    const rowsBefore = queries.listAchievements.all(b.id);
    const second = achievements.onGameFinished(gameId);
    assert.deepEqual(second, { [w.id]: [], [b.id]: [] });
    assert.deepEqual(queries.listAchievements.all(b.id), rowsBefore);
  });

  test("tiers only ever go up", () => {
    const me = makeUser("me");
    assert.equal(achievements.award(me.id, "games_played", 2, { gameId: null }).tier, 2);
    assert.equal(achievements.award(me.id, "games_played", 2, {}), null, "same tier again");
    assert.equal(achievements.award(me.id, "games_played", 1, {}), null, "lower tier");
    assert.equal(tiersOf(me.id).games_played, 2);
    assert.equal(achievements.award(me.id, "games_played", 3, {}).tier, 3);
    assert.equal(achievements.award(me.id, "games_played", 99, {}).tier, 4, "clamped to the top tier");
    assert.equal(achievements.award(me.id, "games_played", 0, {}), null, "tier 0 is nothing");
    assert.equal(achievements.award(me.id, "anniversary", false, {}), null);
    assert.equal(achievements.award(me.id, "anniversary", true, {}).tier, 1);
    assert.equal(achievements.award(me.id, "anniversary", true, {}), null);
  });

  test("an unknown key is a programming error", () => {
    const me = makeUser("me");
    assert.throws(() => achievements.award(me.id, "no_such_badge", 1, {}), /Unknown achievement/);
  });

  test("an unfinished game earns nothing", () => {
    const w = makeUser("w");
    const b = makeUser("b");
    const gameId = recordGame({ white: w.id, black: b.id, moves: ["e2e4"] });
    assert.deepEqual(achievements.onGameFinished(gameId), {});
  });

  test("the record points at the game that earned it", () => {
    const r = playAndEvaluate({ start: "6rk/6pp/8/4N3/8/8/8/K7 w - - 0 1", moves: ["e5f7"], result: "1-0", termination: "checkmate" });
    const row = queries.listAchievements.all(r.wId).find((x) => x.key === "smothered_mate");
    assert.equal(row.game_id, r.gameId);
    assert.ok(row.earned_at);
  });
});
