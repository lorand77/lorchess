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
let whiteName = "White";
let blackName = "Black";
let variant = "standard";
let isMember = false; // game review is a membership perk
let review = null;   // GameReview summary once the analysis finishes
let reviewJob = null; // the running job, so it can be cancelled

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

  variant = game.variant || "standard";
  chess.setVariant(variant === "atomic" ? "atomic" : "standard");
  startFen = game.start_fen || STANDARD_START;
  uciList = game.moves.map((m) => m.uci);
  sanList = game.moves.map((m) => m.san);
  flip = game.white_id !== me.id; // you play the non-white side -> flip

  isMember = !!me.member_since;
  whiteName = game.white_username || "White";
  blackName = game.black_username || "Black";
  titleEl.textContent = game.mode === "ai" ? "vs LorFish" : "PvP game";
  metaEl.textContent =
    `White: ${game.white_username}  ·  Black: ${game.black_username}  ·  ${fmtDate(game.created_at)}`;
  statusEl.textContent = outcomeText(game);
  statusEl.className = "game-over";

  buildMoveList();
  wireControls();
  wireReview();
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
  renderMoveVerdict();
}

function findUci(uci) {
  const from = sqOf(uci.slice(0, 2));
  const to = sqOf(uci.slice(2, 4));
  const promo = uci[4] || null;
  return chess.findMove(from, to, promo);
}

function pieceImgSrc(p) {
  if (window.Theme) return Theme.pieceSrc(p.c, p.t);
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

      if (col === 0) {
        const c = document.createElement("div");
        c.className = "coord rank";
        c.textContent = r + 1;
        div.appendChild(c);
      }
      if (row === 7) {
        const c = document.createElement("div");
        c.className = "coord file";
        c.textContent = String.fromCharCode(97 + f);
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
  // Review verdicts are keyed by ply (1-based), so the move list can be rebuilt
  // with annotations once the analysis lands.
  const byPly = new Map((review ? review.moves : []).map((m) => [m.ply, m]));
  let html = "";
  for (let k = 0; k < sanList.length; k++) {
    if (k % 2 === 0) html += `<span class="mv-num">${k / 2 + 1}.</span> `;
    const verdict = byPly.get(k + 1);
    const cls = verdict && verdict.symbol ? " mv-" + verdict.kind : "";
    const mark = verdict && verdict.symbol ? verdict.symbol : "";
    html += `<span class="mv${cls}" data-ply="${k + 1}">${escapeHtml(sanList[k])}${mark}</span> `;
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

// Redraw once custom pieces / colours arrive from the server.
window.addEventListener("theme:changed", () => { if (typeof renderBoard === "function" && typeof chess !== "undefined") renderBoard(); });

// ---- game review ----
// LorFish evaluates every position of the game in the engine worker. The result
// annotates the move list, summarises each side's play, and — when you step to a
// move — says what the engine would have played instead.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wireReview() {
  const panel = document.getElementById("reviewPanel");
  if (!panel) return;
  // Nothing to review in an empty game.
  if (!uciList.length) {
    panel.style.display = "none";
    return;
  }
  // LorFish only knows standard chess. Reviewing an Atomic game with it would
  // produce confident nonsense, so don't offer it at all.
  if (variant === "atomic") {
    document.getElementById("reviewStart").innerHTML = "";
    document.getElementById("reviewStart").appendChild(
      Object.assign(document.createElement("span"), {
        className: "muted small",
        textContent: "LorFish plays standard chess, so it can't review an Atomic game.",
      })
    );
    return;
  }
  // Members only. This is a UI gate, not a security boundary — the analysis runs
  // in the browser against publicly served engine code, so it is a paywall in
  // the "please don't" sense rather than the "cannot" sense. Enforcing it
  // properly would mean moving the search server-side.
  if (!isMember) {
    showReviewUpsell();
    return;
  }
  document.getElementById("reviewBtn").addEventListener("click", startReview);
  document.getElementById("reviewCancel").addEventListener("click", cancelReview);
  // Arriving from the "Review this game" link on a finished game: start at once
  // rather than asking for the same click twice.
  if (params.get("review")) startReview();
}

function showReviewUpsell() {
  const start = document.getElementById("reviewStart");
  start.innerHTML = "";
  const note = document.createElement("span");
  note.className = "muted small";
  note.textContent = "Have LorFish go through this game move by move — a member feature. ";
  const link = document.createElement("a");
  link.className = "review-link";
  link.href = "/membership.html";
  link.textContent = "🎟 Get membership";
  start.append(note, link);
  start.classList.add("review-locked");
}

function startReview() {
  const startEl = document.getElementById("reviewStart");
  const progEl = document.getElementById("reviewProgress");
  const textEl = document.getElementById("reviewProgressText");
  const errEl = document.getElementById("reviewError");
  const depth = parseInt(document.getElementById("reviewDepth").value, 10) || 2;

  errEl.textContent = "";
  startEl.style.display = "none";
  progEl.style.display = "";
  textEl.textContent = "Analysing… 0%";

  reviewJob = GameReview.run({
    startFen: startFen === STANDARD_START ? null : startFen,
    uciMoves: uciList,
    depth,
    onProgress: ({ done, total }) => {
      textEl.textContent = `Analysing… ${Math.round((done / total) * 100)}% (${done}/${total})`;
    },
    onDone: (result) => {
      reviewJob = null;
      review = result;
      window.review = result; // exposed for debugging / tests
      progEl.style.display = "none";
      buildMoveList();   // repaint with the verdict symbols
      renderSummary();
      renderMoveVerdict();
      highlightMoveList();
    },
    onError: (err) => {
      reviewJob = null;
      progEl.style.display = "none";
      startEl.style.display = "";
      errEl.textContent = err.message || "Review failed.";
    },
  });
}

function cancelReview() {
  if (reviewJob) reviewJob.cancel();
  reviewJob = null;
  document.getElementById("reviewProgress").style.display = "none";
  document.getElementById("reviewStart").style.display = "";
}

function renderSummary() {
  const el = document.getElementById("reviewSummary");
  if (!review) return;
  const row = (name, s) => {
    if (!s.moves) return "";
    return `
      <div class="review-side">
        <div class="review-side-head">
          <span class="review-name">${escapeHtml(name)}</span>
          <span class="review-acc">${s.accuracy.toFixed(1)}%</span>
        </div>
        <div class="review-counts">
          <span class="rc rc-best">${s.best} best</span>
          <span class="rc rc-inaccuracy">${s.inaccuracy} inaccuracies</span>
          <span class="rc rc-mistake">${s.mistake} mistakes</span>
          <span class="rc rc-blunder">${s.blunder} blunders</span>
        </div>
        <div class="review-acpl">avg. loss ${Math.round(s.acpl)} centipawns</div>
      </div>`;
  };
  const d = review.depths;
  const depthNote = !d ? ""
    : d.min === d.max
      ? `Searched at depth ${d.max}.`
      : `Searched at depth ${d.min}–${d.max}, going deeper as pieces came off.`;
  el.innerHTML =
    row(whiteName, review.white) + row(blackName, review.black) +
    `<p class="review-note">${depthNote} Accuracy is measured against LorFish ` +
    `(about 1400–1800), so treat it as a guide rather than a verdict.</p>`;
  el.style.display = "";
}

// What the review says about the move that produced the position on screen.
function renderMoveVerdict() {
  const el = document.getElementById("reviewMove");
  if (!el) return;
  if (!review || idx === 0) {
    el.style.display = "none";
    return;
  }
  const m = review.moves.find((x) => x.ply === idx);
  if (!m) {
    el.style.display = "none";
    return;
  }
  const mover = m.mover === "w" ? "White" : "Black";
  const evalText = GameReview.formatScore(m.evalAfter, "w");
  let html = `<span class="verdict v-${m.kind}">${escapeHtml(m.label)}</span> ` +
    `<span class="muted">${mover} · eval ${escapeHtml(evalText)}` +
    (m.depth ? ` · depth ${m.depth}` : "") + `</span>`;
  if (m.kind !== "best" && m.best) {
    html += `<br><span class="muted">LorFish preferred <b>${escapeHtml(m.best.san)}</b>` +
      (m.loss > 0 ? ` (−${(m.loss / 100).toFixed(2)})` : "") + `</span>`;
  }
  el.innerHTML = html;
  el.style.display = "";
}
