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
  // A Crazyhouse FEN's pockets ("[Qp]" after the board) and promoted-piece
  // marks ("Q~") are dropped: a thumbnail shows only what is on the board.
  function parse(fen) {
    if (typeof fen !== "string") return null;
    const board = fen.trim().split(/\s+/)[0].replace(/\[[A-Za-z]*\]$/, "").replace(/~/g, "");
    const ranks = board.split("/");
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

  // An infinite-chess position (ICN: "w 0/100 1 (8|1) checkmate K5,1+|...")
  // as an 8x8 window of it, around the kings — around White's when they are
  // too far apart to share one. { squares (64, index 0 = the window's lower
  // left), x0, y0 } or null if it isn't one.
  function icnWindow(fen) {
    if (typeof fen !== "string") return null;
    // ICN ends with its piece list ("K5,1+|..."), a FEN with a move number.
    const list = fen.trim().split(/\s+/).pop();
    if (list.indexOf(",") === -1) return null;
    const pieces = [];
    for (const entry of list.split("|")) {
      const m = /^([pnbrqkPNBRQK])(-?\d+),(-?\d+)\+?$/.exec(entry);
      if (!m) return null;
      pieces.push({ ch: m[1], x: Number(m[2]), y: Number(m[3]) });
    }
    const kings = pieces.filter((p) => p.ch === "K" || p.ch === "k");
    if (kings.length !== 2) return null;
    const [a, b] = kings;
    const near = Math.abs(a.x - b.x) <= 7 && Math.abs(a.y - b.y) <= 7;
    const white = kings.find((k) => k.ch === "K");
    const cx = near ? (a.x + b.x) / 2 : white.x, cy = near ? (a.y + b.y) / 2 : white.y;
    const x0 = Math.floor(cx - 3.5), y0 = Math.floor(cy - 3.5);
    const squares = new Array(64).fill(null);
    for (const p of pieces) {
      const f = p.x - x0, r = p.y - y0;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) squares[r * 8 + f] = p.ch;
    }
    return { squares, x0, y0 };
  }

  function render(container, fen, opts) {
    if (!container) return false;
    const icn = icnWindow(fen);
    const squares = icn ? icn.squares : parse(fen);
    if (!squares) return false;
    const o = opts || {};
    const flip = !!o.flip;
    // { from, to }: square indices, or { x, y } squares for infinite chess,
    // which are turned into this window's indices.
    let highlight = o.lastMove || null;
    if (icn && highlight) {
      const idx = (s) => (s && typeof s === "object" ? (s.y - icn.y0) * 8 + (s.x - icn.x0) : null);
      highlight = { from: idx(highlight.from), to: idx(highlight.to) };
    }

    container.innerHTML = "";
    container.classList.add("mini-board");
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = flip ? row : 7 - row;
        const file = flip ? 7 - col : col;
        const sq = rank * 8 + file;
        const cell = document.createElement("div");
        // Dark when the absolute x + y is even, which is rank + file on an
        // ordinary board (a1 dark) and holds for an infinite window too.
        const parity = icn ? icn.x0 + icn.y0 + rank + file : rank + file;
        cell.className = "mini-square " + (Math.abs(parity) % 2 === 0 ? "dark" : "light");
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

  return { render, parse, turnOf, icnWindow };
})();
