"use strict";

// Ratings for a set of players from the games between them, by maximum
// likelihood under the Elo model: a player rated d above another is expected
// to score 1 / (1 + 10^(-d/400)) a game. Elo only measures differences, so some
// players are pinned at known ratings (Stockfish's UCI_Elo levels, for
// scripts/lorfishLevels.js) and the rest are fitted around them. Every game
// counts at once, so a player rated only through a chain of others still gets
// a rating, and an interval wide enough to show it.
//
// Draws are half a point, as in the score. Each pairing also gets one virtual
// drawn game, so a clean sweep gives a finite rating rather than infinity; it
// moves a 1000-game pairing by a fraction of an Elo point.
//
// Pure: no I/O, so the test suite can check it against known ratings.

const C = Math.LN10 / 400;

function expectedScore(diff) {
  return 1 / (1 + Math.pow(10, -diff / 400));
}

// pairings: [{ a, b, n, score }], score being a's points from n games.
// pinned: Map of player to its fixed rating. Returns a Map of every player
// to its rating. Newton's method on the log-likelihood: with at least one pin
// in reach of every player it is concave with a single maximum.
function fitRatings(pairings, pinned) {
  const players = new Set(pinned.keys());
  for (const p of pairings) players.add(p.a).add(p.b);
  const free = [...players].filter((p) => !pinned.has(p));
  checkAnchored(pairings, pinned, free);

  const at = new Map(free.map((p, i) => [p, i]));
  const start = [...pinned.values()].reduce((s, r) => s + r, 0) / pinned.size;
  const rating = new Map([...pinned, ...free.map((p) => [p, start])]);
  for (let iter = 0; iter < 200; iter++) {
    const grad = new Array(free.length).fill(0);
    const hess = free.map(() => new Array(free.length).fill(0));
    for (const { a, b, n, score } of pairings) {
      const games = n + 1;
      const points = score + 0.5;
      const e = expectedScore(rating.get(a) - rating.get(b));
      const g = C * (points - games * e);
      const h = C * C * games * e * (1 - e);
      const i = at.get(a);
      const j = at.get(b);
      if (i !== undefined) { grad[i] += g; hess[i][i] += h; }
      if (j !== undefined) { grad[j] -= g; hess[j][j] += h; }
      if (i !== undefined && j !== undefined) { hess[i][j] -= h; hess[j][i] -= h; }
    }
    // hess holds minus the Hessian, so the Newton step solves hess · step = grad.
    const step = solve(hess, grad);
    let biggest = 0;
    free.forEach((p, k) => {
      // A start far from the answer can overshoot; 400 at a time is plenty.
      const s = Math.max(-400, Math.min(400, step[k]));
      rating.set(p, rating.get(p) + s);
      biggest = Math.max(biggest, Math.abs(s));
    });
    if (biggest < 1e-6) break;
  }
  return rating;
}

// Every fitted player needs a path of games to a pinned one, or nothing fixes
// where its rating sits.
function checkAnchored(pairings, pinned, free) {
  if (!pinned.size) throw new Error("no pinned ratings to measure from");
  const reached = new Set(pinned.keys());
  for (let grew = true; grew;) {
    grew = false;
    for (const { a, b } of pairings) {
      if (reached.has(a) !== reached.has(b)) {
        reached.add(a).add(b);
        grew = true;
      }
    }
  }
  const lost = free.filter((p) => !reached.has(p));
  if (lost.length) throw new Error(`no games link ${lost.join(", ")} to a pinned rating`);
}

// Gaussian elimination with partial pivoting; the systems here are a dozen
// players at most.
function solve(m, v) {
  const n = v.length;
  const rows = m.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let r = col + 1; r < n; r++) {
      const f = rows[r][col] / rows[col][col];
      for (let c = col; c <= n; c++) rows[r][c] -= f * rows[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = rows[r][n];
    for (let c = r + 1; c < n; c++) s -= rows[r][c] * x[c];
    x[r] = s / rows[r][r];
  }
  return x;
}

// 95% intervals by the bootstrap: refit on resampled games, many times over.
// groups: [{ a, b, units: [{ n, score }] }], where a unit is the games of one
// pairing that share an opening (one each way round), resampled together so
// the bootstrap keeps whatever the opening did to both. Returns a Map of
// player to { lo, hi }.
function bootstrapIntervals(groups, pinned, { samples = 200, rng = Math.random } = {}) {
  const runs = [];
  for (let s = 0; s < samples; s++) {
    const pairings = groups.map(({ a, b, units }) => {
      let n = 0;
      let score = 0;
      for (let k = 0; k < units.length; k++) {
        const u = units[Math.floor(rng() * units.length)];
        n += u.n;
        score += u.score;
      }
      return { a, b, n, score };
    });
    runs.push(fitRatings(pairings, pinned));
  }
  const out = new Map();
  for (const player of runs[0].keys()) {
    const values = runs.map((r) => r.get(player)).sort((x, y) => x - y);
    const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
    out.set(player, { lo: at(0.025), hi: at(0.975) });
  }
  return out;
}

module.exports = { expectedScore, fitRatings, bootstrapIntervals };
