"use strict";

// The catalogue of chess variants, shared by the server and the browser the
// same way timeControls.js is. One list, so nothing can drift: adding a variant
// here makes it selectable, validatable, labelled and matchmade without
// touching anything else.
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
    // Can LorFish review it? It only knows the ordinary rules; Chess960 differs
    // only in the starting position, so that one is fine.
    reviewable: true,
  },
  // Draws a fresh back rank for every game (chess960.js has the generator).
  { key: 'chess960', label: 'Chess960',  standardSetup: false, reviewable: true, shuffled: true },
  { key: 'atomic',   label: 'Atomic',    standardSetup: true,  reviewable: false },
  // Its own fixed start: pawns only, on the outermost ranks. The same FEN as
  // PAWN_WARS_START in chess.js (a test holds them together); repeated here
  // because this file also loads in the browser without chess.js.
  { key: 'pawnwars', label: 'Pawn Wars', standardSetup: false, reviewable: false,
    startFen: 'pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1' },
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
    VARIANTS, VARIANTS_BY_KEY, resolveVariant, variantLabel, usesStandardSetup, isReviewable, startOf,
  };
}
