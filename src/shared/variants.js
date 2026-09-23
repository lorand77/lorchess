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
  { key: 'chess960', label: 'Chess960',  standardSetup: false, reviewable: true },
  { key: 'atomic',   label: 'Atomic',    standardSetup: true,  reviewable: false },
  { key: 'pawnwars', label: 'Pawn Wars', standardSetup: false, reviewable: false },
];

// A Map, not a plain object: these keys come off the wire, and a lookup of
// "__proto__" on an object literal returns Object.prototype — truthy, and
// therefore accepted as a real variant.
const BY_KEY = new Map(VARIANTS.map((v) => [v.key, v]));

// Anything unrecognised becomes a standard game rather than an error: a variant
// is a preference, not an instruction that can fail.
function resolveVariant(name) {
  return BY_KEY.has(name) ? name : 'standard';
}

function variantLabel(name) {
  return BY_KEY.get(resolveVariant(name)).label;
}

function usesStandardSetup(name) {
  return !!BY_KEY.get(resolveVariant(name)).standardSetup;
}

function isReviewable(name) {
  return !!BY_KEY.get(resolveVariant(name)).reviewable;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VARIANTS, BY_KEY, resolveVariant, variantLabel, usesStandardSetup, isReviewable };
}
