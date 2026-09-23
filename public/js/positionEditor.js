"use strict";

// The handicap position editor. You start from the standard setup and change
// the 32 starting squares: take a piece off, or swap it for a different one.
// Kings are fixed, and a pawn can't be put on the first or last rank.
//
// Pick a tool, then click squares. "Remove" is selected by default, so the
// common case — clicking pieces off the board — is still one click per piece.
//
// Builds its own modal on first use, so a host page needs no extra markup.
// Requires /js/handicap.js (the shared layout and rules) and, optionally,
// /js/theme.js for custom piece images.
//
//   PositionEditor.open({ squares, onSave })
//     squares  changes to reopen with: { "<sq>": "q" | null }
//     onSave   called with the new changes object

window.PositionEditor = (function () {
  const PIECE_FILES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
  const TOOLS = [
    { key: "remove", label: "Remove", icon: "✕" },
    { key: "original", label: "Put back", icon: "↩" },
    { key: "q", label: "Queen" },
    { key: "r", label: "Rook" },
    { key: "b", label: "Bishop" },
    { key: "n", label: "Knight" },
    { key: "p", label: "Pawn" },
  ];

  let modal = null;
  let boardEl = null;
  let paletteEl = null;
  let summaryEl = null;
  let errorEl = null;
  let saveBtn = null;
  let changes = {};       // sq -> type | null
  let tool = "remove";
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

  // What stands on a square now: the change if there is one, else the original.
  function currentPiece(sq) {
    return Object.prototype.hasOwnProperty.call(changes, sq)
      ? pieceFor(sq, changes[sq])
      : START_PIECES[sq];
  }

  function build() {
    modal = el("div", "editor-modal");
    const box = el("div", "editor-box");
    box.appendChild(el("h3", null, "Handicap position"));
    box.appendChild(el(
      "p", "editor-hint",
      "Pick a tool, then click a square. Take pieces off to give odds, or swap one " +
      "for another. Kings stay put, and pawns can't go on the back rank. " +
      "A handicap game is always casual — it never affects ratings."
    ));

    paletteEl = el("div", "editor-palette");
    box.appendChild(paletteEl);

    boardEl = el("div", "board editor-board");
    box.appendChild(boardEl);

    summaryEl = el("p", "editor-summary");
    errorEl = el("p", "editor-error");
    box.append(summaryEl, errorEl);

    const actions = el("p", "editor-actions");
    const resetBtn = el("button", null, "Reset");
    resetBtn.addEventListener("click", () => { changes = {}; draw(); });
    const cancelBtn = el("button", null, "Cancel");
    cancelBtn.addEventListener("click", close);
    saveBtn = el("button", "primary", "Use position");
    saveBtn.addEventListener("click", () => {
      const check = validateSquares(changes);
      if (!check.ok) { errorEl.textContent = check.error; return; }
      const fn = onSave;
      close();
      if (fn) fn(check.squares);
    });
    actions.append(resetBtn, cancelBtn, saveBtn);
    box.appendChild(actions);

    modal.appendChild(box);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.body.appendChild(modal);
  }

  function drawPalette() {
    paletteEl.innerHTML = "";
    for (const t of TOOLS) {
      const b = el("button", "editor-tool" + (tool === t.key ? " active" : ""));
      if (t.icon) {
        b.appendChild(el("span", "tool-icon", t.icon));
      } else {
        const img = document.createElement("img");
        // Show the White piece: the board colours it by the square it lands on.
        img.src = pieceSrc(t.key.toUpperCase());
        img.draggable = false;
        img.alt = "";
        b.appendChild(img);
      }
      b.appendChild(el("span", "tool-label", t.label));
      b.title = t.label;
      b.addEventListener("click", () => { tool = t.key; drawPalette(); });
      paletteEl.appendChild(b);
    }
  }

  // White at the bottom: a handicap is agreed before colours are known, so the
  // orientation is arbitrary — pick the conventional one.
  function draw() {
    drawPalette();
    boardEl.innerHTML = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = 7 - row;
        const sq = rank * 8 + col;
        const div = el("div", "square " + ((rank + col) % 2 === 0 ? "dark" : "light"));
        div.dataset.sq = sq;

        const now = currentPiece(sq);
        const original = START_PIECES[sq];
        if (now) {
          const img = document.createElement("img");
          img.src = pieceSrc(now);
          img.className = "piece" + (now.toLowerCase() === "p" ? " pawn" : "");
          img.draggable = false;
          img.alt = "";
          div.appendChild(img);
          // Mark a square holding something other than its original piece.
          if (now !== original) div.classList.add("swapped");
        } else if (original) {
          // A ghost of what used to stand here, so an emptied square still reads
          // as a slot rather than as bare board.
          const img = document.createElement("img");
          img.src = pieceSrc(original);
          img.className = "piece removed" + (original.toLowerCase() === "p" ? " pawn" : "");
          img.draggable = false;
          img.alt = "";
          div.appendChild(img);
        }

        if (isEditable(sq)) {
          div.classList.add("removable");
          div.addEventListener("click", () => apply(sq));
        } else if (original) {
          div.classList.add("locked");
          div.title = "The king has to stay";
        }
        boardEl.appendChild(div);
      }
    }

    const list = Object.keys(changes);
    summaryEl.textContent = list.length
      ? "Changes: " + describe(changes)
      : "No changes yet — pick a tool and click a square.";
    saveBtn.disabled = list.length === 0;
    errorEl.textContent = "";
  }

  function apply(sq) {
    if (!isEditable(sq)) return;
    errorEl.textContent = "";
    if (tool === "original") {
      delete changes[sq];
    } else if (tool === "remove") {
      // Clicking a square that is already empty puts its piece back, so the
      // default tool still toggles the way it always has.
      if (Object.prototype.hasOwnProperty.call(changes, sq) && changes[sq] === null) delete changes[sq];
      else changes[sq] = null;
    } else {
      if (tool === "p" && isBackRank(sq)) {
        errorEl.textContent = "A pawn can't stand on the first or last rank.";
        return;
      }
      // Placing the piece that already belongs there is just "put back".
      if (pieceFor(sq, tool) === START_PIECES[sq]) delete changes[sq];
      else changes[sq] = tool;
    }
    draw();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function open(opts) {
    if (!modal) build();
    changes = Object.assign({}, (opts && opts.squares) || {});
    onSave = (opts && opts.onSave) || null;
    tool = "remove";
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
