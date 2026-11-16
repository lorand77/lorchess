'use strict';

// Read-only replay of a four-player game, Teams or free-for-all. Loads the
// game (GET /api/games/:id, with its `seats`), replays its stored moves into
// a FourPlayer engine from the start position, and steps through them with
// the buttons, the arrow keys or a click on a move. In free-for-all the
// record holds the players leaving too ("resign:b"), each a step; the plates
// show the points as they stood, a player out greyed with their army, the
// move list names each move's player, and the result is the placings. A page of its own for the
// reason four.html is: replay.js is for two players (names, captured
// material, the Stockfish review), and replay.html sends a four-player game
// here. The board view and the corner plates are the game page's; there are
// no clocks (only the last time each player had is stored) and no review
// (Stockfish plays two-player chess).
//
// The board is seen from your seat if you played, else from the seat of the
// player whose profile you came from (`as`), else from Red's.
//
//   fourReplay.html?id=<game>[&as=<user>]

const NAMES = FourPlayer.NAMES;
const TEAM_NAMES = ['Red & Yellow', 'Blue & Green'];
// How a game ended, where the board can't say: a mate or a king taken is read
// from the final position instead (fourGame.js does the same for a mate).
const ENDINGS = {
  resign: 'by resignation', timeout: 'on time', disconnect: 'a player left',
  stalemate: 'stalemate', insufficient: 'insufficient material',
  threefold: 'threefold repetition', 'fifty-move': 'the fifty-move rule',
};
// A free-for-all game's ending: its last player out, a claim, or a draw.
const FFA_ENDINGS = {
  checkmate: 'the last player checkmated', stalemate: 'the last player stalemated',
  'king captured': 'the last king taken', resign: 'the last player resigned',
  timeout: 'the last player out of time', disconnect: 'the last player left',
  threefold: 'threefold repetition', 'fifty-move': 'the fifty-move rule', insufficient: 'bare kings',
};
const OUT_WORDS = {
  checkmate: 'checkmated', stalemate: 'stalemated', 'king captured': 'king taken', resign: 'resigned',
  timeout: 'out of time', disconnect: 'left', claim: 'claimed the win', out: 'out',
};

const params = new URLSearchParams(location.search);
const gameId = parseInt(params.get('id'), 10);
const asId = parseInt(params.get('as'), 10) || null;

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('replayStatus');
const movesEl = document.getElementById('history');

const view = FourBoardView.create(boardEl, {
  pieceSrc: (p) => Theme.pieceSrc(p.c, p.t),
  // Right-button drags draw arrows (boardArrows.js); no browser menu.
  onContextMenu: (e) => e.preventDefault(),
  canDrag: () => false,
});

let game = new FourPlayer();
let ffa = false;       // a free-for-all game
let startFen = null;
let moves = [];        // the stored moves' text ("e2e4"), in order
let sans = [];
let movers = [];       // free-for-all: each step's player, null for a player leaving
let seats = null;      // { r: { id, username, bot }, ... }
let mine = null;       // your colour, if you played
let bottom = 'r';
let idx = 0;           // plies shown
let lastMove = null;

init();

async function init() {
  if (!Number.isInteger(gameId)) return fail('No game id.');
  let me, record;
  try {
    const [meRes, gRes] = await Promise.all([
      fetch('/api/me', { credentials: 'same-origin' }),
      fetch('/api/games/' + gameId, { credentials: 'same-origin' }),
    ]);
    if (meRes.status === 401) { location.replace('/login.html'); return; }
    if (gRes.status === 404) return fail('Game not found.');
    if (gRes.status === 403) return fail((await gRes.json()).error || "You can't open that game.");
    me = await meRes.json();
    record = await gRes.json();
  } catch (e) {
    return fail('Failed to load game.');
  }
  // Not a four-player game after all: the ordinary replay.
  if (!isFourPlayer(record.variant)) { location.replace('/replay.html' + location.search); return; }

  ffa = isFreeForAll(record.variant);
  seats = record.seats;
  startFen = record.start_fen;
  moves = record.moves.map((m) => m.uci);
  sans = record.moves.map((m) => m.san);
  const seatOf = (id) => FourPlayer.COLORS.find((c) => seats[c].id === id) || null;
  mine = seatOf(me.id);
  const theirs = asId ? seatOf(asId) : null;
  bottom = mine || theirs || 'r';
  if (!mine && theirs) backTo(asId, seats[theirs].username);

  document.getElementById('replayMeta').textContent =
    `${describeTimeControl(record.initial_ms, record.increment_ms)} · casual · ${fmtDate(record.created_at)}`;
  document.getElementById('replayTitle').textContent = variantLabel(record.variant) + ' · replay';
  document.getElementById('teams').textContent = ffa
    ? (mine ? `You played ${NAMES[mine]}. ` : '') + 'Everyone for themselves: the most points wins.'
    : mine ? `You played ${NAMES[mine]}, with ${NAMES[FourPlayer.partnerOf(mine)]}: ${TEAM_NAMES[FourPlayer.teamOf(mine)]}.`
      : 'Red & Yellow against Blue & Green.';

  goto(moves.length);
  movers = game.history.map((h) => (h.move ? h.turn : null));
  buildMoveList();
  wireControls();
  goto(moves.length);   // open at the final position
  statusEl.textContent = outcomeText(record);
  statusEl.className = record.status === 'active' ? '' : 'game-over';
}

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.className = 'check-text';
}

// Came from someone else's profile: the back link returns to their games.
function backTo(userId, username) {
  const a = document.getElementById('backLink');
  a.href = '/profile.html?id=' + encodeURIComponent(userId) + '#games';
  a.textContent = '← ' + username + "'s games";
}

// The position after `i` plies, replayed from the start (the engine keeps the
// history a FEN can't), and drawn. A move that won't replay ends the record.
function goto(i) {
  idx = Math.max(0, Math.min(moves.length, i));
  game = new FourPlayer(ffa ? 'ffa' : 'teams');
  if (startFen) game.loadFen(startFen);
  lastMove = null;
  for (let k = 0; k < idx; k++) {
    if (!game.playText(moves[k])) break;
    const h = game.history[game.history.length - 1];
    if (h.move) lastMove = h.move;
  }
  render();
}

function checked() {
  return FourPlayer.COLORS.filter((c) => game.kingOf(c) !== -1 && game.inCheck(c));
}

function render() {
  view.render({
    pieces: game.squares,
    bottom,
    lastMove,
    selected: null,
    check: new Set(checked().map((c) => game.kingOf(c))),
    hints: new Map(),
    animation: null,
    dead: new Set(FourPlayer.COLORS.filter((c) => game.out[c])),
  });
  renderPlates();
  highlightMoveList();
}

// The four colours from the bottom, clockwise, and the corner each plate
// takes, as on the game page.
function around() {
  const order = [bottom];
  for (let i = 0; i < 3; i++) order.push(FourPlayer.nextColor(order[i]));
  return [[order[0], 'br'], [order[1], 'bl'], [order[2], 'tl'], [order[3], 'tr']];
}

function renderPlates() {
  for (const [c, corner] of around()) {
    const plate = document.getElementById('plate-' + corner);
    plate.innerHTML = '';
    plate.dataset.color = c;
    plate.style.setProperty('--seat', FourBoardView.COLOURS[c]);
    plate.classList.toggle('to-move', !game.isGameOver() && game.turn === c);
    const who = document.createElement('div');
    who.className = 'four-who';
    const dot = document.createElement('span');
    dot.className = 'four-dot';
    dot.title = NAMES[c];
    who.appendChild(dot);
    const s = seats[c];
    // LorFish has no profile to link to.
    who.appendChild(s.bot ? document.createTextNode(s.username) : playerLink(s.id, s.username));
    if (c === mine) who.appendChild(document.createTextNode(' (you)'));
    else if (!ffa && mine && c === FourPlayer.partnerOf(mine)) who.appendChild(document.createTextNode(' (partner)'));
    plate.appendChild(who);
    // Free-for-all: the points as they stood, and a player out greyed.
    plate.classList.toggle('out', ffa && !!game.out[c]);
    if (ffa) {
      const score = document.createElement('div');
      score.className = 'four-points';
      score.dataset.points = c;
      const n = game.points[c];
      score.textContent = n + (n === 1 ? ' pt' : ' pts') + (game.out[c] ? ' · ' + OUT_WORDS[game.out[c].how || 'out'] : '');
      plate.appendChild(score);
    }
  }
}

// One line a round, Red's move first, as on the game page; each move a link
// to the position after it.
function buildMoveList() {
  movesEl.innerHTML = '';
  if (!sans.length) {
    movesEl.innerHTML = '<span class="muted">No moves.</span>';
    return;
  }
  // Free-for-all: a line a step, each move with its player, as on the game
  // page (turns skip whoever is out, so there are no rounds).
  if (ffa) {
    sans.forEach((san, k) => {
      const line = document.createElement('div');
      line.appendChild(document.createTextNode(`${k + 1}. ` + (movers[k] ? NAMES[movers[k]] + ': ' : '')));
      const mv = document.createElement('span');
      mv.className = 'mv';
      mv.dataset.ply = k + 1;
      mv.textContent = san;
      mv.addEventListener('click', () => goto(k + 1));
      line.appendChild(mv);
      movesEl.appendChild(line);
    });
    return;
  }
  for (let i = 0; i < sans.length; i += 4) {
    const line = document.createElement('div');
    line.appendChild(document.createTextNode(`${i / 4 + 1}. `));
    for (let k = i; k < Math.min(i + 4, sans.length); k++) {
      const mv = document.createElement('span');
      mv.className = 'mv';
      mv.dataset.ply = k + 1;
      mv.textContent = sans[k];
      mv.addEventListener('click', () => goto(k + 1));
      line.append(mv, ' ');
    }
    movesEl.appendChild(line);
  }
}

function highlightMoveList() {
  movesEl.querySelectorAll('.mv').forEach((el) => {
    el.classList.toggle('current', Number(el.dataset.ply) === idx);
  });
  const cur = movesEl.querySelector('.mv.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function wireControls() {
  document.getElementById('firstBtn').onclick = () => goto(0);
  document.getElementById('prevBtn').onclick = () => goto(idx - 1);
  document.getElementById('nextBtn').onclick = () => goto(idx + 1);
  document.getElementById('lastBtn').onclick = () => goto(moves.length);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') goto(idx - 1);
    else if (e.key === 'ArrowRight') goto(idx + 1);
    else if (e.key === 'Home') goto(0);
    else if (e.key === 'End') goto(moves.length);
    else return;
    e.preventDefault();
  });
}

// The result, read with the final position on the board: the winning team,
// and how — the mated colour, the king taken, or the stored termination.
function outcomeText(g) {
  if (g.status === 'active') return 'In progress';
  if (g.status === 'aborted') return 'Aborted';
  if (ffa) return ffaOutcome(g);
  const how = game.isCheckmate() ? `${NAMES[game.turn]} is checkmated`
    : game.kingTaken() ? `${NAMES[game.kingTaken()]}'s king is taken`
      : ENDINGS[g.termination] || g.termination;
  const text = g.result === '1-0' ? `${TEAM_NAMES[0]} win` : g.result === '0-1' ? `${TEAM_NAMES[1]} win` : 'Draw';
  const yours = mine && g.result !== '1/2-1/2'
    ? ((g.result === '1-0') === (FourPlayer.teamOf(mine) === 0) ? ' · your team won' : ' · your team lost')
    : '';
  return text + (how ? ' — ' + how : '') + yours;
}

// A free-for-all game's placings, read from the final position (the
// engine's points), and how it ended.
function ffaOutcome(g) {
  const places = game.standings().sort((a, b) => a.place - b.place);
  const claimer = FourPlayer.COLORS.find((c) => game.out[c] && game.out[c].how === 'claim');
  const how = g.termination === 'claim' && claimer ? `${NAMES[claimer]} claimed the win`
    : FFA_ENDINGS[g.termination] || g.termination;
  let text = places.map((s) => `${FourPlayer.placeText(s.place)} ${NAMES[s.color]} ${s.points}`).join(' · ');
  if (how) text += ' — ' + how;
  const yours = mine && places.find((s) => s.color === mine);
  if (yours) text += ` · you finished ${FourPlayer.placeText(yours.place)}`;
  return text;
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? s : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Redraw once custom pieces / colours arrive from the server.
window.addEventListener('theme:changed', () => { if (seats) render(); });
