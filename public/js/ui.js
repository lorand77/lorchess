"use strict";

const chess = new Chess();
let humanColor = W;
let selected = null;
let legalFromSelected = [];
let lastMove = null;
let promotionPending = null;
let thinking = false;
let moveHistory = [];
// Premove: one move queued while the opponent is on move, played the instant
// their move lands if it turns out to be legal, discarded otherwise. While the
// player is choosing it, `selected`/`legalFromSelected` describe premove
// targets rather than legal moves (premoveSelecting).
let premove = null;             // { from, to } or null
let premoveSelecting = false;
// Fullmove number and side-to-move at the start of the current PGN body,
// plus the FEN string if the game was set up from one (null if standard start).
let startFullmove = 1;
let startTurn = W;
let startFen = null;

// Opponent abstraction + mode. moveSource is assigned in initAi()/initPvp().
let moveSource = null;
let pvpMode = false;
let spectating = false;   // watching someone else's PvP game (?watch=<id>)
let pvpResult = null;            // {result, termination} once a PvP game ends
let whiteName = 'Human';
let blackName = 'LorFish';
let whiteMember = false; // PvP only: both come from the server's game state
let blackMember = false;
let pgnEvent = 'Human vs LorFish';

// PvP clock state (server-authoritative; we render a smooth local countdown
// between server updates). clocks holds the last snapshot {w,b} in ms.
let clocks = null;
let clockBase = 0;          // Date.now() when the snapshot was taken
let clockRunning = false;
let clockTimer = null;

const boardEl       = document.getElementById('board');
const turnEl        = document.getElementById('turn');
const statusEl      = document.getElementById('status');
const historyEl     = document.getElementById('history');
const promoEl       = document.getElementById('promo');
const promoOpts     = document.getElementById('promoOptions');
const colorSelectEl = document.getElementById('humanColor');
const whiteLabelEl  = document.getElementById('whiteLabel');
const blackLabelEl  = document.getElementById('blackLabel');
const capturedTopEl    = document.getElementById('capturedTop');
const capturedBottomEl = document.getElementById('capturedBottom');
const loadFenBtn    = document.getElementById('loadFenBtn');
const fenPanel      = document.getElementById('fenPanel');
const fenText       = document.getElementById('fenText');
const fenLoadBtn    = document.getElementById('fenLoadBtn');
const fenCancelBtn  = document.getElementById('fenCancelBtn');
const fenError      = document.getElementById('fenError');

function setThinking(v) {
  thinking = v;
  render();
}

function getDepth() {
  return parseInt(document.getElementById('depth').value, 10);
}

function gameIsOver() {
  return chess.isGameOver() || !!pvpResult;
}

// Server-side persistence of the AI game (best-effort; never blocks play).
// Unused in PvP, where the server is authoritative and persists moves itself.
const gameStore = createGameStore();

// Shared environment handed to whichever move source is active.
const env = {
  getHumanColor: () => humanColor,
  getTurn:       () => chess.turn,
  isGameOver:    () => chess.isGameOver(),
  getDepth,
  getPosition:   () => ({
    startFen,
    moves: chess.history.map(h => ({
      from: h.move.from,
      to:   h.move.to,
      promo: h.move.promo || null,
    })),
  }),
  applyMove,
  setThinking,
  onReject: (msg) => {
    statusEl.textContent = msg || 'Move rejected.';
    statusEl.className = 'check-text';
  },
};

// Apply a move to the board: the single path for engine moves, the player's own
// confirmed moves, and the opponent's moves. `record` persists client-side
// (AI mode only); in PvP the server already persisted it.
function applyMove(rmove, record, opts) {
  const move = chess.findMove(rmove.from, rmove.to, rmove.promo);
  if (!move) {
    console.error('Move is not legal here:', rmove);
    return;
  }
  const san = chess.moveToSan(move);
  planMoveAnimation(move);
  chess.makeMove(move);
  lastMove = move;
  moveHistory.push(san);
  playMoveSound();
  selected = null;
  legalFromSelected = [];
  premoveSelecting = false;
  // Our turn now: the queued premove is consumed here, played or not.
  const queued = chess.turn === humanColor ? premove : null;
  if (queued) premove = null;
  render();
  if (record) recordApplied(san, move, !!(opts && opts.premove));
  if (queued) playPremove(queued);
}

// Play a queued premove if it is legal in the position that just arrived. A
// promotion premove always takes a queen: there is no dialog for a move that
// was decided before the position existed.
function playPremove(pm) {
  if (gameIsOver() || !canMoveNow()) return;
  const move = chess.legalMoves().find(m =>
    m.from === pm.from && m.to === pm.to && (!m.promo || m.promo === 'q'));
  if (!move) return;
  doHumanMove(move, { premove: true });
}

// Record the move just applied to `chess`, and finalize the game if it ended
// (AI mode — client is authoritative and drives persistence).
function recordApplied(san, move, premove) {
  const ply = chess.history.length;
  const uci = algOf(move.from) + algOf(move.to) + (move.promo || '');
  const fenAfter = chess.fen();
  const byColor = opp(chess.turn);   // the mover = side that just moved (turn has flipped)
  gameStore.recordMove({ ply, san, uci, fenAfter, byColor, premove: !!premove });
  if (chess.isGameOver()) {
    // The server evaluates achievements when it records the end of the game
    // and answers with anything newly earned.
    gameStore.endGame(chess.result(), terminationReason()).then((resp) => {
      if (resp && resp.achievements && typeof AchievementToast !== 'undefined') {
        AchievementToast.show(resp.achievements);
      }
    });
    playOutcomeSound(chess.result());
    showReviewLink(gameStore.currentId());
  }
}

function terminationReason() {
  if (chess.isCheckmate())            return 'checkmate';
  if (chess.isStalemate())            return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isThreefoldRepetition())  return 'threefold';
  if (chess.halfmove >= 100)          return 'fifty-move';
  return null;
}

// Custom piece images (theme.js) win over the bundled set.
function pieceImgSrc(piece) {
  if (window.Theme) return Theme.pieceSrc(piece.c, piece.t);
  return `assets/${piece.c}_${PIECE_NAMES[piece.t]}_1x_ns.png`;
}

const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const CAPTURE_ORDER = ['p', 'n', 'b', 'r', 'q'];

function renderCaptured() {
  const byWhite = [];
  const byBlack = [];
  for (const h of chess.history) {
    if (!h.captured) continue;
    (h.captured.c === B ? byWhite : byBlack).push(h.captured);
  }
  const sortFn = (a, b) => CAPTURE_ORDER.indexOf(a.t) - CAPTURE_ORDER.indexOf(b.t);
  byWhite.sort(sortFn);
  byBlack.sort(sortFn);

  let whiteMat = 0, blackMat = 0;
  for (const p of chess.squares) {
    if (!p) continue;
    if (p.c === W) whiteMat += PIECE_VAL[p.t];
    else           blackMat += PIECE_VAL[p.t];
  }
  const whiteAdv = whiteMat - blackMat;

  const topColor    = humanColor === W ? B : W;
  const bottomColor = humanColor;
  const byTop    = topColor    === W ? byWhite : byBlack;
  const byBottom = bottomColor === W ? byWhite : byBlack;
  const topAdv    = topColor    === W ? whiteAdv : -whiteAdv;
  const bottomAdv = bottomColor === W ? whiteAdv : -whiteAdv;

  fillCaptured(capturedTopEl,    byTop,    topAdv);
  fillCaptured(capturedBottomEl, byBottom, bottomAdv);
}

function fillCaptured(el, pieces, adv) {
  el.innerHTML = '';
  const groups = {};
  for (const p of pieces) {
    if (!groups[p.t]) groups[p.t] = [];
    groups[p.t].push(p);
  }
  for (const t of CAPTURE_ORDER) {
    if (!groups[t]) continue;
    const group = document.createElement('span');
    group.className = 'cap-group';
    for (const p of groups[t]) {
      const img = document.createElement('img');
      img.src = pieceImgSrc(p);
      img.className = 'cap-piece';
      img.draggable = false;
      img.alt = p.c + p.t;
      group.appendChild(img);
    }
    el.appendChild(group);
  }
  if (adv > 0) {
    const badge = document.createElement('span');
    badge.className = 'cap-adv';
    badge.textContent = '+' + adv;
    el.appendChild(badge);
  }
}

// === Sound effects ===
const sounds = {
  move:      new Audio('assets/Move.mp3'),
  capture:   new Audio('assets/Capture.mp3'),
  check:     new Audio('assets/Check.mp3'),
  checkmate: new Audio('assets/Checkmate.mp3'),
  draw:      new Audio('assets/Draw.mp3'),
  explosion: new Audio('assets/Explosion.mp3'),
  victory:   new Audio('assets/Victory.mp3'),
  defeat:    new Audio('assets/Defeat.mp3'),
  lowTime:   new Audio('assets/LowTime.mp3'),
};
Object.values(sounds).forEach(a => { a.preload = 'auto'; a.volume = 0.6; });

function play(a) {
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// Set when playMoveSound already announced the end of the game, so the outcome
// cue below knows not to repeat a draw it just played.
let endingAnnouncedByMove = false;

// Pick a sound based on the position AFTER the most recent makeMove.
function playMoveSound() {
  const last = chess.history[chess.history.length - 1];
  const captured = last ? last.captured : null;
  if (chess.isCheckmate()) {
    endingAnnouncedByMove = true;
    return play(sounds.checkmate);
  }
  if (chess.isGameOver()) {
    endingAnnouncedByMove = true;
    return play(sounds.draw);
  }
  if (captured && captured.t === 'q') return play(sounds.explosion);
  if (chess.inCheck())                return play(sounds.check);
  if (captured)                       return play(sounds.capture);
  play(sounds.move);
}

// === Outcome fanfare ===
// Move sounds answer "what just happened on the board"; this answers "did I
// win". The two layer: a checkmate plays the Checkmate stab on the mating move
// and then Victory/Defeat, delayed so the fanfare lands after the stab instead
// of muddying it. Called from both the AI path (client-authoritative, no
// game:over event exists there) and the PvP game:over event — so endings that
// are NOT moves (resign, timeout, disconnect forfeit, abort) are covered too.
const OUTCOME_DELAY_MS = 400;
let outcomePlayed = false;

// `result` is '1-0' | '0-1' | '1/2-1/2' | '*'. An abort ('*') has no winner, so
// it gets the neutral draw cue rather than a fanfare one side would find wrong.
function playOutcomeSound(result) {
  if (outcomePlayed) return;
  outcomePlayed = true;
  const drawish = result === '1/2-1/2' || result === '*';
  // A draw reached on the board already sounded via playMoveSound.
  if (drawish && endingAnnouncedByMove) return;
  const sound = drawish
    ? sounds.draw
    : (result === '1-0') === (humanColor === W) ? sounds.victory : sounds.defeat;
  setTimeout(() => play(sound), OUTCOME_DELAY_MS);
}

// Low-time warning on your OWN clock. Latched so the 200ms clock tick fires it
// once rather than fifty times; unlatches if an increment lifts you back over
// the line, so a long game can warn again.
const LOW_TIME_MS = 10000;
let lowTimeWarned = false;

function checkLowTime(ms, isYourTurn) {
  if (ms > LOW_TIME_MS) {
    lowTimeWarned = false;
    return;
  }
  if (!isYourTurn || lowTimeWarned) return;
  lowTimeWarned = true;
  play(sounds.lowTime);
}

// Clear the per-game sound latches: new game, resumed game, or an undo that
// takes the position back out of a finished state.
function resetSoundState() {
  endingAnnouncedByMove = false;
  outcomePlayed = false;
  lowTimeWarned = false;
}

// === Move animation ===
// A move is applied to `chess` instantly; the board then renders the piece on
// its destination square and we slide it in from where it came (FLIP-style,
// via the Web Animations API). The animation is stored as state rather than
// fired once because render() rebuilds the whole board DOM and is called
// again almost immediately after a move (e.g. setThinking in AI mode). Each
// render re-attaches the in-flight animation at its current elapsed time, so
// the slide continues seamlessly instead of being wiped.
const MOVE_ANIM_MS = 200;
const reducedMotion = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// { start, pieces: [{from, to}], captured: {sq, piece} | null }
let moveAnim = null;

// A move made by dragging needs no slide: the user carried the piece there
// themselves, so animating it out of the origin square again reads as lag. Set
// by the drop handler, consumed by the next planMoveAnimation.
let noAnimMove = null;

// Call BEFORE chess.makeMove(move): it inspects the current squares to find
// the captured piece (which vanishes once the move is made).
function planMoveAnimation(move) {
  const dragged = noAnimMove
    && noAnimMove.from === move.from && noAnimMove.to === move.to;
  noAnimMove = null; // one move only; never let a stale flag outlive it
  if (dragged) {
    moveAnim = null;
    return;
  }
  if (reducedMotion) return;
  const pieces = [{ from: move.from, to: move.to }];
  if (move.castle) {
    const home = rankOf(move.from);
    pieces.push(move.castle === 'K'
      ? { from: sqIdx(7, home), to: sqIdx(5, home) }
      : { from: sqIdx(0, home), to: sqIdx(3, home) });
  }
  const capSq = move.enpassant ? sqIdx(fileOf(move.to), rankOf(move.from)) : move.to;
  const capPiece = chess.squares[capSq];
  moveAnim = {
    start: performance.now(),
    pieces,
    captured: capPiece ? { sq: capSq, piece: capPiece } : null,
  };
}

// Undo slides the pieces back the way they came. `moves` are the history
// entries being reverted (one or two).
function planUndoAnimation(moves) {
  if (reducedMotion || moves.length === 0) return;
  const pieces = [];
  for (const move of moves) {
    pieces.push({ from: move.to, to: move.from });
    if (move.castle) {
      const home = rankOf(move.from);
      pieces.push(move.castle === 'K'
        ? { from: sqIdx(5, home), to: sqIdx(7, home) }
        : { from: sqIdx(3, home), to: sqIdx(0, home) });
    }
  }
  moveAnim = { start: performance.now(), pieces, captured: null };
}

// Called at the end of render(), once the board DOM reflects the new position.
function applyMoveAnimation() {
  if (!moveAnim) return;
  const elapsed = performance.now() - moveAnim.start;
  if (elapsed >= MOVE_ANIM_MS) { moveAnim = null; return; }
  const sqEl = (sq) => boardEl.querySelector(`.square[data-sq="${sq}"]`);

  for (const p of moveAnim.pieces) {
    const fromEl = sqEl(p.from);
    const toEl = sqEl(p.to);
    const img = toEl && toEl.querySelector('img.piece');
    if (!fromEl || !img) continue;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    toEl.classList.add('animating');   // paint above the squares it crosses
    const anim = img.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: MOVE_ANIM_MS, easing: 'ease-out' }
    );
    anim.currentTime = elapsed;
    anim.finished.then(() => toEl.classList.remove('animating'), () => {});
  }

  // The captured piece stays visible under the arriving piece and fades out,
  // rather than blinking away before the capturer has landed.
  if (moveAnim.captured) {
    const capEl = sqEl(moveAnim.captured.sq);
    if (capEl) {
      const ghost = document.createElement('img');
      ghost.src = pieceImgSrc(moveAnim.captured.piece);
      ghost.className = 'ghost';
      if (moveAnim.captured.piece.t === 'p') ghost.classList.add('pawn');
      ghost.draggable = false;
      ghost.alt = '';
      capEl.insertBefore(ghost, capEl.firstChild);
      const anim = ghost.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: MOVE_ANIM_MS, easing: 'ease-in' }
      );
      anim.currentTime = elapsed;
      anim.finished.then(() => ghost.remove(), () => {});
    }
  }
}

function render() {
  boardEl.innerHTML = '';
  const inCheckNow = chess.inCheck();
  const flip = humanColor === B;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      // row/col are visual indices (0=top/left). Translate to board r/f.
      const r = flip ? row : 7 - row;
      const f = flip ? 7 - col : col;
      const sq = sqIdx(f, r);
      const div = document.createElement('div');
      div.className = 'square ' + ((r + f) % 2 === 0 ? 'dark' : 'light');
      div.dataset.sq = sq;

      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add('last-move');
      if (premove && (premove.from === sq || premove.to === sq)) div.classList.add('premove');
      if (selected === sq) div.classList.add('selected');

      const piece = chess.squares[sq];
      if (inCheckNow && piece && piece.t === 'k' && piece.c === chess.turn) {
        div.classList.add('check');
      }

      // Coordinate colour comes from CSS (opposite square colour, themeable).
      if (col === 0) {
        const c = document.createElement('div');
        c.className = 'coord rank';
        c.textContent = r + 1;
        div.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement('div');
        c.className = 'coord file';
        c.textContent = String.fromCharCode(97 + f);
        div.appendChild(c);
      }

      if (piece) {
        const img = document.createElement('img');
        img.src = pieceImgSrc(piece);
        img.classList.add('piece');
        if (piece.t === 'p') img.classList.add('pawn');
        img.draggable = false;
        img.alt = piece.c + piece.t;
        div.appendChild(img);
      }

      if (selected !== null) {
        // Castling is offered on the rook's square too: in Chess960 that is
        // sometimes the only square that can express it.
        const m = legalFromSelected.find(x => x.to === sq)
          || legalFromSelected.find(x => x.castle && x.rookFrom === sq);
        if (m) {
          const hint = document.createElement('div');
          hint.className = 'hint';
          if (premoveSelecting) hint.classList.add('premove');
          else if (chess.squares[sq] || m.enpassant) hint.classList.add('capture');
          div.appendChild(hint);
        }
      }

      div.addEventListener('click', () => onSquareClick(sq));
      boardEl.appendChild(div);
    }
  }
  applyMoveAnimation();

  // Turn / thinking line
  if (thinking) {
    turnEl.textContent = 'LorFish is thinking…'
      + (premove ? ' · premove ' + algOf(premove.from) + algOf(premove.to) : '');
    turnEl.className = 'thinking';
  } else if (gameIsOver()) {
    turnEl.textContent = '';
    turnEl.className = '';
  } else {
    let t = 'Turn: ' + (chess.turn === W ? 'White' : 'Black');
    if (pvpMode) t += chess.turn === humanColor ? ' — your move' : ' — waiting…';
    if (premove) t += ' · premove ' + algOf(premove.from) + algOf(premove.to);
    turnEl.textContent = t;
    turnEl.className = '';
  }

  // Status line
  if (chess.isGameOver()) {
    let s = `Game Over: ${chess.result()}`;
    if (chess.isCheckmate()) {
      s += ` — ${chess.turn === W ? 'Black' : 'White'} wins!`;
    } else if (chess.isStalemate()) {
      s += ' — Stalemate';
    } else if (chess.isInsufficientMaterial()) {
      s += ' — Insufficient material';
    } else if (chess.isThreefoldRepetition()) {
      s += ' — Threefold repetition';
    } else if (chess.halfmove >= 100) {
      s += ' — 50-move rule';
    }
    statusEl.textContent = s;
    statusEl.className = 'game-over';
  } else if (pvpResult) {
    let s = `Game Over: ${pvpResult.result}`;
    if (pvpResult.termination) s += ` — ${pvpResult.termination}`;
    statusEl.textContent = s;
    statusEl.className = 'game-over';
  } else if (inCheckNow) {
    statusEl.textContent = 'Check!';
    statusEl.className = 'check-text';
  } else {
    statusEl.textContent = '';
    statusEl.className = '';
  }

  historyEl.textContent = buildPgn();
  historyEl.scrollTop = historyEl.scrollHeight;

  renderCaptured();
}

function buildPgn() {
  const d = new Date();
  const dateStr = d.getFullYear() + '.'
    + String(d.getMonth() + 1).padStart(2, '0') + '.'
    + String(d.getDate()).padStart(2, '0');
  const result = chess.isGameOver() ? chess.result()
    : (pvpResult ? pvpResult.result : '*');

  let pgn = '';
  pgn += `[Event "${pgnEvent}"]\n`;
  pgn += `[Date "${dateStr}"]\n`;
  pgn += `[White "${whiteName}"]\n`;
  pgn += `[Black "${blackName}"]\n`;
  pgn += `[Result "${result}"]\n`;
  if (startFen) {
    pgn += '[SetUp "1"]\n';
    pgn += `[FEN "${startFen}"]\n`;
  }
  pgn += '\n';

  let body = '';
  let fm = startFullmove;
  let turn = startTurn;
  for (let i = 0; i < moveHistory.length; i++) {
    if (turn === W) {
      body += fm + '. ' + moveHistory[i] + ' ';
    } else {
      if (i === 0) body += fm + '... ' + moveHistory[i] + ' ';
      else        body += moveHistory[i] + ' ';
      fm++;
    }
    turn = turn === W ? B : W;
  }
  body += result;
  return pgn + body;
}

// May the user pick up whatever is standing on this square right now? Shared by
// click-to-move and drag-and-drop, so the two can never disagree.
function canPickUp(sq) {
  if (promotionPending || gameIsOver()) return false;
  if (!canMoveNow() && !canPremove()) return false;
  const piece = chess.squares[sq];
  return !!piece && piece.c === humanColor;
}

// It is our turn and the source will take a move right now.
function canMoveNow() {
  return !thinking && !!moveSource && moveSource.canHumanMoveNow(chess.turn);
}

// The opponent is on move, so anything we pick up becomes a premove.
function canPremove() {
  if (spectating || !moveSource || moveSource.kind === 'spectator') return false;
  if (promotionPending || gameIsOver()) return false;
  return chess.turn !== humanColor;
}

// Where a premove from `sq` may be aimed: every square the piece could reach
// on an empty board (the opponent's move may clear a path or offer a capture,
// so blockers and legality are only judged when the premove is played).
function premoveTargets(sq) {
  const piece = chess.squares[sq];
  if (!piece || piece.c !== humanColor) return [];
  const f = fileOf(sq), r = rankOf(sq);
  const out = [];
  const add = (nf, nr) => { if (inBoard(nf, nr)) out.push(sqIdx(nf, nr)); };
  const ray = (df, dr) => {
    let nf = f + df, nr = r + dr;
    while (inBoard(nf, nr)) { out.push(sqIdx(nf, nr)); nf += df; nr += dr; }
  };
  const diag = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const ortho = [[-1,0],[1,0],[0,-1],[0,1]];
  switch (piece.t) {
    case 'p': {
      const dir = piece.c === W ? 1 : -1;
      add(f, r + dir);
      if (r === (piece.c === W ? 1 : 6)) add(f, r + 2 * dir);
      add(f - 1, r + dir);
      add(f + 1, r + dir);
      break;
    }
    case 'n':
      for (const [df, dr] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) add(f + df, r + dr);
      break;
    case 'b': for (const [df, dr] of diag) ray(df, dr); break;
    case 'r': for (const [df, dr] of ortho) ray(df, dr); break;
    case 'q': for (const [df, dr] of diag.concat(ortho)) ray(df, dr); break;
    case 'k': {
      for (const [df, dr] of diag.concat(ortho)) add(f + df, r + dr);
      const home = piece.c === W ? 0 : 7;
      if (f === 4 && r === home) { add(6, home); add(2, home); }
      break;
    }
  }
  return out;
}

function selectSquare(sq) {
  selected = sq;
  if (canMoveNow()) {
    premoveSelecting = false;
    legalFromSelected = chess.legalMoves().filter(m => m.from === sq);
  } else {
    premoveSelecting = true;
    legalFromSelected = premoveTargets(sq).map(to => ({ from: sq, to }));
  }
  render();
}

function clearSelection() {
  selected = null;
  legalFromSelected = [];
  premoveSelecting = false;
}

function cancelPremove() {
  if (!premove) return false;
  premove = null;
  return true;
}

// Commit a human move between two squares, opening the promotion dialog when
// the move needs one. Returns false when there is no legal move from -> to, so
// the caller can fall back to its own reselect / deselect behaviour.
// `viaDrag` only affects the animation (see planMoveAnimation).
function attemptMove(from, to, viaDrag) {
  if (premoveSelecting) {
    if (!premoveTargets(from).includes(to)) return false;
    premove = { from, to };
    clearSelection();
    render();
    return true;
  }
  const moves = chess.legalMoves().filter(m => m.from === from);
  // Resolve the GESTURE, which hasn't chosen a promotion piece yet — so match
  // without one. (chess.findMove is for a move that already knows exactly what
  // it is, and requires the promotion to match; using it here silently swallows
  // every promotion.) The ordering mirrors findMove: an ordinary move wins the
  // exact match, then a castle by its rook's square — the Chess960 gesture of
  // dropping the king on its own rook — then a castle by the king's destination.
  const candidate =
    moves.find(m => !m.castle && m.to === to) ||
    moves.find(m => m.castle && m.rookFrom === to) ||
    moves.find(m => m.castle && m.to === to);
  if (!candidate) return false;
  const piece = chess.squares[from];
  if (piece && piece.t === 'p' && (rankOf(to) === 0 || rankOf(to) === 7)) {
    selected = from;
    legalFromSelected = moves;
    promotionPending = { from, to, viaDrag: !!viaDrag };
    showPromotionDialog();
    return true;
  }
  if (viaDrag) noAnimMove = { from, to };
  doHumanMove(candidate);
  return true;
}

// Drag-and-drop (mouse, touch and stylus alike). Taps fall through to
// onSquareClick untouched; only a real drag is handled here.
BoardDrag.attach(boardEl, {
  canDrag: canPickUp,
  onPick: selectSquare,
  onDrop(from, to) {
    // Cancelled, or put back where it came from: leave it selected so the hints
    // stay up and a tap can finish the move instead.
    if (to == null || to === from) return;
    attemptMove(from, to, true);
  },
});

function onSquareClick(sq) {
  if (promotionPending || gameIsOver()) return;
  if (!canMoveNow() && !canPremove()) return;

  // A click anywhere withdraws a queued premove; picking up a piece may then
  // start a new one.
  const cancelled = cancelPremove();

  if (selected === null) {
    if (canPickUp(sq)) selectSquare(sq);
    else if (cancelled) render();
    return;
  }

  if (attemptMove(selected, sq, false)) return;

  // Reselect or deselect
  const piece = chess.squares[sq];
  if (piece && piece.c === humanColor) selectSquare(sq);
  else { clearSelection(); render(); }
}

// Right-click: drop the selection and any queued premove (chess.com habit).
boardEl.addEventListener('contextmenu', (e) => {
  if (selected === null && !premove) return;
  e.preventDefault();
  cancelPremove();
  clearSelection();
  render();
});

// Hand the human's chosen move to the active source. The source owns what
// happens next (AI: apply + engine reply; PvP: emit and await server echo).
function doHumanMove(move, opts) {
  if (moveSource) moveSource.submitMove(move, opts || {});
}

function showPromotionDialog() {
  promoOpts.innerHTML = '';
  for (const t of ['q','r','b','n']) {
    const opt = document.createElement('div');
    opt.className = 'opt';
    const img = document.createElement('img');
    img.src = pieceImgSrc({ c: humanColor, t });
    opt.appendChild(img);
    opt.addEventListener('click', () => {
      const move = legalFromSelected.find(m => m.to === promotionPending.to && m.promo === t);
      const viaDrag = promotionPending.viaDrag;
      promoEl.classList.remove('show');
      promotionPending = null;
      if (!move) return;
      if (viaDrag) noAnimMove = { from: move.from, to: move.to };
      doHumanMove(move);
    });
    promoOpts.appendChild(opt);
  }
  promoEl.classList.add('show');
}

function undo() {
  if (thinking || pvpMode) return;   // no undo in authoritative PvP games
  promotionPending = null;
  promoEl.classList.remove('show');

  const before = chess.history.length;
  const undone = [];
  if (chess.turn === humanColor && chess.history.length >= 2) {
    undone.push(chess.history[before - 1].move, chess.history[before - 2].move);
    chess.undoMove();
    chess.undoMove();
    moveHistory.splice(-2);
  } else if (chess.turn !== humanColor && chess.history.length >= 1) {
    undone.push(chess.history[before - 1].move);
    chess.undoMove();
    moveHistory.splice(-1);
  }
  planUndoAnimation(undone);
  if (chess.history.length < before) {
    play(sounds.move);
    resetSoundState(); // undone past the end: let a later mate sound again
  }
  lastMove = chess.history.length > 0
    ? chess.history[chess.history.length - 1].move
    : null;
  clearSelection();
  premove = null;
  render();
  gameStore.truncate(chess.history.length, chess.fen());
}

function setLabels() {
  const youW = humanColor === W;
  const you = (isYou) => (isYou && !spectating ? ' (you)' : '');
  fillLabel(whiteLabelEl, 'White: ' + whiteName, whiteMember, you(youW));
  fillLabel(blackLabelEl, 'Black: ' + blackName, blackMember, you(!youW));
}

function fillLabel(node, name, member, suffix) {
  node.textContent = name;
  if (member) node.appendChild(memberBadge());
  node.appendChild(document.createTextNode(suffix));
}

// ---- AI mode ----
function refreshGameState() {
  resetSoundState();
  humanColor = colorSelectEl.value === 'b' ? B : W;
  whiteName = humanColor === W ? 'Human' : 'LorFish';
  blackName = humanColor === W ? 'LorFish' : 'Human';
  setLabels();
  moveHistory = [];
  lastMove = null;
  clearSelection();
  premove = null;
  promotionPending = null;
  promoEl.classList.remove('show');
  thinking = false;
  render();
  moveSource.kickIfEngineTurn();
}

async function startNewGame() {
  moveSource.cancel();
  chess.reset();
  startFullmove = 1;
  startTurn = W;
  startFen = null;
  humanColor = colorSelectEl.value === 'b' ? B : W;
  await gameStore.newGame({ humanColor, depth: getDepth(), startFen: null });
  refreshGameState();
}

// ---- AI-only control wiring (these controls are hidden in PvP) ----
document.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // typing in chat / FEN box
  if (fenPanel.classList.contains('show')) {
    if (e.key === 'Escape') fenPanel.classList.remove('show');
    return;
  }
  if (e.key === 'r' || e.key === 'R') undo();
});
// Custom pieces may arrive after the first paint (theme fetched from the
// server); redraw so the board picks them up.
window.addEventListener('theme:changed', () => { if (!moveAnim) render(); });
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('resetBtn').addEventListener('click', startNewGame);
colorSelectEl.addEventListener('change', startNewGame);

loadFenBtn.addEventListener('click', () => {
  fenText.value = '';
  fenError.textContent = '';
  fenPanel.classList.add('show');
  fenText.focus();
});
fenCancelBtn.addEventListener('click', () => {
  fenPanel.classList.remove('show');
});
fenLoadBtn.addEventListener('click', async () => {
  const fen = fenText.value.trim();
  if (!fen) { fenError.textContent = 'Paste a FEN string first.'; return; }
  try {
    chess.loadFen(fen);
  } catch (e) {
    fenError.textContent = e.message;
    return;
  }
  moveSource.cancel();
  startFullmove = chess.fullmove;
  startTurn = chess.turn;
  startFen = fen;
  fenPanel.classList.remove('show');
  humanColor = colorSelectEl.value === 'b' ? B : W;
  await gameStore.newGame({ humanColor, depth: getDepth(), startFen: fen });
  refreshGameState();
});

function initAi() {
  moveSource = createAiMoveSource(env);
  startNewGame();
}

const AI_STANDARD_START =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Inverse of chess.js's algOf: 'e4' -> square index.
const sqFromAlg = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;

// Restore an unfinished AI game from its stored move list and hand the board
// back to the player. The engine picks up from wherever the game left off.
function resumeAiGame(game) {
  resetSoundState();
  moveSource = createAiMoveSource(env);

  // The human plays whichever side the AI doesn't.
  humanColor = game.ai_color === 'w' ? B : W;
  colorSelectEl.value = humanColor === B ? 'b' : 'w';

  // Restore the search depth, but only if the picker actually offers it.
  const depthEl = document.getElementById('depth');
  if (depthEl && [...depthEl.options].some(o => o.value === String(game.ai_depth))) {
    depthEl.value = String(game.ai_depth);
  }

  if (game.start_fen && game.start_fen !== AI_STANDARD_START) {
    chess.loadFen(game.start_fen);
    startFen = game.start_fen;
  } else {
    chess.reset();
    startFen = null;
  }
  startFullmove = chess.fullmove;
  startTurn = chess.turn;

  // REPLAY the moves rather than jumping to current_fen: replaying rebuilds
  // positionCounts, so threefold repetition still works in the resumed game
  // (both loadFen and reset wipe it).
  moveHistory = [];
  lastMove = null;
  let replayed = true;
  for (const m of game.moves) {
    const from = sqFromAlg(m.uci.slice(0, 2));
    const to = sqFromAlg(m.uci.slice(2, 4));
    const promo = m.uci[4] || null;
    const mv = chess.legalMoves().find(x =>
      x.from === from && x.to === to && (promo ? x.promo === promo : !x.promo));
    if (!mv) { replayed = false; break; }
    chess.makeMove(mv);
    moveHistory.push(m.san);
    lastMove = mv;
  }
  if (!replayed) {
    // Incomplete or inconsistent move list. Fall back to the stored position:
    // repetition history and the PGN move list are lost, but the game is
    // still playable from here.
    console.warn('Move replay failed; falling back to current_fen.');
    chess.loadFen(game.current_fen);
    startFen = game.current_fen;
    startFullmove = chess.fullmove;
    startTurn = chess.turn;
    moveHistory = [];
    lastMove = null;
  }

  whiteName = humanColor === W ? 'Human' : 'LorFish';
  blackName = humanColor === W ? 'LorFish' : 'Human';
  setLabels();

  gameStore.resume(game.id);

  clearSelection();
  premove = null;
  promotionPending = null;
  promoEl.classList.remove('show');
  thinking = false;
  render();
  // If we quit while the engine was on move, let it move now.
  moveSource.kickIfEngineTurn();
}

// ---- PvP mode ----
function pvpNotice(text, kind) {
  const el = document.getElementById('pvpNotice');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind === 'info' ? 'pvp-info' : 'check-text';
}

// ---- offers (draw / rematch) ----
// A single prompt strip is reused for both kinds of offer; the accept/decline
// callbacks are swapped each time it is shown.
let offerAccept = null;
let offerDecline = null;
let drawOfferedByMe = false;

function showOffer(text, accept, decline) {
  const el = document.getElementById('offerPrompt');
  const txt = document.getElementById('offerText');
  if (!el || !txt) return;
  txt.textContent = text;
  offerAccept = accept;
  offerDecline = decline;
  el.style.display = '';
}

function hideOffer() {
  const el = document.getElementById('offerPrompt');
  if (el) el.style.display = 'none';
  offerAccept = null;
  offerDecline = null;
}

// Draw is only offerable while the game runs; rematch only once it's finished.
function setOfferButtons(over) {
  const drawBtn = document.getElementById('drawBtn');
  const rematchBtn = document.getElementById('rematchBtn');
  if (drawBtn) drawBtn.style.display = over ? 'none' : '';
  if (rematchBtn) rematchBtn.style.display = over ? '' : 'none';
}

// ---- clocks ----
function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10000) return (ms / 1000).toFixed(1);          // tenths under 10s
  const sec = Math.ceil(ms / 1000);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function setClocks(snap, running) {
  if (!snap) return;
  clocks = { w: snap.w, b: snap.b };
  clockBase = Date.now();
  clockRunning = !!running;
  renderClocks();
}

function paintClock(id, ms, active) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = fmtClock(ms);
  el.classList.toggle('active', active);
  el.classList.toggle('low', ms <= 10000);
}

function renderClocks() {
  if (!pvpMode || !clocks) return;
  const youColor = humanColor;                 // 'w' | 'b'
  const oppColor = youColor === W ? B : W;
  const running = clockRunning && !gameIsOver();
  const valOf = (color) => {
    let ms = clocks[color];
    if (running && chess.turn === color) ms -= Date.now() - clockBase; // smooth tick
    return ms;
  };
  const youMs = valOf(youColor);
  const yourTurn = running && chess.turn === youColor;
  paintClock('clockTop', valOf(oppColor), running && chess.turn === oppColor);
  paintClock('clockBottom', youMs, yourTurn);
  if (!spectating) checkLowTime(youMs, yourTurn);
}

// "👁 N watching" under the notices; hidden when nobody is.
function showSpectators(info) {
  const el = document.getElementById('watchInfo');
  if (!el) return;
  const n = (info && info.count) || 0;
  el.textContent = n ? '👁 ' + n + (n === 1 ? ' spectator' : ' spectators') : '';
  el.style.display = n ? '' : 'none';
}

const colorName = (c) => (c === 'w' ? 'White' : 'Black');

// ---- chat ----
// One panel, but two separate conversations: what a player sends reaches only
// the other player, and what a spectator sends reaches only other spectators.
// The split is enforced server-side (see socket.js handleChat) — this side just
// labels which room you are talking into. Listeners are bound once per socket
// (initChat); history is (re)painted from the join/watch ack on every
// (re)connect via setChatHistory, so a reconnect never duplicates lines.
let chatBound = null;

function chatLine(m) {
  const line = document.createElement('div');
  line.className = 'chat-msg chat-' + (m.role || 's');
  const who = document.createElement('span');
  who.className = 'chat-who';
  // No "(spectator)" marker needed: you only ever receive your own audience's
  // messages, so there is nothing to disambiguate.
  who.textContent = m.username;
  if (m.member) who.appendChild(memberBadge());
  who.appendChild(document.createTextNode(':'));
  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = ' ' + m.text;
  line.append(who, text);
  return line;
}

function appendChat(m) {
  const log = document.getElementById('chatLog');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.appendChild(chatLine(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function setChatHistory(list) {
  const log = document.getElementById('chatLog');
  if (!log) return;
  log.innerHTML = '';
  for (const m of list || []) log.appendChild(chatLine(m));
  log.scrollTop = log.scrollHeight;
}

function initChat(socket, gameId) {
  const panel = document.getElementById('chat');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const errEl = document.getElementById('chatError');
  if (!panel || !form || !input) return;
  panel.style.display = '';

  // Say plainly who can hear this. Spectators can see the live position, so
  // their channel is kept away from the players on purpose.
  const title = document.getElementById('chatTitle');
  const audience = document.getElementById('chatAudience');
  if (title) title.textContent = spectating ? 'Spectator chat' : 'Chat';
  if (audience) {
    audience.textContent = spectating
      ? 'Other spectators only — the players cannot see this.'
      : 'Your opponent only — spectators cannot see this.';
  }

  if (chatBound === socket) return;
  chatBound = socket;

  let errTimer = null;
  const showErr = (msg) => {
    errEl.textContent = msg || '';
    clearTimeout(errTimer);
    if (msg) errTimer = setTimeout(() => { errEl.textContent = ''; }, 3000);
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('chat:send', { gameId, text }, (resp) => {
      if (!resp || !resp.ok) {
        showErr((resp && resp.error) || 'Message not sent.');
        if (!input.value) input.value = text; // give it back to retry
      }
    });
  });
  socket.on('chat:message', appendChat);
}

// ---- spectator mode ----
// Read-only view of a live PvP game. Shares applyPvpState and the board with
// the player view; differences are gated on `spectating`.
function initSpectate(gameId) {
  pvpMode = true;
  spectating = true;
  pgnEvent = 'LorChess PvP';
  for (const id of ['aiControls', 'gameButtons', 'pvpControls']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const clocksEl = document.getElementById('clocks');
  if (clocksEl) clocksEl.style.display = '';
  if (!clockTimer) clockTimer = setInterval(renderClocks, 200);
  statusEl.textContent = 'Connecting…';

  const socket = connectSocket({
    onError: (err) => pvpNotice('Connection error: ' + err.message),
    onDisconnect: () => { if (!gameIsOver()) pvpNotice('Disconnected — reconnecting…'); },
  });

  // (Re)subscribe whenever the socket (re)connects; the ack carries the board.
  socket.on('connect', () => {
    pvpNotice('');
    socket.emit('game:watch', { gameId }, (resp) => {
      if (!resp || !resp.ok) {
        // A player who opened the watch link gets sent to the real game.
        if (resp && resp.player) { location.replace('/game.html?id=' + gameId); return; }
        statusEl.textContent = (resp && resp.error) || 'Cannot watch this game.';
        statusEl.className = 'check-text';
        return;
      }
      applyPvpState(socket, resp.state);
      initChat(socket, gameId);
      showSpectators({ count: resp.state.spectators });
      pvpNotice('You are watching this game.', 'info');
    });
  });

  socket.on('clock:started', (info) => setClocks(info.clocks, true));
  socket.on('move:made', (m) => {
    if (moveSource && moveSource.onServerMove) moveSource.onServerMove(m);
    setClocks(m.clocks, true);
  });
  socket.on('game:over', (info) => {
    pvpResult = info;
    clockRunning = false;
    playOutcomeSound(info.result);
    if (info.clocks) setClocks(info.clocks, false);
    showRatingChange(info.ratings);
    render();
  });
  socket.on('opponent:disconnected', (info) => {
    const secs = Math.round((info.graceMs || 0) / 1000);
    pvpNotice(`${colorName(info.color)} disconnected — ${secs}s to reconnect…`);
  });
  socket.on('opponent:reconnected', (info) => {
    pvpNotice(`${colorName(info && info.color)} reconnected.`, 'info');
    setTimeout(() => pvpNotice(''), 3000);
  });
  socket.on('spectators', showSpectators);
  socket.on('friends:changed', () => renderFriendRow());
  // draw:offered / rematch:offered also reach this room; a spectator has
  // nothing to answer, so they are simply not listened for here.
}

function initPvp(gameId) {
  pvpMode = true;
  pgnEvent = 'LorChess PvP';
  for (const id of ['aiControls', 'gameButtons']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const pvpControls = document.getElementById('pvpControls');
  if (pvpControls) pvpControls.style.display = '';
  const resignBtn = document.getElementById('resignBtn');
  const clocksEl = document.getElementById('clocks');
  if (clocksEl) clocksEl.style.display = '';
  if (!clockTimer) clockTimer = setInterval(renderClocks, 200);

  statusEl.textContent = 'Connecting…';

  const socket = connectSocket({
    onError: (err) => pvpNotice('Connection error: ' + err.message),
    onDisconnect: () => { if (!gameIsOver()) pvpNotice('Disconnected — reconnecting…'); },
  });

  if (resignBtn) {
    resignBtn.addEventListener('click', () => {
      if (gameIsOver()) return;
      if (!window.confirm('Resign this game?')) return;
      socket.emit('game:resign', { gameId });
    });
  }

  const drawBtn = document.getElementById('drawBtn');
  const rematchBtn = document.getElementById('rematchBtn');

  document.getElementById('offerAcceptBtn').addEventListener('click', () => {
    const fn = offerAccept;
    hideOffer();
    if (fn) fn();
  });
  document.getElementById('offerDeclineBtn').addEventListener('click', () => {
    const fn = offerDecline;
    hideOffer();
    if (fn) fn();
  });

  if (drawBtn) {
    drawBtn.addEventListener('click', () => {
      if (gameIsOver()) return;
      socket.emit('draw:offer', { gameId });
      drawBtn.disabled = true;
      drawOfferedByMe = true;
      pvpNotice('Draw offered — waiting for a reply…', 'info');
    });
  }

  if (rematchBtn) {
    rematchBtn.addEventListener('click', () => {
      socket.emit('rematch:offer', { gameId });
      rematchBtn.disabled = true;
      rematchBtn.textContent = 'Rematch offered…';
    });
  }

  // Clear our own "waiting for a reply" notice once the offer is resolved.
  function drawResolved() {
    hideOffer();
    if (drawBtn) drawBtn.disabled = false;
    if (drawOfferedByMe) {
      drawOfferedByMe = false;
      pvpNotice('');
    }
  }

  socket.on('draw:offered', () => {
    showOffer(
      'Opponent offers a draw.',
      () => socket.emit('draw:respond', { gameId, accept: true }),
      () => socket.emit('draw:respond', { gameId, accept: false })
    );
  });
  socket.on('draw:declined', () => {
    drawResolved();
    pvpNotice('Draw declined.');
    setTimeout(() => pvpNotice(''), 3000);
  });
  // Broadcast when a move lapses the outstanding offer.
  socket.on('draw:cleared', drawResolved);

  socket.on('rematch:offered', (info) => {
    const who = (info && info.username) || 'Opponent';
    showOffer(
      who + ' wants a rematch.',
      // Offering back is what accepts: the server pairs on mutual offers.
      () => {
        socket.emit('rematch:offer', { gameId });
        if (rematchBtn) {
          rematchBtn.disabled = true;
          rematchBtn.textContent = 'Rematch offered…';
        }
      },
      () => socket.emit('rematch:decline', { gameId })
    );
  });
  socket.on('rematch:declined', () => {
    hideOffer();
    if (rematchBtn) {
      rematchBtn.disabled = false;
      rematchBtn.textContent = 'Rematch';
    }
    pvpNotice('Rematch declined.');
  });
  // Sent to both players once a rematch is agreed — jump into the new game.
  socket.on('game:start', (info) => {
    if (info && info.gameId) location.href = '/game.html?id=' + info.gameId;
  });

  // (Re)join whenever the socket (re)connects; the ack restores board state,
  // and on the server side cancels any pending forfeit timer.
  socket.on('connect', () => {
    pvpNotice('');
    socket.emit('game:join', { gameId }, (resp) => {
      if (!resp || !resp.ok) {
        statusEl.textContent = 'Cannot join game: ' + ((resp && resp.error) || 'unknown error');
        statusEl.className = 'check-text';
        return;
      }
      applyPvpState(socket, resp.state);
      initChat(socket, gameId);
    });
  });

  // Game-event listeners registered ONCE; they dispatch to the *current*
  // moveSource so a reconnect (which rebuilds the source) never stacks them.
  // Fired when the second player joins and the server starts the clock; the
  // first-joined player's join ack said `running: false`, so start it here.
  socket.on('clock:started', (info) => {
    setClocks(info.clocks, true);
  });
  socket.on('move:made', (m) => {
    if (moveSource && moveSource.onServerMove) moveSource.onServerMove(m);
    setClocks(m.clocks, true);
  });
  socket.on('game:over', (info) => {
    pvpResult = info;
    clockRunning = false;
    playOutcomeSound(info.result);
    showReviewLink(gameId);
    if (info.clocks) setClocks(info.clocks, false);
    if (resignBtn) resignBtn.disabled = true;
    hideOffer();
    drawOfferedByMe = false;
    setOfferButtons(true);
    showRatingChange(info.ratings);
    render();
  });
  // Sent to each player individually once the result is in the database.
  socket.on('achievements:earned', (info) => {
    if (info && typeof AchievementToast !== 'undefined') AchievementToast.show(info.list);
  });
  socket.on('opponent:disconnected', (info) => {
    const secs = Math.round((info.graceMs || 0) / 1000);
    pvpNotice(`Opponent disconnected — ${secs}s to reconnect…`);
  });
  socket.on('opponent:reconnected', () => {
    pvpNotice('Opponent reconnected.');
    setTimeout(() => pvpNotice(''), 3000);
  });
  // The opponent accepted / requested / removed us: redraw the friend control.
  socket.on('friends:changed', () => renderFriendRow());
  socket.on('spectators', showSpectators);
}

// The last PvP state we joined with — it carries both players' ids, which the
// friend control needs to know who the opponent is.
let lastPvpState = null;

// Show "+ Add friend" (or Requested / Accept / Friends) for the opponent.
function renderFriendRow() {
  const row = document.getElementById('friendRow');
  const state = lastPvpState;
  if (!row || !window.Friends || !state) return;
  // Players see a control for their opponent; spectators see one per player.
  const targets = spectating
    ? [{ id: state.whiteId, name: state.white }, { id: state.blackId, name: state.black }]
    : state.yourColor === 'w'
      ? [{ id: state.blackId, name: state.black }]
      : [{ id: state.whiteId, name: state.white }];
  if (!targets.some((t) => t.id)) { row.style.display = 'none'; return; }
  Friends.load()
    .then(() => {
      row.innerHTML = '';
      for (const t of targets) {
        if (!t.id) continue;
        const line = document.createElement('span');
        line.className = 'friend-line';
        const who = document.createElement('span');
        who.className = 'muted small';
        who.textContent = t.name + ': ';
        line.appendChild(who);
        line.appendChild(Friends.button(t.id, renderFriendRow, {
          onError: (msg) => pvpNotice(msg),
        }));
        row.appendChild(line);
      }
      row.style.display = '';
    })
    .catch(() => { /* the game works fine without it */ });
}

function applyPvpState(socket, state) {
  // Spectators watch from White's side of the board.
  humanColor = !spectating && state.yourColor === 'b' ? B : W;
  whiteName = state.white;
  blackName = state.black;
  whiteMember = !!state.whiteMember;
  blackMember = !!state.blackMember;
  lastPvpState = state;
  renderFriendRow();
  setChatHistory(state.chat);
  // Atomic changes the rules, not just the position — tell the board before
  // loading anything, or captures will be applied the standard way.
  chess.setVariant(state.variant || 'standard');
  chess.loadFen(state.fen);
  startFullmove = 1;
  startTurn = W;
  // Non-null for a handicap game, so the exported PGN carries SetUp/FEN. A
  // handicap position is always white-to-move on move 1, so the two above hold.
  startFen = state.startFen || null;
  moveHistory = state.sans.slice();
  lastMove = null;
  clearSelection();
  premove = null;
  promotionPending = null;
  thinking = false;
  // If we're (re)joining a game that's already over, show its real outcome.
  pvpResult = state.status !== 'active'
    ? { result: state.result || '*', termination: state.termination || null }
    : null;
  setLabels();

  // Restore the offer UI for whatever the server says is going on: a finished
  // game shows Rematch, and a draw offer made before we joined is re-surfaced.
  const over = state.status !== 'active';
  setOfferButtons(over);
  hideOffer();
  drawOfferedByMe = false;
  const drawBtnEl = document.getElementById('drawBtn');
  if (drawBtnEl) drawBtnEl.disabled = false;
  if (!spectating && !over && state.drawOffer) {
    if (state.drawOffer === state.yourColor) {
      if (drawBtnEl) drawBtnEl.disabled = true;
      drawOfferedByMe = true;
      pvpNotice('Draw offered — waiting for a reply…', 'info');
    } else {
      showOffer(
        'Opponent offers a draw.',
        () => socket.emit('draw:respond', { gameId: state.gameId, accept: true }),
        () => socket.emit('draw:respond', { gameId: state.gameId, accept: false })
      );
    }
  }

  // Time control + rating, e.g. "Blitz 5+3 · rated".
  const tcLine = document.getElementById('tcLine');
  if (tcLine && state.timeControl) {
    let line = state.timeControl + ' · ' + (state.rated ? 'rated' : 'casual');
    if (state.variant && state.variant !== 'standard') line += ' · ' + variantLabel(state.variant);
    if (state.handicap) line += ' · handicap: ' + state.handicap;
    tcLine.textContent = line;
  }

  // Clock labels (top = opponent, bottom = you; for a spectator top = Black,
  // bottom = White) + initial snapshot.
  const oppName = humanColor === W ? blackName : whiteName;
  const topWho = document.getElementById('clockTopWho');
  const botWho = document.getElementById('clockBottomWho');
  if (topWho) topWho.textContent = oppName;
  if (botWho) botWho.textContent = spectating ? whiteName : 'You';
  setClocks(state.clocks, state.running);

  // Build (or rebuild, on reconnect) the source bound to this socket.
  moveSource = spectating
    ? createSpectatorMoveSource(env)
    : createRemoteMoveSource(env, { socket, gameId: state.gameId, yourColor: state.yourColor });
  render();
}

// Show the local player's rating change after a rated game, and update the
// user bar live.
function showRatingChange(ratings) {
  if (!ratings) return;
  if (spectating) {
    // Both players' changes, e.g. "alice 1230 → 1246 (+16) · bob 1170 → 1154 (−16)".
    const fmt = (name, r) => r && `${name} ${r.before} → ${r.after} (${r.delta >= 0 ? '+' : ''}${r.delta})`;
    const parts = [fmt(whiteName, ratings.w), fmt(blackName, ratings.b)].filter(Boolean);
    if (parts.length) pvpNotice(parts.join(' · '), 'info');
    return;
  }
  const mine = ratings[humanColor]; // humanColor is 'w' | 'b'
  if (!mine) return;
  const sign = mine.delta >= 0 ? '+' : '';
  pvpNotice(`Rating: ${mine.before} → ${mine.after} (${sign}${mine.delta})`, 'info');
  const rEl = document.getElementById('ubRating');
  if (rEl) rEl.textContent = '(' + mine.after + ')';
  if (window.currentUser) window.currentUser.rating = mine.after;
}

// Offer a LorFish review of the game that just ended. The replay viewer owns
// the analysis; this is only the way in. Not shown to spectators, who can't
// fetch the game record.
function showReviewLink(id) {
  const wrap = document.getElementById('reviewLinkWrap');
  const link = document.getElementById('reviewLink');
  if (!wrap || !link || !id) return;
  // LorFish can't review a game whose rules it doesn't know, so don't dangle a
  // link that the replay viewer will only refuse.
  if (!isReviewable(chess.variant)) return;
  // authGuard resolved window.currentUser long before any game could end, so
  // membership is already known here — no extra request.
  const member = !!(window.currentUser && window.currentUser.member_since);
  if (member) {
    link.textContent = '🔍 Review this game';
    link.href = '/replay.html?id=' + id + '&review=1';
  } else {
    link.textContent = '🔒 Review this game with LorFish — members only';
    link.href = '/membership.html';
  }
  wrap.style.display = '';
}

// ---- entry point ----
// ?id=<gameId> is either a live PvP game or an unfinished AI game to resume;
// the server tells us which. No id means start a fresh AI game.
async function openGame(gameId) {
  let game;
  try {
    const res = await fetch('/api/games/' + gameId, { credentials: 'same-origin' });
    if (res.status === 401) { location.replace('/login.html'); return; }
    if (!res.ok) {
      statusEl.textContent = res.status === 403
        ? "That isn't your game." : 'Game not found.';
      statusEl.className = 'check-text';
      return;
    }
    game = await res.json();
  } catch (e) {
    statusEl.textContent = 'Could not load that game.';
    statusEl.className = 'check-text';
    return;
  }

  if (game.mode === 'pvp') { initPvp(gameId); return; }
  // A finished AI game isn't playable — send them to the replay viewer.
  if (game.status !== 'active') { location.replace('/replay.html?id=' + gameId); return; }
  resumeAiGame(game);
}

// ?watch=<gameId> spectates a live PvP game (no ownership check needed: the
// socket handler decides). ?id=<gameId> plays; no id starts a fresh AI game.
const _params = new URLSearchParams(location.search);
const _gameId = parseInt(_params.get('id'), 10);
const _watchId = parseInt(_params.get('watch'), 10);
if (Number.isInteger(_watchId)) initSpectate(_watchId);
else if (Number.isInteger(_gameId)) openGame(_gameId);
else initAi();
