"use strict";

// The infinite chess engine: infinitechess.org's "Classical" rules on a board
// with no edges (docs/design.md, "Infinite chess"). It is not chess.js with
// bigger numbers — two things that engine takes for granted are false here:
//
//   - The board is not 64 squares. A position is a Map from "x,y" to the piece
//     standing there; squares are integer coordinates, the usual setup in its
//     usual place (a1 is 1,1), and every coordinate within ±LIMIT.
//   - A position's moves cannot be listed: a rook on an open file has
//     infinitely many. So nothing here enumerates them. findMove() answers
//     whether one given move is legal, by looking at the finitely many pieces
//     on the board — which piece stands between two squares, which piece
//     attacks a square — never by walking along a ray square by square.
//
// Each piece carries `right`, its special right in ICN's sense: a pawn's
// double step, or a king's or castling piece's castling right.
//
// Loaded as a browser <script> (served at /js/infiniteChess.js) and as a Node
// `require`. Everything is inside the closure, so its helpers can't clash with
// chess.js's globals (W, B, opp, ...) on a page that loads both.

const InfiniteChess = (function () {
  const W = 'w', B = 'b';
  const opp = (c) => (c === W ? B : W);
  // Every coordinate stays within ±LIMIT: a slider stops at it, and nothing
  // may be set up beyond it.
  const LIMIT = 1000000;
  const isCoord = (n) => Number.isInteger(n) && Math.abs(n) <= LIMIT;
  const keyOf = (x, y) => x + ',' + y;
  const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

  const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const SLIDES = { b: DIAGONAL, r: ORTHOGONAL, q: ORTHOGONAL.concat(DIAGONAL) };
  const PIECE_TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
  // Pawns promote on arriving at this rank, and nowhere else.
  const PROMOTION_RANK = { [W]: 8, [B]: 1 };
  const PROMOTIONS = ['q', 'r', 'b', 'n'];

  // The Classical setup: the ordinary pieces on the ordinary squares, every
  // pawn able to step twice, kings and rooks able to castle.
  function classicalPieces() {
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    const pieces = [];
    for (let i = 0; i < 8; i++) {
      const x = i + 1;
      const t = back[i];
      const castles = t === 'r' || t === 'k';
      pieces.push({ t, c: W, x, y: 1, right: castles }, { t: 'p', c: W, x, y: 2, right: true });
      pieces.push({ t, c: B, x, y: 8, right: castles }, { t: 'p', c: B, x, y: 7, right: true });
    }
    return pieces;
  }

  // Dead material (infinitechess.org's insufficientmaterial.ts, the table for a
  // board without edges, standard pieces only). On an infinite board far less
  // can mate than usual: a king and queen can't mate a bare king even with
  // help. Each row is material with which Black can't be checkmated, kings
  // included; a position whose material fits within a row, read either way
  // round, is dead. Counts are maxima. Bishops are [on one colour, on the
  // other], larger first; Infinity means any number.
  const DEAD = (function () {
    const kings = { K: 1, k: 1 };
    const rows = [
      { Q: 1, q: 1 }, { Q: 1, r: 1 }, { Q: 1, b: [1, 0], n: 1 }, { Q: 1, b: [1, 1] },
      { Q: 1, n: 2 }, { Q: 1, p: 1 },
      { R: 1, B: [1, 0], n: 1 }, { R: 1, N: 1, n: 1 }, { R: 1, r: 1 }, { R: 1, b: [1, 1] },
      { R: 1, b: [1, 0], n: 1 }, { R: 1, n: 2 }, { R: 1, p: 1 },
      { B: [Infinity, 1] }, { B: [Infinity, 0], N: 1 }, { B: [Infinity, 0], p: 1 },
      { B: [1, 1], N: 1 }, { B: [1, 1], b: [1, 0] }, { B: [1, 1], n: 1 }, { B: [1, 1], p: 1 },
      { B: [1, 0], N: 2 }, { B: [1, 0], N: 1, b: [1, 0] }, { B: [1, 0], N: 1, b: [0, 1] },
      { B: [1, 0], N: 1, n: 1 }, { B: [1, 0], N: 1, p: 1 }, { B: [1, 0], n: 2 },
      { N: 3 }, { N: 2, n: 1 }, { N: 2, p: 1 }, { P: 3, p: 1 },
    ];
    // Theirs also lists material without a white king, which these rules
    // never have (one king a side), and kings alone.
    return rows.map((r) => Object.assign({}, kings, r)).concat([kings]);
  })();
  // Above this many pieces a position is never called dead (as theirs).
  const DEAD_MAX_PIECES = 10;

  // Does `a` (a count or a bishop pair) exceed `b` anywhere?
  function more(a, b) {
    if (typeof a === 'number') return a > b;
    return a[0] > b[0] || a[1] > b[1];
  }
  const fitsRow = (scen, row) => Object.keys(scen).every((k) => k in row && !more(scen[k], row[k]));
  const isDeadScenario = (scen) => DEAD.some((row) => fitsRow(scen, row));

  // Sort the bishop pairs larger-first, White's first and Black's the same
  // way round, so the two sides' colours keep their relation (theirs:
  // normalizeBishopParities). Black's is sorted alone only when White's says
  // nothing about colour.
  function normalizeBishops(scen) {
    const w = scen.B, b = scen.b;
    let swapped = false;
    if (w && w[0] < w[1]) { scen.B = [w[1], w[0]]; swapped = true; }
    if (b) {
      if (swapped) scen.b = [b[1], b[0]];
      else if (!w || w[0] === w[1]) scen.b = b[0] < b[1] ? [b[1], b[0]] : b;
    }
    return scen;
  }

  // The same material with the colours swapped.
  function invert(scen) {
    const out = {};
    for (const k of Object.keys(scen)) {
      const swapped = k === k.toUpperCase() ? k.toLowerCase() : k.toUpperCase();
      out[swapped] = Array.isArray(scen[k]) ? scen[k].slice() : scen[k];
    }
    return normalizeBishops(out);
  }

  class InfiniteChess {
    constructor() {
      this.reset();
    }

    reset() {
      this.setup({ pieces: classicalPieces() });
    }

    // Load a position. `pieces` is a list of { t, c, x, y, right }; the rest is
    // the state FEN would carry. Throws on anything that is not a position
    // these rules could reach, and leaves the old position alone if it does.
    setup({ pieces, turn = W, ep = null, halfmove = 0, fullmove = 1 }) {
      if (!Array.isArray(pieces)) throw new Error('A position needs a list of pieces');
      if (turn !== W && turn !== B) throw new Error(`Side to move must be "w" or "b", not "${turn}"`);
      const board = new Map();
      const kings = {};
      for (const p of pieces) {
        if (!p || !PIECE_TYPES.includes(p.t) || (p.c !== W && p.c !== B)) {
          throw new Error(`Not a piece: ${JSON.stringify(p)}`);
        }
        if (!isCoord(p.x) || !isCoord(p.y)) {
          throw new Error(`Square ${p.x},${p.y} is not within ±${LIMIT}`);
        }
        const key = keyOf(p.x, p.y);
        if (board.has(key)) throw new Error(`Two pieces on ${key}`);
        if (p.t === 'p' && p.y === PROMOTION_RANK[p.c]) {
          throw new Error(`A pawn on ${key} would have promoted`);
        }
        if (p.t === 'k') {
          if (kings[p.c]) throw new Error('Each side has exactly one king');
          kings[p.c] = true;
        }
        board.set(key, { t: p.t, c: p.c, x: p.x, y: p.y, right: !!p.right });
      }
      if (!kings[W] || !kings[B]) throw new Error('Each side has exactly one king');

      // The en passant square is empty, with the pawn that just stepped past
      // it beyond it and the square it came from empty behind.
      let epSquare = null;
      if (ep != null) {
        const dir = turn === W ? 1 : -1; // the way the side to move's pawns go
        if (!ep || !isCoord(ep.x) || !isCoord(ep.y)) throw new Error('Bad en passant square');
        const pawn = board.get(keyOf(ep.x, ep.y - dir));
        if (board.has(keyOf(ep.x, ep.y)) || board.has(keyOf(ep.x, ep.y + dir)) ||
            !pawn || pawn.t !== 'p' || pawn.c === turn) {
          throw new Error(`${ep.x},${ep.y} is not behind a pawn that just stepped twice`);
        }
        epSquare = { x: ep.x, y: ep.y };
      }
      if (!Number.isInteger(halfmove) || halfmove < 0) throw new Error('Bad halfmove count');
      if (!Number.isInteger(fullmove) || fullmove < 1) throw new Error('Bad fullmove number');

      const previous = { board: this.board, turn: this.turn };
      this.board = board;
      this.turn = turn;
      // The side that just moved can't still be in check.
      if (this.inCheck(opp(turn))) {
        this.board = previous.board;
        this.turn = previous.turn;
        throw new Error('The side not to move is in check');
      }
      this.ep = epSquare;
      this.halfmove = halfmove;
      this.fullmove = fullmove;
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
    }

    pieceAt(x, y) {
      return this.board.get(keyOf(x, y)) || null;
    }

    // The pieces as ICN lists them ("K5,1+", "p3,7"), sorted so two equal
    // positions give equal lists.
    pieceList() {
      const out = [];
      for (const p of this.board.values()) {
        out.push((p.c === W ? p.t.toUpperCase() : p.t) + p.x + ',' + p.y + (p.right ? '+' : ''));
      }
      return out.sort();
    }

    kingOf(c) {
      for (const p of this.board.values()) if (p.t === 'k' && p.c === c) return p;
      return null;
    }

    // Is every square strictly between (x0,y0) and (x1,y1) — on one rank, file
    // or diagonal — empty? Asked of the pieces, not of the squares: there may
    // be a million squares between and only thirty pieces.
    clearBetween(x0, y0, x1, y1) {
      const dx = sign(x1 - x0), dy = sign(y1 - y0);
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (const p of this.board.values()) {
        const t = dx ? (p.x - x0) / dx : (p.y - y0) / dy;
        if (t > 0 && t < n && p.x === x0 + t * dx && p.y === y0 + t * dy) return false;
      }
      return true;
    }

    // Could `p` capture on (x, y) if an enemy stood there? Its pieces' lines,
    // not its legal moves: a pinned piece still attacks.
    attacks(p, x, y) {
      const dx = x - p.x, dy = y - p.y;
      if (!dx && !dy) return false;
      switch (p.t) {
        case 'p': return Math.abs(dx) === 1 && dy === (p.c === W ? 1 : -1);
        case 'n': return (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
        case 'k': return Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
        case 'b': return Math.abs(dx) === Math.abs(dy) && this.clearBetween(p.x, p.y, x, y);
        case 'r': return (!dx || !dy) && this.clearBetween(p.x, p.y, x, y);
        default: // queen
          return (!dx || !dy || Math.abs(dx) === Math.abs(dy)) && this.clearBetween(p.x, p.y, x, y);
      }
    }

    isAttacked(x, y, byColor) {
      for (const p of this.board.values()) {
        if (p.c === byColor && this.attacks(p, x, y)) return true;
      }
      return false;
    }

    inCheck(c) {
      if (c === undefined) c = this.turn;
      const king = this.kingOf(c);
      return !!king && this.isAttacked(king.x, king.y, opp(c));
    }

    // The legal move of the side to move from `from` to `to` (each { x, y }),
    // promoting to `promo` if it is a promotion, or null. Castling is the
    // king's two-square step. Anything malformed is simply not a legal move.
    findMove(from, to, promo) {
      if (!from || !to || !isCoord(from.x) || !isCoord(from.y) || !isCoord(to.x) || !isCoord(to.y)) {
        return null;
      }
      const piece = this.pieceAt(from.x, from.y);
      if (!piece || piece.c !== this.turn) return null;
      const move = this.pseudoMove(piece, to.x, to.y, promo || null);
      if (!move) return null;
      this.makeMove(move, false);
      const legal = !this.inCheck(piece.c);
      this.undoMove();
      return legal ? move : null;
    }

    // `piece` to (x, y) by the way it moves, ignoring only whether it leaves
    // its own king in check (castling excepted: it may not start in check or
    // cross an attacked square, which findMove's test can't see).
    pseudoMove(piece, x, y, promo) {
      const dx = x - piece.x, dy = y - piece.y;
      if (!dx && !dy) return null;
      const target = this.pieceAt(x, y);
      if (target && target.c === piece.c) return null;
      const move = { from: { x: piece.x, y: piece.y }, to: { x, y }, piece: piece.t, capture: !!target };

      if (piece.t === 'p') {
        // A promotion names its piece; nothing else names one.
        if (y === PROMOTION_RANK[piece.c] ? !PROMOTIONS.includes(promo) : promo) return null;
        if (promo) move.promo = promo;
        const dir = piece.c === W ? 1 : -1;
        if (!dx && dy === dir && !target) return move;
        if (!dx && dy === 2 * dir && piece.right && !target && !this.pieceAt(x, piece.y + dir)) {
          move.ep = { x, y: piece.y + dir };
          return move;
        }
        if (Math.abs(dx) === 1 && dy === dir) {
          if (target) return move;
          if (this.ep && this.ep.x === x && this.ep.y === y) {
            move.capture = true;
            move.enpassant = true;
            return move;
          }
        }
        return null;
      }

      if (promo) return null;
      switch (piece.t) {
        case 'n':
        case 'b':
        case 'r':
        case 'q':
          return this.attacks(piece, x, y) ? move : null;
        default: // king
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return move;
          if (!dy && Math.abs(dx) === 2 && !target) return this.castleMove(piece, sign(dx), move);
          return null;
      }
    }

    // Castling: a king with its right steps two squares towards the nearest
    // piece on its rank, which must be friendly, not a pawn, hold its own
    // right and stand at least three squares away; that piece lands on the
    // square the king passed over. Not out of check, nor across an attacked
    // square; landing on one is caught like any other move into check.
    castleMove(king, dir, move) {
      if (!king.right) return null;
      let nearest = null;
      for (const p of this.board.values()) {
        if (p.y !== king.y || (p.x - king.x) * dir <= 0) continue;
        if (!nearest || Math.abs(p.x - king.x) < Math.abs(nearest.x - king.x)) nearest = p;
      }
      if (!nearest || nearest.c !== king.c || nearest.t === 'p' || !nearest.right) return null;
      if (Math.abs(nearest.x - king.x) < 3) return null;
      if (this.inCheck(king.c)) return null;
      // The square passed over, judged with the king standing on it.
      const passed = { x: king.x + dir, y: king.y };
      const step = { from: { x: king.x, y: king.y }, to: passed, piece: 'k', capture: false };
      this.makeMove(step, false);
      const attacked = this.inCheck(king.c);
      this.undoMove();
      if (attacked) return null;
      move.castle = { rookFrom: { x: nearest.x, y: nearest.y }, rookTo: passed };
      return move;
    }

    // Play a move findMove (or pseudoMove) produced. Everything it changes is
    // recorded on the history entry, so undoMove can put it back exactly. The
    // engine's own trial moves pass `track` false: only a move really played
    // counts towards repetition.
    makeMove(move, track = true) {
      const piece = this.pieceAt(move.from.x, move.from.y);
      const capturedAt = move.enpassant ? { x: move.to.x, y: move.from.y } : move.to;
      const captured = move.castle ? null : this.pieceAt(capturedAt.x, capturedAt.y);
      const entry = {
        move,
        piece,
        captured,
        capturedAt,
        rightBefore: piece.right,
        rook: null,
        ep: this.ep,
        halfmove: this.halfmove,
        fullmove: this.fullmove,
        turn: this.turn,
        key: null,
      };

      if (captured) this.board.delete(keyOf(capturedAt.x, capturedAt.y));
      this.board.delete(keyOf(move.from.x, move.from.y));
      if (move.promo) {
        // A new piece, so the pawn object is still there to put back.
        this.board.set(keyOf(move.to.x, move.to.y),
          { t: move.promo, c: piece.c, x: move.to.x, y: move.to.y, right: false });
      } else {
        piece.x = move.to.x;
        piece.y = move.to.y;
        piece.right = false;
        this.board.set(keyOf(piece.x, piece.y), piece);
      }
      if (move.castle) {
        const rook = this.pieceAt(move.castle.rookFrom.x, move.castle.rookFrom.y);
        entry.rook = { piece: rook, right: rook.right };
        this.board.delete(keyOf(rook.x, rook.y));
        rook.x = move.castle.rookTo.x;
        rook.y = move.castle.rookTo.y;
        rook.right = false;
        this.board.set(keyOf(rook.x, rook.y), rook);
      }

      this.ep = move.ep || null;
      this.halfmove = piece.t === 'p' || captured ? 0 : this.halfmove + 1;
      if (this.turn === B) this.fullmove++;
      this.turn = opp(this.turn);
      this.history.push(entry);
      if (track) {
        entry.key = this.positionKey();
        this.positionCounts.set(entry.key, (this.positionCounts.get(entry.key) || 0) + 1);
      }
    }

    undoMove() {
      const h = this.history.pop();
      if (!h) return;
      if (h.key) {
        const n = this.positionCounts.get(h.key) - 1;
        if (n > 0) this.positionCounts.set(h.key, n);
        else this.positionCounts.delete(h.key);
      }
      const { move, piece } = h;
      if (h.rook) {
        const rook = h.rook.piece;
        this.board.delete(keyOf(rook.x, rook.y));
        rook.x = move.castle.rookFrom.x;
        rook.y = move.castle.rookFrom.y;
        rook.right = h.rook.right;
        this.board.set(keyOf(rook.x, rook.y), rook);
      }
      this.board.delete(keyOf(move.to.x, move.to.y));
      piece.x = move.from.x;
      piece.y = move.from.y;
      piece.right = h.rightBefore;
      this.board.set(keyOf(piece.x, piece.y), piece);
      if (h.captured) this.board.set(keyOf(h.capturedAt.x, h.capturedAt.y), h.captured);
      this.ep = h.ep;
      this.halfmove = h.halfmove;
      this.fullmove = h.fullmove;
      this.turn = h.turn;
    }
  }

  Object.assign(InfiniteChess.prototype, {
    // ---- whether any move is left ----

    // Does the side to move have a legal move? Pawns, knights and the king
    // have a handful each, and are simply tried. A slider has infinitely many,
    // but they fall into few kinds. If its king is safe with the slider lifted
    // off the board, its first step along any open ray is legal. If not, only
    // a move that takes or blocks every piece still attacking the king can be,
    // and those are finitely many squares: each attacker's own, and where each
    // ray crosses the line from that attacker to the king.
    hasLegalMove() {
      const c = this.turn;
      const king = this.kingOf(c);
      for (const p of [...this.board.values()]) {
        if (p.c !== c) continue;
        const from = { x: p.x, y: p.y };
        if (!SLIDES[p.t]) {
          for (const to of this.stepTargets(p)) {
            const promo = p.t === 'p' && to.y === PROMOTION_RANK[c] ? 'q' : null;
            if (this.findMove(from, to, promo)) return true;
          }
          continue;
        }
        const attackers = this.attackersWithout(p, king);
        for (const [dx, dy] of SLIDES[p.t]) {
          if (!attackers.length) {
            if (this.findMove(from, { x: p.x + dx, y: p.y + dy })) return true;
            continue;
          }
          for (const to of this.helpingSquares(p, dx, dy, king, attackers)) {
            if (this.findMove(from, to)) return true;
          }
        }
      }
      return false;
    },

    // The squares a pawn, knight or king might move to.
    stepTargets(p) {
      const out = [];
      const add = (dx, dy) => out.push({ x: p.x + dx, y: p.y + dy });
      if (p.t === 'n') for (const [dx, dy] of KNIGHT_STEPS) add(dx, dy);
      else if (p.t === 'k') {
        for (const [dx, dy] of ORTHOGONAL.concat(DIAGONAL)) add(dx, dy);
        add(2, 0); add(-2, 0); // castling
      } else {
        const dir = p.c === W ? 1 : -1;
        add(0, dir); add(0, 2 * dir); add(-1, dir); add(1, dir);
      }
      return out.filter((to) => isCoord(to.x) && isCoord(to.y));
    },

    // The enemy pieces that would attack `king` if `p` were not on the board.
    attackersWithout(p, king) {
      const key = keyOf(p.x, p.y);
      this.board.delete(key);
      const out = [];
      for (const q of this.board.values()) {
        if (q.c !== p.c && this.attacks(q, king.x, king.y)) out.push(q);
      }
      this.board.set(key, p);
      return out;
    },

    // Squares along `p`'s ray (dx, dy) that take or block one of `attackers`.
    helpingSquares(p, dx, dy, king, attackers) {
      const out = [];
      for (const a of attackers) {
        // Taking it, if it stands on the ray.
        const ax = a.x - p.x, ay = a.y - p.y;
        if (ax * dy === ay * dx && ax * dx + ay * dy > 0) out.push({ x: a.x, y: a.y });
        // Blocking it: only a slider's line has squares between.
        if (!SLIDES[a.t]) continue;
        const ex = sign(king.x - a.x), ey = sign(king.y - a.y);
        const n = Math.max(Math.abs(king.x - a.x), Math.abs(king.y - a.y));
        const det = ex * dy - dx * ey;
        // A ray parallel to the attacker's line blocks nothing new: either it
        // is that line — the piece pinned on it, where taking the attacker is
        // always open, nothing standing between them — or it never meets it.
        if (det === 0) continue;
        // Solve p + t*(dx,dy) = a + u*(ex,ey) for whole t >= 1, 0 < u < n.
        const rx = a.x - p.x, ry = a.y - p.y;
        const t = (ex * ry - ey * rx) / det;
        const u = (dx * ry - dy * rx) / det;
        if (Number.isInteger(t) && Number.isInteger(u) && t >= 1 && u > 0 && u < n) {
          out.push({ x: p.x + t * dx, y: p.y + t * dy });
        }
      }
      return out.filter((to) => isCoord(to.x) && isCoord(to.y));
    },

    // ---- how a game ends ----

    isCheckmate() {
      return this.inCheck() && !this.hasLegalMove();
    },

    isStalemate() {
      return !this.inCheck() && !this.hasLegalMove();
    },

    // The position for repetition: every piece with its special right, the
    // side to move, and an en passant square only while a capture there is
    // legal (as chess.js does). Rights count even when unusable, as on
    // infinitechess.org.
    positionKey() {
      let ep = '-';
      if (this.ep) {
        const dir = this.turn === W ? 1 : -1;
        for (const side of [-1, 1]) {
          if (this.findMove({ x: this.ep.x + side, y: this.ep.y - dir }, this.ep)) ep = keyOf(this.ep.x, this.ep.y);
        }
      }
      return this.pieceList().join('|') + ' ' + this.turn + ' ' + ep;
    },

    isThreefoldRepetition() {
      return (this.positionCounts.get(this.positionKey()) || 0) >= 3;
    },

    // The material as the dead-material table counts it, once for each piece
    // up to two pawns might become (staying a pawn included). Null when there
    // are more promotable pawns than that: never dead, as theirs.
    materialScenarios() {
      const base = {};
      const pawns = [];
      for (const p of this.board.values()) {
        if (p.t === 'p') { pawns.push(p); continue; }
        const k = p.c === W ? p.t.toUpperCase() : p.t;
        if (p.t === 'b') {
          if (!base[k]) base[k] = [0, 0];
          base[k][Math.abs(p.x + p.y) % 2] += 1;
        } else base[k] = (base[k] || 0) + 1;
      }
      if (pawns.length > 2) return null;
      let scenarios = [base];
      for (const pawn of pawns) {
        const up = (t) => (pawn.c === W ? t.toUpperCase() : t);
        const next = [];
        for (const scen of scenarios) {
          for (const t of ['p', 'q', 'r', 'n', 'b0', 'b1']) {
            const copy = JSON.parse(JSON.stringify(scen));
            const k = up(t[0]);
            if (t[0] === 'b') {
              if (!copy[k]) copy[k] = [0, 0];
              copy[k][Number(t[1])] += 1;
            } else copy[k] = (copy[k] || 0) + 1;
            next.push(copy);
          }
        }
        scenarios = next;
      }
      return scenarios.map(normalizeBishops);
    },

    // Dead: nobody could checkmate by any series of legal moves.
    isInsufficientMaterial() {
      if (this.board.size > DEAD_MAX_PIECES) return false;
      const scenarios = this.materialScenarios();
      return !!scenarios && scenarios.every((s) => isDeadScenario(s) || isDeadScenario(invert(s)));
    },

    // Could `c` still checkmate, by any series of legal moves with the
    // opponent's help? Asked when the opponent's flag falls: if not, it's a
    // draw. (infinitechess.org has a flag always lose; LorChess keeps the rule
    // every variant here has.) A bare king never can; otherwise the table
    // answers, with `c` as White, the side whose rows say it can't mate.
    hasMatingMaterial(c) {
      let alone = true;
      for (const p of this.board.values()) if (p.c === c && p.t !== 'k') alone = false;
      if (alone) return false;
      const scenarios = this.materialScenarios();
      if (!scenarios) return true;
      return !scenarios.every((s) => isDeadScenario(c === W ? s : invert(s)));
    },

    isGameOver() {
      return !this.hasLegalMove() || this.isInsufficientMaterial()
        || this.halfmove >= 100 || this.isThreefoldRepetition();
    },

    // Mate first, so a draw rule that holds at the same time never takes a
    // win away; then every draw.
    result() {
      if (this.isCheckmate()) return this.turn === W ? '0-1' : '1-0';
      return this.isGameOver() ? '1/2-1/2' : '*';
    },
  });

  InfiniteChess.LIMIT = LIMIT;
  InfiniteChess.PROMOTIONS = PROMOTIONS;
  return InfiniteChess;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { InfiniteChess };
}
