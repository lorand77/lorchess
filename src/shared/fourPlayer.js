"use strict";

// The four-player chess engine, by chess.com's rules: one 14x14 board with its
// 3x3 corners cut away (160 squares), four armies — Red at the bottom, Blue on
// the left, Yellow at the top, Green on the right — moving in that order,
// clockwise. Two modes (new FourPlayer('teams') or ('ffa')), the same board
// and pieces:
//   - Teams (the default): partners sit opposite, Red with Yellow, Blue with
//     Green. A partner's pieces can't be taken, and they block like anyone's.
//     The first team to mate wins.
//   - Free-for-all: everyone against everyone, for points. A player mated,
//     stalemated, whose king is taken, who resigns, runs out of time or
//     forfeits is eliminated: their army goes grey and stays where it stands,
//     dead (it attacks nothing, blocks like anything, and is taken for no
//     points), and the turn skips them. The game ends when one player is left,
//     on a draw, or when a player far enough ahead claims it; the most points
//     wins.
// Its own engine, not chess.js with more squares, as infinite chess has its
// own: four colours, two teams or none, and a turn that comes round in four.
//
// Everything is defined for Red and turned a quarter for each seat after it
// (rotate below): Blue's army is Red's turned once, Yellow's twice, Green's
// three times, so every king starts on its owner's right (the current
// standard setup) and no colour's rules can drift from another's.
//
// From chess.com's rules (support.chess.com, "4 Player Chess", and
// chess.com/terms/4-player-chess):
//   - checkmate happens only when the mated player's turn comes, so a partner
//     (or, in free-for-all, anyone) may still block or capture in between;
//   - Teams: the first team to mate wins; stalemate is a draw; pawns promote
//     on their 11th rank, to the piece of their choice;
//   - free-for-all: pawns promote on their 8th rank, to a queen, which is
//     worth 1 point when taken. Taking a live piece scores it (POINTS), a king
//     20; mating a player scores 20 for the mater, and a stalemated player
//     scores 20 themselves; one move checking two kings scores 5 (1 if a queen
//     gives a check), three kings 20 (5). A draw by rule gives every player
//     still in 10. With two players left, one 21 or more points ahead may
//     claim the game, which gives the other 20.
// Where the sources say nothing, or we chose otherwise, these are choices,
// kept to as few as possible:
//   - en passant as in ordinary chess: on the very next move only, which in
//     Teams is always an opponent's;
//   - a king left where an opponent can take it (in check from one opponent,
//     its partner unable to help, the other opponent next) may be taken: in
//     Teams that wins for the taker's team ("king captured"), in free-for-all
//     it eliminates that player;
//   - threefold repetition draws, and so does the fifty-move rule, counted as
//     fifty moves by each player still in: 200 plies with no capture or pawn
//     move among four;
//   - material is dead only when every player still in has nothing but a king;
//   - free-for-all: a resigned or timed-out army goes grey whole, its king
//     too, and stands still (chess.com keeps its king moving at random, to be
//     mated for points); a mate scores for whichever player gave check most
//     recently; a check bonus is the queen's when any of the checks is a
//     queen's; players level on points share a place.
//
// Squares are numbered y * 14 + x, x the file (a-n) and y the rank (1-14) from
// 0, Red's side at y = 0. Positions read and write chess.com's FEN4; moves are
// written as from and to squares and a promotion letter ("e2e4", "e10e11q").
// A free-for-all player leaving the game is written as an event, how and who
// ("resign:b", "timeout:g", "disconnect:y", "claim:r"), so a game's record
// replays from its texts alone (playText).
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
  const MODES = ['teams', 'ffa'];
  // Fifty moves by each of the four (in free-for-all, by each player still in).
  const FIFTY_MOVE_PLIES = 200;

  // Free-for-all scoring. A live piece taken; a queen promoted from a pawn is
  // worth a pawn's point.
  const POINTS = { p: 1, n: 3, b: 5, r: 5, q: 9, k: 20 };
  const PROMOTED_QUEEN_POINTS = 1;
  const MATE_POINTS = 20;        // to the mater
  const STALEMATE_POINTS = 20;   // to the player stalemated
  const DRAW_POINTS = 10;        // to every player still in
  // One move checking two or three kings: [by other pieces, a queen among them].
  const CHECK_POINTS = { 2: [5, 1], 3: [20, 5] };
  // With two players left, a lead of this many points may claim the game,
  // and the other player gets CLAIM_POINTS.
  const CLAIM_LEAD = 21;
  const CLAIM_POINTS = 20;
  // The ways a free-for-all player leaves without a move: resigning, running
  // out of time, gone past the reconnect grace, or claiming the game. Named
  // as the server names a game's ending.
  const LEAVES = ['resign', 'timeout', 'disconnect'];
  const EVENT_WORDS = { resign: 'resigned', timeout: 'lost on time', disconnect: 'forfeited', claim: 'claimed the win' };

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
    constructor(mode = 'teams') {
      if (!MODES.includes(mode)) throw new Error(`FourPlayer: no mode "${mode}"`);
      this.mode = mode;
      this.ffa = mode === 'ffa';
      // The rank a pawn promotes on, in its own frame, and to what.
      this.promotionRank = this.ffa ? 8 : 11;
      this.promotions = this.ffa ? ['q'] : PROMOTIONS;
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
      // Free-for-all: each colour's points, and for a player eliminated how
      // and by whom ({ how, by }, by null when nobody), else null; and how the
      // game ended ({ how }) once it has. Teams never sets them.
      this.points = { r: 0, b: 0, y: 0, g: 0 };
      this.out = { r: null, b: null, y: null, g: null };
      this.ended = null;
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
    }

    // ---- the colours ----

    static nextColor(c) { return COLORS[(COLORS.indexOf(c) + 1) % 4]; }
    static teamOf(c) { return TEAM[c]; }
    static partnerOf(c) { return COLORS[(COLORS.indexOf(c) + 2) % 4]; }
    static opponentsOf(c) { return COLORS.filter((o) => TEAM[o] !== TEAM[c]); }
    // A colour's team as a two-player game spells a side, 'w' for Red and
    // Yellow, 'b' for Blue and Green, as result() does ('1-0' for Red and
    // Yellow): what the server stores for the team to move.
    static sideOf(c) { return TEAM[c] === 0 ? 'w' : 'b'; }
    // The result when `c`'s team loses (a resignation, a flag, a forfeit).
    static lossFor(c) { return TEAM[c] === 0 ? '0-1' : '1-0'; }

    // The players still in, in turn order (in Teams, always all four).
    active() { return COLORS.filter((c) => !this.out[c]); }
    // The next player still in after `c`, or `c` if there is none.
    nextActive(c) {
      let n = FourPlayer.nextColor(c);
      while (n !== c && this.out[n]) n = FourPlayer.nextColor(n);
      return n;
    }
    // Whose pieces threaten `c`'s: a test of a colour. The other team in
    // Teams, everyone else in free-for-all; never an eliminated player's,
    // which are dead.
    hostile(c) {
      return this.ffa ? (o) => o !== c && !this.out[o] : (o) => TEAM[o] !== TEAM[c] && !this.out[o];
    }
    // The players `c` could check: the other team, or everyone else still in.
    foesOf(c) {
      return this.ffa ? this.active().filter((o) => o !== c) : FourPlayer.opponentsOf(c);
    }
    // May `c` take the piece `q`: an opponent's (never a partner's, never
    // one's own), or a dead one, which anyone may.
    canTake(c, q) {
      return this.ffa ? q.c !== c : TEAM[q.c] !== TEAM[c];
    }

    // The direction a colour's pawns go, and whether a square is on its
    // second rank (a double step from there) or its eleventh (promotion).
    forward(c) { return rotateStep(0, 1, SEAT[c]); }
    onRank(sq, c, rank) { return frameOf(sq, c)[1] === rank - 1; }
    promotesOn(sq, c) { return this.onRank(sq, c, this.promotionRank); }

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
      return this.attackedBy(sq, (c) => TEAM[c] === team && !this.out[c]);
    }

    // The same for the pieces of any colour `by` accepts. With `found`, an
    // array, every attacker's type is put in it rather than stopping at the
    // first.
    attackedBy(sq, by, found) {
      const x = xOf(sq), y = yOf(sq);
      const hit = (t) => {
        if (!found) return true;
        found.push(t);
        return false;
      };
      const enemy = (px, py, types) => {
        if (!onBoard(px, py)) return false;
        const p = this.squares[sqOf(px, py)];
        return !!p && types.includes(p.t) && by(p.c);
      };
      for (const [dx, dy] of KNIGHT) if (enemy(x + dx, y + dy, 'n') && hit('n')) return true;
      for (const [dx, dy] of KING) if (enemy(x + dx, y + dy, 'k') && hit('k')) return true;
      // A pawn attacks the two squares diagonally ahead of it, ahead being its
      // own colour's way.
      for (const c of COLORS) {
        if (!by(c)) continue;
        const [fx, fy] = this.forward(c);
        for (const s of [-1, 1]) {
          const px = x - fx - (fy ? s : 0), py = y - fy - (fx ? s : 0);
          if (!onBoard(px, py)) continue;
          const p = this.squares[sqOf(px, py)];
          if (p && p.t === 'p' && p.c === c && hit('p')) return true;
        }
      }
      for (const [dx, dy] of KING) {
        const diagonal = dx && dy;
        let px = x + dx, py = y + dy;
        while (onBoard(px, py)) {
          const p = this.squares[sqOf(px, py)];
          if (p) {
            if ((p.t === 'q' || p.t === (diagonal ? 'b' : 'r')) && by(p.c) && hit(p.t)) return true;
            break;
          }
          px += dx;
          py += dy;
        }
      }
      return !!found && found.length > 0;
    }

    inCheck(c) {
      if (c === undefined) c = this.turn;
      if (this.out[c]) return false;
      const k = this.kingOf(c);
      return k !== -1 && this.attackedBy(k, this.hostile(c));
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
          return !q || this.canTake(c, q);
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
                if (this.canTake(c, q)) add(to);
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
        if (this.promotesOn(to, c)) for (const promo of this.promotions) add(to, Object.assign({ promo }, extra));
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
        if (q && this.canTake(c, q)) withPromo(to);
        else if (!q && this.ep && this.ep.passed === to) {
          const victim = this.squares[this.ep.pawn];
          if (victim && this.canTake(c, victim)) add(to, { capture: true, enpassant: true });
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
        if (k.crosses.some(([bx, by]) => this.attackedBy(fromFrame(bx, by, c), this.hostile(c)))) continue;
        add(fromFrame(k.kingTo[0], k.kingTo[1], c), {
          castle: { side, rookFrom: rookSq, rookTo: fromFrame(k.rookTo[0], k.rookTo[1], c) },
        });
      }
    }

    // Where the piece on `sq` could go on an otherwise empty board, as square
    // numbers: for a premove, picked before the position it will be played
    // in exists, so nothing standing in the way, and no legality, is judged
    // here. A pawn's step, its double step from its second rank and its two
    // captures; a king's castling squares while it holds the right.
    reachOf(sq) {
      const p = this.squares[sq];
      if (!p) return [];
      const x = xOf(sq), y = yOf(sq);
      const out = new Set();
      const add = (tx, ty) => { if (onBoard(tx, ty)) out.add(sqOf(tx, ty)); };
      if (p.t === 'p') {
        const [fx, fy] = this.forward(p.c);
        add(x + fx, y + fy);
        if (this.onRank(sq, p.c, 2)) add(x + 2 * fx, y + 2 * fy);
        for (const s of [-1, 1]) add(x + fx + (fy ? s : 0), y + fy + (fx ? s : 0));
      } else if (p.t === 'n' || p.t === 'k') {
        for (const [dx, dy] of p.t === 'n' ? KNIGHT : KING) add(x + dx, y + dy);
        if (p.t === 'k' && sq === fromFrame(7, 0, p.c)) {
          for (const side of ['k', 'q']) {
            if (!this.castling[p.c][side]) continue;
            const [kx, ky] = CASTLES[side].kingTo;
            out.add(fromFrame(kx, ky, p.c));
          }
        }
      } else {
        for (const [dx, dy] of RAYS[p.t]) {
          for (let px = x + dx, py = y + dy; onBoard(px, py); px += dx, py += dy) out.add(sqOf(px, py));
        }
      }
      return [...out];
    }

    // The side to move's legal moves: those that don't leave its own king
    // attacked by any opponent. A move that takes a live enemy king is always
    // legal: it ends the game, or in free-for-all that player's part in it.
    // None once the game is over.
    legalMoves() {
      return this.isOver() ? [] : this.movesAsIfOn();
    }

    // The same, as though the game went on: what mate and stalemate ask, so a
    // game drawn by a rule isn't also read as a side with nothing to play.
    movesAsIfOn() {
      const c = this.turn;
      return this.pseudoMoves(c).filter((m) => this.keepsKingSafe(m, c));
    }

    // The legal captures alone, for a search that looks at nothing else: the
    // legality test, the costly part, is run on the captures only.
    legalCaptures() {
      if (this.isOver()) return [];
      const c = this.turn;
      return this.pseudoMoves(c).filter((m) => m.capture && this.keepsKingSafe(m, c));
    }

    keepsKingSafe(m, c) {
      if (m.capture && !m.enpassant && this.squares[m.to].t === 'k' && !this.out[this.squares[m.to].c]) return true;
      this.makeMove(m, false, false);
      const safe = !this.inCheck(c);
      this.undoMove();
      return safe;
    }

    // The legal move from `from` to `to` (square numbers or names), promoting
    // to `promo` if it is a promotion, or null.
    findMove(from, to, promo) {
      const f = typeof from === 'string' ? squareOf(from) : from;
      const t = typeof to === 'string' ? squareOf(to) : to;
      return this.legalMoves().find((m) => m.from === f && m.to === t && (m.promo || null) === (promo || null)) || null;
    }

    // ---- making and taking back moves ----

    // Play `m`. With `track` (the default) the position is counted for
    // repetition and, in free-for-all, the game is settled: a player now to
    // move with no move is mated or stalemated, and a draw by rule ends it. A
    // search may leave both out (`track` false) and judge those itself; the
    // points for a capture, a king taken and a check of several kings are
    // scored either way, unless `scoring` is false: the legality test, which
    // only asks whether the mover's king is safe.
    makeMove(m, track = true, scoring = true) {
      const piece = this.squares[m.from];
      const capturedAt = m.enpassant ? this.ep.pawn : m.to;
      const entry = Object.assign(this.snapshot(), {
        move: m,
        piece,
        captured: this.squares[capturedAt],
        capturedAt,
      });
      this.squares[capturedAt] = null;
      this.squares[m.from] = null;
      this.squares[m.to] = !m.promo ? piece : this.ffa ? { t: m.promo, c: piece.c, promoted: true } : { t: m.promo, c: piece.c };
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
      if (this.ffa && scoring) this.score(c, entry.captured);
      this.turn = this.ffa ? this.nextActive(this.turn) : FourPlayer.nextColor(this.turn);
      this.history.push(entry);
      if (track) this.track(entry);
    }

    // Free-for-all: what a move by `c`, having taken `captured`, scores.
    // Taking a live king eliminates its player.
    score(c, captured) {
      if (captured && !this.out[captured.c]) {
        this.points[c] += captured.promoted ? PROMOTED_QUEEN_POINTS : POINTS[captured.t];
        if (captured.t === 'k') this.knockOut(captured.c, 'king captured', c);
      }
      // The kings `c`'s pieces now check, and whether a queen is among the
      // checkers.
      let kings = 0, queen = false;
      for (const o of this.foesOf(c)) {
        const k = this.kingOf(o), found = [];
        if (k === -1 || !this.attackedBy(k, (a) => a === c, found)) continue;
        kings++;
        if (found.includes('q')) queen = true;
      }
      if (CHECK_POINTS[kings]) this.points[c] += CHECK_POINTS[kings][queen ? 1 : 0];
    }

    // What a history entry keeps to put the game back: everything a move or
    // an elimination changes besides the squares.
    snapshot() {
      return {
        castling: JSON.stringify(this.castling),
        ep: this.ep,
        halfmove: this.halfmove,
        turn: this.turn,
        points: this.ffa ? Object.assign({}, this.points) : null,
        out: this.ffa ? Object.assign({}, this.out) : null,
        ended: this.ended,
        key: null,
      };
    }

    // Count the position for repetition, settling a free-for-all game first
    // (eliminations change the position) and judging its draws after.
    track(entry) {
      if (this.ffa) this.settle();
      entry.key = this.positionKey();
      this.positionCounts.set(entry.key, (this.positionCounts.get(entry.key) || 0) + 1);
      if (this.ffa) this.drawByRule();
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
      if (m) {
        if (m.castle) {
          this.squares[m.castle.rookFrom] = this.squares[m.castle.rookTo];
          this.squares[m.castle.rookTo] = null;
        }
        this.squares[m.to] = null;
        this.squares[m.from] = h.piece;
        this.squares[h.capturedAt] = h.captured;
      }
      this.castling = JSON.parse(h.castling);
      this.ep = h.ep;
      this.halfmove = h.halfmove;
      this.turn = h.turn;
      if (h.points) {
        this.points = h.points;
        this.out = h.out;
      }
      this.ended = h.ended;
    }

    // ---- free-for-all: leaving the game ----

    // Eliminate `c`: their army goes dead where it stands, and with one player
    // left the game is over, ended by how the last one went.
    knockOut(c, how, by = null) {
      this.out = Object.assign({}, this.out, { [c]: { how, by } });
      if (this.active().length <= 1) this.ended = { how };
    }

    // The player to move with no move: mated (MATE_POINTS to whoever gave
    // check most recently) or stalemated (STALEMATE_POINTS to themselves), and
    // out; then the next player, who may have none either.
    settle() {
      while (!this.ended && this.movesAsIfOn().length === 0) {
        const c = this.turn;
        this.stuck(c);
        if (!this.ended) this.turn = this.nextActive(c);
      }
    }

    // `c`, with no move, mated or stalemated: the points, and out.
    stuck(c) {
      if (this.inCheck(c)) {
        const by = this.materOf(c);
        this.points[by] += MATE_POINTS;
        this.knockOut(c, 'checkmate', by);
      } else {
        this.points[c] += STALEMATE_POINTS;
        this.knockOut(c, 'stalemate');
      }
    }

    // The same for a search (lorfishFfa.js), which plays the opponents' turns
    // out of order and asks of a player whose turn it is not: `c`, who has no
    // move, is out as settle would put them out on their turn, kept in the
    // history like an elimination so undoMove takes it back. The turn stays.
    concede(c) {
      const entry = Object.assign(this.snapshot(), { event: { color: c, how: this.inCheck(c) ? 'checkmate' : 'stalemate' } });
      this.stuck(c);
      this.history.push(entry);
    }

    // Who mated `c`, whose king is attacked: of the players whose pieces
    // attack it, the one who moved most recently.
    materOf(c) {
      const k = this.kingOf(c);
      for (let i = this.history.length - 1; i >= 0; i--) {
        const mover = this.history[i].move && this.history[i].turn;
        if (mover && mover !== c && !this.out[mover] && this.attackedBy(k, (a) => a === mover)) return mover;
      }
      return this.active().find((o) => o !== c && this.attackedBy(k, (a) => a === o));
    }

    // A draw by rule ends a free-for-all game, DRAW_POINTS to everyone still in.
    drawByRule() {
      if (this.ended) return;
      const how = this.isInsufficientMaterial() ? 'insufficient'
        : this.isThreefoldRepetition() ? 'threefold'
          : this.halfmove >= this.fiftyMovePlies() ? 'fifty-move' : null;
      if (!how) return;
      for (const c of this.active()) this.points[c] += DRAW_POINTS;
      this.ended = { how };
    }

    // The fifty-move rule's length: fifty moves by each player still in.
    fiftyMovePlies() { return this.ffa ? 50 * this.active().length : FIFTY_MOVE_PLIES; }

    // A free-for-all player resigning, out of time or forfeited ('resign',
    // 'timeout', 'disconnect'): their army goes dead, they keep their points,
    // and if it was their turn it passes on. Kept in the history like a move,
    // so undoMove takes it back. False, changing nothing, if it can't be.
    eliminate(c, how) {
      if (!this.ffa || this.ended || !COLORS.includes(c) || this.out[c] || !LEAVES.includes(how)) return false;
      this.leave(c, how);
      return true;
    }

    // Can `c` claim the game: two players left, `c` one of them and CLAIM_LEAD
    // points ahead.
    canClaimWin(c) {
      if (!this.ffa || this.ended || !COLORS.includes(c) || this.out[c]) return false;
      const left = this.active();
      if (left.length !== 2) return false;
      const other = left.find((o) => o !== c);
      return this.points[c] - this.points[other] >= CLAIM_LEAD;
    }

    // Claim it: `c` leaves the board, the other player gets CLAIM_POINTS, and
    // the game is over, `c` still ahead.
    claimWin(c) {
      if (!this.canClaimWin(c)) return false;
      this.leave(c, 'claim');
      return true;
    }

    leave(c, how) {
      const entry = Object.assign(this.snapshot(), { event: { color: c, how } });
      if (how === 'claim') this.points[this.active().find((o) => o !== c)] += CLAIM_POINTS;
      this.knockOut(c, how);
      if (!this.ended && this.turn === c) this.turn = this.nextActive(c);
      this.history.push(entry);
      this.track(entry);
    }

    // Every player's points and place, in turn order: a place is one more
    // than the number of players with more points, so players level share it.
    standings() {
      return COLORS.map((c) => ({
        color: c,
        points: this.points[c],
        place: 1 + COLORS.filter((o) => this.points[o] > this.points[c]).length,
        out: this.out[c],
      }));
    }

    // ---- how the game ends ----

    // A colour whose king has been taken, or null. In free-for-all that is no
    // ending, only an elimination, so it is always null there.
    kingTaken() {
      if (this.ffa) return null;
      for (const c of COLORS) if (this.kingOf(c) === -1) return c;
      return null;
    }

    // The side to move has no legal move: mated if in check, else stalemated.
    // Asked only of the side to move: a mate is decided when the mated
    // player's turn comes, as chess.com has it. In free-for-all a settled game
    // has done this already (settle), so these ask of a move not yet tracked,
    // as moveToSan's "#".
    noMoves() { return this.movesAsIfOn().length === 0; }
    isCheckmate() { return !this.kingTaken() && !this.ended && this.inCheck() && this.noMoves(); }
    isStalemate() { return !this.kingTaken() && !this.ended && !this.out[this.turn] && !this.inCheck() && this.noMoves(); }
    isThreefoldRepetition() { return (this.positionCounts.get(this.positionKey()) || 0) >= 3; }
    // Nothing but kings, dead pieces aside.
    isInsufficientMaterial() { return this.squares.every((p) => !p || p.t === 'k' || this.out[p.c]); }

    // Over without asking for the move list (legalMoves asks this). A
    // free-for-all game is over once settled so (ended).
    isOver() {
      if (this.ffa) return !!this.ended;
      return !!this.kingTaken() || this.halfmove >= FIFTY_MOVE_PLIES
        || this.isThreefoldRepetition() || this.isInsufficientMaterial();
    }
    isGameOver() { return this.isOver() || (!this.ffa && this.noMoves()); }

    // How it ended, named as for the other engines, or null while it goes on.
    // A free-for-all game is named by how its last player went ('checkmate',
    // 'stalemate', 'king captured', 'resign', 'timeout', 'disconnect',
    // 'claim') or by its draw.
    termination() {
      if (this.ffa) return this.ended ? this.ended.how : null;
      if (this.kingTaken()) return 'king captured';
      if (this.isCheckmate()) return 'checkmate';
      if (this.isStalemate()) return 'stalemate';
      if (this.isInsufficientMaterial()) return 'insufficient';
      if (this.isThreefoldRepetition()) return 'threefold';
      if (this.halfmove >= FIFTY_MOVE_PLIES) return 'fifty-move';
      return null;
    }

    // Results are by team, written as for two players: "1-0" for Red and
    // Yellow, "0-1" for Blue and Green. A free-for-all game's is its
    // placings, the colours from first to last, those sharing a place joined
    // by "=" ("r,b=g,y"), and '*' while it goes on.
    result() {
      if (this.ffa) {
        if (!this.ended) return '*';
        const places = this.standings().sort((a, b) => a.place - b.place);
        let text = places[0].color;
        for (let i = 1; i < 4; i++) text += (places[i].place === places[i - 1].place ? '=' : ',') + places[i].color;
        return text;
      }
      const taken = this.kingTaken();
      if (taken) return TEAM[taken] === 0 ? '0-1' : '1-0';
      if (this.isCheckmate()) return TEAM[this.turn] === 0 ? '0-1' : '1-0';
      return this.isGameOver() ? '1/2-1/2' : '*';
    }

    // ---- notation ----

    // The position for repetition: the board, the side to move, the castling
    // rights, an en passant square only while the capture is legal, and who
    // is still in.
    positionKey() {
      let s = '';
      for (const p of this.squares) s += p ? p.c + (p.promoted ? 'd' : p.t) : '.';
      let ep = '-';
      if (this.ep && this.pseudoMoves(this.turn).some((m) => m.enpassant)) ep = this.ep.passed;
      const out = COLORS.map((c) => (this.out[c] ? 1 : 0)).join('');
      return `${s} ${this.turn} ${JSON.stringify(this.castling)} ${ep} ${out}`;
    }

    // chess.com's FEN4: side to move, eliminated players, kingside and
    // queenside castling rights and points, each four values in turn order,
    // the fifty-move count, then the ranks from 14 to 1, each square a to n
    // comma-separated ("rP", or a count of empty squares; the corners count as
    // empty). En passant is not part of it, nor how a player went out. A
    // free-for-all queen promoted from a pawn, worth a point, is written "D"
    // ("rD"), our own letter.
    fen() {
      const flags = (f) => COLORS.map(f).join(',');
      const header = [
        this.turn.toUpperCase(),
        flags((c) => (this.out[c] ? 1 : 0)),
        flags((c) => (this.castling[c].k ? 1 : 0)),
        flags((c) => (this.castling[c].q ? 1 : 0)),
        flags((c) => this.points[c]),
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
          cells.push(p.c + (p.promoted ? 'D' : p.t.toUpperCase()));
        }
        if (empty) cells.push(String(empty));
        ranks.push(cells.join(','));
      }
      return header + '-' + ranks.join('/');
    }

    // Read a FEN4. Throws, leaving the position as it was, on anything else: a
    // piece in a corner, a colour without exactly one king, a pawn already on
    // its promotion rank; in Teams a player marked eliminated, points or a
    // promoted queen ("D"); in free-for-all fewer than two players left, the
    // side to move eliminated, or more than one king of an eliminated player
    // (who may have lost theirs). An eliminated player's how is unknown.
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
      const gone = four(eliminated, 'eliminated players');
      const ks = four(kside, 'kingside castling'), qs = four(qside, 'queenside castling');
      const score = points.split(',');
      if (score.length !== 4 || score.some((p) => !/^\d{1,4}$/.test(p))) throw new Error(`FEN4: bad points "${points}"`);
      if (!this.ffa) {
        if (gone.some(Boolean)) throw new Error('FEN4: no player is eliminated in Teams');
        if (score.some((p) => p !== '0')) throw new Error('FEN4: Teams keeps no points');
      } else {
        if (gone.filter((g) => !g).length < 2) throw new Error('FEN4: a game with fewer than two players left is over');
        if (gone[COLORS.indexOf(turn)]) throw new Error(`FEN4: ${NAMES[turn]} is eliminated and can't be to move`);
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
          const m = (this.ffa ? /^([rbyg])([PNBRQKD])$/ : /^([rbyg])([PNBRQK])$/).exec(cell);
          if (!m) throw new Error(`FEN4: "${cell}" is not a piece`);
          if (!onBoard(x, y)) throw new Error(`FEN4: a piece on ${String.fromCharCode(97 + x)}${y + 1}, outside the board`);
          squares[sqOf(x, y)] = m[2] === 'D' ? { t: 'q', c: m[1], promoted: true } : { t: m[2].toLowerCase(), c: m[1] };
          x++;
        }
        if (x !== N) throw new Error(`FEN4: rank ${y + 1} is ${x} squares, not 14`);
      });
      COLORS.forEach((c, i) => {
        const kings = squares.filter((p) => p && p.t === 'k' && p.c === c).length;
        if (kings !== 1 && !(gone[i] && kings === 0)) throw new Error(`FEN4: ${NAMES[c]} must have exactly one king`);
      });
      const old = { squares: this.squares, turn: this.turn };
      this.squares = squares;
      this.turn = turn;
      try {
        for (let sq = 0; sq < N * N; sq++) {
          const p = squares[sq];
          if (p && p.t === 'p' && this.promotesOn(sq, p.c)) throw new Error(`FEN4: a ${NAMES[p.c]} pawn on ${nameOf(sq)} would have promoted`);
        }
      } catch (e) {
        Object.assign(this, old);
        throw e;
      }
      this.castling = {};
      COLORS.forEach((c, i) => { this.castling[c] = { k: ks[i], q: qs[i] }; });
      this.ep = null;
      this.halfmove = Number(half);
      this.points = {};
      this.out = {};
      COLORS.forEach((c, i) => {
        this.points[c] = Number(score[i]);
        this.out[c] = gone[i] ? { how: null, by: null } : null;
      });
      this.ended = null;
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

    // A free-for-all player leaving, as stored: how and who ("resign:b"); and
    // as the move list shows it ("Blue resigned").
    static eventText(e) { return `${e.how}:${e.color}`; }
    static eventSan(e) { return `${NAMES[e.color]} ${EVENT_WORDS[e.how]}`; }
    // A free-for-all place as the pages write it: "1st", "2nd", "3rd", "4th".
    static placeText(place) { return place + (['st', 'nd', 'rd'][place - 1] || 'th'); }
    // A history entry as stored: its move's text, or its event's.
    static entryText(h) { return h.event ? FourPlayer.eventText(h.event) : FourPlayer.moveText(h.move); }
    // { color, how } from a stored event text, or null.
    static eventFromText(text) {
      const m = /^(resign|timeout|disconnect|claim):([rbyg])$/.exec(String(text));
      return m ? { how: m[1], color: m[2] } : null;
    }

    // Play a stored text, a move or a free-for-all event, as a game's record
    // replays: true if it was legal here, else false, changing nothing.
    playText(text) {
      const e = FourPlayer.eventFromText(text);
      if (e) return e.how === 'claim' ? this.claimWin(e.color) : this.eliminate(e.color, e.how);
      const m = this.moveFromText(text);
      if (m) this.makeMove(m);
      return !!m;
    }

    // A move as the move list shows it, chess.com's long form: the piece
    // letter (none for a pawn), from, "-" or "x", to, "=Q", "+" for check to
    // any opponent and "#" when the next player is mated. Call BEFORE making
    // it.
    moveToSan(m) {
      if (m.castle) return m.castle.side === 'k' ? 'O-O' : 'O-O-O';
      let san = (m.piece === 'p' ? '' : m.piece.toUpperCase()) + nameOf(m.from) + (m.capture ? 'x' : '-') + nameOf(m.to);
      if (m.promo) san += '=' + m.promo.toUpperCase();
      this.makeMove(m, false);
      if (this.foesOf(m.color).some((o) => this.inCheck(o))) san += this.isCheckmate() ? '#' : '+';
      this.undoMove();
      return san;
    }
  }

  Object.assign(FourPlayer, {
    COLORS, NAMES, PROMOTIONS, MODES, FIFTY_MOVE_PLIES, POINTS, PROMOTED_QUEEN_POINTS, MATE_POINTS, STALEMATE_POINTS,
    DRAW_POINTS, CHECK_POINTS, CLAIM_LEAD, CLAIM_POINTS, onBoard, sqOf, nameOf, squareOf, rotate, frameOf,
  });
  return FourPlayer;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FourPlayer };
}
