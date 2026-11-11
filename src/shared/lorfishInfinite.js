"use strict";

// LorFish for infinite chess (src/shared/infiniteChess.js). LorFish itself
// cannot play there: its search lists every legal move, and a slider on an
// open board has infinitely many; its evaluation reads a 64-square array. This
// is the same search — negamax with alpha-beta, a capture search, mate scores
// counted in plies from the root, repetition as a draw, the pruned root and
// killer moves, the temperature that makes the weaker levels — over the finite
// list of moves worth searching that the engine gives (candidateMoves), with
// an evaluation of its own. Its scores mean what LorFish's do, and its
// searchRoot, getBestMove and analyse take and return the same things, so a
// caller need not know which of the two it holds.
//
// Loaded as a browser <script> or a worker's importScripts after
// infiniteChess.js and lorfish.js (it borrows LorFish's sampling, so a
// temperature means the same in both), and as a Node `require`.

const LorFishInfinite = {
  // Material, from the side to move's point of view: the evaluation for now.
  pieceValues: { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0 },

  evaluate(chess) {
    let score = 0;
    for (const p of chess.board.values()) {
      score += p.c === 'w' ? this.pieceValues[p.t] : -this.pieceValues[p.t];
    }
    return chess.turn === 'w' ? score : -score;
  },

  MATE: 100000,
  MAX_DEPTH: 6,
  clampDepth(depth) {
    return Math.min(this.MAX_DEPTH, Math.max(1, Math.floor(Number(depth)) || 1));
  },

  // A position with no move left, for the side to move: mated, or stalemate.
  // (The engine's result() would say the same, after asking again whether a
  // move is left; the search already knows there is none.)
  endScore(chess) {
    return chess.inCheck() ? -(this.MATE - (chess.history.length - this.rootPly)) : 0;
  },

  // Drawn whatever is played: repeated in the game and this line (one more
  // pass would make threefold), the 50-move rule, or material nobody can mate
  // with.
  isDraw(chess) {
    return (chess.positionCounts.get(chess.positionKey()) || 0) >= 2
      || chess.halfmove >= 100 || chess.isInsufficientMaterial();
  },

  // Killer moves and ordering, as in LorFish: captures by most valuable
  // victim, least valuable attacker; promotions; then the quiet moves that
  // last cut the search off at this ply.
  KILLER_BONUS: 950,
  moveKey(m) {
    return m.from.x + ',' + m.from.y + '>' + m.to.x + ',' + m.to.y + (m.promo || '');
  },
  addKiller(ply, m) {
    const k = this.moveKey(m), slot = this.killers[ply] || (this.killers[ply] = []);
    if (slot[0] !== k) { slot[1] = slot[0]; slot[0] = k; }
  },
  orderMoves(chess, moves, killers) {
    const scored = moves.map((m) => {
      let s = 0;
      if (m.capture) {
        const victim = m.enpassant ? 'p' : chess.pieceAt(m.to.x, m.to.y).t;
        s += this.pieceValues[victim] * 10 - ((this.pieceValues[m.piece] / 100) | 0);
      } else if (killers) {
        const k = this.moveKey(m);
        if (k === killers[0] || k === killers[1]) s += this.KILLER_BONUS;
      }
      if (m.promo) s += 8000;
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.m);
  },

  // Captures only, out of check; in check, every answer to it, since standing
  // still is not one. Chains stop at a depth, as a capture can be answered by
  // one from anywhere on the board.
  QDEPTH: 8,
  quiescence(chess, alpha, beta, qdepth) {
    this.nodes++;
    if (qdepth > this.maxQ) this.maxQ = qdepth;
    if (this.isDraw(chess)) return 0;
    const checked = chess.inCheck();
    const moves = chess.candidateMoves(!checked);
    if (checked && !moves.length) return this.endScore(chess);
    if (!checked) {
      const standPat = this.evaluate(chess);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
      if (qdepth >= this.QDEPTH) return alpha;
    }
    let best = checked ? -Infinity : alpha;
    for (const m of this.orderMoves(chess, moves)) {
      chess.makeMove(m);
      const score = -this.quiescence(chess, -beta, -alpha, qdepth + 1);
      chess.undoMove();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    // Out of check with no capture worth it, the stand-pat stands (and
    // without a single capture there is still a quiet move: the side is not
    // stalemated just because the list holds no captures).
    return best;
  },

  negamax(chess, depth, alpha, beta) {
    this.nodes++;
    if (this.isDraw(chess)) return 0;
    if (depth <= 0 && !chess.inCheck()) return this.quiescence(chess, alpha, beta, 0);
    const moves = chess.candidateMoves();
    if (!moves.length) return this.endScore(chess);
    // In check at the horizon: one more ply, as LorFish does.
    if (depth <= 0) depth = 1;
    const ply = chess.history.length - this.rootPly;
    let best = -Infinity;
    for (const m of this.orderMoves(chess, moves, this.killers[ply])) {
      chess.makeMove(m);
      const v = -this.negamax(chess, depth - 1, -beta, -alpha);
      chess.undoMove();
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (!m.capture) this.addKiller(ply, m);
        break;
      }
    }
    return best;
  },

  // As LorFish.searchRoot: every candidate scored (exactly, unless `prune`
  // lets one that can't be picked fail low early), then the best taken, with
  // the jitter or the temperature's sampling. SAN is ICN's long form.
  searchRoot(chess, depth, opts) {
    const o = opts || {};
    const rng = o.rng || Math.random;
    const hot = o.temperature > 0;
    const noise = !!o.noise && !hot;
    const prune = !!o.prune && !hot;
    const reach = noise ? 20 : 0;
    this.nodes = 0;
    this.maxQ = 0;
    this.rootPly = chess.history.length;
    this.killers = [];
    const effDepth = this.clampDepth(depth);
    const evals = [];
    let best = null, top = -Infinity;
    // The board is a Map, and moves made and taken back reorder it, so the
    // same position can list its moves in another order. Put them in a fixed
    // one first: the same position, the same jitter on the same move.
    const keyed = chess.candidateMoves().map((m) => [this.moveKey(m), m]);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const m of this.orderMoves(chess, keyed.map((k) => k[1]))) {
      const san = chess.moveToSan(m);
      chess.makeMove(m);
      const floor = prune ? top - reach - 1 : -Infinity;
      const raw = -this.negamax(chess, effDepth - 1, -Infinity, -floor);
      chess.undoMove();
      if (raw > top) top = raw;
      const jitter = (noise && raw < 99000) ? Math.floor(rng() * 21) - 10 : 0;
      const v = raw + jitter;
      if (!best || v > best.v) best = { move: m, san, raw, v };
      evals.push({ move: m, san, raw, v });
    }
    if (hot && evals.length) best = LorFish.sample(evals, o.temperature, rng);
    return { evals, best, effDepth };
  },

  getBestMove(chess, depth, opts) {
    const { best } = this.searchRoot(chess, depth, Object.assign({ noise: true, prune: true }, opts));
    return best ? best.move : null;
  },

  analyse(chess, depth) {
    const { best, effDepth } = this.searchRoot(chess, depth, { noise: false });
    if (!best) return null;
    return { score: best.raw, depth: effDepth, san: best.san, move: best.move };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  globalThis.LorFish = require('./lorfish.js').LorFish;
  module.exports = { LorFishInfinite };
}
