"use strict";

// A small, read-only board rendered straight from a FEN. Used by the lobby for
// the daily-puzzle card, the more-puzzles card and the live-game previews —
// none of which accept input, so this shares nothing with the playable boards
// in ui.js / puzzles.js.
//
//   MiniBoard.render(container, fen, { flip, lastMove })
//
// `container` is styled by .mini-board in the stylesheet; the caller decides how
// big it is. Returns false when the FEN can't be parsed, so a caller can hide
// the card rather than show a broken board.

window.MiniBoard = (function () {
  const PIECE_FILES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

  function pieceSrc(ch) {
    const color = ch === ch.toUpperCase() ? "w" : "b";
    const type = ch.toLowerCase();
    if (!PIECE_FILES[type]) return null;
    if (window.Theme && Theme.pieceSrc) return Theme.pieceSrc(color, type);
    return "/assets/" + color + "_" + PIECE_FILES[type] + "_1x_ns.png";
  }

  // FEN board field -> array of 64, index 0 = a1. Returns null if malformed.
  function parse(fen) {
    if (typeof fen !== "string") return null;
    const ranks = fen.trim().split(/\s+/)[0].split("/");
    if (ranks.length !== 8) return null;
    const squares = new Array(64).fill(null);
    for (let i = 0; i < 8; i++) {
      const rank = 7 - i; // FEN starts at rank 8
      let file = 0;
      for (const ch of ranks[i]) {
        if (ch >= "1" && ch <= "8") {
          file += Number(ch);
          continue;
        }
        if (file > 7 || !PIECE_FILES[ch.toLowerCase()]) return null;
        squares[rank * 8 + file] = ch;
        file++;
      }
      if (file !== 8) return null;
    }
    return squares;
  }

  // Side to move, from the FEN's second field.
  function turnOf(fen) {
    return String(fen).trim().split(/\s+/)[1] === "b" ? "b" : "w";
  }

  function render(container, fen, opts) {
    if (!container) return false;
    const squares = parse(fen);
    if (!squares) return false;
    const o = opts || {};
    const flip = !!o.flip;
    const highlight = o.lastMove || null; // { from, to } as square indices

    container.innerHTML = "";
    container.classList.add("mini-board");
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = flip ? row : 7 - row;
        const file = flip ? 7 - col : col;
        const sq = rank * 8 + file;
        const cell = document.createElement("div");
        cell.className = "mini-square " + ((rank + file) % 2 === 0 ? "dark" : "light");
        if (highlight && (highlight.from === sq || highlight.to === sq)) {
          cell.classList.add("last-move");
        }
        const piece = squares[sq];
        if (piece) {
          const src = pieceSrc(piece);
          if (src) {
            const img = document.createElement("img");
            img.src = src;
            img.draggable = false;
            img.alt = "";
            cell.appendChild(img);
          }
        }
        container.appendChild(cell);
      }
    }
    return true;
  }

  return { render, parse, turnOf };
})();
