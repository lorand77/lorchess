"use strict";

// The handicap position editor: a board you tap pieces off of, to give material
// odds. Removal is the only operation — you start from the standard setup and
// take things away, so the result is always a legal position and the server can
// rebuild it from nothing but the list of cleared squares.
//
// Builds its own modal on first use, so a host page needs no extra markup.
// Requires /js/handicap.js (the shared piece layout) and, optionally,
// /js/theme.js for custom piece images.
//
//   PositionEditor.open({ removed, onSave })
//     removed  squares already cleared, to reopen with the current selection
//     onSave   called with the new array of cleared squares

window.PositionEditor = (function () {
  const PIECE_FILES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

  let modal = null;
  let boardEl = null;
  let summaryEl = null;
  let errorEl = null;
  let saveBtn = null;
  let removed = new Set();
  let onSave = null;

  function pieceSrc(ch) {
    const color = ch === ch.toUpperCase() ? "w" : "b";
    const type = ch.toLowerCase();
    if (window.Theme && Theme.pieceSrc) return Theme.pieceSrc(color, type);
    return "/assets/" + color + "_" + PIECE_FILES[type] + "_1x_ns.png";
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    modal = el("div", "editor-modal");
    const box = el("div", "editor-box");
    box.appendChild(el("h3", null, "Handicap position"));
    box.appendChild(el(
      "p", "editor-hint",
      "Tap a piece to take it off the board, tap its square again to put it back. " +
      "Kings stay. A handicap game is always casual — it never affects ratings."
    ));

    boardEl = el("div", "board editor-board");
    box.appendChild(boardEl);

    summaryEl = el("p", "editor-summary");
    box.appendChild(summaryEl);
    errorEl = el("p", "editor-error");
    box.appendChild(errorEl);

    const actions = el("p", "editor-actions");
    const resetBtn = el("button", null, "Reset");
    resetBtn.addEventListener("click", () => {
      removed.clear();
      draw();
    });
    const cancelBtn = el("button", null, "Cancel");
    cancelBtn.addEventListener("click", close);
    saveBtn = el("button", "primary", "Use position");
    saveBtn.addEventListener("click", () => {
      const list = [...removed].sort((a, b) => a - b);
      const check = validateRemovals(list);
      if (!check.ok) {
        errorEl.textContent = check.error;
        return;
      }
      const fn = onSave;
      close();
      if (fn) fn(check.removed);
    });
    actions.append(resetBtn, cancelBtn, saveBtn);
    box.appendChild(actions);

    modal.appendChild(box);
    // Clicking the backdrop dismisses; clicks inside must not bubble to it.
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.body.appendChild(modal);
  }

  // White at the bottom: a handicap is agreed before colours are known, so the
  // orientation is arbitrary — pick the conventional one.
  function draw() {
    boardEl.innerHTML = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = 7 - row;
        const sq = rank * 8 + col;
        const div = el("div", "square " + ((rank + col) % 2 === 0 ? "dark" : "light"));
        div.dataset.sq = sq;

        const piece = START_PIECES[sq];
        const gone = removed.has(sq);
        if (piece && !gone) {
          const img = document.createElement("img");
          img.src = pieceSrc(piece);
          img.className = "piece" + (piece.toLowerCase() === "p" ? " pawn" : "");
          img.draggable = false;
          img.alt = "";
          div.appendChild(img);
        } else if (piece && gone) {
          // Keep a faint outline of what used to be here, so it's obvious the
          // square is a slot you can refill rather than just empty board.
          const img = document.createElement("img");
          img.src = pieceSrc(piece);
          img.className = "piece removed" + (piece.toLowerCase() === "p" ? " pawn" : "");
          img.draggable = false;
          img.alt = "";
          div.appendChild(img);
        }

        if (canRemove(sq)) {
          div.classList.add("removable");
          div.addEventListener("click", () => toggle(sq));
        } else if (piece) {
          div.classList.add("locked");
          div.title = "The king has to stay";
        }
        boardEl.appendChild(div);
      }
    }

    const list = [...removed];
    summaryEl.textContent = list.length
      ? "Removed: " + describe(list)
      : "Nothing removed — take at least one piece off.";
    saveBtn.disabled = list.length === 0;
    errorEl.textContent = "";
  }

  function toggle(sq) {
    if (!canRemove(sq)) return;
    if (removed.has(sq)) removed.delete(sq);
    else removed.add(sq);
    draw();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function open(opts) {
    if (!modal) build();
    removed = new Set((opts && opts.removed) || []);
    onSave = (opts && opts.onSave) || null;
    draw();
    modal.classList.add("show");
    window.addEventListener("keydown", onKey);
  }

  function close() {
    if (!modal) return;
    modal.classList.remove("show");
    window.removeEventListener("keydown", onKey);
  }

  return { open, close };
})();
