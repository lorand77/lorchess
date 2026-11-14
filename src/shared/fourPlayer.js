"use strict";

// The four-player chess engine, Teams mode, by chess.com's rules: one 14x14
// board with its 3x3 corners cut away (160 squares), four armies — Red at the
// bottom, Blue on the left, Yellow at the top, Green on the right — moving in
// that order, clockwise, and partners sitting opposite: Red with Yellow, Blue
// with Green. A partner's pieces can't be taken, and they block like anyone's.
// Its own engine, not chess.js with more squares, as infinite chess has its
// own: four colours, two teams and a turn that comes round in four.
//
// Everything is defined for Red and turned a quarter for each seat after it
// (rotate below): Blue's army is Red's turned once, Yellow's twice, Green's
// three times, so every king starts on its owner's right (the current
// standard setup) and no colour's rules can drift from another's.
//
// From chess.com's rules (support.chess.com, "4 Player Chess"):
//   - checkmate happens only when the mated player's turn comes, so a partner
//     may still block or capture in between; the first team to mate wins;
//   - stalemate is a draw;
//   - pawns promote on their 11th rank (their 8th in free-for-all, not here).
// Where the sources say nothing, these are choices, kept to as few as possible:
//   - en passant as in ordinary chess: on the very next move only, which in
//     Teams is always an opponent's;
//   - a king left where an opponent can take it (in check from one opponent,
//     its partner unable to help, the other opponent next) may be taken, and
//     that wins for the taker's team ("king captured");
//   - threefold repetition draws, and so does the fifty-move rule, counted as
//     fifty moves by each player: 200 plies with no capture or pawn move;
//   - material is dead only when all four have nothing but their kings.
//
// Squares are numbered y * 14 + x, x the file (a-n) and y the rank (1-14) from
// 0, Red's side at y = 0. Positions read and write chess.com's FEN4; moves are
// written as from and to squares and a promotion letter ("e2e4", "e10e11q").
//
// Loaded as a browser <script> (served at /js/fourPlayer.js) and as a Node
// `require`. Everything is inside the closure, so its helpers can't clash with
// chess.js's globals on a page that loads both.

const FourPlayer = (function () {
  const N = 14;
  const COLORS = ['r', 'b', 'y', 'g'];                 // the turn order, clockwise
  const TEAM = { r: 0, y: 0, b: 1, g: 1 };             // partners sit opposite
  const SEAT = { r: 0, b: 1, y: 2, g: 3 };             // quarter turns from Red
  const NAMES = { r: 'Red', b: 'Blue', y: 'Yellow', g: 'Green' };
  const PROMOTIONS = ['q', 'r', 'b', 'n'];
  // Fifty moves by each of the four.
  const FIFTY_MOVE_PLIES = 200;

  const onBoard = (x, y) => x >= 0 && x < N && y >= 0 && y < N && !((x < 3 || x > 10) && (y < 3 || y > 10));
  const sqOf = (x, y) => y * N + x;
  const xOf = (sq) => sq % N;
  const yOf = (sq) => (sq - (sq % N)) / N;
  const nameOf = (sq) => String.fromCharCode(97 + xOf(sq)) + (yOf(sq) + 1);
  function squareOf(name) {
    const m = /^([a-n])([1-9]|1[0-4])$/.exec(String(name));
    if (!m) return -1;
    const x = m[1].charCodeAt(0) - 97, y = Number(m[2]) - 1;
    return onBoard(x, y) ? sqOf(x, y) : -1;
  }

  // A quarter turn clockwise, Red's side to Blue's: (x, y) -> (y, 13 - x), and
  // a step (dx, dy) -> (dy, -dx). k quarter turns of a square or a step.
  function rotate(x, y, k) {
    for (let i = 0; i < k; i++) [x, y] = [y, N - 1 - x];
    return [x, y];
  }
  function rotateStep(dx, dy, k) {
    for (let i = 0; i < k; i++) [dx, dy] = [dy, -dx];
    return [dx, dy];
  }
  // A square as its owner sees it: in Red's frame, where its army stands at
  // the bottom.
  const frameOf = (sq, c) => rotate(xOf(sq), yOf(sq), (4 - SEAT[c]) % 4);
  const fromFrame = (x, y, c) => {
    const [rx, ry] = rotate(x, y, SEAT[c]);
    return sqOf(rx, ry);
  };

  // Red's back rank, d1 to k1: the king on its right.
  const BACK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  // Red's castling, in its frame: the king on h1, rooks on d1 and k1. Short is
  // towards k1 (two squares between, as in ordinary chess), long towards d1.
  const CASTLES = {
    k: { rook: [10, 0], kingTo: [9, 0], rookTo: [8, 0], between: [[8, 0], [9, 0]], crosses: [[8, 0], [9, 0]] },
    q: { rook: [3, 0], kingTo: [5, 0], rookTo: [6, 0], between: [[4, 0], [5, 0], [6, 0]], crosses: [[6, 0], [5, 0]] },
  };

  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const RAYS = { b: KING.slice(4), r: KING.slice(0, 4), q: KING };

  class FourPlayer {
    constructor() {
      this.reset();
    }

    reset() {
      this.squares = new Array(N * N).fill(null);
      for (const c of COLORS) {
        BACK.forEach((t, i) => {
          this.squares[fromFrame(3 + i, 0, c)] = { t, c };
          this.squares[fromFrame(3 + i, 1, c)] = { t: 'p', c };
        });
      }
      this.turn = 'r';
      this.castling = {};
      for (const c of COLORS) this.castling[c] = { k: true, q: true };
      this.ep = null;
      this.halfmove = 0;
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
    }

    // ---- the colours ----

    static nextColor(c) { return COLORS[(COLORS.indexOf(c) + 1) % 4]; }
    static teamOf(c) { return TEAM[c]; }
    static partnerOf(c) { return COLORS[(COLORS.indexOf(c) + 2) % 4]; }
    static opponentsOf(c) { return COLORS.filter((o) => TEAM[o] !== TEAM[c]); }

    // The direction a colour's pawns go, and whether a square is on its
    // second rank (a double step from there) or its eleventh (promotion).
    forward(c) { return rotateStep(0, 1, SEAT[c]); }
    onRank(sq, c, rank) { return frameOf(sq, c)[1] === rank - 1; }

    kingOf(c) {
      for (let sq = 0; sq < N * N; sq++) {
        const p = this.squares[sq];
        if (p && p.t === 'k' && p.c === c) return sq;
      }
      return -1;
    }

    // ---- attacks ----

    // Is `sq` attacked by any piece of `team` (0: Red and Yellow, 1: Blue and
    // Green)? Its pieces' lines, not its legal moves: a pinned piece attacks.
    isAttacked(sq, team) {
      const x = xOf(sq), y = yOf(sq);
      const enemy = (px, py, types) => {
        if (!onBoard(px, py)) return false;
        const p = this.squares[sqOf(px, py)];
        return !!p && TEAM[p.c] === team && types.includes(p.t);
      };
      for (const [dx, dy] of KNIGHT) if (enemy(x + dx, y + dy, 'n')) return true;
      for (const [dx, dy] of KING) if (enemy(x + dx, y + dy, 'k')) return true;
      // A pawn attacks the two squares diagonally ahead of it, ahead being its
      // own colour's way.
      for (const c of COLORS) {
        if (TEAM[c] !== team) continue;
        const [fx, fy] = this.forward(c);
        for (const s of [-1, 1]) {
          const px = x - fx - (fy ? s : 0), py = y - fy - (fx ? s : 0);
          if (!onBoard(px, py)) continue;
          const p = this.squares[sqOf(px, py)];
          if (p && p.t === 'p' && p.c === c) return true;
        }
      }
      for (const [dx, dy] of KING) {
        const diagonal = dx && dy;
        let px = x + dx, py = y + dy;
        while (onBoard(px, py)) {
          const p = this.squares[sqOf(px, py)];
          if (p) {
            if (TEAM[p.c] === team && (p.t === 'q' || p.t === (diagonal ? 'b' : 'r'))) return true;
            break;
          }
          px += dx;
          py += dy;
        }
      }
      return false;
    }

    inCheck(c) {
      if (c === undefined) c = this.turn;
      const k = this.kingOf(c);
      return k !== -1 && this.isAttacked(k, 1 - TEAM[c]);
    }

    // ---- moves ----

    // Every move of `c`'s pieces by the way they move, ignoring only whether
    // it leaves `c`'s own king attacked. Castling is checked in full here.
    pseudoMoves(c) {
      const moves = [];
      for (let from = 0; from < N * N; from++) {
        const p = this.squares[from];
        if (!p || p.c !== c) continue;
        const x = xOf(from), y = yOf(from);
        // A square a piece may land on: empty, or an opponent's (never a partner's).
        const target = (to) => {
          const q = this.squares[to];
          return !q || TEAM[q.c] !== TEAM[c];
        };
        const add = (to, extra) => {
          const q = this.squares[to];
          moves.push(Object.assign({ from, to, piece: p.t, color: c, capture: !!q }, extra));
        };
        if (p.t === 'p') this.pawnMoves(from, c, add);
        else if (p.t === 'n' || p.t === 'k') {
          for (const [dx, dy] of p.t === 'n' ? KNIGHT : KING) {
            if (!onBoard(x + dx, y + dy)) continue;
            const to = sqOf(x + dx, y + dy);
            if (target(to)) add(to);
          }
          if (p.t === 'k') this.castleMoves(from, c, add);
        } else {
          for (const [dx, dy] of RAYS[p.t]) {
            let px = x + dx, py = y + dy;
            while (onBoard(px, py)) {
              const to = sqOf(px, py);
              const q = this.squares[to];
              if (q) {
                if (TEAM[q.c] !== TEAM[c]) add(to);
                break;
              }
              add(to);
              px += dx;
              py += dy;
            }
          }
        }
      }
      return moves;
    }

    pawnMoves(from, c, add) {
      const [fx, fy] = this.forward(c);
      const x = xOf(from), y = yOf(from);
      const withPromo = (to, extra) => {
        if (this.onRank(to, c, 11)) for (const promo of PROMOTIONS) add(to, Object.assign({ promo }, extra));
        else add(to, extra);
      };
      if (onBoard(x + fx, y + fy) && !this.squares[sqOf(x + fx, y + fy)]) {
        withPromo(sqOf(x + fx, y + fy));
        const two = sqOf(x + 2 * fx, y + 2 * fy);
        if (this.onRank(from, c, 2) && onBoard(x + 2 * fx, y + 2 * fy) && !this.squares[two]) {
          add(two, { ep: { passed: sqOf(x + fx, y + fy), pawn: two } });
        }
      }
      for (const s of [-1, 1]) {
        const tx = x + fx + (fy ? s : 0), ty = y + fy + (fx ? s : 0);
        if (!onBoard(tx, ty)) continue;
        const to = sqOf(tx, ty);
        const q = this.squares[to];
        if (q && TEAM[q.c] !== TEAM[c]) withPromo(to);
        else if (!q && this.ep && this.ep.passed === to) {
          const victim = this.squares[this.ep.pawn];
          if (victim && TEAM[victim.c] !== TEAM[c]) add(to, { capture: true, enpassant: true });
        }
      }
    }

    // Castling, as in ordinary chess: neither king nor rook has moved, the
    // squares between are empty, and the king is not in check and crosses no
    // square an opponent attacks (landing on one is caught like any move into
    // check).
    castleMoves(from, c, add) {
      if (from !== fromFrame(7, 0, c) || this.inCheck(c)) return;
      for (const side of ['k', 'q']) {
        if (!this.castling[c][side]) continue;
        const k = CASTLES[side];
        const rookSq = fromFrame(k.rook[0], k.rook[1], c);
        const rook = this.squares[rookSq];
        if (!rook || rook.t !== 'r' || rook.c !== c) continue;
        if (k.between.some(([bx, by]) => this.squares[fromFrame(bx, by, c)])) continue;
        if (k.crosses.some(([bx, by]) => this.isAttacked(fromFrame(bx, by, c), 1 - TEAM[c]))) continue;
        add(fromFrame(k.kingTo[0], k.kingTo[1], c), {
          castle: { side, rookFrom: rookSq, rookTo: fromFrame(k.rookTo[0], k.rookTo[1], c) },
        });
      }
    }

    // The side to move's legal moves: those that don't leave its own king
    // attacked by either opponent. A move that takes an enemy king is always
    // legal: it ends the game. None once the game is over.
    legalMoves() {
      return this.isOver() ? [] : this.movesAsIfOn();
    }

    // The same, as though the game went on: what mate and stalemate ask, so a
    // game drawn by a rule isn't also read as a side with nothing to play.
    movesAsIfOn() {
      const c = this.turn;
      return this.pseudoMoves(c).filter((m) => {
        if (m.capture && !m.enpassant && this.squares[m.to].t === 'k') return true;
        this.makeMove(m, false);
        const safe = !this.inCheck(c);
        this.undoMove();
        return safe;
      });
    }

    // The legal move from `from` to `to` (square numbers or names), promoting
    // to `promo` if it is a promotion, or null.
    findMove(from, to, promo) {
      const f = typeof from === 'string' ? squareOf(from) : from;
      const t = typeof to === 'string' ? squareOf(to) : to;
      return this.legalMoves().find((m) => m.from === f && m.to === t && (m.promo || null) === (promo || null)) || null;
    }

    // ---- making and taking back moves ----

    makeMove(m, track = true) {
      const piece = this.squares[m.from];
      const capturedAt = m.enpassant ? this.ep.pawn : m.to;
      const entry = {
        move: m,
        piece,
        captured: this.squares[capturedAt],
        capturedAt,
        castling: JSON.stringify(this.castling),
        ep: this.ep,
        halfmove: this.halfmove,
        turn: this.turn,
        key: null,
      };
      this.squares[capturedAt] = null;
      this.squares[m.from] = null;
      this.squares[m.to] = m.promo ? { t: m.promo, c: piece.c } : piece;
      if (m.castle) {
        this.squares[m.castle.rookTo] = this.squares[m.castle.rookFrom];
        this.squares[m.castle.rookFrom] = null;
      }
      // Rights lost: a king that moves, a rook that leaves its corner or is
      // taken there.
      const c = piece.c;
      if (piece.t === 'k') this.castling[c] = { k: false, q: false };
      for (const o of COLORS) {
        for (const side of ['k', 'q']) {
          const home = fromFrame(CASTLES[side].rook[0], CASTLES[side].rook[1], o);
          if (m.from === home || capturedAt === home) this.castling[o] = Object.assign({}, this.castling[o], { [side]: false });
        }
      }
      this.ep = m.ep || null;
      this.halfmove = piece.t === 'p' || entry.captured ? 0 : this.halfmove + 1;
      this.turn = FourPlayer.nextColor(this.turn);
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
      const m = h.move;
      if (m.castle) {
        this.squares[m.castle.rookFrom] = this.squares[m.castle.rookTo];
        this.squares[m.castle.rookTo] = null;
      }
      this.squares[m.to] = null;
      this.squares[m.from] = h.piece;
      this.squares[h.capturedAt] = h.captured;
      this.castling = JSON.parse(h.castling);
      this.ep = h.ep;
      this.halfmove = h.halfmove;
      this.turn = h.turn;
    }

    // ---- how the game ends ----

    // A colour whose king has been taken, or null.
    kingTaken() {
      for (const c of COLORS) if (this.kingOf(c) === -1) return c;
      return null;
    }

    // The side to move has no legal move: mated if in check, else stalemated.
    // Asked only of the side to move: a mate is decided when the mated
    // player's turn comes, as chess.com has it.
    noMoves() { return this.movesAsIfOn().length === 0; }
    isCheckmate() { return !this.kingTaken() && this.inCheck() && this.noMoves(); }
    isStalemate() { return !this.kingTaken() && !this.inCheck() && this.noMoves(); }
    isThreefoldRepetition() { return (this.positionCounts.get(this.positionKey()) || 0) >= 3; }
    isInsufficientMaterial() { return this.squares.every((p) => !p || p.t === 'k'); }

    // Over without asking for the move list (legalMoves asks this).
    isOver() {
      return !!this.kingTaken() || this.halfmove >= FIFTY_MOVE_PLIES
        || this.isThreefoldRepetition() || this.isInsufficientMaterial();
    }
    isGameOver() { return this.isOver() || this.noMoves(); }

    // How it ended, named as for the other engines, or null while it goes on.
    termination() {
      if (this.kingTaken()) return 'king captured';
      if (this.isCheckmate()) return 'checkmate';
      if (this.isStalemate()) return 'stalemate';
      if (this.isInsufficientMaterial()) return 'insufficient';
      if (this.isThreefoldRepetition()) return 'threefold';
      if (this.halfmove >= FIFTY_MOVE_PLIES) return 'fifty-move';
      return null;
    }

    // Results are by team, written as for two players: "1-0" for Red and
    // Yellow, "0-1" for Blue and Green.
    result() {
      const taken = this.kingTaken();
      if (taken) return TEAM[taken] === 0 ? '0-1' : '1-0';
      if (this.isCheckmate()) return TEAM[this.turn] === 0 ? '0-1' : '1-0';
      return this.isGameOver() ? '1/2-1/2' : '*';
    }

    // ---- notation ----

    // The position for repetition: the board, the side to move, the castling
    // rights, and an en passant square only while the capture is legal.
    positionKey() {
      let s = '';
      for (const p of this.squares) s += p ? p.c + p.t : '.';
      let ep = '-';
      if (this.ep && this.pseudoMoves(this.turn).some((m) => m.enpassant)) ep = this.ep.passed;
      return `${s} ${this.turn} ${JSON.stringify(this.castling)} ${ep}`;
    }

    // chess.com's FEN4: side to move, eliminated players, kingside and
    // queenside castling rights and points, each four flags in turn order, the
    // fifty-move count, then the ranks from 14 to 1, each square a to n
    // comma-separated ("rP", or a count of empty squares; the corners count as
    // empty). En passant is not part of it.
    fen() {
      const flags = (f) => COLORS.map(f).join(',');
      const header = [
        this.turn.toUpperCase(),
        '0,0,0,0',
        flags((c) => (this.castling[c].k ? 1 : 0)),
        flags((c) => (this.castling[c].q ? 1 : 0)),
        '0,0,0,0',
        String(this.halfmove),
      ].join('-');
      const ranks = [];
      for (let y = N - 1; y >= 0; y--) {
        const cells = [];
        let empty = 0;
        for (let x = 0; x < N; x++) {
          const p = this.squares[sqOf(x, y)];
          if (!p) { empty++; continue; }
          if (empty) { cells.push(String(empty)); empty = 0; }
          cells.push(p.c + p.t.toUpperCase());
        }
        if (empty) cells.push(String(empty));
        ranks.push(cells.join(','));
      }
      return header + '-' + ranks.join('/');
    }

    // Read a FEN4. Throws, leaving the position as it was, on anything else: a
    // player marked eliminated or points (not in Teams), a piece in a corner,
    // a colour without exactly one king, a pawn already on its promotion rank,
    // or the side not to move able to take a king it shouldn't have been left.
    loadFen(text) {
      const parts = String(text == null ? '' : text).trim().split('-');
      if (parts.length < 7) throw new Error('FEN4 needs its six header fields and the ranks');
      const [turnField, eliminated, kside, qside, points, half] = parts;
      const board = parts.slice(6).join('-');
      const turn = turnField.toLowerCase();
      if (!COLORS.includes(turn)) throw new Error(`FEN4: "${turnField}" is not Red, Blue, Yellow or Green`);
      const four = (field, name) => {
        const v = field.split(',');
        if (v.length !== 4 || v.some((f) => f !== '0' && f !== '1')) throw new Error(`FEN4: bad ${name} "${field}"`);
        return v.map((f) => f === '1');
      };
      if (four(eliminated, 'eliminated players').some(Boolean)) throw new Error('FEN4: no player is eliminated in Teams');
      const ks = four(kside, 'kingside castling'), qs = four(qside, 'queenside castling');
      if (points.split(',').some((p) => p !== '0') || points.split(',').length !== 4) {
        throw new Error('FEN4: Teams keeps no points');
      }
      if (!/^\d{1,4}$/.test(half)) throw new Error(`FEN4: bad fifty-move count "${half}"`);
      const rows = board.split('/');
      if (rows.length !== N) throw new Error('FEN4 needs 14 ranks');
      const squares = new Array(N * N).fill(null);
      rows.forEach((row, i) => {
        const y = N - 1 - i;
        let x = 0;
        for (const cell of row.split(',')) {
          if (/^\d+$/.test(cell)) { x += Number(cell); continue; }
          const m = /^([rbyg])([PNBRQK])$/.exec(cell);
          if (!m) throw new Error(`FEN4: "${cell}" is not a piece`);
          if (!onBoard(x, y)) throw new Error(`FEN4: a piece on ${String.fromCharCode(97 + x)}${y + 1}, outside the board`);
          squares[sqOf(x, y)] = { t: m[2].toLowerCase(), c: m[1] };
          x++;
        }
        if (x !== N) throw new Error(`FEN4: rank ${y + 1} is ${x} squares, not 14`);
      });
      for (const c of COLORS) {
        const kings = squares.filter((p) => p && p.t === 'k' && p.c === c).length;
        if (kings !== 1) throw new Error(`FEN4: ${NAMES[c]} must have exactly one king`);
      }
      const old = { squares: this.squares, turn: this.turn };
      this.squares = squares;
      this.turn = turn;
      try {
        for (let sq = 0; sq < N * N; sq++) {
          const p = squares[sq];
          if (p && p.t === 'p' && this.onRank(sq, p.c, 11)) throw new Error(`FEN4: a ${NAMES[p.c]} pawn on ${nameOf(sq)} would have promoted`);
        }
      } catch (e) {
        Object.assign(this, old);
        throw e;
      }
      this.castling = {};
      COLORS.forEach((c, i) => { this.castling[c] = { k: ks[i], q: qs[i] }; });
      this.ep = null;
      this.halfmove = Number(half);
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
    }

    // A move as stored: from, to and a promotion letter ("e10e11q").
    static moveText(m) {
      return nameOf(m.from) + nameOf(m.to) + (m.promo || '');
    }

    // The legal move a stored text names here, or null.
    moveFromText(text) {
      const m = /^([a-n](?:[1-9]|1[0-4]))([a-n](?:[1-9]|1[0-4]))([qrbn]?)$/.exec(String(text));
      return m ? this.findMove(m[1], m[2], m[3] || null) : null;
    }

    // A move as the move list shows it, chess.com's long form: the piece
    // letter (none for a pawn), from, "-" or "x", to, "=Q", "+" for check to
    // either opponent and "#" when the next player is mated. Call BEFORE
    // making it.
    moveToSan(m) {
      if (m.castle) return m.castle.side === 'k' ? 'O-O' : 'O-O-O';
      let san = (m.piece === 'p' ? '' : m.piece.toUpperCase()) + nameOf(m.from) + (m.capture ? 'x' : '-') + nameOf(m.to);
      if (m.promo) san += '=' + m.promo.toUpperCase();
      this.makeMove(m, false);
      if (FourPlayer.opponentsOf(m.color).some((o) => this.inCheck(o))) san += this.isCheckmate() ? '#' : '+';
      this.undoMove();
      return san;
    }
  }

  Object.assign(FourPlayer, { COLORS, NAMES, PROMOTIONS, FIFTY_MOVE_PLIES, onBoard, sqOf, nameOf, squareOf, rotate });
  return FourPlayer;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FourPlayer };
}
