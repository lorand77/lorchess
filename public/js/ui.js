"use strict";

const chess = new Chess();
let humanColor = W;
let selected = null;
let legalFromSelected = [];
let lastMove = null;
let promotionPending = null;
let thinking = false;
let moveHistory = [];
// Fullmove number and side-to-move at the start of the current PGN body,
// plus the FEN string if the game was set up from one (null if standard start).
let startFullmove = 1;
let startTurn = W;
let startFen = null;

// Opponent abstraction + mode. moveSource is assigned in initAi()/initPvp().
let moveSource = null;
let pvpMode = false;
let pvpResult = null;            // {result, termination} once a PvP game ends
let whiteName = 'Human';
let blackName = 'LorFish';
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
function applyMove(rmove, record) {
  const move = chess.legalMoves().find(m =>
    m.from === rmove.from &&
    m.to === rmove.to &&
    (rmove.promo ? m.promo === rmove.promo : !m.promo));
  if (!move) {
    console.error('Move is not legal here:', rmove);
    return;
  }
  const san = chess.moveToSan(move);
  chess.makeMove(move);
  lastMove = move;
  moveHistory.push(san);
  playMoveSound();
  selected = null;
  legalFromSelected = [];
  render();
  if (record) recordApplied(san, move);
}

// Record the move just applied to `chess`, and finalize the game if it ended
// (AI mode — client is authoritative and drives persistence).
function recordApplied(san, move) {
  const ply = chess.history.length;
  const uci = algOf(move.from) + algOf(move.to) + (move.promo || '');
  const fenAfter = chess.fen();
  const byColor = opp(chess.turn);   // the mover = side that just moved (turn has flipped)
  gameStore.recordMove({ ply, san, uci, fenAfter, byColor });
  if (chess.isGameOver()) {
    gameStore.endGame(chess.result(), terminationReason());
    playOutcomeSound(chess.result());
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

function pieceImgSrc(piece) {
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
      if (selected === sq) div.classList.add('selected');

      const piece = chess.squares[sq];
      if (inCheckNow && piece && piece.t === 'k' && piece.c === chess.turn) {
        div.classList.add('check');
      }

      const coordColor = ((r + f) % 2 === 0) ? '#f0d9b5' : '#b58863';
      if (col === 0) {
        const c = document.createElement('div');
        c.className = 'coord rank';
        c.textContent = r + 1;
        c.style.color = coordColor;
        div.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement('div');
        c.className = 'coord file';
        c.textContent = String.fromCharCode(97 + f);
        c.style.color = coordColor;
        div.appendChild(c);
      }

      if (piece) {
        const img = document.createElement('img');
        img.src = pieceImgSrc(piece);
        if (piece.t === 'p') img.classList.add('pawn');
        img.draggable = false;
        img.alt = piece.c + piece.t;
        div.appendChild(img);
      }

      if (selected !== null) {
        const m = legalFromSelected.find(x => x.to === sq);
        if (m) {
          const hint = document.createElement('div');
          hint.className = 'hint';
          if (chess.squares[sq] || m.enpassant) hint.classList.add('capture');
          div.appendChild(hint);
        }
      }

      div.addEventListener('click', () => onSquareClick(sq));
      boardEl.appendChild(div);
    }
  }

  // Turn / thinking line
  if (thinking) {
    turnEl.textContent = 'LorFish is thinking…';
    turnEl.className = 'thinking';
  } else if (gameIsOver()) {
    turnEl.textContent = '';
    turnEl.className = '';
  } else {
    let t = 'Turn: ' + (chess.turn === W ? 'White' : 'Black');
    if (pvpMode) t += chess.turn === humanColor ? ' — your move' : ' — waiting…';
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

function onSquareClick(sq) {
  if (promotionPending || thinking || gameIsOver()) return;
  if (!moveSource || !moveSource.canHumanMoveNow(chess.turn)) return;

  if (selected === null) {
    const piece = chess.squares[sq];
    if (piece && piece.c === humanColor) {
      selected = sq;
      legalFromSelected = chess.legalMoves().filter(m => m.from === sq);
      render();
    }
    return;
  }

  const candidate = legalFromSelected.find(m => m.to === sq);
  if (candidate) {
    const piece = chess.squares[selected];
    if (piece.t === 'p' && (rankOf(sq) === 0 || rankOf(sq) === 7)) {
      promotionPending = { from: selected, to: sq };
      showPromotionDialog();
      return;
    }
    doHumanMove(candidate);
    return;
  }

  // Reselect or deselect
  const piece = chess.squares[sq];
  if (piece && piece.c === humanColor) {
    selected = sq;
    legalFromSelected = chess.legalMoves().filter(m => m.from === sq);
  } else {
    selected = null;
    legalFromSelected = [];
  }
  render();
}

// Hand the human's chosen move to the active source. The source owns what
// happens next (AI: apply + engine reply; PvP: emit and await server echo).
function doHumanMove(move) {
  if (moveSource) moveSource.submitMove(move);
}

function showPromotionDialog() {
  promoOpts.innerHTML = '';
  for (const t of ['q','r','b','n']) {
    const opt = document.createElement('div');
    opt.className = 'opt';
    const img = document.createElement('img');
    img.src = `assets/${humanColor}_${PIECE_NAMES[t]}_1x_ns.png`;
    opt.appendChild(img);
    opt.addEventListener('click', () => {
      const move = legalFromSelected.find(m => m.to === promotionPending.to && m.promo === t);
      promoEl.classList.remove('show');
      promotionPending = null;
      if (move) doHumanMove(move);
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
  if (chess.turn === humanColor && chess.history.length >= 2) {
    chess.undoMove();
    chess.undoMove();
    moveHistory.splice(-2);
  } else if (chess.turn !== humanColor && chess.history.length >= 1) {
    chess.undoMove();
    moveHistory.splice(-1);
  }
  if (chess.history.length < before) {
    play(sounds.move);
    resetSoundState(); // undone past the end: let a later mate sound again
  }
  lastMove = chess.history.length > 0
    ? chess.history[chess.history.length - 1].move
    : null;
  selected = null;
  legalFromSelected = [];
  render();
  gameStore.truncate(chess.history.length, chess.fen());
}

function setLabels() {
  const youW = humanColor === W;
  whiteLabelEl.textContent = 'White: ' + whiteName + (youW ? ' (you)' : '');
  blackLabelEl.textContent = 'Black: ' + blackName + (!youW ? ' (you)' : '');
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
  selected = null;
  legalFromSelected = [];
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
  if (fenPanel.classList.contains('show')) {
    if (e.key === 'Escape') fenPanel.classList.remove('show');
    return;
  }
  if (e.key === 'r' || e.key === 'R') undo();
});
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

  selected = null;
  legalFromSelected = [];
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
  checkLowTime(youMs, yourTurn);
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
    });
  });

  // Game-event listeners registered ONCE; they dispatch to the *current*
  // moveSource so a reconnect (which rebuilds the source) never stacks them.
  socket.on('move:made', (m) => {
    if (moveSource && moveSource.onServerMove) moveSource.onServerMove(m);
    setClocks(m.clocks, true);
  });
  socket.on('game:over', (info) => {
    pvpResult = info;
    clockRunning = false;
    playOutcomeSound(info.result);
    if (info.clocks) setClocks(info.clocks, false);
    if (resignBtn) resignBtn.disabled = true;
    hideOffer();
    drawOfferedByMe = false;
    setOfferButtons(true);
    showRatingChange(info.ratings);
    render();
  });
  socket.on('opponent:disconnected', (info) => {
    const secs = Math.round((info.graceMs || 0) / 1000);
    pvpNotice(`Opponent disconnected — ${secs}s to reconnect…`);
  });
  socket.on('opponent:reconnected', () => {
    pvpNotice('Opponent reconnected.');
    setTimeout(() => pvpNotice(''), 3000);
  });
}

function applyPvpState(socket, state) {
  humanColor = state.yourColor === 'b' ? B : W;
  whiteName = state.white;
  blackName = state.black;
  // M5: PvP games always start from the standard position.
  chess.loadFen(state.fen);
  startFullmove = 1;
  startTurn = W;
  startFen = null;
  moveHistory = state.sans.slice();
  lastMove = null;
  selected = null;
  legalFromSelected = [];
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
  if (!over && state.drawOffer) {
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

  // Clock labels (top = opponent, bottom = you) + initial snapshot.
  const oppName = humanColor === W ? blackName : whiteName;
  const topWho = document.getElementById('clockTopWho');
  const botWho = document.getElementById('clockBottomWho');
  if (topWho) topWho.textContent = oppName;
  if (botWho) botWho.textContent = 'You';
  setClocks(state.clocks, state.running);

  // Build (or rebuild, on reconnect) the remote source bound to this socket.
  moveSource = createRemoteMoveSource(env, {
    socket,
    gameId: state.gameId,
    yourColor: state.yourColor,
  });
  render();
}

// Show the local player's rating change after a rated game, and update the
// user bar live.
function showRatingChange(ratings) {
  if (!ratings) return;
  const mine = ratings[humanColor]; // humanColor is 'w' | 'b'
  if (!mine) return;
  const sign = mine.delta >= 0 ? '+' : '';
  pvpNotice(`Rating: ${mine.before} → ${mine.after} (${sign}${mine.delta})`, 'info');
  const rEl = document.getElementById('ubRating');
  if (rEl) rEl.textContent = '(' + mine.after + ')';
  if (window.currentUser) window.currentUser.rating = mine.after;
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

const _params = new URLSearchParams(location.search);
const _gameId = parseInt(_params.get('id'), 10);
if (Number.isInteger(_gameId)) openGame(_gameId);
else initAi();
