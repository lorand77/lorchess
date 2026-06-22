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

const boardEl       = document.getElementById('board');
const turnEl        = document.getElementById('turn');
const scannerEl     = document.getElementById('scanner');
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

// Scanner uses Web Audio API so its audio thread keeps playing during the
// engine's synchronous search — an HTMLAudioElement stalls once its decode
// buffer drains (~3-4s) when the main thread is blocked.
let scannerCtx = null;
let scannerBuffer = null;
let scannerSource = null;
let scannerGain = null;
function ensureScannerCtx() {
  if (scannerCtx) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) { console.warn('Web Audio API not supported'); return; }
  scannerCtx = new Ctor();
  scannerGain = scannerCtx.createGain();
  scannerGain.gain.value = 0.3;
  scannerGain.connect(scannerCtx.destination);
  fetch('assets/Scanner.mp3')
    .then(r => {
      if (!r.ok) throw new Error('fetch ' + r.status);
      return r.arrayBuffer();
    })
    .then(buf => scannerCtx.decodeAudioData(buf))
    .then(audioBuf => { scannerBuffer = audioBuf; })
    .catch(err => console.error('Scanner audio load failed:', err));
}
// Browsers require a user gesture before an AudioContext can play. Unlock on
// the first click/keypress so the buffer is ready before the engine thinks.
function unlockScannerAudio() {
  ensureScannerCtx();
  if (scannerCtx && scannerCtx.state === 'suspended') {
    scannerCtx.resume().catch(err => console.error('Scanner resume failed:', err));
  }
}
document.addEventListener('click',   unlockScannerAudio, { once: true });
document.addEventListener('keydown', unlockScannerAudio, { once: true });

function playScanner() {
  ensureScannerCtx();
  if (!scannerCtx || !scannerBuffer) return;
  if (scannerCtx.state === 'suspended') scannerCtx.resume();
  stopScanner();
  scannerSource = scannerCtx.createBufferSource();
  scannerSource.buffer = scannerBuffer;
  scannerSource.loop = true;
  scannerSource.connect(scannerGain);
  scannerSource.start(0);
}
function stopScanner() {
  if (!scannerSource) return;
  try { scannerSource.stop(); } catch (e) {}
  scannerSource.disconnect();
  scannerSource = null;
}

function play(a) {
  if (!a) return;
  a.currentTime = 0;
  // Browsers reject .play() before any user gesture — swallow that quietly.
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

      // Coordinates: rank labels in leftmost displayed column,
      // file labels in bottom displayed row. Text uses the opposite
      // shade of the square so it's readable.
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

  // Info panel
  if (chess.isGameOver() && !thinking) {
    turnEl.textContent = '';
    turnEl.className = '';
  } else {
    turnEl.textContent = 'Turn: ' + (chess.turn === W ? 'White' : 'Black');
    turnEl.className = '';
  }
  scannerEl.classList.toggle('show', thinking);

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
  const result = chess.isGameOver() ? chess.result() : '*';
  const whiteName = humanColor === W ? 'Human' : 'LorFish';
  const blackName = humanColor === W ? 'LorFish' : 'Human';

  let pgn = '';
  pgn += '[Event "Human vs LorFish"]\n';
  pgn += `[Date "${dateStr}"]\n`;
  pgn += `[White "${whiteName}"]\n`;
  pgn += `[Black "${blackName}"]\n`;
  pgn += `[Result "${result}"]\n`;
  if (startFen) {
    pgn += '[SetUp "1"]\n';
    pgn += `[FEN "${startFen}"]\n`;
  }
  pgn += '\n';

  // Move numbers continue from the position's fullmove counter, not 1.
  // If black moves first (loaded FEN), the first move uses "N..." notation.
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
  if (promotionPending || thinking || chess.isGameOver()) return;
  if (chess.turn !== humanColor) return;

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

function doHumanMove(move) {
  const san = chess.moveToSan(move);
  chess.makeMove(move);
  lastMove = move;
  moveHistory.push(san);
  playMoveSound();
  selected = null;
  legalFromSelected = [];
  render();

  if (!chess.isGameOver()) {
    setTimeout(makeEngineMove, 50);
  }
}

function makeEngineMove() {
  if (thinking || chess.isGameOver() || chess.turn === humanColor) return;
  thinking = true;
  render();
  playScanner();
  // Defer to next tick so the "thinking" UI paints before we block.
  setTimeout(() => {
    const depth = parseInt(document.getElementById('depth').value, 10);
    const move = LorFish.getBestMove(chess, depth);
    stopScanner();
    if (move) {
      const san = chess.moveToSan(move);
      chess.makeMove(move);
      lastMove = move;
      moveHistory.push(san);
      playMoveSound();
    }
    thinking = false;
    render();
  }, 30);
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
  if (thinking) return;
  promotionPending = null;
  promoEl.classList.remove('show');

  const before = chess.history.length;
  // After a normal turn it's the human to move; pop two plies (engine + human).
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
}

// Initialise the UI for a fresh game. The chess instance must already be in
// the desired starting position (default reset, or a FEN load).
function refreshGameState() {
  humanColor = colorSelectEl.value === 'b' ? B : W;
  whiteLabelEl.textContent = 'White: ' + (humanColor === W ? 'Human' : 'LorFish');
  blackLabelEl.textContent = 'Black: ' + (humanColor === W ? 'LorFish' : 'Human');
  moveHistory = [];
  lastMove = null;
  selected = null;
  legalFromSelected = [];
  promotionPending = null;
  promoEl.classList.remove('show');
  thinking = false;
  render();
  // If it's not the human's turn, the engine plays.
  if (chess.turn !== humanColor && !chess.isGameOver()) {
    setTimeout(makeEngineMove, 50);
  }
}

function startNewGame() {
  chess.reset();
  startFullmove = 1;
  startTurn = W;
  startFen = null;
  refreshGameState();
}

document.addEventListener('keydown', e => {
  // Block keyboard shortcuts while the FEN modal is open.
  if (fenPanel.classList.contains('show')) {
    if (e.key === 'Escape') {
      fenPanel.classList.remove('show');
    }
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
fenLoadBtn.addEventListener('click', () => {
  const fen = fenText.value.trim();
  if (!fen) { fenError.textContent = 'Paste a FEN string first.'; return; }
  try {
    chess.loadFen(fen);
  } catch (e) {
    fenError.textContent = e.message;
    return;
  }
  startFullmove = chess.fullmove;
  startTurn = chess.turn;
  startFen = fen;
  fenPanel.classList.remove('show');
  refreshGameState();
});

startNewGame();
