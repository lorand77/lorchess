"use strict";

// LorFish for four-player chess (src/shared/fourPlayer.js, Teams). In Teams
// the turn goes Red, Blue, Yellow, Green: one team, then the other, every
// ply. So it is a two-sided game to a search, and this is LorFish's search —
// negamax with alpha-beta, mate scores counted in plies from the root,
// repetition as a draw, killer moves, the pruned root, the jitter and the
// temperature that make the levels — with a score always from the side to
// move's team's point of view. Its searchRoot, getBestMove and analyse take
// and return what LorFish's do, and it borrows LorFish.sample, so a
// temperature means the same in both.
//
// What four players change:
//   - The capture search. Two plies from Red reach only Blue's reply, and a
//     piece Red leaves where Green can take it would look safe. So standing
//     pat here is passing the turn on: each player in turn may capture or
//     pass, and a line is scored only once all four have passed in a row, or
//     at the depth limit. Green's capture is always seen.
//   - How a game ends: a player with no move is mated if in check (their team
//     loses) and stalemated otherwise (a draw), decided on their own turn as
//     the engine does; a king left where an opponent can take it is taken,
//     and that wins. Draws by repetition, the 200-ply rule and bare kings.
//   - The evaluation, for the cross board: material, each army's own pawns
//     going forward (in its own frame, FourPlayer.frameOf), minor pieces
//     towards the middle, and a king's shelter.
//
// Loaded as a browser <script> or importScripts after fourPlayer.js and
// lorfish.js, and as a Node `require`.

const LorFishFour = {
  // ---- evaluation ----

  pieceValues: { p: 100, n: 300, b: 350, r: 500, q: 950, k: 0 },
  // A pawn is worth more the further it has come: per rank, more once past
  // the middle of the board (its 7th rank) and nearing promotion (its 11th).
  PAWN_STEP: 6,
  PAWN_PAST_MIDDLE: 14,
  // Knights and bishops are worth more nearer the middle, where they reach
  // all four armies.
  CENTRE: 4,
  // Each own pawn on the three squares in front of the king shelters it.
  SHELTER: 12,

  // Per square, worked out once: a pawn's bonus for each colour (from how far
  // it has come in that colour's frame), and a minor piece's for the middle.
  // The evaluation runs at every leaf, so it only looks these up.
  tables() {
    if (this._tables) return this._tables;
    const pawn = {}, centre = new Array(196).fill(0);
    for (const c of FourPlayer.COLORS) {
      pawn[c] = new Array(196).fill(0);
      for (let sq = 0; sq < 196; sq++) {
        const y = FourPlayer.frameOf(sq, c)[1];
        pawn[c][sq] = this.PAWN_STEP * (y - 1) + (y > 6 ? this.PAWN_PAST_MIDDLE * (y - 6) : 0);
      }
    }
    for (let sq = 0; sq < 196; sq++) {
      const x = sq % 14, y = (sq - x) / 14;
      centre[sq] = Math.round(this.CENTRE * (7 - Math.max(Math.abs(x - 6.5), Math.abs(y - 6.5))));
    }
    this._tables = { pawn, centre };
    return this._tables;
  },

  evaluate(chess) {
    const { pawn, centre } = this.tables();
    let score = 0;   // for Red and Yellow
    const kings = {};
    for (let sq = 0; sq < 196; sq++) {
      const p = chess.squares[sq];
      if (!p) continue;
      let v = this.pieceValues[p.t];
      if (p.t === 'k') kings[p.c] = sq;
      else if (p.t === 'p') v += pawn[p.c][sq];
      else if (p.t === 'n' || p.t === 'b') v += centre[sq];
      score += FourPlayer.teamOf(p.c) === 0 ? v : -v;
    }
    for (const c of FourPlayer.COLORS) {
      if (kings[c] === undefined) continue;
      const v = this.SHELTER * this.shelter(chess, kings[c], c);
      score += FourPlayer.teamOf(c) === 0 ? v : -v;
    }
    return FourPlayer.teamOf(chess.turn) === 0 ? score : -score;
  },

  // Own pawns on the three squares in front of a king, in its own frame.
  shelter(chess, sq, c) {
    const [x, y] = FourPlayer.frameOf(sq, c);
    let n = 0;
    for (const dx of [-1, 0, 1]) {
      const [rx, ry] = FourPlayer.rotate(x + dx, y + 1, FourPlayer.COLORS.indexOf(c));
      if (!FourPlayer.onBoard(rx, ry)) continue;
      const p = chess.squares[FourPlayer.sqOf(rx, ry)];
      if (p && p.t === 'p' && p.c === c) n++;
    }
    return n;
  },

  // ---- the end of a game ----

  MATE: 100000,
  MAX_DEPTH: 6,
  clampDepth(depth) {
    return Math.min(this.MAX_DEPTH, Math.max(1, Math.floor(Number(depth)) || 1));
  },
  mateScore(chess) {
    return this.MATE - (chess.history.length - this.rootPly);
  },

  // Over by rule or by a king taken, scored for the side to move; null if
  // not over that way. (No move left is the callers': they know already.)
  ruleScore(chess) {
    const taken = chess.kingTaken();
    if (taken) return FourPlayer.teamOf(taken) === FourPlayer.teamOf(chess.turn) ? -this.mateScore(chess) : this.mateScore(chess);
    const last = chess.history[chess.history.length - 1];
    const key = (last && last.key) || chess.positionKey();
    if ((chess.positionCounts.get(key) || 0) >= 2) return 0;   // one more pass makes threefold
    if (chess.halfmove >= FourPlayer.FIFTY_MOVE_PLIES || chess.isInsufficientMaterial()) return 0;
    return null;
  },

  // No move left for the side to move: mated in check, else stalemate.
  noMoveScore(chess) {
    return chess.inCheck() ? -this.mateScore(chess) : 0;
  },

  // ---- ordering ----

  KILLER_BONUS: 950,
  moveKey(m) {
    return m.from + '>' + m.to + (m.promo || '');
  },
  addKiller(ply, m) {
    const k = this.moveKey(m), slot = this.killers[ply] || (this.killers[ply] = []);
    if (slot[0] !== k) { slot[1] = slot[0]; slot[0] = k; }
  },
  // A king taken first (it ends the game), then captures by most valuable
  // victim and least valuable attacker, promotions, the killers.
  orderMoves(chess, moves, killers) {
    const scored = moves.map((m) => {
      let s = 0;
      if (m.capture) {
        const victim = m.enpassant ? 'p' : chess.squares[m.to].t;
        s += victim === 'k' ? 100000 : this.pieceValues[victim] * 10 - ((this.pieceValues[m.piece] / 100) | 0);
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

  // A capture worth looking at: it takes a king, or something worth at least
  // the capturer, or something its own team doesn't defend.
  canGain(chess, m) {
    if (m.enpassant) return true;
    const victim = chess.squares[m.to];
    if (victim.t === 'k' || this.pieceValues[victim.t] >= this.pieceValues[m.piece]) return true;
    return !chess.isAttacked(m.to, FourPlayer.teamOf(victim.c));
  },

  // Passing the turn, for the capture search only: the next player moves,
  // and an en passant chance, the passer's to take, lapses.
  pass(chess) {
    const saved = { turn: chess.turn, ep: chess.ep };
    chess.turn = FourPlayer.nextColor(chess.turn);
    chess.ep = null;
    return saved;
  },
  unpass(chess, saved) {
    chess.turn = saved.turn;
    chess.ep = saved.ep;
  },

  // Captures, or a pass, for each player in turn; `passes` counts the passes
  // in a row just made. In check there is no passing: every answer to it is
  // searched, and none is mate.
  //
  // Bounded three ways, since every node offers a pass as well as its
  // captures: a depth; only captures that can gain (the victim worth at least
  // the capturer, or undefended — a king always); and a node budget, past
  // which the capture search stops and the position stands as it is. The
  // budget keeps a move within the bot's time on a board full of loose
  // pieces, where the other two bounds are not enough. It is shared out
  // evenly between the root moves (searchRoot), so a move searched late is
  // looked at as hard as one searched early.
  QDEPTH: 6,
  NODE_BUDGET: 60000,
  quiescence(chess, alpha, beta, qdepth, passes) {
    this.nodes++;
    if (qdepth > this.maxQ) this.maxQ = qdepth;
    const over = this.ruleScore(chess);
    if (over !== null) return over;
    const spent = this.nodes > this.budgetEnd;
    const checked = chess.inCheck();
    let moves;
    if (checked) {
      moves = chess.legalMoves();
      if (!moves.length) return this.noMoveScore(chess);
      if (qdepth >= this.QDEPTH || spent) return this.evaluate(chess);
    } else {
      // Standing pat: with the other three passed, the position stands as it
      // is; otherwise it goes on to the next player.
      let standPat;
      if (passes >= 3 || qdepth >= this.QDEPTH || spent) standPat = this.evaluate(chess);
      else {
        const saved = this.pass(chess);
        standPat = -this.quiescence(chess, -beta, -alpha, qdepth + 1, passes + 1);
        this.unpass(chess, saved);
      }
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      if (qdepth >= this.QDEPTH || spent) return alpha;
      moves = chess.legalCaptures().filter((m) => this.canGain(chess, m));
    }
    let best = checked ? -Infinity : alpha;
    for (const m of this.orderMoves(chess, moves)) {
      chess.makeMove(m);
      const score = -this.quiescence(chess, -beta, -alpha, qdepth + 1, 0);
      chess.undoMove();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  },

  negamax(chess, depth, alpha, beta) {
    this.nodes++;
    const over = this.ruleScore(chess);
    if (over !== null) return over;
    if (depth <= 0) return this.quiescence(chess, alpha, beta, 0, 0);
    const moves = chess.legalMoves();
    if (!moves.length) return this.noMoveScore(chess);
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
    const effDepth = this.clampDepth(depth);
    const evals = [];
    let best = null, top = -Infinity;
    const moves = this.orderMoves(chess, chess.legalMoves());
    const share = Math.floor(this.NODE_BUDGET / Math.max(1, moves.length));
    for (const m of moves) {
      const san = chess.moveToSan(m);
      this.budgetEnd = this.nodes + share;
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
  module.exports = { LorFishFour };
}
