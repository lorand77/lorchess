"use strict";

// The game page's board for infinite chess: a window onto a board with no
// edges. The same interface as gridBoardView.js — ui.js says what to show,
// this shows it — but a square is "x,y" rather than 0-63, and only part of
// the board is ever on screen, so the view also keeps a camera:
//
//   - the window is `size` squares across (zoom: 8 to 40), its lower-left
//     corner at (left, bottom); it starts framed on the pieces
//   - drag the board to pan it, the wheel or the − / + buttons to zoom, ⌖ to
//     frame the pieces again
//   - a move that lands off screen brings the window to it
//   - pieces off screen show as markers on the edge, in their direction;
//     click one to go there
//
// Read-only for now: it reports no clicks or drags as moves.
//
//   const view = InfiniteBoardView.create(boardEl, { pieceSrc })
//   view.render(state)   as gridBoardView.js, except: pieces is a Map from
//                        "x,y" to the piece, squares are { x, y } (lastMove,
//                        premove, selected) or "x,y" (check, mustCapture,
//                        hints); returns whether the animation still runs
//   view.destroy()       takes the camera's controls off the page

window.InfiniteBoardView = (function () {
  const MOVE_ANIM_MS = 200;
  const MIN_SIZE = 8, MAX_SIZE = 40;
  const keyOf = (p) => p.x + ',' + p.y;

  function create(boardEl, handlers) {
    let size = 10;
    let left = 0, bottom = 0;   // the lower-left square of the window
    let framed = false;         // placed on a first position yet?
    let followed = null;        // the last move the window has followed
    let state = null;           // what was last rendered, to redraw on a pan

    boardEl.classList.add('infinite');

    // ---- the camera ----

    const visible = (p) => p.x >= left && p.x < left + size && p.y >= bottom && p.y < bottom + size;

    function centreOn(x, y) {
      left = Math.round(x - (size - 1) / 2);
      bottom = Math.round(y - (size - 1) / 2);
    }

    function zoom(newSize) {
      const s = Math.max(MIN_SIZE, Math.min(MAX_SIZE, newSize));
      if (s === size) return;
      const cx = left + (size - 1) / 2, cy = bottom + (size - 1) / 2;
      size = s;
      centreOn(cx, cy);
      redraw();
    }

    // Frame the pieces: all of them if they fit, else those around the king
    // at the bottom of the board.
    function frame() {
      if (!state) return;
      const pieces = [...state.pieces.values()];
      const bottomColour = state.flip ? 'b' : 'w';
      let group = pieces;
      const span = (ps, axis) => Math.max(...ps.map((p) => p[axis])) - Math.min(...ps.map((p) => p[axis]));
      if (Math.max(span(group, 'x'), span(group, 'y')) + 3 > MAX_SIZE) {
        const king = pieces.find((p) => p.t === 'k' && p.c === bottomColour) || pieces[0];
        group = pieces.filter((p) => Math.abs(p.x - king.x) < MAX_SIZE / 2 && Math.abs(p.y - king.y) < MAX_SIZE / 2);
      }
      const xs = group.map((p) => p.x), ys = group.map((p) => p.y);
      size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.max(span(group, 'x'), span(group, 'y')) + 3));
      centreOn((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
    }

    // ---- controls ----

    const tools = document.createElement('div');
    tools.className = 'infinite-tools';
    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      tools.appendChild(b);
      return b;
    };
    button('−', 'Zoom out', () => zoom(size + 4));
    button('+', 'Zoom in', () => zoom(size - 4));
    button('⌖', 'Frame the pieces', () => { frame(); redraw(); });
    boardEl.parentElement.appendChild(tools);
    const placeTools = () => { tools.style.top = (boardEl.offsetTop + 6) + 'px'; };

    function onWheel(e) {
      e.preventDefault();
      zoom(size + (e.deltaY > 0 ? 2 : -2));
    }

    // Drag to pan: the board follows the pointer a whole square at a time.
    let pan = null;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.edge-marker')) return;
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left, bottom };
      boardEl.setPointerCapture(e.pointerId);
      boardEl.classList.add('panning');
    }
    function onPointerMove(e) {
      if (!pan || e.pointerId !== pan.id) return;
      const px = boardEl.clientWidth / size;
      const dx = Math.round((e.clientX - pan.x) / px), dy = Math.round((e.clientY - pan.y) / px);
      const sign = state && state.flip ? -1 : 1;
      const l = pan.left - sign * dx, b = pan.bottom + sign * dy;
      if (l !== left || b !== bottom) { left = l; bottom = b; redraw(); }
    }
    function onPointerUp(e) {
      if (!pan || e.pointerId !== pan.id) return;
      pan = null;
      boardEl.classList.remove('panning');
    }
    boardEl.addEventListener('wheel', onWheel, { passive: false });
    boardEl.addEventListener('pointerdown', onPointerDown);
    boardEl.addEventListener('pointermove', onPointerMove);
    boardEl.addEventListener('pointerup', onPointerUp);
    boardEl.addEventListener('pointercancel', onPointerUp);

    // ---- drawing ----

    const sqEl = (key) => boardEl.querySelector(`.square[data-sq="${key}"]`);

    // Window position (col, row from the top left) of a board square.
    function place(x, y) {
      return state.flip
        ? { col: left + size - 1 - x, row: y - bottom }
        : { col: x - left, row: bottom + size - 1 - y };
    }

    function render(next) {
      state = next;
      if (!framed) {
        frame();
        framed = true;
        followed = state.lastMove ? keyOf(state.lastMove.to) : null;
      } else if (state.lastMove && keyOf(state.lastMove.to) !== followed) {
        followed = keyOf(state.lastMove.to);
        if (!visible(state.lastMove.to)) centreOn(state.lastMove.to.x, state.lastMove.to.y);
      }
      return draw();
    }

    function redraw() {
      if (state) draw();
    }

    function draw() {
      const { pieces, flip, lastMove, premove, selected, check, mustCapture, hints } = state;
      boardEl.innerHTML = '';
      boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
      boardEl.style.gridTemplateRows = `repeat(${size}, 1fr)`;
      boardEl.style.setProperty('--sq', `calc(var(--board) / ${size})`);
      placeTools();
      const at = (sq, key) => sq && keyOf(sq) === key;

      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          const x = flip ? left + size - 1 - col : left + col;
          const y = flip ? bottom + row : bottom + size - 1 - row;
          const key = x + ',' + y;
          const div = document.createElement('div');
          // Dark when x + y is even: a1 (1,1) is dark, as ICN has it.
          div.className = 'square ' + ((x + y) % 2 === 0 ? 'dark' : 'light');
          div.dataset.sq = key;

          if (lastMove && (at(lastMove.from, key) || at(lastMove.to, key))) div.classList.add('last-move');
          if (mustCapture && mustCapture.has(key)) div.classList.add('must-capture');
          if (premove && (at(premove.from, key) || at(premove.to, key))) div.classList.add('premove');
          if (at(selected, key)) div.classList.add('selected');
          if (check === key) div.classList.add('check');

          if (col === 0) {
            const c = document.createElement('div');
            c.className = 'coord rank';
            c.textContent = y;
            div.appendChild(c);
          }
          if (row === size - 1) {
            const c = document.createElement('div');
            c.className = 'coord file';
            c.textContent = x;
            div.appendChild(c);
          }

          const piece = pieces.get(key);
          if (piece) {
            const img = document.createElement('img');
            img.src = handlers.pieceSrc(piece);
            img.classList.add('piece');
            if (piece.t === 'p') img.classList.add('pawn');
            img.draggable = false;
            img.alt = piece.c + piece.t;
            div.appendChild(img);
          }

          const hint = hints && hints.get(key);
          if (hint) {
            const dot = document.createElement('div');
            dot.className = 'hint';
            if (hint !== 'move') dot.classList.add(hint);
            div.appendChild(dot);
          }
          boardEl.appendChild(div);
        }
      }
      drawMarkers();
      return animate(state.animation);
    }

    // Pieces off screen, shown on the edge square nearest to them, pushed
    // towards the edge they lie beyond. Several behind one edge square share a
    // marker, with a count; the nearest gives it its picture.
    function drawMarkers() {
      const groups = new Map();
      for (const p of state.pieces.values()) {
        if (visible(p)) continue;
        const cx = Math.max(left, Math.min(left + size - 1, p.x));
        const cy = Math.max(bottom, Math.min(bottom + size - 1, p.y));
        const key = cx + ',' + cy;
        const dist = Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy));
        const g = groups.get(key);
        if (!g) groups.set(key, { cx, cy, nearest: p, dist, count: 1, dx: Math.sign(p.x - cx), dy: Math.sign(p.y - cy) });
        else {
          g.count++;
          if (dist < g.dist) { g.nearest = p; g.dist = dist; }
        }
      }
      for (const g of groups.values()) {
        const { col, row } = place(g.cx, g.cy);
        const flipSign = state.flip ? -1 : 1;
        const m = document.createElement('div');
        m.className = 'edge-marker';
        // Pushed towards the edge, but kept whole inside its square.
        m.style.left = `${((col + 0.5 + 0.2 * g.dx * flipSign) / size) * 100}%`;
        m.style.top = `${((row + 0.5 - 0.2 * g.dy * flipSign) / size) * 100}%`;
        const p = g.nearest;
        m.title = `${g.count > 1 ? g.count + ' pieces, the nearest ' : ''}${p.t.toUpperCase()} at ${p.x},${p.y}` +
          ` — ${g.dist} square${g.dist === 1 ? '' : 's'} beyond the edge`;
        m.dataset.target = keyOf(p);
        const img = document.createElement('img');
        img.src = handlers.pieceSrc(p);
        img.alt = '';
        img.draggable = false;
        m.appendChild(img);
        if (g.count > 1) {
          const n = document.createElement('span');
          n.className = 'edge-count';
          n.textContent = g.count;
          m.appendChild(n);
        }
        m.addEventListener('click', () => { centreOn(p.x, p.y); redraw(); });
        boardEl.appendChild(m);
      }
    }

    // As gridBoardView.js: slide the moved piece in from where it came, if
    // that square is on screen; fade out what it took.
    function animate(anim) {
      if (!anim) return false;
      const elapsed = performance.now() - anim.start;
      if (elapsed >= MOVE_ANIM_MS) return false;
      for (const p of anim.pieces) {
        const fromEl = sqEl(p.from), toEl = sqEl(p.to);
        const img = toEl && toEl.querySelector('img.piece');
        if (!fromEl || !img) continue;
        const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
        toEl.classList.add('animating');
        const slide = img.animate(
          [{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'translate(0, 0)' }],
          { duration: MOVE_ANIM_MS, easing: 'ease-out' }
        );
        slide.currentTime = elapsed;
        slide.finished.then(() => toEl.classList.remove('animating'), () => {});
      }
      if (anim.captured) {
        const capEl = sqEl(anim.captured.sq);
        if (capEl) {
          const ghost = document.createElement('img');
          ghost.src = handlers.pieceSrc(anim.captured.piece);
          ghost.className = 'ghost';
          if (anim.captured.piece.t === 'p') ghost.classList.add('pawn');
          ghost.draggable = false;
          ghost.alt = '';
          capEl.insertBefore(ghost, capEl.firstChild);
          const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOVE_ANIM_MS, easing: 'ease-in' });
          fade.currentTime = elapsed;
          fade.finished.then(() => ghost.remove(), () => {});
        }
      }
      return true;
    }

    function destroy() {
      tools.remove();
      boardEl.removeEventListener('wheel', onWheel);
      boardEl.removeEventListener('pointerdown', onPointerDown);
      boardEl.removeEventListener('pointermove', onPointerMove);
      boardEl.removeEventListener('pointerup', onPointerUp);
      boardEl.removeEventListener('pointercancel', onPointerUp);
      boardEl.classList.remove('infinite', 'panning');
      boardEl.style.removeProperty('grid-template-columns');
      boardEl.style.removeProperty('grid-template-rows');
      boardEl.style.removeProperty('--sq');
    }

    // For tests and the page: where the window is.
    const camera = () => ({ left, bottom, size });

    return { render, destroy, camera };
  }

  return { create };
})();
