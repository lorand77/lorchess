'use strict';

// The game page for four-player chess (Teams): Red and Yellow against Blue and
// Green on the cross board (fourPlayer.js, fourBoardView.js). A page of its
// own rather than a mode of ui.js, whose every part — two names, two clocks,
// PGN, material, undo, AI games, draws and rematches — is for two players.
// game.html sends a four-player game here.
//
// The server decides everything, as for any PvP game (src/game/socket.js): a
// move is sent with move:make and drawn only when move:made comes back, for
// the mover as for everyone. The page keeps its own engine, replayed from the
// game's moves, to know whose turn it is, where a piece may go, and who is in
// check. Each player sees the board from their own side; a spectator from
// Red's. The four plates sit in the board's empty corners, each by its
// player's king, with the name and the clock. No premoves yet.
//
//   four.html?id=<game>     play (a seat in the game)
//   four.html?watch=<game>  watch

const COLORS = FourPlayer.COLORS;
const NAMES = FourPlayer.NAMES;
const TEAM_NAMES = ['Red & Yellow', 'Blue & Green'];
const params = new URLSearchParams(location.search);
const watchId = parseInt(params.get('watch'), 10);
const spectating = Number.isInteger(watchId);
const gameId = spectating ? watchId : parseInt(params.get('id'), 10);

let game = new FourPlayer();
let me = null;               // my colour; null when watching
let seats = null;            // { r: { id, name, member }, ... } from the server
let sans = [];
let result = null;           // { result, termination } once the game is over
let clocks = null;           // the last snapshot, { r: ms, ... }
let clockBase = 0;           // when it was taken
let running = false;
let selected = null;
let targets = [];            // the selected piece's legal moves
let lastMove = null;
let anim = null;
let socket = null;

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const turnEl = document.getElementById('turn');
const promoEl = document.getElementById('promo');
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const view = FourBoardView.create(boardEl, {
  pieceSrc: (p) => Theme.pieceSrc(p.c, p.t),
  onSquareClick,
  // Right-button drags draw arrows (boardArrows.js); no browser menu.
  onContextMenu: (e) => e.preventDefault(),
  canDrag: canPick,
  onPick: select,
  onDrop: (from, to) => {
    if (to == null || to === from) return render();
    attempt(from, to);
  },
});
window.addEventListener('theme:changed', () => render());

// ---- moving ----

function myTurn() {
  return !!me && !result && game.turn === me && !game.isGameOver();
}

function canPick(sq) {
  const p = game.squares[sq];
  return myTurn() && !promoEl.classList.contains('show') && !!p && p.c === me;
}

function select(sq) {
  selected = sq;
  targets = game.legalMoves().filter((m) => m.from === sq);
  render();
}

function clearSelection() {
  selected = null;
  targets = [];
}

function onSquareClick(sq) {
  if (selected !== null && selected !== sq && targets.some((m) => m.to === sq)) return attempt(selected, sq);
  if (canPick(sq) && sq !== selected) return select(sq);
  clearSelection();
  render();
}

// A move to `to`: straight to the server, or through the promotion dialog
// when the pawn reaches its 11th rank.
function attempt(from, to) {
  const moves = game.legalMoves().filter((m) => m.from === from && m.to === to);
  clearSelection();
  if (!moves.length) return render();
  if (moves.length > 1) return askPromotion(moves);
  send(moves[0]);
}

function send(m) {
  render();
  socket.emit('move:make', { gameId, from: m.from, to: m.to, promo: m.promo || null }, (resp) => {
    if (!resp || !resp.ok) notice((resp && resp.error) || 'Move refused.');
  });
}

function askPromotion(moves) {
  const opts = document.getElementById('promoOptions');
  opts.innerHTML = '';
  for (const t of FourPlayer.PROMOTIONS) {
    const m = moves.find((x) => x.promo === t);
    const b = document.createElement('div');
    b.className = 'opt';
    const img = document.createElement('img');
    img.src = Theme.pieceSrc('w', t);
    img.className = 'four-' + me;
    img.alt = t;
    b.appendChild(img);
    b.addEventListener('click', () => {
      promoEl.classList.remove('show');
      send(m);
    });
    opts.appendChild(b);
  }
  promoEl.classList.add('show');
  render();
}

// A move the server made: played on our engine, animated, sounded.
function applyServerMove(m) {
  if (m.ply <= game.history.length) return;               // already have it
  if (m.ply > game.history.length + 1) return rejoin();   // missed one
  const move = game.findMove(m.from, m.to, m.promo);
  if (!move) return rejoin();
  game.makeMove(move);
  const entry = game.history[game.history.length - 1];
  lastMove = move;
  sans.push(m.san);
  anim = reducedMotion ? null : {
    start: performance.now(),
    pieces: [{ from: move.from, to: move.to }].concat(move.castle ? [{ from: move.castle.rookFrom, to: move.castle.rookTo }] : []),
    captured: entry.captured ? { sq: entry.capturedAt, piece: entry.captured } : null,
  };
  if (selected !== null && !canPick(selected)) clearSelection();
  moveSound(entry);
  render();
}

// ---- drawing ----

// The four colours from the bottom, clockwise, and the corner each plate takes.
function around() {
  const bottom = me || 'r';
  const order = [bottom];
  for (let i = 0; i < 3; i++) order.push(FourPlayer.nextColor(order[i]));
  return [[order[0], 'br'], [order[1], 'bl'], [order[2], 'tl'], [order[3], 'tr']];
}

function checked() {
  return COLORS.filter((c) => game.kingOf(c) !== -1 && game.inCheck(c));
}

function render() {
  const hints = new Map(targets.map((m) => [m.to, m.capture ? 'capture' : 'move']));
  const still = view.render({
    pieces: game.squares,
    bottom: me || 'r',
    lastMove,
    selected,
    check: new Set(checked().map((c) => game.kingOf(c))),
    hints,
    animation: anim,
  });
  if (!still) anim = null;
  renderPlates();
  renderStatus();
  renderMoves();
}

const teamOf = (c) => TEAM_NAMES[FourPlayer.teamOf(c)];

function renderPlates() {
  for (const [c, corner] of around()) {
    const plate = document.getElementById('plate-' + corner);
    plate.innerHTML = '';
    plate.dataset.color = c;
    plate.style.setProperty('--seat', FourBoardView.COLOURS[c]);
    const who = document.createElement('div');
    who.className = 'four-who';
    const dot = document.createElement('span');
    dot.className = 'four-dot';
    dot.title = NAMES[c];
    who.appendChild(dot);
    const s = seats && seats[c];
    if (s) {
      who.appendChild(playerLink(s.id, s.name, { newTab: true }));
      if (s.member) who.appendChild(memberBadge());
    }
    if (c === me) who.appendChild(document.createTextNode(' (you)'));
    else if (me && c === FourPlayer.partnerOf(me)) who.appendChild(document.createTextNode(' (partner)'));
    plate.appendChild(who);
    const clock = document.createElement('div');
    clock.className = 'clock';
    clock.dataset.clock = c;
    plate.appendChild(clock);
  }
  renderClocks();
}

function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10000) return (ms / 1000).toFixed(1);
  const sec = Math.ceil(ms / 1000);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function setClocks(snap, run) {
  if (!snap) return;
  clocks = Object.assign({}, snap);
  clockBase = Date.now();
  running = !!run;
  renderClocks();
}

function renderClocks() {
  if (!clocks) return;
  const live = running && !result;
  for (const el of document.querySelectorAll('.four-plate .clock')) {
    const c = el.dataset.clock;
    const active = live && game.turn === c;
    const ms = clocks[c] - (active ? Date.now() - clockBase : 0);
    el.textContent = fmtClock(ms);
    el.classList.toggle('active', active);
    el.classList.toggle('low', ms <= 10000);
    el.parentElement.classList.toggle('to-move', !result && game.turn === c);
  }
}
setInterval(renderClocks, 200);

const list = (cs) => cs.map((c) => NAMES[c]).join(' and ');

function renderStatus() {
  document.getElementById('controls').style.display = me && !result ? '' : 'none';
  if (result) {
    turnEl.textContent = '';
    const winners = result.result === '1-0' ? 0 : result.result === '0-1' ? 1 : null;
    let s = winners === null ? 'Game over: no result' : `Game over: ${TEAM_NAMES[winners]} win`;
    // The board says who was mated; a resignation or a flag is the team's.
    const how = game.isCheckmate() ? `${NAMES[game.turn]} is checkmated` : result.termination;
    if (how) s += ` — ${how}`;
    if (me && winners !== null) s += FourPlayer.teamOf(me) === winners ? ' · your team wins' : ' · your team loses';
    statusEl.textContent = s;
    statusEl.className = 'game-over';
    return;
  }
  const t = game.turn;
  let line = `Turn: ${NAMES[t]}`;
  if (me) line += t === me ? ' — your move' : t === FourPlayer.partnerOf(me) ? ' — your partner' : ' — waiting…';
  if (!running && !game.history.length) line = 'Waiting for all four players…';
  turnEl.textContent = line;
  const inCheck = checked();
  statusEl.textContent = !inCheck.length ? ''
    : me && inCheck.includes(me) ? (inCheck.length > 1 ? `Check! (${list(inCheck)})` : 'Check!')
      : `Check: ${list(inCheck)}`;
  statusEl.className = inCheck.length ? 'check-text' : '';
}

// One line a round, Red's move first, as chess.com writes them.
function renderMoves() {
  const el = document.getElementById('history');
  el.innerHTML = '';
  for (let i = 0; i < sans.length; i += 4) {
    const line = document.createElement('div');
    line.textContent = `${i / 4 + 1}. ${sans.slice(i, i + 4).join('  ')}`;
    el.appendChild(line);
  }
  el.scrollTop = el.scrollHeight;
}

// ---- sounds ----

const sounds = {};
for (const k of ['Move', 'Capture', 'Check', 'Checkmate', 'Victory', 'Defeat', 'Draw']) {
  sounds[k] = new Audio('/assets/' + k + '.mp3');
  sounds[k].volume = 0.6;
}
function play(a) {
  a.currentTime = 0;
  a.play().catch(() => {});
}
function moveSound(entry) {
  if (game.isCheckmate()) return play(sounds.Checkmate);
  if (checked().length) return play(sounds.Check);
  play(entry.captured ? sounds.Capture : sounds.Move);
}
function outcomeSound(res) {
  const winners = res === '1-0' ? 0 : res === '0-1' ? 1 : null;
  if (!me || winners === null) return play(sounds.Draw);
  setTimeout(() => play(FourPlayer.teamOf(me) === winners ? sounds.Victory : sounds.Defeat), 400);
}

// ---- notices, spectators, chat ----

let noticeTimer = null;
function notice(text, kind, ttlMs) {
  const el = document.getElementById('pvpNotice');
  el.textContent = text || '';
  el.className = kind === 'info' ? 'pvp-info' : 'check-text';
  clearTimeout(noticeTimer);
  if (ttlMs) noticeTimer = setTimeout(() => { el.textContent = ''; }, ttlMs);
}

function showSpectators(info) {
  const el = document.getElementById('watchInfo');
  const n = (info && info.count) || 0;
  el.textContent = n ? '👁 ' + n + (n === 1 ? ' spectator' : ' spectators') : '';
  el.style.display = n ? '' : 'none';
}

// As on the game page: players and spectators have separate conversations,
// kept apart by the server; this only labels which one you are in. A
// player's line is coloured by their team ('w' Red and Yellow, 'b' Blue and
// Green, as the server stores it).
function chatLine(m) {
  const line = document.createElement('div');
  line.className = 'chat-msg chat-' + (m.role || 's');
  const who = document.createElement('span');
  who.className = 'chat-who';
  who.textContent = m.username;
  if (m.member) who.appendChild(memberBadge());
  who.appendChild(document.createTextNode(':'));
  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = ' ' + m.text;
  line.append(who, text);
  return line;
}
function setChatHistory(msgs) {
  const log = document.getElementById('chatLog');
  log.innerHTML = '';
  for (const m of msgs || []) log.appendChild(chatLine(m));
  log.scrollTop = log.scrollHeight;
}
function appendChat(m) {
  const log = document.getElementById('chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.appendChild(chatLine(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
  const mine = window.currentUser && m.userId === window.currentUser.id;
  if (!mine && typeof ChatToast !== 'undefined') ChatToast.show(m);
}
function initChat() {
  document.getElementById('chatTitle').textContent = spectating ? 'Spectator chat' : 'Chat';
  document.getElementById('chatAudience').textContent = spectating
    ? 'Other spectators only — the players cannot see this.'
    : 'All four players — spectators cannot see this.';
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const errEl = document.getElementById('chatError');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('chat:send', { gameId, text }, (resp) => {
      if (resp && resp.ok) return;
      errEl.textContent = (resp && resp.error) || 'Message not sent.';
      setTimeout(() => { errEl.textContent = ''; }, 3000);
      if (!input.value) input.value = text;
    });
  });
  socket.on('chat:message', appendChat);
}

// ---- the game, from the server ----

function applyState(state) {
  me = spectating ? null : state.yourColor;
  seats = state.seats;
  // Replayed from the moves, so the engine has the repetition counts a FEN
  // can't carry; the FEN only if the record won't replay.
  game = new FourPlayer();
  if (state.startFen) game.loadFen(state.startFen);
  lastMove = null;
  for (const text of state.moves) {
    const mv = game.moveFromText(text);
    if (!mv) {
      game.loadFen(state.fen);
      lastMove = null;
      break;
    }
    game.makeMove(mv);
    lastMove = mv;
  }
  sans = state.sans.slice();
  result = state.status !== 'active' ? { result: state.result || '*', termination: state.termination || null } : null;
  anim = null;
  clearSelection();
  promoEl.classList.remove('show');
  document.getElementById('tcLine').textContent = `${state.timeControl} · casual · ${variantLabel(state.variant)}`;
  document.getElementById('teams').textContent = me
    ? `You play ${NAMES[me]}, with ${NAMES[FourPlayer.partnerOf(me)]}: ${teamOf(me)}.`
    : 'Red & Yellow against Blue & Green.';
  document.getElementById('resignBtn').disabled = false;
  setChatHistory(state.chat);
  showSpectators({ count: state.spectators });
  setClocks(state.clocks, state.running);
  render();
}

function rejoin() {
  if (!socket) return;
  socket.emit(spectating ? 'game:watch' : 'game:join', { gameId }, (resp) => {
    if (!resp || !resp.ok) {
      // A player who opened the watch link gets sent to their seat.
      if (resp && resp.player) { location.replace('/four.html?id=' + gameId); return; }
      statusEl.textContent = (resp && resp.error) || 'Cannot open this game.';
      statusEl.className = 'check-text';
      return;
    }
    applyState(resp.state);
    if (spectating) notice('You are watching this game.', 'info');
  });
}

function start() {
  if (!Number.isInteger(gameId)) {
    statusEl.textContent = 'No game given.';
    return;
  }
  statusEl.textContent = 'Connecting…';
  socket = connectSocket({
    onError: (err) => notice('Connection error: ' + err.message),
    onDisconnect: () => { if (!result) notice('Disconnected — reconnecting…'); },
  });
  // (Re)join on every (re)connect: the reply carries the whole game.
  socket.on('connect', () => {
    notice('');
    rejoin();
  });
  socket.on('clock:started', (info) => {
    setClocks(info.clocks, true);
    render();   // the turn line stops waiting for players
  });
  socket.on('move:made', (m) => {
    applyServerMove(m);
    setClocks(m.clocks, true);
  });
  socket.on('game:over', (info) => {
    result = { result: info.result, termination: info.termination };
    promoEl.classList.remove('show');
    clearSelection();
    if (info.clocks) setClocks(info.clocks, false);
    outcomeSound(info.result);
    render();
  });
  const seatName = (c) => (me && c === FourPlayer.partnerOf(me) ? 'Your partner' : NAMES[c] || 'A player');
  socket.on('opponent:disconnected', (info) => {
    const secs = Math.round((info.graceMs || 0) / 1000);
    notice(`${seatName(info.color)} disconnected — ${secs}s to reconnect…`);
  });
  socket.on('opponent:reconnected', (info) => notice(`${seatName(info && info.color)} reconnected.`, 'info', 3000));
  socket.on('spectators', showSpectators);
  socket.on('lobby:error', (info) => notice((info && info.error) || 'Request refused.'));
  socket.on('achievements:earned', (info) => {
    if (info && typeof AchievementToast !== 'undefined') AchievementToast.show(info.list);
  });
  // A player on this page who opens another game elsewhere goes there.
  socket.on('game:start', (info) => {
    if (info && info.gameId && info.gameId !== gameId) location.href = '/game.html?id=' + info.gameId;
  });
  document.getElementById('resignBtn').addEventListener('click', () => {
    if (result || !window.confirm('Resign? Your team loses the game.')) return;
    socket.emit('game:resign', { gameId });
  });
  initChat();
}

start();
