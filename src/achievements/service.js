"use strict";

// Achievement evaluation. Three kinds of check:
//
//   game feats   — replay a finished game's moves and look at what happened
//                  (en passant, smothered mate, comeback, ...). Run once per
//                  human participant when a game finishes.
//   stats        — counters and highs computed from the tables (games played,
//                  wins per time control, puzzle streaks, rating, ...). Cheap
//                  aggregate queries, run after every game / puzzle / chat.
//   puzzle       — the bits that only make sense right after a puzzle.
//
// Awarding is idempotent: awardAchievement only writes when the tier goes up,
// so re-running any evaluation (or the backfill script) never double-counts.
// Every entry point returns the list of NEWLY earned (or upgraded) badges so
// the caller can tell the player.

const queries = require("../db/queries");
const { Chess, fileOf, rankOf, sqIdx } = require("../shared/chess");
const handicap = require("../shared/handicap");
const { TIME_CONTROLS } = require("../shared/timeControls");
const { BY_KEY, describe, tierName } = require("../shared/achievements");

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// Depth of LorFish's strongest setting (see the <select id="depth"> in game.html).
const MAX_AI_DEPTH = 4;

const other = (c) => (c === "w" ? "b" : "w");
const sqFromAlg = (a) => sqIdx(a.charCodeAt(0) - 97, parseInt(a[1], 10) - 1);

// ---- awarding ----

// Record `key` at `tier` for a user. Returns a display record if this is new
// (or a higher tier than before), else null.
function award(userId, key, tier, ref) {
  const def = BY_KEY[key];
  if (!def) throw new Error("Unknown achievement: " + key);
  const t = def.tiers ? Math.max(0, Math.min(Number(tier) || 0, def.tiers.length)) : (tier ? 1 : 0);
  if (t < 1) return null;
  const info = queries.awardAchievement.run({
    userId,
    key,
    tier: t,
    at: (ref && ref.at) || null,
    gameId: (ref && ref.gameId) || null,
    puzzleId: (ref && ref.puzzleId) || null,
  });
  if (!info.changes) return null;
  return view(def, t);
}

function view(def, tier) {
  return {
    key: def.key,
    name: def.name,
    icon: def.icon,
    tier,
    tierName: tierName(def, tier),
    maxTier: def.tiers ? def.tiers.length : 1,
    desc: describe(def, tier),
    hidden: !!def.hidden,
  };
}

// Highest tier whose threshold `value` meets, for a tiered achievement.
function tierFor(key, value) {
  const tiers = BY_KEY[key].tiers;
  let t = 0;
  for (let i = 0; i < tiers.length; i++) if (value >= tiers[i]) t = i + 1;
  return t;
}

// ---- game analysis ----

// Replay a finished game and return one record per ply plus game-level facts,
// or null if the move list can't be replayed (AI games are client-reported).
function analyze(game, moves) {
  const chess = new Chess();
  const startFen = game.start_fen || STANDARD_START;
  try {
    if (startFen === STANDARD_START) chess.reset();
    else chess.loadFen(startFen);
  } catch (e) {
    return null;
  }
  const removed = startFen === STANDARD_START ? [] : handicap.removalsFromFen(startFen);
  const standardStart = startFen === STANDARD_START;
  // A handicap is a known, server-built position; anything else is a pasted FEN.
  const trustedStart = standardStart || (Array.isArray(removed) && removed.length > 0);

  const plies = [];
  for (const m of moves) {
    if (typeof m.uci !== "string" || m.uci.length < 4) return null;
    const from = sqFromAlg(m.uci.slice(0, 2));
    const to = sqFromAlg(m.uci.slice(2, 4));
    const promo = m.uci[4] || null;
    const mv = chess
      .findMove(from, to, promo);
    if (!mv) return null;
    const color = chess.turn;
    const origPiece = chess.squares[from].t;
    const captured = mv.enpassant ? "p" : chess.squares[to] ? chess.squares[to].t : null;
    chess.makeMove(mv);
    const sig = signature(chess);
    plies.push({
      ply: plies.length + 1,
      color,
      from,
      to,
      uci: m.uci,
      san: m.san,
      piece: promo || origPiece,
      origPiece,
      captured,
      enpassant: !!mv.enpassant,
      castle: mv.castle || null,
      promo,
      check: chess.inCheck(),
      thinkMs: m.think_ms == null ? null : Number(m.think_ms),
      premove: !!m.premove,
      material: sig.material,      // { w, b } in pawn units
      pieces: sig.pieces,          // { w: 'bbk', b: 'k' } sorted piece types
    });
  }

  const winner = game.result === "1-0" ? "w" : game.result === "0-1" ? "b" : null;
  return {
    chess,
    plies,
    standardStart,
    trustedStart,
    removed: Array.isArray(removed) ? removed : [],
    winner,
    checkmate: game.termination === "checkmate" && chess.isCheckmate(),
    stalemate: game.termination === "stalemate" && chess.isStalemate(),
  };
}

function signature(chess) {
  const material = { w: 0, b: 0 };
  const types = { w: [], b: [] };
  for (let i = 0; i < 64; i++) {
    const p = chess.squares[i];
    if (!p) continue;
    material[p.c] += VALUE[p.t];
    types[p.c].push(p.t);
  }
  return {
    material,
    pieces: { w: types.w.sort().join(""), b: types.b.sort().join("") },
  };
}

// Material balance from `me`'s point of view after a ply record.
const balance = (ply, me) => (ply.material.w - ply.material.b) * (me === "w" ? 1 : -1);

// Squares adjacent to `sq` that are on the board.
function neighbours(sq) {
  const out = [];
  const f = fileOf(sq), r = rankOf(sq);
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(sqIdx(nf, nr));
    }
  }
  return out;
}

// e2e4 -> e7e5: the same move made by the other side.
function mirrorUci(uci) {
  const flip = (a) => a[0] + String(9 - parseInt(a[1], 10));
  return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + (uci[4] || "");
}

// Highest-value piece among `removed` squares belonging to `color`:
// 1 pawn, 2 minor, 3 rook, 4 queen; 0 if nothing of theirs was removed.
function oddsTier(removed, color) {
  let best = 0;
  for (const sq of removed) {
    const p = handicap.START_PIECES[sq];
    if (!p || (handicap.isWhitePiece(p) ? "w" : "b") !== color) continue;
    const t = { P: 1, N: 2, B: 2, R: 3, Q: 4 }[p.toUpperCase()] || 0;
    if (t > best) best = t;
  }
  return best;
}

// ---- game feats ----
// Each check receives a context for one player and returns a tier (or a
// boolean for one-shot achievements).
const GAME_CHECKS = {
  fools_mate: (c) => c.won && c.a.standardStart && c.a.checkmate && c.plies <= 4 && c.last.color === c.me,
  scholars_mate: (c) =>
    c.won && c.a.standardStart && c.a.checkmate && c.plies <= 8 && c.last.color === c.me &&
    c.last.piece === "q" && c.last.to === (c.me === "w" ? sqFromAlg("f7") : sqFromAlg("f2")),
  underdog: (c) => c.won && c.rated && c.oppRating - c.myRating >= 200,
  giant_slayer: (c) => c.won && c.rated && c.oppRating - c.myRating >= 400,
  comeback_kid: (c) => c.won && c.a.standardStart && c.mine.some((p) => balance(p, c.me) <= -9),
  pawn_power: (c) => c.won && c.mine.some((p) => p.promo),
  underpromotion: (c) => c.mine.some((p) => p.promo && p.promo !== "q"),
  knight_rider: (c) => c.won && c.a.checkmate && c.last.color === c.me && c.last.promo === "n",
  en_passant: (c) => c.mine.some((p) => p.enpassant),
  holy_hell: (c) => c.won && c.mine.some((p) => p.enpassant && p.check),
  smothered_mate: (c) => {
    if (!(c.won && c.a.checkmate && c.last.color === c.me && c.last.piece === "n")) return false;
    const king = c.a.chess.findKing(c.opp);
    return neighbours(king).every((sq) => {
      const p = c.a.chess.squares[sq];
      return p && p.c === c.opp;
    });
  },
  back_rank: (c) => {
    if (!(c.won && c.a.checkmate && c.last.color === c.me)) return false;
    if (c.last.piece !== "r" && c.last.piece !== "q") return false;
    const king = c.a.chess.findKing(c.opp);
    const home = c.opp === "w" ? 0 : 7;
    if (rankOf(king) !== home || rankOf(c.last.to) !== home) return false;
    const ahead = c.opp === "w" ? 1 : 6;
    for (let df = -1; df <= 1; df++) {
      const f = fileOf(king) + df;
      if (f < 0 || f > 7) continue;
      const p = c.a.chess.squares[sqIdx(f, ahead)];
      if (!p || p.c !== c.opp) return false;
    }
    return true;
  },
  two_bishops: (c) =>
    c.won && c.a.checkmate && c.last.pieces[c.me] === "bbk" && c.last.pieces[c.opp] === "k",
  the_grinder: (c) =>
    c.won && c.a.plies.some((p) => p.pieces[c.me] === "kp" && p.pieces[c.opp] === "k"),
  flag_bearer: (c) => c.won && c.game.termination === "timeout",
  down_to_wire: (c) => c.won && c.timed && c.myClockMs != null && c.myClockMs < 1000,
  escape_artist: (c) => c.drew && c.a.stalemate && balance(c.last, c.me) <= -5,
  fortress: (c) => c.drew && c.game.termination === "threefold" && balance(c.last, c.me) <= -3,
  perpetual_check: (c) =>
    c.drew && c.game.termination === "threefold" && c.mine.length >= 6 &&
    c.mine.slice(-6).every((p) => p.check),
  pacifist: (c) =>
    c.won && (c.game.termination === "checkmate" || c.game.termination === "resign") &&
    c.plies >= 20 && !c.mine.some((p) => p.captured),
  queen_sacrifice: (c) => {
    if (!c.won || !(c.game.termination === "checkmate" || c.game.termination === "resign")) return false;
    const ps = c.a.plies;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.color !== c.opp || p.captured !== "q") continue;
      // Balance before the sequence started (before my previous move) versus
      // after my reply: a real sacrifice leaves me at least a rook down on it.
      const before = i >= 2 ? balance(ps[i - 2], c.me) : c.startBalance;
      const afterPly = ps[i + 1] || p;
      if (balance(afterPly, c.me) > before - 5) continue;
      if (ps.length - (i + 1) <= 20) return true;
    }
    return false;
  },
  full_house: (c) => c.won && c.a.standardStart && c.plies >= 40 && c.a.plies[39].pieces[c.me].length === 16,
  no_time_wasted: (c) =>
    c.won && c.timed && c.plies >= 20 &&
    c.mine.every((p) => p.thinkMs != null && p.thinkMs < 5000),
  // Every move after the first was queued before the opponent had replied.
  clairvoyant: (c) => c.won && c.plies >= 10 && c.mine.slice(1).every((p) => p.premove),

  // mate by piece: the piece that made the mating move (a promotion counts as
  // the piece it became; a king move that uncovers mate counts for the king)
  mate_pawn: (c) => c.mated && c.last.piece === "p",
  mate_knight: (c) => c.mated && c.last.piece === "n",
  mate_bishop: (c) => c.mated && c.last.piece === "b",
  mate_rook: (c) => c.mated && c.last.piece === "r" && !c.last.castle,
  mate_queen: (c) => c.mated && c.last.piece === "q",
  mate_king: (c) => c.mated && c.last.piece === "k" && !c.last.castle,
  mate_en_passant: (c) => c.mated && c.last.enpassant,
  mate_castle: (c) => c.mated && !!c.last.castle,

  // formats
  beat_fish_2: (c) => c.won && c.game.mode === "ai" && c.game.ai_depth === 2,
  fish_slayer: (c) => c.won && c.game.mode === "ai" && c.game.ai_depth >= MAX_AI_DEPTH,
  giving_odds: (c) => (c.won ? oddsTier(c.a.removed, c.me) : 0),
  handicap_hustler: (c) => c.won && c.game.mode === "pvp" && oddsTier(c.a.removed, c.me) === 4,
  iron_man: (c) => c.plies >= 199,
  // A resignation counts, but not one so early there was no game to speak of.
  blitzkrieg: (c) =>
    c.won && c.a.standardStart && c.plies <= 40 &&
    (c.game.termination === "checkmate" || (c.game.termination === "resign" && c.plies >= 10)),

  // hidden
  oops: (c) => c.lost && c.game.termination === "resign" && c.plies <= 2,
  hasty: (c) => c.lost && c.game.termination === "timeout" && c.game.initial_ms === 600000 && c.plies < 20,
  bongcloud: (c) => {
    if (!c.won) return false;
    const p = c.a.plies[c.me === "w" ? 2 : 3];
    return !!p && p.color === c.me && p.origPiece === "k" &&
      p.to === (c.me === "w" ? sqFromAlg("e2") : sqFromAlg("e7"));
  },
  mirror_match: (c) => {
    if (!c.a.standardStart || c.plies < 20) return false;
    for (let i = 0; i < 10; i++) {
      if (c.a.plies[2 * i + 1].uci !== mirrorUci(c.a.plies[2 * i].uci)) return false;
    }
    return true;
  },
  stalemate_sadness: (c) => c.drew && c.a.stalemate && c.last.color === c.me && balance(c.last, c.me) >= 9,
  rage_quit: (c) =>
    c.lost && c.game.termination === "resign" && c.resignReactionMs != null &&
    c.resignReactionMs < 2000 && c.last && c.last.color === c.opp && !!c.last.captured,
};

// Run every game feat for one participant. `extra` carries facts that only the
// live room knew (how fast a resignation came).
function evaluateGame(userId, game, analysis, extra) {
  const me = game.white_id === userId ? "w" : "b";
  const opp = other(me);
  const plies = analysis.plies;
  if (plies.length === 0) return [];
  const ratings = ratingsBefore(game, userId);
  const startSig = (() => {
    const ch = new Chess();
    if (analysis.standardStart) ch.reset(); else ch.loadFen(game.start_fen);
    return signature(ch);
  })();
  const ctx = {
    game,
    a: analysis,
    me,
    opp,
    plies: plies.length,
    last: plies[plies.length - 1],
    mine: plies.filter((p) => p.color === me),
    won: analysis.winner === me,
    lost: analysis.winner === opp,
    // I delivered the mating move.
    mated: analysis.winner === me && analysis.checkmate && plies[plies.length - 1].color === me,
    drew: game.result === "1/2-1/2",
    rated: game.mode === "pvp" && !!game.rated,
    timed: game.initial_ms != null,
    myClockMs: me === "w" ? game.clock_w_ms : game.clock_b_ms,
    myRating: ratings.mine,
    oppRating: ratings.opp,
    startBalance: (startSig.material.w - startSig.material.b) * (me === "w" ? 1 : -1),
    resignReactionMs: extra && extra.resignReactionMs != null ? extra.resignReactionMs : null,
  };
  const ref = { gameId: game.id, at: extra && extra.at };
  const earned = [];
  for (const key of Object.keys(GAME_CHECKS)) {
    let r;
    try {
      r = GAME_CHECKS[key](ctx);
    } catch (e) {
      console.error(`[achievements] ${key} check failed on game #${game.id}:`, e);
      continue;
    }
    const got = award(userId, key, r, ref);
    if (got) earned.push(got);
  }
  return earned;
}

// Both players' ratings going into a game. Rated games have a history row;
// otherwise the current ratings are the best we have.
function ratingsBefore(game, userId) {
  const oppId = game.white_id === userId ? game.black_id : game.white_id;
  const rows = queries.ratingHistoryForGame.all(game.id);
  const byUser = {};
  for (const r of rows) byUser[r.user_id] = r.rating_before;
  const cur = (id) => {
    const u = queries.getUserById.get(id);
    return u ? u.rating : 1200;
  };
  return {
    mine: byUser[userId] != null ? byUser[userId] : cur(userId),
    opp: byUser[oppId] != null ? byUser[oppId] : cur(oppId),
  };
}

// ---- stats ----

function clockKey(initialMs) {
  const tc = TIME_CONTROLS.find((t) => t.initialMs === initialMs);
  return tc ? tc.key : null;
}

function evaluateStats(userId, ref) {
  const user = queries.achievementUser.get(userId);
  if (!user) return [];
  const g = queries.achievementGameStats.get({ me: userId });
  const mv = queries.achievementMoveStats.get(userId);
  const byClock = {};
  for (const r of queries.achievementWinsByClock.all({ me: userId })) {
    const k = clockKey(r.initial_ms);
    if (k) byClock[k] = (byClock[k] || 0) + r.n;
  }
  const bullet = byClock["1+0"] || 0;
  const blitz = (byClock["3+0"] || 0) + (byClock["5+0"] || 0);
  const rapid = byClock["10+0"] || 0;
  const recent = queries.achievementRecentResults.all(userId, userId);
  const attempts = queries.achievementRecentAttempts.all(userId);
  let firstTry = 0;
  for (const a of attempts) { if (a.solved) firstTry++; else break; }
  const solved = queries.attemptStats.get(userId).solved;
  const chat = queries.achievementChatCount.get(userId).n;

  const today = new Date().toISOString().slice(0, 10);
  const streakLive = user.daily_last_date === today || user.daily_last_date === addDays(today, -1);
  const streak = streakLive ? user.daily_streak : 0;

  const results = [
    ["games_played", tierFor("games_played", g.finished)],
    ["wins", tierFor("wins", g.wins)],
    ["checkmates", tierFor("checkmates", g.checkmates)],
    ["moves", tierFor("moves", mv.moves)],
    ["puzzles_solved", tierFor("puzzles_solved", solved)],
    ["puzzle_rating", tierFor("puzzle_rating", user.puzzle_rating)],
    ["rating", tierFor("rating", user.rating)],
    ["daily_streak", tierFor("daily_streak", streak)],
    ["sharpshooter", tierFor("sharpshooter", firstTry)],
    ["bullet_wins", tierFor("bullet_wins", bullet)],
    ["blitz_wins", tierFor("blitz_wins", blitz)],
    ["rapid_wins", tierFor("rapid_wins", rapid)],
    ["well_rounded", TIME_CONTROLS.every((t) => (byClock[t.key] || 0) > 0)],
    ["both_colours", g.wins_white > 0 && g.wins_black > 0],
    ["black_is_ok", tierFor("black_is_ok", g.wins_black)],
    ["castled_both_ways", mv.long_castles > 0 && mv.short_castles > 0],
    ["long_castle", mv.long_castles >= 10],
    ["draw_master", recent.length >= 10 && recent.every((r) => r.result === "1/2-1/2")],
    ["chatty", chat >= 100],
    ["rating_rollercoaster", rollercoaster(userId, today)],
    ["anniversary", anniversary(user)],
  ];
  const earned = [];
  for (const [key, tier] of results) {
    const got = award(userId, key, tier, ref);
    if (got) earned.push(got);
  }
  return earned;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Up 100 and then back down 100 within one UTC day.
function rollercoaster(userId, today) {
  const rows = queries.ratingHistorySince.all(userId, today + " 00:00:00");
  if (rows.length < 2) return false;
  const seq = [rows[0].rating_before, ...rows.map((r) => r.rating_after)];
  let low = seq[0];
  let peak = null;
  for (const r of seq) {
    if (peak == null) {
      if (r < low) low = r;
      if (r - low >= 100) peak = r;
    } else {
      if (r > peak) peak = r;
      if (peak - r >= 100) return true;
    }
  }
  return false;
}

function anniversary(user) {
  if (!user.created_at) return false;
  const created = new Date(user.created_at.replace(" ", "T") + "Z");
  if (isNaN(created)) return false;
  const year = new Date(created);
  year.setUTCFullYear(year.getUTCFullYear() + 1);
  return Date.now() >= year.getTime();
}

// ---- entry points ----

// A game just finished (or, in the backfill, finished long ago). Returns
// { [userId]: earned[] } for every human participant.
function onGameFinished(gameId, extra) {
  const game = queries.getGameById.get(gameId);
  const out = {};
  if (!game || game.status !== "finished") return out;
  const analysis = analyze(game, queries.getMovesForGame.all(gameId));
  const humans = [game.white_id, game.black_id].filter((id) => id != null && isHuman(id));
  for (const uid of humans) {
    const earned = [];
    // A pasted-FEN AI game is whatever the client says it is; only count feats
    // from the standard position or a server-built handicap.
    if (analysis && (game.mode === "pvp" || analysis.trustedStart)) {
      earned.push(...evaluateGame(uid, game, analysis, extra));
    }
    if (!(extra && extra.skipStats)) earned.push(...evaluateStats(uid, { gameId, at: extra && extra.at }));
    out[uid] = earned;
  }
  return out;
}

let aiUserId = null;
function isHuman(userId) {
  if (aiUserId == null) {
    const cfg = require("../config");
    const ai = queries.getUserByUsername.get(cfg.AI_USERNAME);
    aiUserId = ai ? ai.id : -1;
  }
  return userId !== aiUserId;
}

// A rated first attempt at a puzzle just ended.
function onPuzzleFinished(userId, puzzle) {
  return evaluateStats(userId, { puzzleId: puzzle.id });
}

function onChat(userId) {
  return evaluateStats(userId, {});
}

// Anything time-based (the anniversary) plus a general catch-up.
function onVisit(userId) {
  return evaluateStats(userId, {});
}

module.exports = { onGameFinished, onPuzzleFinished, onChat, onVisit, evaluateGame, evaluateStats, analyze, award };
