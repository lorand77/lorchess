"use strict";

// The achievement catalogue: what exists, what it's called, and what it takes.
// Shared the same way timeControls.js is — one file, loaded as a browser
// <script> (served at /js/achievements.js, for the achievements page) and as a
// Node `require` (the evaluator in src/achievements/service.js).
//
// This file holds DISPLAY data only. The checks that decide whether something
// was earned live server-side; nothing here is trusted from a client.
//
// Fields:
//   key        stable id, stored in user_achievements.key
//   name       display name
//   icon       an emoji
//   group      'milestones' | 'formats' | 'feats' | 'hidden'
//   desc       description; tiered entries use {n} for the tier's threshold
//   tiers      thresholds for tiered achievements (Bronze/Silver/Gold/Diamond);
//              omitted for one-shot achievements
//   tierDescs  per-tier descriptions when the tiers aren't a single number
//   hidden     not shown (name/description) until earned

const TIER_NAMES = ["Bronze", "Silver", "Gold", "Diamond"];

const ACHIEVEMENTS = [
  // ---- milestones (tiered counters) ----
  { key: "games_played", name: "Games Played", icon: "♟️", group: "milestones",
    desc: "Finish {n} games.", tiers: [1, 10, 100, 1000] },
  { key: "wins", name: "Victorious", icon: "🏆", group: "milestones",
    desc: "Win {n} games.", tiers: [1, 10, 100, 500] },
  { key: "checkmates", name: "Checkmate!", icon: "♚", group: "milestones",
    desc: "Win {n} games by checkmate.", tiers: [1, 25, 100, 500] },
  { key: "moves", name: "Move Machine", icon: "🔁", group: "milestones",
    desc: "Play {n} moves.", tiers: [100, 1000, 10000, 100000] },
  { key: "puzzles_solved", name: "Puzzle Solver", icon: "🧩", group: "milestones",
    desc: "Solve {n} puzzles.", tiers: [10, 100, 1000, 5000] },
  { key: "puzzle_rating", name: "Puzzle Climber", icon: "📈", group: "milestones",
    desc: "Reach a puzzle rating of {n}.", tiers: [1400, 1600, 1800, 2100] },
  { key: "rating", name: "Rated Climber", icon: "🚀", group: "milestones",
    desc: "Reach a game rating of {n}.", tiers: [1300, 1500, 1700, 2000] },
  { key: "daily_streak", name: "Daily Devotee", icon: "🔥", group: "milestones",
    desc: "Keep a daily puzzle streak of {n} days.", tiers: [3, 7, 30, 100] },
  { key: "sharpshooter", name: "Sharpshooter", icon: "🎯", group: "milestones",
    desc: "Solve {n} puzzles in a row on the first try.", tiers: [10, 25, 50] },
  { key: "anniversary", name: "Anniversary", icon: "🎂", group: "milestones",
    desc: "One year since you joined LorChess." },

  // ---- modes and formats ----
  { key: "bullet_wins", name: "Bullet Brawler", icon: "💨", group: "formats",
    desc: "Win {n} bullet (1+0) games.", tiers: [1, 10, 50] },
  { key: "blitz_wins", name: "Blitz Boss", icon: "⚡", group: "formats",
    desc: "Win {n} blitz (3+0 or 5+0) games.", tiers: [1, 10, 50] },
  { key: "rapid_wins", name: "Rapid Regular", icon: "⏱️", group: "formats",
    desc: "Win {n} rapid (10+0) games.", tiers: [1, 10, 50] },
  { key: "well_rounded", name: "Well Rounded", icon: "🧭", group: "formats",
    desc: "Win a game in every time control." },
  { key: "beat_fish_2", name: "Fish Food", icon: "🐟", group: "formats",
    desc: "Beat LorFish at depth 2." },
  { key: "fish_slayer", name: "Fish Slayer", icon: "🔱", group: "formats",
    desc: "Beat LorFish at depth 4, its strongest setting." },
  { key: "giving_odds", name: "Giving Odds", icon: "⚖️", group: "formats",
    tiers: [1, 2, 3, 4],
    tierDescs: [
      "Win a game after giving pawn odds.",
      "Win a game after giving a minor piece.",
      "Win a game after giving a rook.",
      "Win a game after giving your queen.",
    ] },
  { key: "handicap_hustler", name: "Handicap Hustler", icon: "🎩", group: "formats",
    desc: "Beat another player after giving queen odds." },
  { key: "both_colours", name: "Both Colours", icon: "☯️", group: "formats",
    desc: "Win a game as White and a game as Black." },
  { key: "black_is_ok", name: "Black Is OK", icon: "♞", group: "formats",
    desc: "Win {n} games with the black pieces.", tiers: [5, 25, 100] },
  { key: "iron_man", name: "Iron Man", icon: "🦾", group: "formats",
    desc: "Play a game that lasts 100 moves or more." },
  { key: "blitzkrieg", name: "Blitzkrieg", icon: "🌩️", group: "formats",
    desc: "Win a game in 20 moves or fewer." },

  // ---- in-game feats ----
  { key: "fools_mate", name: "Fool's Mate", icon: "🤡", group: "feats",
    desc: "Deliver checkmate on move 2." },
  { key: "scholars_mate", name: "Scholar's Mate", icon: "🎓", group: "feats",
    desc: "Deliver checkmate by move 4 with your queen on f7 (or f2)." },
  { key: "underdog", name: "Underdog", icon: "🐕", group: "feats",
    desc: "Win a rated game against an opponent rated 200 or more above you." },
  { key: "giant_slayer", name: "Giant Slayer", icon: "🗡️", group: "feats",
    desc: "Win a rated game against an opponent rated 400 or more above you." },
  { key: "comeback_kid", name: "Comeback Kid", icon: "🔄", group: "feats",
    desc: "Win a game after being down a queen's worth of material." },
  { key: "pawn_power", name: "Pawn Power", icon: "👑", group: "feats",
    desc: "Promote a pawn and go on to win." },
  { key: "underpromotion", name: "Underpromotion", icon: "🐴", group: "feats",
    desc: "Promote a pawn to something other than a queen." },
  { key: "knight_rider", name: "Knight Rider", icon: "🏇", group: "feats",
    desc: "Deliver checkmate by promoting to a knight." },
  { key: "en_passant", name: "En Passant", icon: "🫣", group: "feats",
    desc: "Capture en passant." },
  { key: "holy_hell", name: "Holy Hell", icon: "😱", group: "feats",
    desc: "Win a game in which you captured en passant with check." },
  { key: "castled_both_ways", name: "Castled Both Ways", icon: "🏰", group: "feats",
    desc: "Castle kingside in one game and queenside in another." },
  { key: "long_castle", name: "Long Castle", icon: "🏯", group: "feats",
    desc: "Castle queenside 10 times." },
  { key: "smothered_mate", name: "Smothered Mate", icon: "🐎", group: "feats",
    desc: "Checkmate with a knight while the king is boxed in by its own pieces." },
  { key: "back_rank", name: "Back Rank Blunder… Theirs", icon: "🧱", group: "feats",
    desc: "Win by back-rank mate." },
  { key: "two_bishops", name: "Two Bishops", icon: "⛪", group: "feats",
    desc: "Checkmate with king and two bishops against a bare king." },
  { key: "the_grinder", name: "The Grinder", icon: "⚙️", group: "feats",
    desc: "Win from a king and pawn versus king endgame." },
  { key: "flag_bearer", name: "Flag Bearer", icon: "🚩", group: "feats",
    desc: "Win on time." },
  { key: "down_to_wire", name: "Down to the Wire", icon: "⏳", group: "feats",
    desc: "Win with under a second left on your own clock." },
  { key: "escape_artist", name: "Escape Artist", icon: "🪄", group: "feats",
    desc: "Draw by stalemate while down at least a rook's worth of material." },
  { key: "fortress", name: "Fortress", icon: "🛡️", group: "feats",
    desc: "Draw by repetition while behind on material." },
  { key: "perpetual_check", name: "Perpetual Check", icon: "♾️", group: "feats",
    desc: "Draw by repetition where your last six moves all gave check." },
  { key: "pacifist", name: "Pacifist", icon: "🕊️", group: "feats",
    desc: "Win a game without capturing a single piece." },
  { key: "queen_sacrifice", name: "Queen Sacrifice", icon: "💎", group: "feats",
    desc: "Give up your queen and win within the next 10 moves." },
  { key: "full_house", name: "Full House", icon: "🏠", group: "feats",
    desc: "Win a game with all 16 of your pieces still on the board at move 20." },
  { key: "no_time_wasted", name: "No Time Wasted", icon: "🏃", group: "feats",
    desc: "Win a game where every one of your moves took under 5 seconds." },

  // ---- hidden ----
  { key: "oops", name: "Oops", icon: "🙈", group: "hidden", hidden: true,
    desc: "Resign on move 1." },
  { key: "hasty", name: "Hasty", icon: "🐌", group: "hidden", hidden: true,
    desc: "Lose on time in a 10+0 game with fewer than 10 moves played." },
  { key: "bongcloud", name: "Bongcloud", icon: "☁️", group: "hidden", hidden: true,
    desc: "Play Ke2 (or Ke7) on move 2 and win." },
  { key: "mirror_match", name: "Mirror Match", icon: "🪞", group: "hidden", hidden: true,
    desc: "Play a game where both sides' first 10 moves are symmetrical." },
  { key: "stalemate_sadness", name: "Stalemate Sadness", icon: "😭", group: "hidden", hidden: true,
    desc: "Stalemate your opponent while up a queen or more." },
  { key: "draw_master", name: "Draw Master", icon: "🤝", group: "hidden", hidden: true,
    desc: "Draw 10 games in a row." },
  { key: "rating_rollercoaster", name: "Rating Rollercoaster", icon: "🎢", group: "hidden", hidden: true,
    desc: "Gain and then lose 100 rating points in a single day." },
  { key: "chatty", name: "Chatty", icon: "💬", group: "hidden", hidden: true,
    desc: "Send 100 chat messages." },
  { key: "rage_quit", name: "Rage Quit", icon: "😤", group: "hidden", hidden: true,
    desc: "Resign within two seconds of losing a piece." },
];

const GROUPS = [
  { key: "milestones", title: "Milestones" },
  { key: "formats", title: "Modes & formats" },
  { key: "feats", title: "Feats" },
  { key: "hidden", title: "Hidden" },
];

const BY_KEY = {};
for (const a of ACHIEVEMENTS) BY_KEY[a.key] = a;

function maxTier(a) {
  return a.tiers ? a.tiers.length : 1;
}

// Human description of one tier of an achievement.
function describe(a, tier) {
  if (!a.tiers) return a.desc;
  const t = Math.max(1, Math.min(tier || 1, a.tiers.length));
  if (a.tierDescs) return a.tierDescs[t - 1];
  return a.desc.replace("{n}", String(a.tiers[t - 1]));
}

// "Gold" etc. for a tiered achievement, or null for a one-shot one.
function tierName(a, tier) {
  if (!a.tiers) return null;
  return TIER_NAMES[Math.max(1, Math.min(tier, a.tiers.length)) - 1];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ACHIEVEMENTS, GROUPS, BY_KEY, TIER_NAMES, maxTier, describe, tierName };
}
