"use strict";

// Read-only game replay. Loads a game (GET /api/games/:id), reconstructs each
// position by replaying the stored UCI moves into a Chess instance (which gives
// us captured pieces + last-move highlight for free), and lets the user step
// through with buttons, arrow keys, or by clicking a move.

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const CAPTURE_ORDER = ["p", "n", "b", "r", "q"];

const boardEl = document.getElementById("board");
const capTopEl = document.getElementById("capturedTop");
const capBottomEl = document.getElementById("capturedBottom");
const titleEl = document.getElementById("replayTitle");
const metaEl = document.getElementById("replayMeta");
const statusEl = document.getElementById("replayStatus");
const movesEl = document.getElementById("history");

const params = new URLSearchParams(location.search);
const gameId = parseInt(params.get("id"), 10);

const chess = new Chess();
let uciList = [];
let sanList = [];
let startFen = STANDARD_START;
let flip = false; // orient from the viewer's side
let idx = 0; // number of plies shown
let lastMove = null;

const sqOf = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;

init();

async function init() {
  if (!gameId) { fail("No game id."); return; }
  let me, game;
  try {
    const [meRes, gRes] = await Promise.all([
      fetch("/api/me", { credentials: "same-origin" }),
      fetch("/api/games/" + gameId, { credentials: "same-origin" }),
    ]);
    if (meRes.status === 401) { location.replace("/login.html"); return; }
    if (gRes.status === 404) { fail("Game not found."); return; }
    if (gRes.status === 403) { fail("That isn't your game."); return; }
    me = await meRes.json();
    game = await gRes.json();
  } catch (e) {
    fail("Failed to load game.");
    return;
  }

  startFen = game.start_fen || STANDARD_START;
  uciList = game.moves.map((m) => m.uci);
  sanList = game.moves.map((m) => m.san);
  flip = game.white_id !== me.id; // you play the non-white side -> flip

  titleEl.textContent = game.mode === "ai" ? "vs LorFish" : "PvP game";
  metaEl.textContent =
    `White: ${game.white_username}  ·  Black: ${game.black_username}  ·  ${fmtDate(game.created_at)}`;
  statusEl.textContent = outcomeText(game);
  statusEl.className = "game-over";

  buildMoveList();
  wireControls();
  goto(uciList.length); // open at the final position
}

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.className = "check-text";
}

// Rebuild the position after `i` plies and render.
function goto(i) {
  idx = Math.max(0, Math.min(uciList.length, i));
  chess.loadFen(startFen);
  lastMove = null;
  for (let k = 0; k < idx; k++) {
    const m = findUci(uciList[k]);
    if (!m) break;
    chess.makeMove(m);
    lastMove = m;
  }
  renderBoard();
  highlightMoveList();
}

function findUci(uci) {
  const from = sqOf(uci.slice(0, 2));
  const to = sqOf(uci.slice(2, 4));
  const promo = uci[4] || null;
  return chess
    .legalMoves()
    .find((m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo));
}

function pieceImgSrc(p) {
  return `assets/${p.c}_${PIECE_NAMES[p.t]}_1x_ns.png`;
}

function renderBoard() {
  boardEl.innerHTML = "";
  const inCheck = chess.inCheck();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const r = flip ? row : 7 - row;
      const f = flip ? 7 - col : col;
      const sq = sqIdx(f, r);
      const div = document.createElement("div");
      div.className = "square " + ((r + f) % 2 === 0 ? "dark" : "light");
      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add("last-move");
      const piece = chess.squares[sq];
      if (inCheck && piece && piece.t === "k" && piece.c === chess.turn) div.classList.add("check");

      const coordColor = (r + f) % 2 === 0 ? "#f0d9b5" : "#b58863";
      if (col === 0) {
        const c = document.createElement("div");
        c.className = "coord rank";
        c.textContent = r + 1;
        c.style.color = coordColor;
        div.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement("div");
        c.className = "coord file";
        c.textContent = String.fromCharCode(97 + f);
        c.style.color = coordColor;
        div.appendChild(c);
      }
      if (piece) {
        const img = document.createElement("img");
        img.src = pieceImgSrc(piece);
        if (piece.t === "p") img.classList.add("pawn");
        img.draggable = false;
        div.appendChild(img);
      }
      boardEl.appendChild(div);
    }
  }
  renderCaptured();
}

function renderCaptured() {
  const youColor = flip ? B : W; // bottom side
  const byWhite = [], byBlack = [];
  for (const h of chess.history) {
    if (!h.captured) continue;
    (h.captured.c === B ? byWhite : byBlack).push(h.captured);
  }
  const sortFn = (a, b) => CAPTURE_ORDER.indexOf(a.t) - CAPTURE_ORDER.indexOf(b.t);
  byWhite.sort(sortFn);
  byBlack.sort(sortFn);

  let wm = 0, bm = 0;
  for (const p of chess.squares) {
    if (!p) continue;
    if (p.c === W) wm += PIECE_VAL[p.t];
    else bm += PIECE_VAL[p.t];
  }
  const adv = wm - bm;
  const topColor = youColor === W ? B : W;
  const byTop = topColor === W ? byWhite : byBlack;
  const byBottom = youColor === W ? byWhite : byBlack;
  fillCaptured(capTopEl, byTop, topColor === W ? adv : -adv);
  fillCaptured(capBottomEl, byBottom, youColor === W ? adv : -adv);
}

function fillCaptured(el, pieces, adv) {
  el.innerHTML = "";
  const groups = {};
  for (const p of pieces) (groups[p.t] = groups[p.t] || []).push(p);
  for (const t of CAPTURE_ORDER) {
    if (!groups[t]) continue;
    const group = document.createElement("span");
    group.className = "cap-group";
    for (const p of groups[t]) {
      const img = document.createElement("img");
      img.src = pieceImgSrc(p);
      img.className = "cap-piece";
      img.draggable = false;
      group.appendChild(img);
    }
    el.appendChild(group);
  }
  if (adv > 0) {
    const badge = document.createElement("span");
    badge.className = "cap-adv";
    badge.textContent = "+" + adv;
    el.appendChild(badge);
  }
}

function buildMoveList() {
  movesEl.innerHTML = "";
  if (!sanList.length) {
    movesEl.innerHTML = '<span class="muted">No moves.</span>';
    return;
  }
  let html = "";
  for (let k = 0; k < sanList.length; k++) {
    if (k % 2 === 0) html += `<span class="mv-num">${k / 2 + 1}.</span> `;
    html += `<span class="mv" data-ply="${k + 1}">${sanList[k]}</span> `;
  }
  movesEl.innerHTML = html;
  movesEl.querySelectorAll(".mv").forEach((el) => {
    el.addEventListener("click", () => goto(parseInt(el.dataset.ply, 10)));
  });
}

function highlightMoveList() {
  movesEl.querySelectorAll(".mv").forEach((el) => {
    el.classList.toggle("current", parseInt(el.dataset.ply, 10) === idx);
  });
  const cur = movesEl.querySelector(".mv.current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function wireControls() {
  document.getElementById("firstBtn").onclick = () => goto(0);
  document.getElementById("prevBtn").onclick = () => goto(idx - 1);
  document.getElementById("nextBtn").onclick = () => goto(idx + 1);
  document.getElementById("lastBtn").onclick = () => goto(uciList.length);
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") goto(idx - 1);
    else if (e.key === "ArrowRight") goto(idx + 1);
    else if (e.key === "Home") goto(0);
    else if (e.key === "End") goto(uciList.length);
    else return;
    e.preventDefault();
  });
}

function outcomeText(g) {
  if (g.status === "active") return "In progress";
  if (g.status === "aborted") return "Aborted" + (g.termination ? ` (${g.termination})` : "");
  if (g.result === "1/2-1/2") return "Draw" + (g.termination ? ` (${g.termination})` : "");
  const whiteWon = g.result === "1-0";
  return `${whiteWon ? "White" : "Black"} wins` + (g.termination ? ` by ${g.termination}` : "");
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? s : d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
