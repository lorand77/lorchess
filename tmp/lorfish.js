"use strict";

// ====================================================================
// LorFish engine — port of lorfish.py
// ====================================================================
const LorFish = {
  // Same piece values and PSTs as the Python (sunfish-derived).
  pieceValues: { p: 100, n: 280, b: 320, r: 479, q: 929, k: 0 },
  pst: {
    p: [
        0,   0,   0,   0,   0,   0,   0,   0,
      -31,   8,  -7, -37, -36, -14,   3, -31,
      -22,   9,   5, -11, -10,  -2,   3, -19,
      -26,   3,  10,   9,   6,   1,   0, -23,
      -17,  16,  -2,  15,  14,   0,  15, -13,
        7,  29,  21,  44,  40,  31,  44,   7,
       78,  83,  86,  73, 102,  82,  85,  90,
        0,   0,   0,   0,   0,   0,   0,   0
    ],
    n: [
      -74, -23, -26, -24, -19, -35, -22, -69,
      -23, -15,   2,   0,   2,   0, -23, -20,
      -18,  10,  13,  22,  18,  15,  11, -14,
       -1,   5,  31,  21,  22,  35,   2,   0,
       24,  24,  45,  37,  33,  41,  25,  17,
       10,  67,   1,  74,  73,  27,  62,  -2,
       -3,  -6, 100, -36,   4,  62,  -4, -14,
      -66, -53, -75, -75, -10, -55, -58, -70
    ],
    b: [
       -7,   2, -15, -12, -14, -15, -10, -10,
       19,  20,  11,   6,   7,   6,  20,  16,
       14,  25,  24,  15,   8,  25,  20,  15,
       13,  10,  17,  23,  17,  16,   0,   7,
       25,  17,  20,  34,  26,  25,  15,  10,
       -9,  39, -32,  41,  52, -10,  28, -14,
      -11,  20,  35, -42, -39,  31,   2, -22,
      -59, -78, -82, -76, -23,-107, -37, -50
    ],
    r: [
      -30, -24, -18,   5,  -2, -18, -31, -32,
      -53, -38, -31, -26, -29, -43, -44, -53,
      -42, -28, -42, -25, -25, -35, -26, -46,
      -28, -35, -16, -21, -13, -29, -46, -30,
        0,   5,  16,  13,  18,  -4,  -9,  -6,
       19,  35,  28,  33,  45,  27,  25,  15,
       55,  29,  56,  67,  55,  62,  34,  60,
       35,  29,  33,   4,  37,  33,  56,  50
    ],
    q: [
      -39, -30, -31, -13, -31, -36, -34, -42,
      -36, -18,   0, -19, -15, -15, -21, -38,
      -30,  -6, -13, -11, -16, -11, -16, -27,
      -14, -15,  -2,  -5,  -1, -10, -20, -22,
        1, -16,  22,  17,  25,  20, -13,  -6,
       -2,  43,  32,  60,  72,  63,  43,   2,
       14,  32,  60, -10,  20,  76,  57,  24,
        6,   1,  -8,-104,  69,  24,  88,  26
    ],
    k: [
       17,  30,  -3, -14,   6,  -1,  40,  18,
       -4,   3, -14, -50, -57, -18,  13,   4,
      -47, -42, -43, -79, -64, -32, -29, -32,
      -55, -43, -52, -28, -51, -47,  -8, -50,
      -55,  50,  11,  -4, -19,  13,   0, -49,
      -62,  12, -57,  44, -67,  28,  37, -31,
      -32,  10,  55,  56,  56,  55,  10,   3,
        4,  54,  47, -99, -99,  60,  83, -62
    ],
  },

  // Endgame piece-square tables, blended with `pst` by gamePhase() in
  // evaluate(). Only `k` and `p` are defined: in pawn endgames the
  // middlegame king PST punishes centralization and the pawn PST under-
  // rewards advanced pawns. Other pieces fall back to the middlegame PST.
  pstEnd: {
    p: [
        0,   0,   0,   0,   0,   0,   0,   0,
       10,  10,  10,  10,  10,  10,  10,  10,
       12,  12,  12,  12,  12,  12,  12,  12,
       20,  20,  20,  25,  25,  20,  20,  20,
       30,  30,  35,  40,  40,  35,  30,  30,
       50,  50,  50,  55,  55,  50,  50,  50,
       80,  80,  80,  85,  85,  80,  80,  80,
        0,   0,   0,   0,   0,   0,   0,   0,
    ],
    k: [
      -50, -30, -30, -30, -30, -30, -30, -50,
      -30, -10,   0,   0,   0,   0, -10, -30,
      -30,   0,  20,  30,  30,  20,   0, -30,
      -30,   0,  30,  40,  40,  30,   0, -30,
      -30,   0,  30,  40,  40,  30,   0, -30,
      -30,   0,  20,  30,  30,  20,   0, -30,
      -30, -10,   0,   0,   0,   0, -10, -30,
      -50, -30, -30, -30, -30, -30, -30, -50,
    ],
  },

  // Passed-pawn bonus indexed by advancement from the owner's perspective.
  // 0 = home rank, 6 = one square from promotion. Endgame-weighted in
  // evaluate(): full value when phase==0, 25% when phase==24.
  passedPawnBonus: [0, 0, 10, 20, 40, 70, 120, 0],

  // True when the pawn at `sq` has no opposing pawn on its file or either
  // adjacent file, on any rank between it and promotion.
  isPassedPawn(chess, sq, color) {
    const f = sq & 7;
    const r = sq >> 3;
    const step = color === W ? 1 : -1;
    const last = color === W ? 7 : 0;
    for (let nr = r + step; nr !== last + step; nr += step) {
      for (let df = -1; df <= 1; df++) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const p = chess.squares[nr * 8 + nf];
        if (p && p.t === 'p' && p.c !== color) return false;
      }
    }
    return true;
  },

  // Sum of non-pawn piece weights across both sides.
  // 24 at the starting position; 0 in a pure pawn endgame.
  gamePhase(chess) {
    let phase = 0;
    for (let i = 0; i < 64; i++) {
      const p = chess.squares[i];
      if (!p) continue;
      if (p.t === 'n' || p.t === 'b') phase += 1;
      else if (p.t === 'r')           phase += 2;
      else if (p.t === 'q')           phase += 4;
    }
    return phase;
  },

  // Detect "win by mating a lone king" endgames: weaker side has only its
  // king, stronger side has K + at least one major piece and no pawns.
  // Returns { winner, loser } colors or null. Gates the lone-king eval term
  // and the depth bump below — by construction, never fires in the middlegame.
  isLoneKingMate(chess) {
    let wPieces = 0, bPieces = 0;
    let wMajor = 0, bMajor = 0;
    let wPawns = 0, bPawns = 0;
    for (let i = 0; i < 64; i++) {
      const p = chess.squares[i];
      if (!p) continue;
      if (p.c === W) {
        wPieces++;
        if (p.t === 'r' || p.t === 'q') wMajor++;
        else if (p.t === 'p') wPawns++;
      } else {
        bPieces++;
        if (p.t === 'r' || p.t === 'q') bMajor++;
        else if (p.t === 'p') bPawns++;
      }
    }
    if (wPieces === 1 && bPieces > 1 && bMajor >= 1 && bPawns === 0) {
      return { winner: B, loser: W };
    }
    if (bPieces === 1 && wPieces > 1 && wMajor >= 1 && wPawns === 0) {
      return { winner: W, loser: B };
    }
    return null;
  },

  // White-positive eval contribution that herds the lone king to the edge/
  // corner, brings the winning king close, and rewards the opposition. Caller
  // adds this into `score` before the side-to-move flip in evaluate(). Sized
  // to dominate rook-PST jitter (~30 cp swings) so the engine consistently
  // makes progress instead of shuffling.
  loneKingMateTerm(chess, lk) {
    let wKsq = -1, bKsq = -1;
    for (let i = 0; i < 64; i++) {
      const p = chess.squares[i];
      if (p && p.t === 'k') {
        if (p.c === W) wKsq = i; else bKsq = i;
      }
    }
    const winSq = lk.winner === W ? wKsq : bKsq;
    const losSq = lk.loser  === W ? wKsq : bKsq;
    const wf = winSq & 7, wr = winSq >> 3;
    const lf = losSq & 7, lr = losSq >> 3;

    // Edge push of loser king: 0 in central 4x4, up to 120 in a corner.
    const edgeF = Math.max(3 - lf, lf - 4, 0);
    const edgeR = Math.max(3 - lr, lr - 4, 0);
    const edge = 20 * (edgeF + edgeR);

    // Corner bonus — only the four corners mate with a lone rook.
    const corner = (losSq === 0 || losSq === 7 || losSq === 56 || losSq === 63) ? 30 : 0;

    // Strong-king proximity by Chebyshev distance (king-tempo metric).
    const cheb = Math.max(Math.abs(wf - lf), Math.abs(wr - lr));
    const prox = 16 * (7 - cheb);

    // Opposition: kings on same file/rank with exactly one square between.
    const opposition = (cheb === 2 && (wf === lf || wr === lr)) ? 24 : 0;

    const total = edge + corner + prox + opposition;
    return lk.winner === W ? total : -total;
  },

  // Boost search depth as the position simplifies, so endgame mates fall
  // within the horizon without slowing middlegame play.
  adaptiveDepth(chess, baseDepth) {
    const phase = this.gamePhase(chess);
    if (phase <= 6)  return baseDepth + 2;
    if (phase <= 12) return baseDepth + 1;
    return baseDepth;
  },

  orderMoves(chess, moves) {
    // MVV-LVA + promotion bonus. Skipping gives_check bonus for performance.
    const scored = new Array(moves.length);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      let s = 0;
      const victim = m.enpassant ? { t: 'p' } : chess.squares[m.to];
      const attacker = chess.squares[m.from];
      if (victim && attacker) {
        s += (this.pieceValues[victim.t] || 0) * 10;
        s -= (this.pieceValues[attacker.t] || 0) / 100 | 0;
      }
      if (m.promo) s += 8000;
      scored[i] = { m, s };
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.m);
  },

  evaluate(chess) {
    const lk = this.isLoneKingMate(chess);
    const phase = this.gamePhase(chess);   // 0..24
    const eg = 24 - phase;
    let score = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = chess.squares[sq];
      if (!p) continue;
      // Skip the king PST in lone-king-mate endgames — its middlegame bias
      // (rewards corners, penalizes center) actively fights the mate drive.
      if (lk && p.t === 'k') continue;
      const idx = p.c === W ? sq : (sq ^ 56);
      const mgPst = this.pst[p.t][idx];
      const egTable = this.pstEnd[p.t];
      const egPst = egTable ? egTable[idx] : mgPst;
      const pstVal = ((mgPst * phase + egPst * eg) / 24) | 0;
      let v = this.pieceValues[p.t] + pstVal;
      if (p.t === 'p' && this.isPassedPawn(chess, sq, p.c)) {
        const adv = p.c === W ? (sq >> 3) : 7 - (sq >> 3);
        const base = this.passedPawnBonus[adv];
        // Full bonus in pure endgame, 25% at the starting position.
        v += ((base * eg + (base >> 2) * phase) / 24) | 0;
      }
      score += p.c === W ? v : -v;
    }
    if (lk) score += this.loneKingMateTerm(chess, lk);
    return chess.turn === W ? score : -score;
  },

  quiescence(chess, alpha, beta, qdepth) {
    this.nodes++;
    if (qdepth > this.maxQ) this.maxQ = qdepth;

    if ((chess.positionCounts.get(chess.positionKey()) || 0) >= 2) return 0;
    const moves = chess.legalMoves();
    if (moves.length === 0) return chess.inCheck() ? -99999 : 0;
    if (chess.isInsufficientMaterial()) return 0;

    const standPat = this.evaluate(chess);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    const captures = this.orderMoves(chess, moves.filter(m => m.capture || m.enpassant));
    for (const m of captures) {
      chess.makeMove(m);
      const score = -this.quiescence(chess, -beta, -alpha, qdepth + 1);
      chess.undoMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  },

  negamax(chess, depth, alpha, beta) {
    this.nodes++;
    // Repetition draw: count >= 2 means the position appears in the actual
    // game history plus the current search line ≥ 2 times — i.e. one more
    // pass through it forces 3-fold. Treat as draw so a winning side avoids
    // it and a losing side can seek it.
    if ((chess.positionCounts.get(chess.positionKey()) || 0) >= 2) return 0;
    const moves = chess.legalMoves();
    if (moves.length === 0) return chess.inCheck() ? (-99999 - depth) : 0;
    if (chess.isInsufficientMaterial()) return 0;
    // Check extension: at the horizon, give the side in check one more ply
    // so short forcing mates and quiet replies to checks fall in the window.
    if (depth === 0) {
      if (chess.inCheck()) depth = 1;
      else return this.quiescence(chess, alpha, beta, 0);
    }

    const ordered = this.orderMoves(chess, moves);
    let best = -Infinity;
    for (const m of ordered) {
      chess.makeMove(m);
      const v = -this.negamax(chess, depth - 1, -beta, -alpha);
      chess.undoMove();
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  },

  getBestMove(chess, depth) {
    this.nodes = 0;
    this.maxQ = 0;
    const t0 = performance.now();
    const effDepth = this.adaptiveDepth(chess, depth);
    let bestMove = null, bestVal = -Infinity;
    const moves = this.orderMoves(chess, chess.legalMoves());
    const evals = [];
    for (const m of moves) {
      // SAN must be built BEFORE makeMove (needs pre-move state).
      const san = chess.moveToSan(m);
      chess.makeMove(m);
      // Full window at root so logged evals are exact, not pruning bounds.
      const raw = -this.negamax(chess, effDepth - 1, -Infinity, Infinity);
      chess.undoMove();
      // Tiny tiebreaker noise so equal-ish moves vary game to game.
      // Skip noise on mate scores so the fastest mate is always chosen.
      const noise = raw >= 99000 ? 0 : Math.floor(Math.random() * 21) - 10; // -10..+10
      const v = raw + noise;
      if (v > bestVal) { bestVal = v; bestMove = m; }
      evals.push({ san, raw, v });
    }
    const dt = ((performance.now() - t0) / 1000).toFixed(3);
    evals.sort((a, b) => b.v - a.v);
    const side = chess.turn === W ? 'White' : 'Black';
    const depthStr = effDepth === depth ? `depth=${depth}` : `depth=${depth} → ${effDepth}`;
    console.log(`LorFish evals (${side} to move, ${depthStr}):`);
    for (const e of evals) console.log(`  ${e.san.padEnd(8)} ${e.v}  [raw=${e.raw}]`);
    console.log(`nodes=${this.nodes} time=${dt}s maxQ=${this.maxQ}`);
    return bestMove;
  },
};
