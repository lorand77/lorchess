"use strict";

// The catalogue of time controls, shared by the lobby UI and the server the
// same way chess.js is: one file, loaded as a browser <script> global (served
// at /js/timeControls.js) and as a Node `require`.
//
// This is an ALLOWLIST, not a suggestion. Seeks and challenges arrive over a
// socket, so the server resolves the client's `tc` key against this table and
// uses the resolved milliseconds — a crafted payload can't conjure a game with
// a 24-hour clock or a negative one.

const TIME_CONTROLS = [
  { key: '1+0',   label: 'Bullet 1+0',     initialMs:   60 * 1000, incrementMs:  0 },
  { key: '2+1',   label: 'Bullet 2+1',     initialMs:  120 * 1000, incrementMs:  1000 },
  { key: '3+0',   label: 'Blitz 3+0',      initialMs:  180 * 1000, incrementMs:  0 },
  { key: '3+2',   label: 'Blitz 3+2',      initialMs:  180 * 1000, incrementMs:  2000 },
  { key: '5+0',   label: 'Blitz 5+0',      initialMs:  300 * 1000, incrementMs:  0 },
  { key: '5+3',   label: 'Blitz 5+3',      initialMs:  300 * 1000, incrementMs:  3000 },
  { key: '10+0',  label: 'Rapid 10+0',     initialMs:  600 * 1000, incrementMs:  0 },
  { key: '10+5',  label: 'Rapid 10+5',     initialMs:  600 * 1000, incrementMs:  5000 },
  { key: '15+10', label: 'Rapid 15+10',    initialMs:  900 * 1000, incrementMs: 10000 },
  { key: '30+0',  label: 'Classical 30+0', initialMs: 1800 * 1000, incrementMs:  0 },
];

// Matches the historical server default (10 minutes, no increment), so games
// created before time controls existed replay with the clock they were played on.
const DEFAULT_TC = '10+0';

function findTimeControl(key) {
  return TIME_CONTROLS.find((t) => t.key === key) || null;
}

// Resolve a client-supplied key, falling back to the default rather than
// throwing — callers treat an unknown key as "they meant the default".
function resolveTimeControl(key) {
  return findTimeControl(key) || findTimeControl(DEFAULT_TC);
}

// Render stored milliseconds back to a label, for game rows whose preset key
// isn't kept (only the resolved ms are persisted).
function describeTimeControl(initialMs, incrementMs) {
  if (initialMs == null) return 'unlimited';
  const mins = Math.round(initialMs / 60000);
  const inc = Math.round((incrementMs || 0) / 1000);
  const found = TIME_CONTROLS.find(
    (t) => t.initialMs === initialMs && t.incrementMs === (incrementMs || 0)
  );
  return found ? found.label : `${mins}+${inc}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TIME_CONTROLS, DEFAULT_TC, findTimeControl, resolveTimeControl, describeTimeControl };
}
