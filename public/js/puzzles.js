"use strict";

// Puzzle trainer. Two modes on one page:
//   /puzzles.html         rated stream, picked near your puzzle rating
//   /puzzles.html?daily   the shared puzzle of the day (+ streak)
// The server keeps the solution; we send the moves played so far and it tells
// us whether we're still on track, replying with the opponent's answer.

(function () {
  const daily = new URLSearchParams(location.search).has("daily");
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), promoEl = $("promo"), promoOpts = $("promoOptions");
  const headEl = $("puzzleHead"), taskEl = $("taskLine"), statusEl = $("statusLine");
  const resultEl = $("result"), navEl = $("modeNav");
  const btn = { giveUp: $("giveUpBtn"), retry: $("retryBtn"), solution: $("solutionBtn"), next: $("nextBtn") };

  const chess = new Chess();
  let puzzle = null;      // { id, fen, firstMove, playerColor }
  let dailyInfo = null;   // the /daily payload (streak, done, …)
  let me = { rating: null, streak: 0 };
  let moves = [];         // player's moves so far (UCI)
  let phase = "idle";     // idle | intro | playing | waiting | solved | failed | replay
  let selected = null, legal = [], lastMove = null, wrongSq = null;
  let pendingPromo = null;
  let timers = [];

  // ---- helpers ----
  const alg = (sq) => String.fromCharCode(97 + (sq & 7)) + ((sq >> 3) + 1);
  const uciOf = (m) => alg(m.from) + alg(m.to) + (m.promo || "");
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const colorName = (c) => (c === "w" ? "White" : "Black");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function findMove(uci) {
    return chess.legalMoves().find((m) => uciOf(m) === uci) || null;
  }
  function play(uci) {
    const m = findMove(uci);
    if (!m) throw new Error("Illegal move " + uci);
    chess.makeMove(m);
    lastMove = m;
    return m;
  }

  async function api(method, path, body) {
    const res = await fetch("/api/puzzles" + path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.replace("/login.html"); throw new Error("Not logged in."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  // ---- board ----
  function render() {
    boardEl.innerHTML = "";
    const flip = puzzle && puzzle.playerColor === "b";
    const inCheck = chess.inCheck();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = flip ? row : 7 - row;
        const f = flip ? 7 - col : col;
        const sq = sqIdx(f, r);
        const div = el("div", "square " + ((r + f) % 2 === 0 ? "dark" : "light"));
        if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add("last-move");
        if (selected === sq) div.classList.add("selected");
        if (wrongSq === sq) div.classList.add("wrong");
        const piece = chess.squares[sq];
        if (inCheck && piece && piece.t === "k" && piece.c === chess.turn) div.classList.add("check");
        if (col === 0) div.appendChild(el("div", "coord rank", String(r + 1)));
        if (row === 7) div.appendChild(el("div", "coord file", String.fromCharCode(97 + f)));
        if (piece) {
          const img = document.createElement("img");
          img.src = Theme.pieceSrc(piece.c, piece.t);
          img.className = "piece" + (piece.t === "p" ? " pawn" : "");
          img.draggable = false;
          img.alt = "";
          div.appendChild(img);
        }
        if (selected !== null) {
          const m = legal.find((x) => x.to === sq);
          if (m) {
            const hint = el("div", "hint");
            if (chess.squares[sq] || m.enpassant) hint.classList.add("capture");
            div.appendChild(hint);
          }
        }
        div.addEventListener("click", () => onSquareClick(sq));
        boardEl.appendChild(div);
      }
    }
  }
  window.addEventListener("theme:changed", render);

  function onSquareClick(sq) {
    if (phase !== "playing" || chess.turn !== puzzle.playerColor) return;
    const piece = chess.squares[sq];
    if (selected !== null) {
      const cands = legal.filter((m) => m.to === sq);
      if (cands.length) {
        selected = null; legal = [];
        if (cands.length > 1 && cands[0].promo) return askPromotion(cands);
        return submit(cands[0]);
      }
    }
    if (piece && piece.c === puzzle.playerColor) {
      selected = sq;
      legal = chess.legalMoves().filter((m) => m.from === sq);
    } else {
      selected = null; legal = [];
    }
    render();
  }

  function askPromotion(cands) {
    pendingPromo = cands;
    promoOpts.innerHTML = "";
    for (const t of ["q", "r", "b", "n"]) {
      const opt = el("div", "opt");
      const img = document.createElement("img");
      img.src = Theme.pieceSrc(puzzle.playerColor, t);
      opt.appendChild(img);
      opt.addEventListener("click", () => {
        promoEl.classList.remove("show");
        const m = pendingPromo.find((x) => x.promo === t);
        pendingPromo = null;
        if (m) submit(m);
      });
      promoOpts.appendChild(opt);
    }
    promoEl.classList.add("show");
    render();
  }

  // ---- flow ----
  function setStatus(text, cls) {
    statusEl.textContent = text || "";
    statusEl.className = "puzzle-status " + (cls || "");
  }
  function showButtons(list) {
    for (const k of Object.keys(btn)) btn[k].style.display = list.includes(k) ? "" : "none";
  }
  function setTask() {
    taskEl.innerHTML = "";
    if (!puzzle) return;
    taskEl.appendChild(el("span", "dot " + puzzle.playerColor));
    taskEl.appendChild(document.createTextNode("Find the best move for " + colorName(puzzle.playerColor) + "."));
  }

  function renderHead() {
    headEl.innerHTML = "";
    if (daily) {
      headEl.appendChild(el("span", "big", dailyInfo ? dailyInfo.date : ""));
      const s = dailyInfo ? dailyInfo.streak : me.streak;
      headEl.appendChild(el("span", "streak", s > 0 ? "🔥 " + s + "-day streak" : "No streak yet"));
      headEl.appendChild(el("span", "muted small", "Puzzle rating " + me.rating));
    } else {
      headEl.appendChild(el("span", "muted small", "Your puzzle rating"));
      headEl.appendChild(el("span", "big", String(me.rating)));
    }
    navEl.innerHTML = "";
    const a = el("a", "", daily ? "🧩 Rated puzzles →" : "📅 Today's daily puzzle →");
    a.href = daily ? "/puzzles.html" : "/puzzles.html?daily";
    navEl.appendChild(a);
  }

  // Start (or restart) the current puzzle from its stored position.
  function begin() {
    clearTimers();
    chess.loadFen(puzzle.fen);
    moves = []; selected = null; legal = []; lastMove = null; wrongSq = null;
    promoEl.classList.remove("show");
    resultEl.style.display = "none";
    phase = "intro";
    setTask();
    setStatus(colorName(puzzle.playerColor === "w" ? "b" : "w") + " just played…", "info");
    showButtons([]);
    render();
    later(() => {
      play(puzzle.firstMove);
      phase = "playing";
      setStatus("Your move.", "");
      showButtons(["giveUp"]);
      render();
    }, 700);
  }

  async function submit(move) {
    chess.makeMove(move);
    lastMove = move;
    moves.push(uciOf(move));
    phase = "waiting";
    render();
    let resp;
    try {
      resp = await api("POST", "/" + puzzle.id + "/moves", { moves });
    } catch (err) {
      chess.undoMove(); moves.pop(); phase = "playing";
      setStatus(err.message, "bad"); render();
      return;
    }
    if (resp.status === "ok") {
      setStatus("Correct! Keep going.", "ok");
      later(() => {
        if (resp.reply) play(resp.reply);
        phase = "playing";
        setStatus("Your move.", "");
        render();
      }, 450);
    } else if (resp.status === "solved") {
      phase = "solved";
      setStatus("Solved! ✓", "ok");
      finish(resp, true);
    } else {
      phase = "failed";
      wrongSq = move.to;
      setStatus("That's not it.", "bad");
      finish(resp, false);
    }
    render();
  }

  function finish(resp, solved) {
    showButtons(solved ? ["next"] : ["retry", "solution", "next"]);
    if (daily) {
      btn.next.style.display = "none";
      if (dailyInfo) { dailyInfo.done = true; dailyInfo.solved = solved; }
    }
    if (typeof resp.streak === "number") { me.streak = resp.streak; if (dailyInfo) dailyInfo.streak = resp.streak; }
    if (resp.rating) me.rating = resp.rating.after;
    renderHead();
    showResult(resp, solved);
    puzzle.solution = resp.solution;
  }

  function showResult(resp, solved) {
    resultEl.innerHTML = "";
    resultEl.style.display = "";
    const line = el("div");
    line.appendChild(document.createTextNode((solved ? "Solved. " : "Failed. ") + "Puzzle rating " + resp.puzzleRating + ". "));
    if (resp.rating) {
      const d = resp.rating.delta;
      line.appendChild(document.createTextNode("Your rating " + resp.rating.before + " → " + resp.rating.after + " ("));
      line.appendChild(el("span", "delta " + (d >= 0 ? "up" : "down"), (d >= 0 ? "+" : "") + d));
      line.appendChild(document.createTextNode(")"));
    } else {
      line.appendChild(el("span", "muted", "Not rated: you had already attempted this one."));
    }
    resultEl.appendChild(line);
    if (daily && typeof resp.streak === "number") {
      resultEl.appendChild(el("div", "streak", "🔥 Daily streak: " + resp.streak + (resp.streak === 1 ? " day" : " days")));
    }
    if (resp.themes && resp.themes.length) {
      const t = el("div", "themes");
      for (const th of resp.themes) t.appendChild(el("span", "tag", th));
      resultEl.appendChild(t);
    }
    if (resp.gameUrl) {
      const p = el("div");
      const a = el("a", "nav-link", "From a real game on Lichess ↗");
      a.href = resp.gameUrl; a.target = "_blank"; a.rel = "noopener";
      p.appendChild(a);
      resultEl.appendChild(p);
    }
  }

  // Play the stored solution through on the board. `label` prefixes the status
  // so the reason (gave up / asked) stays visible while it plays.
  function replaySolution(solution, label) {
    clearTimers();
    chess.loadFen(puzzle.fen);
    play(puzzle.firstMove);
    wrongSq = null; selected = null; legal = [];
    phase = "replay";
    showButtons(daily ? ["retry"] : ["retry", "next"]);
    const prefix = label ? label + " " : "";
    setStatus(prefix + "Solution…", "info");
    render();
    solution.forEach((uci, i) => later(() => {
      play(uci);
      render();
      if (i === solution.length - 1) setStatus(prefix + "That was the solution.", "info");
    }, 600 * (i + 1)));
  }

  // ---- loading ----
  async function loadRated() {
    let data;
    try { data = await api("GET", "/next"); }
    catch (err) { return setStatus(err.message, "bad"); }
    puzzle = data.puzzle;
    me.rating = data.rating;
    renderHead();
    begin();
    if (data.repeat) later(() => setStatus("You've seen every puzzle near your rating — this one is a repeat (unrated).", "info"), 750);
  }

  async function loadDaily() {
    let data;
    try { data = await api("GET", "/daily"); }
    catch (err) { return setStatus(err.message, "bad"); }
    dailyInfo = data;
    puzzle = data.puzzle;
    me.rating = data.rating; me.streak = data.streak;
    renderHead();
    if (!data.done) return begin();
    // Already done today: show the outcome and let them replay it unrated.
    clearTimers();
    chess.loadFen(puzzle.fen); play(puzzle.firstMove);
    moves = []; selected = null; legal = []; wrongSq = null;
    phase = "idle";
    setTask();
    setStatus(data.solved ? "You solved today's puzzle. ✓" : "You attempted today's puzzle.", data.solved ? "ok" : "info");
    puzzle.solution = data.solution;
    showResult({ ...data, rating: null, puzzleRating: data.puzzleRating }, data.solved);
    resultEl.querySelector(".muted") && (resultEl.querySelector(".muted").textContent = "Come back tomorrow for a new one.");
    showButtons(["retry", "solution"]);
    render();
  }

  btn.giveUp.addEventListener("click", async () => {
    if (phase !== "playing") return;
    phase = "waiting";
    try {
      const resp = await api("POST", "/" + puzzle.id + "/giveup");
      phase = "failed";
      finish(resp, false);
      replaySolution(resp.solution, "Gave up.");
    } catch (err) { phase = "playing"; setStatus(err.message, "bad"); }
  });
  btn.retry.addEventListener("click", () => { resultEl.style.display = "none"; begin(); later(() => setStatus("Your move (unrated retry).", ""), 750); });
  btn.solution.addEventListener("click", () => { if (puzzle.solution) replaySolution(puzzle.solution); });
  btn.next.addEventListener("click", () => { if (!daily) loadRated(); });

  $("pageTitle").textContent = daily ? "Daily puzzle" : "Puzzles";
  document.title = "LorChess — " + (daily ? "Daily puzzle" : "Puzzles");
  render();
  if (daily) loadDaily(); else loadRated();
})();
