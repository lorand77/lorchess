"use strict";

// The catalogue of chess variants, shared by the server and the browser the
// same way timeControls.js is. One list, so nothing can drift: adding a variant
// here makes it selectable, validatable, labelled and matchmade without
// touching anything else. The one exception is its win badge: add a
// `<key>_wins` entry to achievements.js and its check to the achievements
// service (a test fails until both exist).
//
// This file exists because the knowledge WAS duplicated — an allowlist in the
// lobby, a separate ternary in matchmaking, a label map in the client — and the
// copies fell out of step, silently turning Atomic games into standard ones.

const VARIANTS = [
  {
    key: 'standard',
    label: 'Standard',
    // Does the game open from the ordinary chess setup? A handicap edits that
    // setup, so it only means anything where this is true.
    standardSetup: true,
    // Can the game review (Stockfish) handle it? It only knows the ordinary
    // rules; Chess960 differs only in the starting position, so that one is fine.
    reviewable: true,
    // May a game of it be rated? Every variant moves the same Elo, so one whose
    // games are not yet trusted to say who is stronger stays casual.
    rateable: true,
    // Do the achievements that read the material on the board (a comeback from
    // a deficit, a sacrifice, every piece still standing) mean anything? Not
    // where a captured piece comes back, nor where losing material is the aim.
    materialBadges: true,
    // Can the achievements that replay a game's moves (mates, en passant,
    // smothered mate, ...) run on it at all? They read an 8x8 board.
    moveBadges: true,
    // Does LorFish play it? A variant is switched on here once the bot both
    // keeps to its rules and plays it with some sense.
    bot: true,
  },
  // Draws a fresh back rank for every game (chess960.js has the generator).
  { key: 'chess960', label: 'Chess960', standardSetup: false, reviewable: true, rateable: true,
    materialBadges: true, moveBadges: true, bot: true, shuffled: true },
  { key: 'atomic', label: 'Atomic', standardSetup: true, reviewable: false, rateable: true,
    materialBadges: true, moveBadges: true, bot: true },
  // Its own fixed start: pawns only, on the outermost ranks. The same FEN as
  // PAWN_WARS_START in chess.js (a test holds them together); repeated here
  // because this file also loads in the browser without chess.js.
  { key: 'pawnwars', label: 'Pawn Wars', standardSetup: false, reviewable: false, rateable: true,
    materialBadges: true, moveBadges: true, bot: true, startFen: 'pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1' },
  // Captured pieces change sides and can be dropped back on the board. It opens
  // from the standard setup, but takes no handicap until odds have been tried
  // with pockets, so standardSetup is false. Casual while it is new.
  { key: 'crazyhouse', label: 'Crazyhouse', standardSetup: false, reviewable: false, rateable: false,
    materialBadges: false, moveBadges: true, bot: true },
  // The aim is to lose every piece, captures are compulsory and there is no
  // castling: the ordinary setup without castling rights, ANTICHESS_START in
  // chess.js (a test holds them together). Casual while it is new.
  { key: 'antichess', label: 'Antichess', standardSetup: false, reviewable: false, rateable: false,
    materialBadges: false, moveBadges: true, bot: true, startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1' },
  // Ordinary chess, and a king that reaches the centre (d4, e4, d5, e5) wins.
  // It opens from the standard setup and a handicap leaves the rule alone.
  // Stockfish's review only knows the ordinary win. Casual while it is new.
  { key: 'kingofthehill', label: 'King of the Hill', standardSetup: true, reviewable: false, rateable: false,
    materialBadges: true, moveBadges: true, bot: true },
  // Ordinary chess, and giving check a third time wins. Opens from the standard
  // setup (with no checks given, which its FEN writes as "3+3"), and a
  // handicap leaves the rule alone. Casual while it is new.
  { key: 'threecheck', label: 'Three-check', standardSetup: true, reviewable: false, rateable: false,
    materialBadges: true, moveBadges: true, bot: true },
  // Two boards, two teams of two: a capture goes to the partner on the other
  // board (src/shared/bughouse.js, src/game/matches.js). `teams` keeps it out
  // of everything that seats two players — the lobby's pickers, quick match,
  // seeks and challenges — and out of "Jack of All Trades". Each board is its
  // own games row, so it can't be replayed alone (no move badges); pieces
  // change hands (no material badges). LorFish plays its seats on the server,
  // not as an AI game, so `bot` is off; `seatBots` says it may fill a
  // table's empty seats. Always casual.
  { key: 'bughouse', label: 'Bughouse', standardSetup: false, reviewable: false, rateable: false,
    materialBadges: false, moveBadges: false, bot: false, teams: true, seatBots: true },
  // Four players on one cross-shaped board, Red and Yellow against Blue and
  // Green (chess.com's Teams rules), in its own engine (fourPlayer.js). Its
  // start is the engine's, in FEN4 (a test holds them together). A team game,
  // seated at a table of four; LorFish can't take a seat yet, so a table
  // starts only when four people sit. No 8x8 board for the move badges, no
  // material badges. Always casual.
  { key: 'fourplayer', label: 'Four-Player Chess', standardSetup: false, reviewable: false, rateable: false,
    materialBadges: false, moveBadges: false, bot: false, teams: true, seatBots: false,
    startFen: 'R-0,0,0,0-1,1,1,1-1,1,1,1-0,0,0,0-0-3,yR,yN,yB,yK,yQ,yB,yN,yR,3/3,yP,yP,yP,yP,yP,yP,yP,yP,3/14/bR,bP,10,gP,gR/bN,bP,10,gP,gN/bB,bP,10,gP,gB/bQ,bP,10,gP,gK/bK,bP,10,gP,gQ/bB,bP,10,gP,gB/bN,bP,10,gP,gN/bR,bP,10,gP,gR/14/3,rP,rP,rP,rP,rP,rP,rP,rP,3/3,rR,rN,rB,rQ,rK,rB,rN,rR,3' },
  // A board with no edges (infinitechess.org's Classical rules), played by its
  // own engine (engines.js). Its start is an ICN position, the same as
  // infiniteChess.js's Classical setup (a test holds them together). Casual
  // while it is new; no handicap, no review, and no achievement that replays
  // moves on an 8x8 board.
  { key: 'infinite', label: 'Infinite Chess', standardSetup: false, reviewable: false, rateable: false,
    materialBadges: false, moveBadges: false, bot: true,
    startFen: 'w 0/100 1 (8|1) checkmate B3,1|B6,1|K5,1+|N2,1|N7,1|P1,2+|P2,2+|P3,2+|P4,2+|P5,2+|P6,2+|P7,2+|P8,2+|Q4,1|R1,1+|R8,1+|b3,8|b6,8|k5,8+|n2,8|n7,8|p1,7+|p2,7+|p3,7+|p4,7+|p5,7+|p6,7+|p7,7+|p8,7+|q4,8|r1,8+|r8,8+' },
];

// A Map, not a plain object: these keys come off the wire, and a lookup of
// "__proto__" on an object literal returns Object.prototype — truthy, and
// therefore accepted as a real variant. Named for this file: as browser
// globals, achievements.js's lookup table must not clash with it.
const VARIANTS_BY_KEY = new Map(VARIANTS.map((v) => [v.key, v]));

// Anything unrecognised becomes a standard game rather than an error: a variant
// is a preference, not an instruction that can fail.
function resolveVariant(name) {
  return VARIANTS_BY_KEY.has(name) ? name : 'standard';
}

function variantLabel(name) {
  return VARIANTS_BY_KEY.get(resolveVariant(name)).label;
}

function usesStandardSetup(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).standardSetup;
}

function isReviewable(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).reviewable;
}

function isRateable(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).rateable;
}

function hasMaterialBadges(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).materialBadges;
}

function hasMoveBadges(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).moveBadges;
}

function hasBot(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).bot;
}

// Played by two teams of two (Bughouse on two boards, four-player chess on
// one) rather than by two players: seated at a table of four, never offered
// or matched as a two-player game.
function isTeamGame(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).teams;
}

// May LorFish take a team game's empty seats? Then a table can start before
// four people sit, and "Play the computer" offers the game.
function hasSeatBots(name) {
  return !!VARIANTS_BY_KEY.get(resolveVariant(name)).seatBots;
}

// Where a game of this variant opens: null means the standard setup (or a
// handicap built from it), a FEN is a fixed start of the variant's own, and
// 'shuffled' tells the caller to draw one per game. Matchmaking reads this, so
// a new variant with its own start needs no change there.
function startOf(name) {
  const v = VARIANTS_BY_KEY.get(resolveVariant(name));
  return v.shuffled ? 'shuffled' : v.startFen || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VARIANTS, VARIANTS_BY_KEY, resolveVariant, variantLabel, usesStandardSetup, isReviewable, isRateable,
    hasMaterialBadges, hasMoveBadges, hasBot, isTeamGame, hasSeatBots, startOf,
  };
}
