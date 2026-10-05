"use strict";

// Analysis board: a board where either side can be moved freely, with
// Stockfish's evaluation of whatever position is on it. Nothing is saved and
// the server is never asked about a move; the page's own Chess decides what is
// legal, and LiveEval (liveEval.js) keeps the engine on the position shown.
//
// The line is a single list of moves. Stepping back and playing something else
// replaces the moves after it; playing the move that was already next just
// steps forward. The start position and the moves live in the URL
// (?fen=…&moves=e2e4,e7e5), so a refresh or a shared link reopens the same
// board. Moves are spelled as the engine and the game records spell them,
// castling by the rook square.

(function () {
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board"), promoEl = $("promo"), promoOpts = $("promoOptions");
  const historyEl = $("history"), statusEl = $("positionStatus");
  const barEl = $("evalBar"), numberEl = $("evalNumber");
  const depthEl = $("engineDepth"), lineEl = $("engineLine"), engineErrEl = $("engineError");
  const toggleEl = $("engineToggle"), fenOutEl = $("fenOut");
  const fenPanel = $("fenPanel"), fenText = $("fenText"), fenError = $("fenError");

  // Remembers whether the engine was switched off, across visits.
  const ENGINE_KEY = "lorchess.analysisEngine";
  // How much of the engine's line to spell out under the bar.
  const PV_SHOWN = 10;

  const chess = new Chess();
  let startFen = STANDARD_START;
  let line = [];        // [{ uci, san }] from the start position
  let idx = 0;          // plies of `line` on the board
  let lastMove = null;
  let flip = false;
  let selected = null, legal = [];
  let pendingPromo = null;
  let engineOn = localStorage.getItem(ENGINE_KEY) !== "off";
  let engineFailed = false;

  const sqOf = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;
  const uciOf = (m) =>
    algOf(m.from) + algOf(m.castle && m.rookFrom != null ? m.rookFrom : m.to) + (m.promo || "");
  const findUci = (board, uci) =>
    /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)
      ? board.findMove(sqOf(uci.slice(0, 2)), sqOf(uci.slice(2, 4)), uci[4] || null)
      : null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const live = LiveEval.create({
    onUpdate: showEval,
    onError(err) {
      engineFailed = true;
      engineErrEl.textContent = err.message;
      clearEval();
    },
  });

  // ---- position ----

  // Show the position after `i` plies, rebuilt from the start so that
  // repetition counts are right.
  function goto(i) {
    idx = Math.max(0, Math.min(line.length, i));
    chess.loadFen(startFen);
    lastMove = null;
    for (let k = 0; k < idx; k++) {
      lastMove = findUci(chess, line[k].uci);
      chess.makeMove(lastMove);
    }
    selected = null; legal = [];
    pendingPromo = null;
    promoEl.classList.remove("show");
    render();
    renderMoves();
    renderStatus();
    analyse();
  }

  function play(m) {
    const uci = uciOf(m);
    if (line[idx] && line[idx].uci === uci) return goto(idx + 1);
    line = line.slice(0, idx);
    line.push({ uci, san: chess.moveToSan(m) });
    saveUrl();
    goto(idx + 1);
  }

  // Start again from `fen` (null: the standard start), with `uciMoves` played
  // as far as they are legal. Throws, changing nothing, on a FEN that won't load.
  function load(fen, uciMoves) {
    const scratch = new Chess();
    scratch.loadFen(fen || STANDARD_START);
    const kept = [];
    for (const uci of uciMoves || []) {
      const m = findUci(scratch, uci);
      if (!m) break;
      kept.push({ uci: uciOf(m), san: scratch.moveToSan(m) });
      scratch.makeMove(m);
    }
    startFen = fen || STANDARD_START;
    line = kept;
    saveUrl();
    goto(line.length);
  }

  function saveUrl() {
    const params = new URLSearchParams();
    if (startFen !== STANDARD_START) params.set("fen", startFen);
    if (line.length) params.set("moves", line.map((x) => x.uci).join(","));
    // Slashes and commas are fine in a query and far easier to read unescaped.
    const query = params.toString().replace(/%2F/g, "/").replace(/%2C/g, ",");
    history.replaceState(null, "", location.pathname + (query ? "?" + query : ""));
  }

  // ---- board ----

  function render() {
    boardEl.innerHTML = "";
    const inCheck = chess.inCheck();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = flip ? row : 7 - row;
        const f = flip ? 7 - col : col;
        const sq = sqIdx(f, r);
        const div = el("div", "square " + ((r + f) % 2 === 0 ? "dark" : "light"));
        div.dataset.sq = sq; // boardDrag.js and boardArrows.js find squares by this
        if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add("last-move");
        if (selected === sq) div.classList.add("selected");
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
          // Castling is offered on the rook's square too, as on the game page.
          const m = legal.find((x) => x.to === sq) || legal.find((x) => x.castle && x.rookFrom === sq);
          if (m) {
            const hint = el("div", "hint");
            if ((chess.squares[sq] && !m.castle) || m.enpassant) hint.classList.add("capture");
            div.appendChild(hint);
          }
        }
        div.addEventListener("click", () => onSquareClick(sq));
        boardEl.appendChild(div);
      }
    }
  }
  window.addEventListener("theme:changed", render);

  // Either side may move, whichever is to play.
  function canPickUp(sq) {
    const piece = chess.squares[sq];
    return !pendingPromo && !!piece && piece.c === chess.turn && !chess.isGameOver();
  }

  function selectSquare(sq) {
    selected = sq;
    legal = chess.legalMoves().filter((m) => m.from === sq);
    render();
  }

  // Resolve the gesture the way ui.js does: an ordinary move first, then a
  // castle by its rook's square, then by the king's destination. The promotion
  // piece is asked for afterwards. False when nothing legal matches.
  function attemptMove(from, to) {
    const moves = chess.legalMoves().filter((m) => m.from === from);
    const candidate =
      moves.find((m) => !m.castle && m.to === to) ||
      moves.find((m) => m.castle && m.rookFrom === to) ||
      moves.find((m) => m.castle && m.to === to);
    if (!candidate) return false;
    selected = null; legal = [];
    if (candidate.promo) askPromotion(moves.filter((m) => m.to === to && m.promo));
    else play(candidate);
    return true;
  }

  function onSquareClick(sq) {
    if (pendingPromo) return;
    if (selected !== null && attemptMove(selected, sq)) return;
    if (canPickUp(sq) && selected !== sq) selectSquare(sq);
    else { selected = null; legal = []; render(); }
  }

  BoardDrag.attach(boardEl, {
    canDrag: canPickUp,
    onPick: selectSquare,
    onDrop(from, to) {
      if (to == null || to === from) return;
      if (!attemptMove(from, to)) { selected = null; legal = []; render(); }
    },
  });
  BoardArrows.attach(boardEl);

  function askPromotion(cands) {
    pendingPromo = cands;
    promoOpts.innerHTML = "";
    for (const t of ["q", "r", "b", "n"]) {
      const opt = el("div", "opt");
      const img = document.createElement("img");
      img.src = Theme.pieceSrc(chess.turn, t);
      opt.appendChild(img);
      opt.addEventListener("click", () => {
        const m = pendingPromo && pendingPromo.find((x) => x.promo === t);
        pendingPromo = null;
        promoEl.classList.remove("show");
        if (m) play(m);
      });
      promoOpts.appendChild(opt);
    }
    promoEl.classList.add("show");
    render();
  }
  // A click beside the four pieces changes nothing.
  promoEl.addEventListener("click", (e) => {
    if (e.target !== promoEl) return;
    pendingPromo = null;
    promoEl.classList.remove("show");
  });

  // ---- move list and status ----

  // Numbered from the start position's own move number and side to move, so a
  // FEN with Black to play opens with "23…".
  function renderMoves() {
    historyEl.innerHTML = "";
    if (!line.length) {
      historyEl.appendChild(el("span", "muted", "Make a move on the board."));
      return;
    }
    const scratch = new Chess();
    scratch.loadFen(startFen);
    let number = scratch.fullmove;
    let white = scratch.turn === W;
    line.forEach((mv, k) => {
      if (white) historyEl.append(el("span", "mv-num", number + "."), " ");
      else if (k === 0) historyEl.append(el("span", "mv-num", number + "…"), " ");
      const span = el("span", "mv" + (k + 1 === idx ? " current" : ""), mv.san);
      span.addEventListener("click", () => goto(k + 1));
      historyEl.append(span, " ");
      if (!white) number++;
      white = !white;
    });
    const cur = historyEl.querySelector(".mv.current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function renderStatus() {
    fenOutEl.value = chess.fen();
    const side = chess.turn === W ? "White" : "Black";
    let text = side + " to move";
    if (chess.isCheckmate()) text = "Checkmate — " + (chess.turn === W ? "Black" : "White") + " wins";
    else if (chess.isStalemate()) text = "Stalemate — draw";
    else if (chess.isInsufficientMaterial()) text = "Draw — insufficient material";
    else if (chess.isThreefoldRepetition()) text = "Draw — threefold repetition";
    else if (chess.halfmove >= 100) text = "Draw — fifty-move rule";
    else if (chess.inCheck()) text += " · check";
    statusEl.textContent = text;
  }

  // ---- evaluation ----

  // Search the position on the board, or score it outright when the game is
  // over there: Stockfish is never asked about a finished position.
  function analyse() {
    if (!engineFailed) engineErrEl.textContent = "";
    if (!engineOn || engineFailed) { live.stop(); clearEval(); return; }
    if (chess.isGameOver()) {
      live.stop();
      const mate = chess.isCheckmate();
      setBar(mate ? (chess.turn === W ? -GameReview.MATE : GameReview.MATE) : 0);
      numberEl.textContent = mate ? (chess.turn === W ? "0-1" : "1-0") : "½-½";
      depthEl.textContent = "";
      lineEl.textContent = "Game over.";
      return;
    }
    // The bar stays where it was until the first score of the new search, so
    // it slides from one evaluation to the next instead of resetting.
    depthEl.textContent = "";
    lineEl.textContent = "Analysing…";
    live.analyse({
      startFen: startFen === STANDARD_START ? null : startFen,
      uciMoves: line.slice(0, idx).map((x) => x.uci),
      turn: chess.turn,
    });
  }

  function setBar(score) {
    barEl.classList.remove("pending");
    barEl.classList.toggle("flipped", flip);
    barEl.style.setProperty("--white-share", GameReview.whiteShare(score) + "%");
  }

  function clearEval() {
    barEl.classList.add("pending");
    barEl.title = "";
    numberEl.textContent = "";
    depthEl.textContent = "";
    lineEl.textContent = engineOn ? "" : "Engine off.";
  }

  function showEval(update) {
    if (update.done) {
      if (depthEl.textContent) depthEl.textContent += " · done";
      return;
    }
    const mate = Math.abs(update.score) >= 99000;
    setBar(update.score);
    numberEl.textContent = GameReview.formatScore(update.score, "w");
    barEl.title = "Evaluation " + numberEl.textContent;
    // A forced mate sends Stockfish straight to depth 245, which means nothing.
    depthEl.textContent = mate ? "" : "depth " + update.depth;
    lineEl.textContent = "";
    lineEl.append(el("b", null, numberEl.textContent), " ", pvText(update.pv));
  }

  // The engine's line in SAN, numbered from the position on the board. It
  // stops at the first move the page's rules don't accept rather than guess.
  function pvText(pv) {
    const scratch = new Chess();
    scratch.loadFen(startFen);
    for (let k = 0; k < idx; k++) scratch.makeMove(findUci(scratch, line[k].uci));
    const out = [];
    for (const uci of pv.slice(0, PV_SHOWN)) {
      const m = findUci(scratch, uci);
      if (!m) break;
      if (scratch.turn === W) out.push(scratch.fullmove + ".");
      else if (!out.length) out.push(scratch.fullmove + "…");
      out.push(scratch.moveToSan(m));
      scratch.makeMove(m);
    }
    return out.join(" ");
  }

  // Leaving the page: let go of the engine now rather than whenever the
  // browser gets round to it.
  window.addEventListener("pagehide", () => live.destroy());

  toggleEl.checked = engineOn;
  toggleEl.addEventListener("change", () => {
    engineOn = toggleEl.checked;
    localStorage.setItem(ENGINE_KEY, engineOn ? "on" : "off");
    analyse();
  });

  // ---- controls ----

  $("firstBtn").onclick = () => goto(0);
  $("prevBtn").onclick = () => goto(idx - 1);
  $("nextBtn").onclick = () => goto(idx + 1);
  $("lastBtn").onclick = () => goto(line.length);
  $("flipBtn").onclick = () => { flip = !flip; render(); barEl.classList.toggle("flipped", flip); };
  $("resetBtn").onclick = () => load(null, []);
  fenOutEl.addEventListener("focus", () => fenOutEl.select());

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (fenPanel.classList.contains("show") || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") goto(idx - 1);
    else if (e.key === "ArrowRight") goto(idx + 1);
    else if (e.key === "Home") goto(0);
    else if (e.key === "End") goto(line.length);
    else if (e.key === "f") $("flipBtn").onclick();
    else return;
    e.preventDefault();
  });

  $("loadFenBtn").addEventListener("click", () => {
    fenText.value = "";
    fenError.textContent = "";
    fenPanel.classList.add("show");
    fenText.focus();
  });
  $("fenCancelBtn").addEventListener("click", () => fenPanel.classList.remove("show"));
  $("fenLoadBtn").addEventListener("click", () => {
    const fen = fenText.value.trim();
    if (!fen) { fenError.textContent = "Paste a FEN string first."; return; }
    try { load(fen, []); }
    catch (e) { fenError.textContent = e.message; return; }
    fenPanel.classList.remove("show");
  });

  // ---- start ----

  const params = new URLSearchParams(location.search);
  const moves = (params.get("moves") || "").split(",").filter(Boolean);
  try {
    load(params.get("fen"), moves);
  } catch (e) {
    load(null, []);
    engineErrEl.textContent = "That link's position didn't load: " + e.message;
  }
})();
