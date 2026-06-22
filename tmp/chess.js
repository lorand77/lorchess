"use strict";

// ====================================================================
// Chess rules engine
// ====================================================================
const W = 'w', B = 'b';
const sqIdx = (f, r) => r * 8 + f;
const fileOf = sq => sq & 7;
const rankOf = sq => sq >> 3;
const algOf = sq => String.fromCharCode(97 + fileOf(sq)) + (rankOf(sq) + 1);
const opp = c => c === W ? B : W;
const inBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const PIECE_NAMES = { p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king' };

class Chess {
  constructor() { this.reset(); }

  reset() {
    this.squares = new Array(64).fill(null);
    const back = ['r','n','b','q','k','b','n','r'];
    for (let f = 0; f < 8; f++) {
      this.squares[sqIdx(f,0)] = { t: back[f], c: W };
      this.squares[sqIdx(f,1)] = { t: 'p',     c: W };
      this.squares[sqIdx(f,6)] = { t: 'p',     c: B };
      this.squares[sqIdx(f,7)] = { t: back[f], c: B };
    }
    this.turn = W;
    this.castling = { K: true, Q: true, k: true, q: true };
    this.ep = null;
    this.halfmove = 0;
    this.fullmove = 1;
    this.history = [];
    this.positionCounts = new Map();
    this.positionCounts.set(this.positionKey(), 1);
  }

  // Load a position from FEN. Throws on invalid input.
  loadFen(fen) {
    const parts = String(fen || '').trim().split(/\s+/);
    if (parts.length < 4) throw new Error('FEN must have at least 4 fields');

    const newSquares = new Array(64).fill(null);
    const ranks = parts[0].split('/');
    if (ranks.length !== 8) throw new Error('FEN must have 8 ranks separated by "/"');

    for (let i = 0; i < 8; i++) {
      const r = 7 - i; // FEN lists rank 8 first, our index 7 = rank 8
      let f = 0;
      for (const ch of ranks[i]) {
        if (ch >= '1' && ch <= '8') {
          f += ch.charCodeAt(0) - 48;
        } else if ('prnbqkPRNBQK'.includes(ch)) {
          if (f >= 8) throw new Error(`FEN rank ${8 - i} overflows 8 files`);
          const c = ch === ch.toUpperCase() ? W : B;
          newSquares[sqIdx(f, r)] = { t: ch.toLowerCase(), c };
          f++;
        } else {
          throw new Error(`FEN: bad piece char "${ch}"`);
        }
      }
      if (f !== 8) throw new Error(`FEN rank ${8 - i} does not sum to 8 squares`);
    }

    let wKings = 0, bKings = 0;
    for (const p of newSquares) {
      if (!p || p.t !== 'k') continue;
      if (p.c === W) wKings++; else bKings++;
    }
    if (wKings !== 1 || bKings !== 1) {
      throw new Error('FEN must have exactly one king per side');
    }

    this.squares = newSquares;
    this.turn = parts[1] === 'b' ? B : W;
    const cr = parts[2] || '-';
    this.castling = {
      K: cr.includes('K'),
      Q: cr.includes('Q'),
      k: cr.includes('k'),
      q: cr.includes('q'),
    };
    if (parts[3] && parts[3] !== '-') {
      const file = parts[3].charCodeAt(0) - 97;
      const rank = parseInt(parts[3][1], 10) - 1;
      if (file < 0 || file > 7 || isNaN(rank) || rank < 0 || rank > 7) {
        throw new Error(`FEN: bad en-passant square "${parts[3]}"`);
      }
      this.ep = sqIdx(file, rank);
    } else {
      this.ep = null;
    }
    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
    this.history = [];
    this.positionCounts = new Map();
    this.positionCounts.set(this.positionKey(), 1);
  }

  // FEN-like key for repetition detection: pieces + turn + castling + ep target.
  positionKey() {
    let s = '';
    for (let i = 0; i < 64; i++) {
      const p = this.squares[i];
      s += p ? (p.c === W ? p.t.toUpperCase() : p.t) : '.';
    }
    s += '|' + this.turn;
    s += '|' + (this.castling.K ? 'K' : '') + (this.castling.Q ? 'Q' : '')
            + (this.castling.k ? 'k' : '') + (this.castling.q ? 'q' : '');
    s += '|' + (this.ep != null ? this.ep : '-');
    return s;
  }

  pseudoMovesFrom(sq, c) {
    const piece = this.squares[sq];
    if (!piece || piece.c !== c) return [];
    const moves = [];
    const f = fileOf(sq), r = rankOf(sq);
    const them = opp(c);
    const add = (to, opts) => moves.push(Object.assign({ from: sq, to }, opts || {}));

    if (piece.t === 'p') {
      const dir = c === W ? 1 : -1;
      const startRank = c === W ? 1 : 6;
      const promoRank = c === W ? 7 : 0;
      // forward 1
      if (inBoard(f, r + dir) && !this.squares[sqIdx(f, r + dir)]) {
        const to = sqIdx(f, r + dir);
        if (rankOf(to) === promoRank) {
          for (const p of ['q','r','b','n']) add(to, { promo: p });
        } else {
          add(to);
          if (r === startRank && !this.squares[sqIdx(f, r + 2*dir)]) {
            add(sqIdx(f, r + 2*dir), { ep_set: sqIdx(f, r + dir) });
          }
        }
      }
      // captures
      for (const df of [-1, 1]) {
        const nf = f + df, nr = r + dir;
        if (!inBoard(nf, nr)) continue;
        const to = sqIdx(nf, nr);
        const tgt = this.squares[to];
        if (tgt && tgt.c === them) {
          if (rankOf(to) === promoRank) {
            for (const p of ['q','r','b','n']) add(to, { promo: p, capture: true });
          } else {
            add(to, { capture: true });
          }
        } else if (this.ep === to && !tgt) {
          add(to, { capture: true, enpassant: true });
        }
      }
    } else if (piece.t === 'n') {
      const offs = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
      for (const [df, dr] of offs) {
        const nf = f + df, nr = r + dr;
        if (!inBoard(nf, nr)) continue;
        const to = sqIdx(nf, nr);
        const tgt = this.squares[to];
        if (!tgt) add(to);
        else if (tgt.c === them) add(to, { capture: true });
      }
    } else if (piece.t === 'b' || piece.t === 'r' || piece.t === 'q') {
      const dirs = [];
      if (piece.t !== 'r') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      if (piece.t !== 'b') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (inBoard(nf, nr)) {
          const to = sqIdx(nf, nr);
          const tgt = this.squares[to];
          if (!tgt) add(to);
          else { if (tgt.c === them) add(to, { capture: true }); break; }
          nf += df; nr += dr;
        }
      }
    } else if (piece.t === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = f + df, nr = r + dr;
        if (!inBoard(nf, nr)) continue;
        const to = sqIdx(nf, nr);
        const tgt = this.squares[to];
        if (!tgt) add(to);
        else if (tgt.c === them) add(to, { capture: true });
      }
      // castling (path-empty + rook check; check/attack tested in legalMoves)
      const home = c === W ? 0 : 7;
      const KK = c === W ? 'K' : 'k';
      const QQ = c === W ? 'Q' : 'q';
      if (r === home && f === 4) {
        const rookK = this.squares[sqIdx(7, home)];
        if (this.castling[KK]
            && !this.squares[sqIdx(5, home)]
            && !this.squares[sqIdx(6, home)]
            && rookK && rookK.t === 'r' && rookK.c === c) {
          add(sqIdx(6, home), { castle: 'K' });
        }
        const rookQ = this.squares[sqIdx(0, home)];
        if (this.castling[QQ]
            && !this.squares[sqIdx(1, home)]
            && !this.squares[sqIdx(2, home)]
            && !this.squares[sqIdx(3, home)]
            && rookQ && rookQ.t === 'r' && rookQ.c === c) {
          add(sqIdx(2, home), { castle: 'Q' });
        }
      }
    }
    return moves;
  }

  isAttacked(sq, byColor) {
    const f = fileOf(sq), r = rankOf(sq);
    // pawn (attacker of byColor moves toward us; their pawn at r-dir attacks us)
    const dir = byColor === W ? -1 : 1;
    for (const df of [-1, 1]) {
      const nf = f + df, nr = r + dir;
      if (!inBoard(nf, nr)) continue;
      const p = this.squares[sqIdx(nf, nr)];
      if (p && p.c === byColor && p.t === 'p') return true;
    }
    // knight
    const knightOffs = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [df, dr] of knightOffs) {
      const nf = f + df, nr = r + dr;
      if (!inBoard(nf, nr)) continue;
      const p = this.squares[sqIdx(nf, nr)];
      if (p && p.c === byColor && p.t === 'n') return true;
    }
    // sliders
    const diag = [[-1,-1],[-1,1],[1,-1],[1,1]];
    const ortho = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [df, dr] of diag) {
      let nf = f + df, nr = r + dr;
      while (inBoard(nf, nr)) {
        const p = this.squares[sqIdx(nf, nr)];
        if (p) {
          if (p.c === byColor && (p.t === 'b' || p.t === 'q')) return true;
          break;
        }
        nf += df; nr += dr;
      }
    }
    for (const [df, dr] of ortho) {
      let nf = f + df, nr = r + dr;
      while (inBoard(nf, nr)) {
        const p = this.squares[sqIdx(nf, nr)];
        if (p) {
          if (p.c === byColor && (p.t === 'r' || p.t === 'q')) return true;
          break;
        }
        nf += df; nr += dr;
      }
    }
    // king
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df, nr = r + dr;
      if (!inBoard(nf, nr)) continue;
      const p = this.squares[sqIdx(nf, nr)];
      if (p && p.c === byColor && p.t === 'k') return true;
    }
    return false;
  }

  findKing(c) {
    for (let i = 0; i < 64; i++) {
      const p = this.squares[i];
      if (p && p.c === c && p.t === 'k') return i;
    }
    return -1;
  }

  inCheck(c) {
    if (c === undefined) c = this.turn;
    return this.isAttacked(this.findKing(c), opp(c));
  }

  legalMoves(forColor) {
    const c = forColor || this.turn;
    const moves = [];
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq];
      if (!p || p.c !== c) continue;
      for (const m of this.pseudoMovesFrom(sq, c)) {
        if (m.castle) {
          // Can't castle out of check, through check, or into check.
          if (this.inCheck(c)) continue;
          const home = c === W ? 0 : 7;
          const passSq = m.castle === 'K' ? sqIdx(5, home) : sqIdx(3, home);
          if (this.isAttacked(passSq, opp(c))) continue;
        }
        // Validation make/undo — skip repetition tracking for performance.
        this.makeMove(m, false);
        if (!this.isAttacked(this.findKing(c), opp(c))) moves.push(m);
        this.undoMove();
      }
    }
    return moves;
  }

  makeMove(m, trackPosition = true) {
    const piece = this.squares[m.from];
    const captured = m.enpassant
      ? this.squares[sqIdx(fileOf(m.to), rankOf(m.from))]
      : this.squares[m.to];

    const histEntry = {
      move: m,
      captured,
      castling: { K: this.castling.K, Q: this.castling.Q, k: this.castling.k, q: this.castling.q },
      ep: this.ep,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
      turn: this.turn,
      tracked: trackPosition,
      newKey: null,
    };
    this.history.push(histEntry);

    this.squares[m.from] = null;
    this.squares[m.to] = m.promo ? { t: m.promo, c: piece.c } : piece;

    if (m.enpassant) {
      this.squares[sqIdx(fileOf(m.to), rankOf(m.from))] = null;
    }

    if (m.castle === 'K') {
      const r = rankOf(m.from);
      this.squares[sqIdx(5, r)] = this.squares[sqIdx(7, r)];
      this.squares[sqIdx(7, r)] = null;
    } else if (m.castle === 'Q') {
      const r = rankOf(m.from);
      this.squares[sqIdx(3, r)] = this.squares[sqIdx(0, r)];
      this.squares[sqIdx(0, r)] = null;
    }

    // Castling rights updates
    if (piece.t === 'k') {
      if (piece.c === W) { this.castling.K = false; this.castling.Q = false; }
      else { this.castling.k = false; this.castling.q = false; }
    }
    if (m.from === sqIdx(0,0) || m.to === sqIdx(0,0)) this.castling.Q = false;
    if (m.from === sqIdx(7,0) || m.to === sqIdx(7,0)) this.castling.K = false;
    if (m.from === sqIdx(0,7) || m.to === sqIdx(0,7)) this.castling.q = false;
    if (m.from === sqIdx(7,7) || m.to === sqIdx(7,7)) this.castling.k = false;

    this.ep = (m.ep_set != null) ? m.ep_set : null;

    if (piece.t === 'p' || captured) this.halfmove = 0;
    else this.halfmove++;

    if (this.turn === B) this.fullmove++;
    this.turn = opp(this.turn);

    if (trackPosition) {
      const key = this.positionKey();
      histEntry.newKey = key;
      this.positionCounts.set(key, (this.positionCounts.get(key) || 0) + 1);
    }
  }

  undoMove() {
    if (this.history.length === 0) return;
    const h = this.history.pop();
    const m = h.move;

    if (h.tracked && h.newKey) {
      const cur = (this.positionCounts.get(h.newKey) || 0) - 1;
      if (cur <= 0) this.positionCounts.delete(h.newKey);
      else this.positionCounts.set(h.newKey, cur);
    }

    this.castling = h.castling;
    this.ep = h.ep;
    this.halfmove = h.halfmove;
    this.fullmove = h.fullmove;
    this.turn = h.turn;

    const movedPiece = this.squares[m.to];
    this.squares[m.from] = m.promo ? { t: 'p', c: movedPiece.c } : movedPiece;

    if (m.enpassant) {
      this.squares[m.to] = null;
      this.squares[sqIdx(fileOf(m.to), rankOf(m.from))] = h.captured;
    } else {
      this.squares[m.to] = h.captured;
    }

    if (m.castle === 'K') {
      const r = rankOf(m.from);
      this.squares[sqIdx(7, r)] = this.squares[sqIdx(5, r)];
      this.squares[sqIdx(5, r)] = null;
    } else if (m.castle === 'Q') {
      const r = rankOf(m.from);
      this.squares[sqIdx(0, r)] = this.squares[sqIdx(3, r)];
      this.squares[sqIdx(3, r)] = null;
    }
  }

  isInsufficientMaterial() {
    const ps = [];
    for (let i = 0; i < 64; i++) {
      const p = this.squares[i];
      if (p) ps.push({ t: p.t, c: p.c, sq: i });
    }
    if (ps.length === 2) return true;
    if (ps.length === 3) {
      const nk = ps.find(p => p.t !== 'k');
      if (nk && (nk.t === 'b' || nk.t === 'n')) return true;
    }
    if (ps.length === 4) {
      const bs = ps.filter(p => p.t === 'b');
      if (bs.length === 2 && ps.filter(p => p.t === 'k').length === 2) {
        const c0 = (fileOf(bs[0].sq) + rankOf(bs[0].sq)) & 1;
        const c1 = (fileOf(bs[1].sq) + rankOf(bs[1].sq)) & 1;
        if (c0 === c1) return true;
      }
    }
    return false;
  }

  isCheckmate() { return this.inCheck() && this.legalMoves().length === 0; }
  isStalemate() { return !this.inCheck() && this.legalMoves().length === 0; }
  isThreefoldRepetition() {
    return (this.positionCounts.get(this.positionKey()) || 0) >= 3;
  }
  isFivefoldRepetition() {
    return (this.positionCounts.get(this.positionKey()) || 0) >= 5;
  }
  isGameOver() {
    return this.legalMoves().length === 0
        || this.isInsufficientMaterial()
        || this.halfmove >= 100
        || this.isThreefoldRepetition();
  }
  result() {
    if (this.isCheckmate()) return this.turn === W ? '0-1' : '1-0';
    if (this.isGameOver()) return '1/2-1/2';
    return '*';
  }

  // SAN — call BEFORE making the move
  moveToSan(m) {
    const piece = this.squares[m.from];
    let san;
    if (m.castle === 'K') san = 'O-O';
    else if (m.castle === 'Q') san = 'O-O-O';
    else {
      const isCap = !!(m.capture || m.enpassant);
      if (piece.t === 'p') {
        san = '';
        if (isCap) san += String.fromCharCode(97 + fileOf(m.from)) + 'x';
        san += algOf(m.to);
        if (m.promo) san += '=' + m.promo.toUpperCase();
      } else {
        san = piece.t.toUpperCase();
        const cands = this.legalMoves(piece.c).filter(om =>
          om.to === m.to && om.from !== m.from &&
          this.squares[om.from] && this.squares[om.from].t === piece.t
        );
        if (cands.length > 0) {
          const sameFile = cands.some(c => fileOf(c.from) === fileOf(m.from));
          const sameRank = cands.some(c => rankOf(c.from) === rankOf(m.from));
          if (!sameFile)      san += String.fromCharCode(97 + fileOf(m.from));
          else if (!sameRank) san += String(rankOf(m.from) + 1);
          else                san += algOf(m.from);
        }
        if (isCap) san += 'x';
        san += algOf(m.to);
      }
    }
    this.makeMove(m);
    if (this.inCheck()) san += this.legalMoves().length === 0 ? '#' : '+';
    this.undoMove();
    return san;
  }
}
