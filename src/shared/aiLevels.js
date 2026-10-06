"use strict";

// LorFish's playing levels, shared by the server and the browser the same way
// variants.js is. A level is what the player picks and what a game records;
// the search depth and temperature behind it are LorFish's business (see
// LorFish.searchRoot). The page builds its picker from this list, the API
// resolves the client's key against it, and achievements read the stored key.
//
// The ratings were measured in self-play with scripts/lorfishLevels.js, taking
// depth 2 as 1400 (see "Engine" in docs/design.md). Beginner and Casual share
// a depth, so a game stores the level, not just the depth.

const AI_LEVELS = [
  { key: 'beginner',     label: 'Beginner',     elo: 600,  depth: 1, temperature: 60 },
  { key: 'casual',       label: 'Casual',       elo: 1000, depth: 1, temperature: 10 },
  { key: 'intermediate', label: 'Intermediate', elo: 1400, depth: 2, temperature: 0 },
  // Not measured yet: a guess carried over from before the levels existed.
  { key: 'advanced',     label: 'Advanced',     elo: 1800, depth: 4, temperature: 0 },
];

const DEFAULT_AI_LEVEL = 'intermediate';

// A Map, for the same reason as VARIANTS_BY_KEY: these keys come off the wire.
const AI_LEVELS_BY_KEY = new Map(AI_LEVELS.map((l) => [l.key, l]));

// Anything unrecognised plays the default, as an unknown variant plays
// standard: a level is a preference, not an instruction that can fail.
function resolveAiLevel(key) {
  return AI_LEVELS_BY_KEY.has(key) ? key : DEFAULT_AI_LEVEL;
}

function aiLevelOf(key) {
  return AI_LEVELS_BY_KEY.get(resolveAiLevel(key));
}

function aiLevelLabel(key) {
  const level = aiLevelOf(key);
  return `${level.label} (~${level.elo})`;
}

// The level a bare depth stood for before levels existed: the picker offered 2
// and 4, and the strongest-setting achievement counted 4 and up. Anything else
// (an old picker also offered 3) matches no level and gets null.
function aiLevelForDepth(depth) {
  const d = Number(depth);
  if (d === 2) return 'intermediate';
  if (d >= 4) return 'advanced';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AI_LEVELS, AI_LEVELS_BY_KEY, DEFAULT_AI_LEVEL, resolveAiLevel, aiLevelOf, aiLevelLabel, aiLevelForDepth,
  };
}
