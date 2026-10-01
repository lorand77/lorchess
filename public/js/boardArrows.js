"use strict";

// Arrows and circles drawn on a board with the right mouse button, as on
// Lichess and chess.com. Right-drag from one square to another draws an arrow;
// a right-click on a square circles it. Plain is green, Shift or Ctrl red, Alt
// blue, and Shift/Ctrl with Alt yellow. Drawing the same shape again erases it;
// the same squares in another colour replace it. A left click on the board
// clears everything, and so does any change in the position (a move, or a step
// through a replay), the way both sites drop drawings once the game moves on.
//
// The drawings are the user's own scratch notes: kept in this page only, never
// sent anywhere (an opponent does not see them), and gone on reload. Touch has
// no right button, so nothing is drawn by touch.
//
// The host re-renders its board with innerHTML = '' on every change, so the
// overlay cannot simply live inside it. A MutationObserver puts the <svg> back
// after each render and redraws it; that is also where a changed position is
// noticed. Shapes are kept as square numbers and placed by measuring the
// squares at draw time, so a flipped board needs nothing special.
//
// Host board requirements (as for boardDrag.js):
//   - squares are `.square` elements inside the container, with `data-sq="<0-63>"`
//   - a piece is an <img> directly inside its square (img.ghost is ignored)

window.BoardArrows = (function () {
  const NS = "http://www.w3.org/2000/svg";
  // Lichess's brushes.
  const BRUSHES = { green: "#15781b", red: "#882020", blue: "#003088", yellow: "#e68f00" };
  // Geometry in squares (the overlay is 8 × 8 units).
  const LINE = 0.16;        // arrow shaft width
  const HEAD_LEN = 0.42;
  const HEAD_HALF = 0.26;   // half the arrowhead's width
  const TIP_BACK = 0.1;     // the tip stops this short of the target's centre
  const RING_R = 0.45;
  const RING_W = 0.07;

  function brushFor(e) {
    const red = e.shiftKey || e.ctrlKey;
    if (red && e.altKey) return "yellow";
    if (red) return "red";
    if (e.altKey) return "blue";
    return "green";
  }

  function svgEl(name, attrs) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function attach(boardEl) {
    if (!boardEl) return function () {};
    const svg = svgEl("svg", { class: "board-arrows", viewBox: "0 0 8 8", "aria-hidden": "true" });

    let shapes = [];       // { from, to, brush }; from === to is a circle
    let drawing = null;    // the shape under a held right button, see onPointerDown
    let position = null;   // piece placement last seen, to notice the position moving on

    const squareEl = (sq) => boardEl.querySelector('.square[data-sq="' + sq + '"]');

    function squareAt(x, y) {
      const hit = document.elementFromPoint(x, y);
      const sq = hit && hit.closest ? hit.closest(".square") : null;
      if (!sq || !boardEl.contains(sq)) return null;
      const n = Number(sq.dataset.sq);
      return Number.isInteger(n) ? n : null;
    }

    // Centre of a square in board units, measured from the DOM.
    function centre(sq) {
      const el = squareEl(sq);
      if (!el || !el.offsetWidth) return null;
      return {
        x: Math.round(el.offsetLeft / el.offsetWidth) + 0.5,
        y: Math.round(el.offsetTop / el.offsetHeight) + 0.5,
      };
    }

    function placement() {
      let s = "";
      for (const img of boardEl.querySelectorAll(".square[data-sq] > img:not(.ghost)")) {
        s += img.parentNode.dataset.sq + "=" + img.getAttribute("src") + ";";
      }
      return s;
    }

    // A knight's arrow bends, as on chess.com: along the long leg, then the short.
    function arrow(g, a, b, color) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const knight = (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
      const corner = !knight ? null : Math.abs(dx) > Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      const last = corner || a;
      const len = Math.hypot(b.x - last.x, b.y - last.y);
      const ux = (b.x - last.x) / len;
      const uy = (b.y - last.y) / len;
      const tip = { x: b.x - ux * TIP_BACK, y: b.y - uy * TIP_BACK };
      const base = { x: tip.x - ux * HEAD_LEN, y: tip.y - uy * HEAD_LEN };
      const pts = [a, corner, base].filter(Boolean).map((p) => p.x + "," + p.y).join(" ");
      g.appendChild(svgEl("polyline", {
        points: pts, fill: "none", stroke: color, "stroke-width": LINE, "stroke-linejoin": "round",
      }));
      const px = -uy * HEAD_HALF;
      const py = ux * HEAD_HALF;
      g.appendChild(svgEl("polygon", {
        points: [tip, { x: base.x + px, y: base.y + py }, { x: base.x - px, y: base.y - py }]
          .map((p) => p.x + "," + p.y).join(" "),
        fill: color,
      }));
    }

    function drawShape(s, preview) {
      const a = centre(s.from);
      const b = centre(s.to);
      if (!a || !b) return;
      const color = BRUSHES[s.brush];
      // Opacity on the group, so shaft and head overlap without a darker seam.
      const g = svgEl("g", { opacity: preview ? 0.5 : 0.8 });
      if (s.from === s.to) {
        g.appendChild(svgEl("circle", {
          cx: a.x, cy: a.y, r: RING_R, fill: "none", stroke: color, "stroke-width": RING_W,
        }));
      } else {
        arrow(g, a, b, color);
      }
      svg.appendChild(g);
    }

    function draw() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      for (const s of shapes) drawShape(s, false);
      if (drawing && drawing.to != null) drawShape(drawing, true);
    }

    // After every render of the host: put the overlay back, drop the drawings
    // if the pieces have moved, and redraw.
    function sync() {
      const now = placement();
      if (position !== null && now !== position) {
        shapes = [];
        drawing = null;
      }
      position = now;
      if (svg.parentNode !== boardEl) boardEl.appendChild(svg);
      draw();
    }

    const observer = new MutationObserver((records) => {
      // Our own re-append is the only change: nothing to do.
      const ours = records.every((r) =>
        r.removedNodes.length === 0 && r.addedNodes.length === 1 && r.addedNodes[0] === svg);
      if (!ours) sync();
    });

    function toggle(d) {
      const i = shapes.findIndex((s) => s.from === d.from && s.to === d.to);
      const shape = { from: d.from, to: d.to, brush: d.brush };
      if (i < 0) shapes.push(shape);
      else if (shapes[i].brush === d.brush) shapes.splice(i, 1);
      else shapes[i] = shape;
    }

    function onPointerDown(e) {
      if (e.button === 0) {
        if (shapes.length) { shapes = []; draw(); }
        return;
      }
      if (e.button !== 2 || e.pointerType === "touch" || drawing) return;
      const from = squareAt(e.clientX, e.clientY);
      if (from == null) return;
      drawing = { pointerId: e.pointerId, from, to: from, brush: brushFor(e) };
      draw();
    }

    function onPointerMove(e) {
      if (!drawing || e.pointerId !== drawing.pointerId) return;
      const to = squareAt(e.clientX, e.clientY); // null off the board: no preview
      if (to === drawing.to) return;
      drawing.to = to;
      draw();
    }

    function onPointerUp(e) {
      if (!drawing || e.pointerId !== drawing.pointerId || e.button !== 2) return;
      const d = drawing;
      drawing = null;
      if (d.to != null) toggle(d);
      draw();
    }

    function cancel() {
      if (!drawing) return;
      drawing = null;
      draw();
    }

    // The browser's menu would open over the board on every drawing.
    function onContextMenu(e) { e.preventDefault(); }

    function onKeyDown(e) {
      if (e.key === "Escape") cancel();
    }

    boardEl.addEventListener("pointerdown", onPointerDown);
    boardEl.addEventListener("contextmenu", onContextMenu);
    // On window: a drawing may be released outside the board.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown);
    observer.observe(boardEl, { childList: true });
    sync();

    return function detach() {
      observer.disconnect();
      svg.remove();
      boardEl.removeEventListener("pointerdown", onPointerDown);
      boardEl.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }

  return { attach };
})();
