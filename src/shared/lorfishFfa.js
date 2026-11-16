"use strict";

// LorFish for four-player free-for-all (src/shared/fourPlayer.js, mode 'ffa').
// Teams is a two-sided game to a search (lorfishFour.js); free-for-all is not:
// three opponents, each for themselves, each moving in turn. So this is a
// best-reply search (Schadd and Winands, "Best Reply Search for Multiplayer
// Games", 2011): LorFish's own moves, then the single strongest reply any
// one of the three could make, as though the other two passed, then LorFish
// again. The tree is two-sided — LorFish against "the opponents" — so
// alpha-beta works, and a depth reaches LorFish's own next move twice as soon
// as playing out all four turns would; a threat from Green is seen as soon as
// one from Blue. What it gives up: the opponents' moves are never combined,
// which is what a free-for-all opponent rarely does on purpose anyway.
//
// What else it must get right:
//   - Scores are always LorFish's own, the player at the root (`me`): its
//     points and pieces against the average of the other three's, since every
//     opponent's loss is its gain and placings are decided by points.
//   - Points as the engine scores them: a capture, a king taken, a check of
//     several kings. A player with no move is out (FourPlayer.concede): a
//     mated opponent's points go to its mater and its army counts for nothing
//     from then on. LorFish itself out — mated, stalemated, its king taken — is
//     the worst there is, sooner worse than later.
//   - The capture search: LorFish's captures or standing pat, then any one
//     opponent's capture or all of them passing, bounded by a depth, by
//     captures that can gain, and by a node budget shared between the root
//     moves, as in lorfishFour.js.
//   - The evaluation: material (pawn 100, knight 300, bishop 350, rook 500,
//     queen 950), a point worth POINT; pawns going towards their 8th rank,
//     where they promote; minor pieces towards the middle; a king's shelter.
//     Dead armies count for nothing. A test holds it to the board's symmetry.
//
// Its searchRoot, getBestMove and analyse take and return what LorFish's do,
// and it borrows LorFish.sample, so a temperature means the same in all three.
// Loaded as a browser <script> or importScripts after fourPlayer.js and
// lorfish.js, and as a Node `require`.

const LorFishFfa = {
  // ---- evaluation ----

  pieceValues: { p: 100, n: 300, b: 350, r: 500, q: 950, k: 0 },
  // A point, as material: a capture is worth its points as well as the
  // material it takes, and points decide the game.
  POINT: 50,
  // A pawn is worth more the further it has come towards its 8th rank, more
  // again over the last three.
  PAWN_STEP: 8,
  PAWN_NEAR: 16,
  CENTRE: 4,
  SHELTER: 12,

  tables() {
    if (this._tables) return this._tables;
    const pawn = {}, centre = new Array(196).fill(0);
    for (const c of FourPlayer.COLORS) {
      pawn[c] = new Array(196).fill(0);
      for (let sq = 0; sq < 196; sq++) {
        const y = Math.min(FourPlayer.frameOf(sq, c)[1], 7);
        pawn[c][sq] = this.PAWN_STEP * Math.max(0, y - 1) + (y > 3 ? this.PAWN_NEAR * (y - 3) : 0);
      }
    }
    for (let sq = 0; sq < 196; sq++) {
      const x = sq % 14, y = (sq - x) / 14;
      centre[sq] = Math.round(this.CENTRE * (7 - Math.max(Math.abs(x - 6.5), Math.abs(y - 6.5))));
    }
    this._tables = { pawn, centre };
    return this._tables;
  },

  // `me`'s standing: its own worth less the average of the other three's, a
  // player's worth being its points and, while it is still in, its pieces.
  evaluate(chess, me) {
    if (me === undefined) me = chess.turn;
    const { pawn, centre } = this.tables();
    const worth = {};
    for (const c of FourPlayer.COLORS) worth[c] = this.POINT * chess.points[c];
    for (let sq = 0; sq < 196; sq++) {
      const p = chess.squares[sq];
      if (!p || chess.out[p.c]) continue;
      let v = this.pieceValues[p.t];
      if (p.t === 'k') v += this.SHELTER * LorFishFour.shelter(chess, sq, p.c);
      else if (p.t === 'p') v += pawn[p.c][sq];
      else if (p.t === 'n' || p.t === 'b') v += centre[sq];
      worth[p.c] += v;
    }
    let others = 0;
    for (const c of FourPlayer.COLORS) if (c !== me) others += worth[c];
    return Math.round(worth[me] - others / 3);
  },

  // ---- the end of a game ----

  MATE: 100000,
  MAX_DEPTH: 6,
  clampDepth(depth) {
    return Math.min(this.MAX_DEPTH, Math.max(1, Math.floor(Number(depth)) || 1));
  },
  // LorFish out: the worst there is, sooner worse than later.
  outScore(chess) {
    return -(this.MATE - (chess.history.length - this.rootPly));
  },

  // ---- turns out of order ----

  // Give the turn to `c`, saving what it was. An en passant chance is only
  // for the player whose turn it really is next, so it lapses for anyone else.
  enter(chess, c) {
    const saved = { turn: chess.turn, ep: chess.ep };
    if (c !== chess.turn) chess.ep = null;
    chess.turn = c;
    return saved;
  },
  leave(chess, saved) {
    chess.turn = saved.turn;
    chess.ep = saved.ep;
  },

  // The opponents with no move are out, as on their turn; how many were put
  // out, for undo. In the capture search (`all` false) only those in check
  // are asked: a stalemate there is too rare to pay for.
  concedeStuck(chess, all) {
    let n = 0;
    for (const c of chess.active()) {
      if (c === this.me || chess.ended) continue;
      if (!all && !chess.inCheck(c)) continue;
      const saved = this.enter(chess, c);
      const none = chess.movesAsIfOn().length === 0;
      this.leave(chess, saved);
      if (none) {
        chess.concede(c);
        n++;
      }
    }
    return n;
  },
  undo(chess, n) {
    for (let i = 0; i < n; i++) chess.undoMove();
  },

  // ---- ordering ----

  KILLER_BONUS: 950,
  moveKey(m) {
    return m.color + m.from + '>' + m.to;
  },
  addKiller(ply, m) {
    const k = this.moveKey(m), slot = this.killers[ply] || (this.killers[ply] = []);
    if (slot[0] !== k) { slot[1] = slot[0]; slot[0] = k; }
  },
  // A live king taken first (it puts a player out), then captures of live
  // pieces by most valuable victim and least valuable attacker, promotions,
  // the killers; a dead piece taken is worth nothing.
  victimValue(chess, m) {
    if (m.enpassant) return chess.out[chess.squares[chess.ep.pawn].c] ? 0 : this.pieceValues.p;
    const v = chess.squares[m.to];
    if (chess.out[v.c]) return 0;
    return v.t === 'k' ? 100000 : this.pieceValues[v.t];
  },
  orderMoves(chess, moves, killers) {
    const scored = moves.map((m) => {
      let s = 0;
      if (m.capture) {
        const v = this.victimValue(chess, m);
        s += v >= 100000 ? v : v * 10 - ((this.pieceValues[m.piece] / 100) | 0);
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

  // ---- the search ----

  // A capture worth looking at: a live king, or a live piece worth at least
  // the capturer, or one nobody else could take back.
  canGain(chess, m) {
    const v = this.victimValue(chess, m);
    if (v === 0) return false;
    if (v >= this.pieceValues[m.piece]) return true;
    return !chess.attackedBy(m.to, chess.hostile(m.color));
  },

  // An opponent's reply `m` (theirs the turn), then LorFish's turn, the
  // others passing. undoMove puts the turn and en passant back as they were.
  // LorFish's own moves are plain makeMove: the turn goes on to whoever is
  // next, and the opponents' replies are asked of each in turn.
  reply(chess, m) {
    chess.makeMove(m, false);
    if (this.me !== chess.turn) chess.ep = null;
    chess.turn = this.me;
  },

  // Every move for each opponent still in, each tagged with its player.
  replies(chess, captures) {
    const out = [];
    for (const c of chess.active()) {
      if (c === this.me) continue;
      const saved = this.enter(chess, c);
      const moves = captures ? chess.legalCaptures().filter((m) => this.canGain(chess, m)) : chess.movesAsIfOn();
      this.leave(chess, saved);
      for (const m of moves) out.push(m);
    }
    return out;
  },

  // Minimax with alpha-beta, scores LorFish's: `mine` whether it is LorFish
  // to move or the opponents' best reply.
  search(chess, depth, alpha, beta, mine) {
    this.nodes++;
    if (chess.out[this.me]) return this.outScore(chess);
    if (chess.ended) return this.evaluate(chess, this.me);
    const ply = chess.history.length - this.rootPly;
    if (mine) {
      const saved = this.enter(chess, this.me);
      const moves = chess.movesAsIfOn();
      let best;
      if (!moves.length) best = this.outScore(chess);
      else if (depth <= 0) best = this.quiescence(chess, alpha, beta, 0, true);
      else {
        best = -Infinity;
        for (const m of this.orderMoves(chess, moves, this.killers[ply])) {
          chess.makeMove(m, false);
          const v = this.search(chess, depth - 1, alpha, beta, false);
          chess.undoMove();
          if (v > best) best = v;
          if (best > alpha) alpha = best;
          if (alpha >= beta) {
            if (!m.capture) this.addKiller(ply, m);
            break;
          }
        }
      }
      this.leave(chess, saved);
      return best;
    }
    const conceded = this.concedeStuck(chess, true);
    let best;
    if (chess.out[this.me] || chess.ended) best = this.search(chess, depth, alpha, beta, false);
    else if (depth <= 0) best = this.quiescence(chess, alpha, beta, 0, false);
    else {
      best = Infinity;
      for (const m of this.orderMoves(chess, this.replies(chess, false), this.killers[ply])) {
        const saved = this.enter(chess, m.color);
        this.reply(chess, m);
        const v = this.search(chess, depth - 1, alpha, beta, true);
        chess.undoMove();
        this.leave(chess, saved);
        if (v < best) best = v;
        if (best < beta) beta = best;
        if (alpha >= beta) {
          if (!m.capture) this.addKiller(ply, m);
          break;
        }
      }
      if (best === Infinity) best = this.evaluate(chess, this.me);
    }
    this.undo(chess, conceded);
    return best;
  },

  QDEPTH: 6,
  NODE_BUDGET: 60000,
  // LorFish's captures or standing pat; then one opponent's capture, or all
  // three passing. In check LorFish may not stand pat: every answer is
  // searched, and none is LorFish out.
  quiescence(chess, alpha, beta, qdepth, mine) {
    this.nodes++;
    if (qdepth > this.maxQ) this.maxQ = qdepth;
    if (chess.out[this.me]) return this.outScore(chess);
    if (chess.ended) return this.evaluate(chess, this.me);
    const spent = this.nodes > this.budgetEnd || qdepth >= this.QDEPTH;
    if (mine) {
      const saved = this.enter(chess, this.me);
      const checked = chess.inCheck(this.me);
      let best, moves;
      if (checked) {
        moves = chess.movesAsIfOn();
        if (!moves.length) best = this.outScore(chess);
        else if (spent) best = this.evaluate(chess, this.me);
      } else {
        const stand = this.evaluate(chess, this.me);
        if (stand >= beta || spent) best = stand;
        else {
          if (stand > alpha) alpha = stand;
          moves = chess.legalCaptures().filter((m) => this.canGain(chess, m));
        }
      }
      if (best === undefined) {
        best = checked ? -Infinity : alpha;
        for (const m of this.orderMoves(chess, moves)) {
          chess.makeMove(m, false);
          const v = this.quiescence(chess, alpha, beta, qdepth + 1, false);
          chess.undoMove();
          if (v > best) best = v;
          if (v > alpha) alpha = v;
          if (alpha >= beta) break;
        }
      }
      this.leave(chess, saved);
      return best;
    }
    const conceded = this.concedeStuck(chess, false);
    let best;
    if (chess.out[this.me] || chess.ended) best = this.quiescence(chess, alpha, beta, qdepth, false);
    else {
      const stand = this.evaluate(chess, this.me);
      if (stand <= alpha || spent) best = stand;
      else {
        if (stand < beta) beta = stand;
        best = beta;
        for (const m of this.orderMoves(chess, this.replies(chess, true))) {
          const saved = this.enter(chess, m.color);
          this.reply(chess, m);
          const v = this.quiescence(chess, alpha, beta, qdepth + 1, true);
          chess.undoMove();
          this.leave(chess, saved);
          if (v < best) best = v;
          if (v < beta) beta = v;
          if (alpha >= beta) break;
        }
      }
    }
    this.undo(chess, conceded);
    return best;
  },

  // As LorFish.searchRoot: every root move scored (exactly, unless `prune`
  // lets one that can't be picked fail low early), then the best taken, with
  // the jitter, or sampled at a temperature.
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
    this.me = chess.turn;
    const effDepth = this.clampDepth(depth);
    const evals = [];
    let best = null, top = -Infinity;
    const moves = this.orderMoves(chess, chess.legalMoves());
    const share = Math.floor(this.NODE_BUDGET / Math.max(1, moves.length));
    for (const m of moves) {
      const san = chess.moveToSan(m);
      this.budgetEnd = this.nodes + share;
      chess.makeMove(m, false);
      const floor = prune ? top - reach - 1 : -Infinity;
      const raw = this.search(chess, effDepth - 1, floor, Infinity, false);
      chess.undoMove();
      if (raw > top) top = raw;
      const jitter = (noise && Math.abs(raw) < 99000) ? Math.floor(rng() * 21) - 10 : 0;
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

  // The same position, the same verdict: no jitter, no temperature.
  analyse(chess, depth) {
    const { best, effDepth } = this.searchRoot(chess, depth, { noise: false });
    if (!best) return null;
    return { score: best.raw, depth: effDepth, san: best.san, move: best.move };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  globalThis.LorFish = require('./lorfish.js').LorFish;
  globalThis.FourPlayer = require('./fourPlayer.js').FourPlayer;
  globalThis.LorFishFour = require('./lorfishFour.js').LorFishFour;
  module.exports = { LorFishFfa };
}
