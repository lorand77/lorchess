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
  // ---- evaluation ----
  //
  // From the side to move's point of view, in centipawns, like LorFish's. Each
  // term is one pass over the pieces: attack tests here walk every piece, and
  // the evaluation runs at every leaf.
  //
  // Material, valued for a board without edges: a knight can't reach anything
  // far off and a slider reaches everything, so knights are worth less than
  // usual and rooks and queens, the pieces that mate here, more.
  pieceValues: { p: 100, n: 250, b: 400, r: 600, q: 1150, k: 0 },

  evaluate(chess) {
    const kings = { w: null, b: null };
    const sliders = { w: { line: 0, diag: 0 }, b: { line: 0, diag: 0 } };
    for (const p of chess.board.values()) {
      if (p.t === 'k') kings[p.c] = p;
      if (p.t === 'r' || p.t === 'q') sliders[p.c].line++;
      if (p.t === 'b' || p.t === 'q') sliders[p.c].diag++;
    }
    let score = 0;
    for (const p of chess.board.values()) {
      let v = this.pieceValues[p.t];
      if (p.t === 'p') v += this.pawnBonus(chess, p);
      else if (p.t !== 'k') v -= this.strayPenalty(p, kings[p.c === 'w' ? 'b' : 'w']);
      score += p.c === 'w' ? v : -v;
    }
    score -= this.kingDanger(chess, kings.w, sliders.b);
    score += this.kingDanger(chess, kings.b, sliders.w);
    return chess.turn === 'w' ? score : -score;
  },

  // A pawn is worth more the nearer it is to promoting (rank 8 for White, 1
  // for Black), and more again with no enemy pawn ahead of it on its own file
  // or either beside it.
  PAWN_STEP: 8,
  PASSED: [0, 10, 20, 35, 55, 80],
  pawnBonus(chess, pawn) {
    const up = pawn.c === 'w' ? 1 : -1;
    const adv = Math.max(0, Math.min(5, pawn.c === 'w' ? pawn.y - 2 : 7 - pawn.y));
    let passed = true;
    for (const q of chess.board.values()) {
      if (q.t === 'p' && q.c !== pawn.c && Math.abs(q.x - pawn.x) <= 1 && (q.y - pawn.y) * up > 0) {
        passed = false;
        break;
      }
    }
    return this.PAWN_STEP * adv + (passed ? this.PASSED[adv] : 0);
  },

  // A piece gone far from the enemy king does nothing on a board this size,
  // and a slider's candidate moves can take it a long way. A knight or bishop
  // pays beyond 8 squares, a rook or queen beyond 16; the cost stops growing
  // at 40 squares further, as by then the piece is simply out of play.
  STRAY: { n: [8, 2], b: [8, 1], r: [16, 1], q: [16, 1] },
  strayPenalty(p, enemyKing) {
    const [free, rate] = this.STRAY[p.t];
    const d = Math.max(Math.abs(p.x - enemyKing.x), Math.abs(p.y - enemyKing.y));
    return rate * Math.min(40, Math.max(0, d - free));
  },

  // The danger to `king`: each of its eight lines with nothing close along it
  // (no piece within two squares) is an open road for an enemy slider coming
  // from any distance — ranks and files for rooks and queens, diagonals for
  // bishops and queens — counted only if the enemy has such a slider, and
  // twice if it has two. Pieces of its own beside it shelter it.
  OPEN_LINE: 30,
  OPEN_DIAG: 20,
  SHELTER: 8,
  kingDanger(chess, king, enemySliders) {
    const near = new Map();   // direction -> distance of the nearest piece on it
    let shelter = 0;
    for (const p of chess.board.values()) {
      if (p === king) continue;
      const dx = p.x - king.x, dy = p.y - king.y;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d === 1 && p.c === king.c) shelter++;
      if (dx && dy && Math.abs(dx) !== Math.abs(dy)) continue;
      const dir = Math.sign(dx) + ',' + Math.sign(dy);
      if (!near.has(dir) || d < near.get(dir)) near.set(dir, d);
    }
    let danger = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const d = near.get(dx + ',' + dy);
      if (d !== undefined && d <= 2) continue;
      danger += dx && dy
        ? this.OPEN_DIAG * Math.min(2, enemySliders.diag)
        : this.OPEN_LINE * Math.min(2, enemySliders.line);
    }
    return danger - this.SHELTER * shelter;
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
    return chess.inCheck() ? -(this.MATE - (chess.history.length - this.rootPly)) : this.drawScore(chess);
  },

  // A draw, from the side to move's point of view, with contempt: a little
  // worse than level for the side LorFish is playing, a little better for its
  // opponent. On a board this open both sides can nearly always shuffle, and
  // a draw scored as level would be taken from any level position; this way
  // the search plays on unless every other line is worse. A worse position
  // still takes a perpetual check, as it should.
  CONTEMPT: 20,
  drawScore(chess) {
    return chess.turn === this.rootSide ? -this.CONTEMPT : this.CONTEMPT;
  },

  // Drawn whatever is played: repeated in the game and this line (one more
  // pass would make threefold), the 50-move rule, or material nobody can mate
  // with.
  isDraw(chess) {
    // The key makeMove just counted, rather than building it again.
    const last = chess.history[chess.history.length - 1];
    const key = (last && last.key) || chess.positionKey();
    return (chess.positionCounts.get(key) || 0) >= 2
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
    if (this.isDraw(chess)) return this.drawScore(chess);
    const checked = chess.inCheck();
    // Out of check, the stand-pat first: when it already beats beta, the
    // captures are never needed, and listing them is most of the cost.
    if (!checked) {
      const standPat = this.evaluate(chess);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
      if (qdepth >= this.QDEPTH) return alpha;
    }
    const moves = chess.candidateMoves(!checked);
    if (checked && !moves.length) return this.endScore(chess);
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
    if (this.isDraw(chess)) return this.drawScore(chess);
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
    this.rootSide = chess.turn;
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
