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
  constructor() {
    // Which rule set is in force. 'standard' covers Chess960 too — that only
    // changes the starting position. 'atomic' changes what a capture does.
    // Set it with setVariant(); reset() and loadFen() deliberately leave it
    // alone, so loading a position never silently changes the rules.
    this.variant = 'standard';
    this.reset();
  }

  setVariant(name) {
    this.variant = name === 'atomic' || name === 'pawnwars' ? name : 'standard';
    return this;
  }

  get isAtomic() { return this.variant === 'atomic'; }

  // Pawn Wars: nothing but pawns, starting on the first and last ranks. There
  // are no kings, so there is no check and no mate — you win by taking every
  // pawn your opponent has.
  get isPawnWars() { return this.variant === 'pawnwars'; }

  pawnCount(c) {
    let n = 0;
    for (const p of this.squares) if (p && p.c === c && p.t === 'p') n++;
    return n;
  }

  // The squares an explosion centred on `sq` destroys: the square itself and
  // its eight neighbours. Pawns on the neighbouring squares survive — only the
  // captured pawn and the capturing piece go up with it.
  explosionSquares(sq) {
    const out = [sq];
    const f = fileOf(sq), r = rankOf(sq);
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = f + df, nr = r + dr;
        if (inBoard(nf, nr)) out.push(sqIdx(nf, nr));
      }
    }
    return out;
  }

  // True once a side has no king — in atomic that ends the game immediately.
  kingMissing(c) { return this.findKing(c) === -1; }

  reset() {
    this.squares = new Array(64).fill(null);
    if (this.isPawnWars) {
      // Pawns only, on the outermost ranks: they start where they would
      // normally promote, and promote at the far end.
      for (let f = 0; f < 8; f++) {
        this.squares[sqIdx(f, 0)] = { t: 'p', c: W };
        this.squares[sqIdx(f, 7)] = { t: 'p', c: B };
      }
    } else {
    const back = ['r','n','b','q','k','b','n','r'];
    for (let f = 0; f < 8; f++) {
      this.squares[sqIdx(f,0)] = { t: back[f], c: W };
      this.squares[sqIdx(f,1)] = { t: 'p',     c: W };
      this.squares[sqIdx(f,6)] = { t: 'p',     c: B };
      this.squares[sqIdx(f,7)] = { t: back[f], c: B };
    }
    }
    this.turn = W;
    // Nothing to castle with in Pawn Wars, and claiming rights would put a
    // meaningless "KQkq" in every FEN it produces.
    this.castling = this.isPawnWars
      ? { K: false, Q: false, k: false, q: false }
      : { K: true, Q: true, k: true, q: true };
    // Standard chess fixes the king on e1/e8 and the castling rooks in the
    // corners. Chess960 does not, so both are state rather than constants.
    this.castleRook = { K: 7, Q: 0, k: 7, q: 0 };
    this.kingHomeFile = { [W]: 4, [B]: 4 };
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
    // Pawn Wars has no kings at all; every other variant must have exactly one
    // per side, which is the check that catches most malformed FENs.
    if (this.isPawnWars ? (wKings || bKings) : (wKings !== 1 || bKings !== 1)) {
      throw new Error(this.isPawnWars
        ? 'Pawn Wars positions have no kings'
        : 'FEN must have exactly one king per side');
    }

    // Validate the en-passant field before touching any state, so a bad FEN
    // never leaves a half-loaded position behind.
    let ep = null;
    if (parts[3] && parts[3] !== '-') {
      const file = parts[3].charCodeAt(0) - 97;
      const rank = parseInt(parts[3][1], 10) - 1;
      if (file < 0 || file > 7 || isNaN(rank) || rank < 0 || rank > 7) {
        throw new Error(`FEN: bad en-passant square "${parts[3]}"`);
      }
      ep = sqIdx(file, rank);
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
    this.deriveCastlingLayout(cr);
    this.ep = ep;
    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
    this.history = [];
    this.positionCounts = new Map();
    this.positionCounts.set(this.positionKey(), 1);
  }

  // Work out which rook each castling right refers to and where each king
  // stands. Plain KQkq doesn't say — in standard chess it needn't, but Chess960
  // puts the pieces anywhere. Resolved with the X-FEN rule: a right refers to
  // the OUTERMOST rook on that side of the king. Shredder-style file letters
  // (e.g. "HAha") are honoured literally when present.
  //
  // The one position this can't resolve is a back rank holding three or more
  // same-colour rooks (only reachable by promotion) while the rights are still
  // live; there the outermost rook may not be the one the right meant.
  deriveCastlingLayout(cr) {
    this.castleRook = { K: 7, Q: 0, k: 7, q: 0 };
    this.kingHomeFile = { [W]: 4, [B]: 4 };

    for (const c of [W, B]) {
      const home = c === W ? 0 : 7;
      const ours = c === W;
      const kRight = ours ? 'K' : 'k';
      const qRight = ours ? 'Q' : 'q';

      let kingFile = -1;
      const rookFiles = [];
      for (let f = 0; f < 8; f++) {
        const p = this.squares[sqIdx(f, home)];
        if (!p || p.c !== c) continue;
        if (p.t === 'k' && kingFile < 0) kingFile = f;
        else if (p.t === 'r') rookFiles.push(f);
      }
      // A king off its home rank cannot castle, whatever the FEN claims.
      if (kingFile < 0) {
        this.castling[kRight] = false;
        this.castling[qRight] = false;
        continue;
      }
      this.kingHomeFile[c] = kingFile;

      const explicit = [];
      for (const ch of cr) {
        const mine = ours ? ch >= 'A' && ch <= 'H' : ch >= 'a' && ch <= 'h';
        if (mine) explicit.push(ch.toLowerCase().charCodeAt(0) - 97);
      }

      if (explicit.length) {
        this.castling[kRight] = false;
        this.castling[qRight] = false;
        for (const f of explicit) {
          if (f > kingFile) { this.castling[kRight] = true; this.castleRook[kRight] = f; }
          else if (f < kingFile) { this.castling[qRight] = true; this.castleRook[qRight] = f; }
        }
        continue;
      }

      const right = rookFiles.filter((f) => f > kingFile);
      const left = rookFiles.filter((f) => f < kingFile);
      if (this.castling[kRight]) {
        if (!right.length) this.castling[kRight] = false;
        else this.castleRook[kRight] = right[right.length - 1];
      }
      if (this.castling[qRight]) {
        if (!left.length) this.castling[qRight] = false;
        else this.castleRook[qRight] = left[0];
      }
    }
  }

  // Resolve a (from, to) pair to a legal move.
  //
  // Castling is encoded king-to-ROOK, the Chess960 convention, because in
  // Chess960 the king's castling destination can be a single square away and
  // therefore identical to an ordinary king move — "f1g1" on its own would be
  // ambiguous. Order matters: an ordinary move wins the exact match, then a
  // castle is matched by its rook's square, and only then by the king's
  // destination, which is how games recorded before Chess960 existed are written.
  findMove(from, to, promo) {
    const moves = this.legalMoves();
    const promoOk = (m) => (promo ? m.promo === promo : !m.promo);
    return (
      moves.find((m) => !m.castle && m.from === from && m.to === to && promoOk(m)) ||
      moves.find((m) => m.castle && m.from === from && m.rookFrom === to) ||
      moves.find((m) => m.castle && m.from === from && m.to === to) ||
      null
    );
  }

  // Every square the king and rook travel over (and land on) must be empty,
  // ignoring those two pieces themselves — in Chess960 either may already be
  // standing on a square the other needs.
  castlePathClear(kingFrom, rookFrom, kingTo, rookTo) {
    const home = rankOf(kingFrom);
    const walk = (a, b) => {
      const lo = Math.min(fileOf(a), fileOf(b));
      const hi = Math.max(fileOf(a), fileOf(b));
      for (let f = lo; f <= hi; f++) {
        const sq = sqIdx(f, home);
        if (sq === kingFrom || sq === rookFrom) continue;
        if (this.squares[sq]) return false;
      }
      return true;
    };
    return walk(kingFrom, kingTo) && walk(rookFrom, rookTo);
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

  // Serialize to a standard FEN string (the inverse of loadFen). Used to persist
  // positions server-side (games.current_fen, moves.fen_after) and, in PvP, for
  // the server's authoritative state.
  fen() {
    let board = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.squares[sqIdx(f, r)];
        if (!p) { empty++; continue; }
        if (empty) { board += empty; empty = 0; }
        board += p.c === W ? p.t.toUpperCase() : p.t;
      }
      if (empty) board += empty;
      if (r > 0) board += '/';
    }
    let cr = (this.castling.K ? 'K' : '') + (this.castling.Q ? 'Q' : '')
           + (this.castling.k ? 'k' : '') + (this.castling.q ? 'q' : '');
    if (!cr) cr = '-';
    const ep = this.ep != null ? algOf(this.ep) : '-';
    const turn = this.turn === W ? 'w' : 'b';
    return `${board} ${turn} ${cr} ${ep} ${this.halfmove} ${this.fullmove}`;
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
      // Pawn Wars starts its pawns on the outer ranks, so that is where their
      // two-square opening move comes from.
      const startRank = this.isPawnWars ? (c === W ? 0 : 7) : (c === W ? 1 : 6);
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
      // Castling (path-empty + rook check; attacked squares tested in
      // legalMoves). Wherever the pieces start, the king finishes on the g-file
      // and the rook on f (kingside), or c and d (queenside).
      const home = c === W ? 0 : 7;
      if (r === home && f === this.kingHomeFile[c]) {
        const sides = c === W
          ? [['K', 'K', 6, 5], ['Q', 'Q', 2, 3]]
          : [['k', 'K', 6, 5], ['q', 'Q', 2, 3]];
        for (const [right, side, kingToFile, rookToFile] of sides) {
          if (!this.castling[right]) continue;
          const rookFrom = sqIdx(this.castleRook[right], home);
          const rook = this.squares[rookFrom];
          if (!rook || rook.t !== 'r' || rook.c !== c) continue;
          const kingTo = sqIdx(kingToFile, home);
          const rookTo = sqIdx(rookToFile, home);
          if (!this.castlePathClear(sq, rookFrom, kingTo, rookTo)) continue;
          add(kingTo, { castle: side, rookFrom });
        }
      }
    }
    return moves;
  }

  // `ignoreKing` skips attacks by the opposing king: in atomic a king can never
  // capture, so it cannot deliver check, and the two kings may stand adjacent.
  isAttacked(sq, byColor, ignoreKing) {
    if (sq < 0) return false;
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
    // king — skipped entirely under `ignoreKing`, which is how atomic lets the
    // two kings stand next to each other: neither can capture, so neither can
    // give check.
    if (!ignoreKing) {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = f + df, nr = r + dr;
        if (!inBoard(nf, nr)) continue;
        const p = this.squares[sqIdx(nf, nr)];
        if (p && p.c === byColor && p.t === 'k') return true;
      }
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

  // Atomic: kings on adjacent squares are "connected". Neither can be captured
  // (the blast would take the capturer's own king too), so no piece gives
  // check while they touch, whatever else is aimed at them.
  kingsConnected() {
    if (!this.isAtomic) return false;
    const wk = this.findKing(W), bk = this.findKing(B);
    if (wk === -1 || bk === -1) return false;
    return Math.abs(fileOf(wk) - fileOf(bk)) <= 1 && Math.abs(rankOf(wk) - rankOf(bk)) <= 1;
  }

  inCheck(c) {
    if (c === undefined) c = this.turn;
    const king = this.findKing(c);
    if (king === -1) return false;
    if (this.kingsConnected()) return false;
    return this.isAttacked(king, opp(c), this.isAtomic);
  }

  // Castling may not start from check or pass through an attacked square; the
  // landing square is covered by the ordinary make/undo test. The king's walk
  // can be any length, or none, in Chess960, so every square from where it
  // stands to where it lands is checked.
  castlingCrossesCheck(m, c) {
    if (this.inCheck(c)) return true;
    const home = rankOf(m.from);
    const lo = Math.min(fileOf(m.from), fileOf(m.to));
    const hi = Math.max(fileOf(m.from), fileOf(m.to));
    for (let ff = lo; ff <= hi; ff++) {
      if (this.isAttacked(sqIdx(ff, home), opp(c), this.isAtomic)) return true;
    }
    return false;
  }

  legalMoves(forColor) {
    const c = forColor || this.turn;
    // With a king already gone the game is over; offering moves would let a
    // search play on past the end.
    if (this.isAtomic && (this.kingMissing(W) || this.kingMissing(B))) return [];
    // Same in Pawn Wars once a side has been wiped out.
    if (this.isPawnWars && (this.pawnCount(W) === 0 || this.pawnCount(B) === 0)) return [];
    const moves = [];
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq];
      if (!p || p.c !== c) continue;
      for (const m of this.pseudoMovesFrom(sq, c)) {
        // Pawn Wars has no king to expose, so every pseudo-legal move is legal.
        if (this.isPawnWars) { moves.push(m); continue; }
        // No castling out of check or through check, in any variant. Into
        // check is caught by the make/undo test below.
        if (m.castle && this.castlingCrossesCheck(m, c)) continue;
        if (this.isAtomic) {
          // A king that captured would blow itself up, so it never may.
          if (p.t === 'k' && (m.capture || m.enpassant)) continue;
          this.makeMove(m, false);
          const mine = this.findKing(c);
          const theirs = this.findKing(opp(c));
          // Blowing up your own king is never legal, even to take theirs.
          // Taking theirs and keeping yours wins on the spot — check is moot.
          // With the kings connected nothing can take ours, so a square next
          // to theirs is safe however many pieces are aimed at it.
          const legal =
            mine !== -1 &&
            (theirs === -1 || this.kingsConnected() || !this.isAttacked(mine, opp(c), true));
          this.undoMove();
          if (legal) moves.push(m);
          continue;
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
    // Castling captures nothing — and in Chess960 the king's destination may be
    // occupied by its own castling rook, which must not be read as a capture.
    const captured = m.castle
      ? null
      : m.enpassant
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

    if (m.castle) {
      // Both pieces move at once and their squares can overlap, so lift both
      // before setting either down.
      const r = rankOf(m.from);
      const rookFrom = m.rookFrom != null ? m.rookFrom : sqIdx(m.castle === 'K' ? 7 : 0, r);
      const rook = this.squares[rookFrom];
      this.squares[m.from] = null;
      this.squares[rookFrom] = null;
      this.squares[sqIdx(m.castle === 'K' ? 6 : 2, r)] = piece;
      this.squares[sqIdx(m.castle === 'K' ? 5 : 3, r)] = rook;
    } else {
      this.squares[m.from] = null;
      this.squares[m.to] = m.promo ? { t: m.promo, c: piece.c } : piece;
      if (m.enpassant) {
        this.squares[sqIdx(fileOf(m.to), rankOf(m.from))] = null;
      }
    }

    // Castling rights updates
    if (piece.t === 'k') {
      if (piece.c === W) { this.castling.K = false; this.castling.Q = false; }
      else { this.castling.k = false; this.castling.q = false; }
    }
    // A move from or to a castling rook's home square ends that right —
    // whichever square that happens to be.
    for (const right of ['K', 'Q', 'k', 'q']) {
      if (!this.castling[right]) continue;
      const rookHome = sqIdx(this.castleRook[right], right === right.toUpperCase() ? 0 : 7);
      if (m.from === rookHome || m.to === rookHome) this.castling[right] = false;
    }

    // Atomic: a capture destroys the capturing piece, whatever it took, and
    // every non-pawn on the eight adjacent squares. Recorded on the history
    // entry so undoMove can put them all back.
    if (this.isAtomic && (captured || m.enpassant)) {
      const blast = [];
      for (const sq of this.explosionSquares(m.to)) {
        const p = this.squares[sq];
        if (!p) continue;
        // Only the square itself is cleared unconditionally; neighbouring
        // pawns are the one thing an explosion leaves standing.
        if (sq !== m.to && p.t === 'p') continue;
        blast.push({ sq, piece: p });
        this.squares[sq] = null;
      }
      // En passant takes a pawn that is beside the blast, not in it.
      if (m.enpassant) {
        const epSq = sqIdx(fileOf(m.to), rankOf(m.from));
        if (this.squares[epSq]) {
          blast.push({ sq: epSq, piece: this.squares[epSq] });
          this.squares[epSq] = null;
        }
      }
      histEntry.blast = blast;
      // A rook that goes up in the blast takes its castling right with it.
      for (const right of ['K', 'Q', 'k', 'q']) {
        if (!this.castling[right]) continue;
        const rookHome = sqIdx(this.castleRook[right], right === right.toUpperCase() ? 0 : 7);
        if (blast.some((b) => b.sq === rookHome)) this.castling[right] = false;
      }
      for (const b of blast) {
        if (b.piece.t !== 'k') continue;
        if (b.piece.c === W) { this.castling.K = false; this.castling.Q = false; }
        else { this.castling.k = false; this.castling.q = false; }
      }
    }

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

    // Atomic: restore everything the explosion removed before unwinding the
    // move itself, so the piece that moved is back on its destination square.
    if (h.blast) {
      for (const b of h.blast) this.squares[b.sq] = b.piece;
    }

    if (m.castle) {
      const r = rankOf(m.from);
      const kingTo = sqIdx(m.castle === 'K' ? 6 : 2, r);
      const rookTo = sqIdx(m.castle === 'K' ? 5 : 3, r);
      const rookFrom = m.rookFrom != null ? m.rookFrom : sqIdx(m.castle === 'K' ? 7 : 0, r);
      const king = this.squares[kingTo];
      const rook = this.squares[rookTo];
      this.squares[kingTo] = null;
      this.squares[rookTo] = null;
      this.squares[m.from] = king;
      this.squares[rookFrom] = rook;
    } else {
      const movedPiece = this.squares[m.to];
      this.squares[m.from] = m.promo ? { t: 'p', c: movedPiece.c } : movedPiece;
      if (m.enpassant) {
        this.squares[m.to] = null;
        this.squares[sqIdx(fileOf(m.to), rankOf(m.from))] = h.captured;
      } else {
        this.squares[m.to] = h.captured;
      }
    }
  }

  isInsufficientMaterial() {
    if (this.isPawnWars) return false;
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

  // Atomic ends the moment a king is destroyed, however that happened.
  isCheckmate() {
    if (this.isPawnWars) return false;
    if (this.isAtomic) {
      if (this.kingMissing(this.turn)) return true;          // ours went up: we lost
      if (this.kingMissing(opp(this.turn))) return false;    // theirs did: a win, not mate
      return this.inCheck() && this.legalMoves().length === 0;
    }
    return this.inCheck() && this.legalMoves().length === 0;
  }
  isStalemate() {
    if (this.isPawnWars) {
      if (this.pawnCount(W) === 0 || this.pawnCount(B) === 0) return false;
      return this.legalMoves().length === 0;
    }
    if (this.isAtomic && (this.kingMissing(W) || this.kingMissing(B))) return false;
    return !this.inCheck() && this.legalMoves().length === 0;
  }
  isThreefoldRepetition() {
    return (this.positionCounts.get(this.positionKey()) || 0) >= 3;
  }
  isFivefoldRepetition() {
    return (this.positionCounts.get(this.positionKey()) || 0) >= 5;
  }
  isGameOver() {
    if (this.isPawnWars) {
      return this.pawnCount(W) === 0 || this.pawnCount(B) === 0
          || this.legalMoves().length === 0
          || this.halfmove >= 100
          || this.isThreefoldRepetition();
    }
    if (this.isAtomic && (this.kingMissing(W) || this.kingMissing(B))) return true;
    return this.legalMoves().length === 0
        || this.isInsufficientMaterial()
        || this.halfmove >= 100
        || this.isThreefoldRepetition();
  }
  result() {
    if (this.isPawnWars) {
      const w = this.pawnCount(W), b = this.pawnCount(B);
      // Promoting your last pawn loses too — the rule is about pawns, not
      // material — and a move that clears both sides at once is a draw.
      if (w === 0 && b === 0) return '1/2-1/2';
      if (w === 0) return '0-1';
      if (b === 0) return '1-0';
      if (this.isGameOver()) return '1/2-1/2';  // nothing to move, or a rule draw
      return '*';
    }
    if (this.isAtomic) {
      // Whoever still has a king has won.
      if (this.kingMissing(W)) return '0-1';
      if (this.kingMissing(B)) return '1-0';
    }
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

// --- UMD export: Node `require` gets the named bindings; browser <script> and
// Web Worker importScripts keep the top-level lexical globals (W/B/Chess/...)
// that ui.js, lorfish.js, and engineWorker.js rely on. ---
// Pawn Wars opens with eight pawns a side on the outer ranks.
const PAWN_WARS_START = 'pppppppp/8/8/8/8/8/8/PPPPPPPP w - - 0 1';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Chess, W, B, PIECE_NAMES, PAWN_WARS_START,
    sqIdx, fileOf, rankOf, algOf, opp, inBoard,
  };
}
