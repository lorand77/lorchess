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
};
Object.values(sounds).forEach(a => { a.preload = 'auto'; a.volume = 0.6; });

function play(a) {
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// Pick a sound based on the position AFTER the most recent makeMove.
function playMoveSound() {
  const last = chess.history[chess.history.length - 1];
  const captured = last ? last.captured : null;
  if (chess.isCheckmate())            return play(sounds.checkmate);
  if (chess.isGameOver())             return play(sounds.draw);
  if (captured && captured.t === 'q') return play(sounds.explosion);
  if (chess.inCheck())                return play(sounds.check);
  if (captured)                       return play(sounds.capture);
  play(sounds.move);
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
  if (chess.history.length < before) play(sounds.move);
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

// ---- PvP mode ----
function pvpNotice(text) {
  const el = document.getElementById('pvpNotice');
  if (el) el.textContent = text || '';
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
  });
  socket.on('game:over', (info) => {
    pvpResult = info;
    pvpNotice('');
    if (resignBtn) resignBtn.disabled = true;
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
  pvpResult = state.status === 'finished' ? { result: '*', termination: null } : null;
  setLabels();
  // Build (or rebuild, on reconnect) the remote source bound to this socket.
  moveSource = createRemoteMoveSource(env, {
    socket,
    gameId: state.gameId,
    yourColor: state.yourColor,
  });
  render();
}

// ---- entry point: PvP if ?id=<gameId>, else AI ----
const _params = new URLSearchParams(location.search);
const _pvpId = _params.get('id');
if (_pvpId) initPvp(parseInt(_pvpId, 10));
else initAi();
