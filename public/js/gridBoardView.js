"use strict";

// The game page's board as the familiar 8x8 grid. ui.js decides what the board
// should show — the pieces, which squares to highlight, where the selected
// piece may go, which move to animate — and what a click or a drag means; this
// decides how that looks and which square the pointer is on. Nothing in ui.js
// touches the board's DOM. A board of another shape (infinite chess, with no
// edges) is another view with the same interface.
//
//   const view = GridBoardView.create(boardEl, handlers)
//     handlers.pieceSrc(piece)       image URL for { t, c }
//     handlers.onSquareClick(sq)     a square was clicked (taps; drags below)
//     handlers.onContextMenu(event)  a right-click on the board
//     handlers.canDrag / onPick / onDrop, handlers.dragSources
//                                    passed to BoardDrag (see boardDrag.js)
//
//   view.render(state) redraws the board from scratch:
//     pieces       the 64 squares, index 0 = a1, each { t, c } or null
//     flip         Black at the bottom
//     lastMove     { from, to } or null; premove the same
//     selected     the selected square, or null
//     check        the square of a king in check, or null
//     mustCapture  squares to ring (Antichess), or null
//     hill         the centre squares to mark (King of the Hill), or null
//     hints        Map of square -> 'move' | 'capture' | 'premove'
//     animation    the move to animate, as ui.js planned it, or null
//   and returns whether that animation is still running.
//
//   view.destroy() takes its handlers off the board, so another view can
//   take it over (an infinite-chess game swaps this one out).
//
// Squares are looked up by their data-sq attribute (boardDrag.js and
// boardArrows.js rely on it), and the board is redrawn wholesale on every
// change, so nothing here holds on to an element between renders.

window.GridBoardView = (function () {
  // How long a move takes to slide (or a dropped piece to appear).
  const MOVE_ANIM_MS = 200;

  function create(boardEl, handlers) {
    // Drag-and-drop (mouse, touch and stylus alike). Taps fall through to the
    // squares' own click handlers untouched; only a real drag is handled there.
    const detachDrag = BoardDrag.attach(boardEl, {
      sources: handlers.dragSources || [],
      canDrag: handlers.canDrag,
      onPick: handlers.onPick,
      onDrop: handlers.onDrop,
    });
    // Right-button arrows and circles (Lichess / chess.com style). Local to
    // the page; the opponent never sees them.
    const detachArrows = BoardArrows.attach(boardEl);
    const onContextMenu = (e) => handlers.onContextMenu(e);
    boardEl.addEventListener('contextmenu', onContextMenu);

    const sqEl = (sq) => boardEl.querySelector(`.square[data-sq="${sq}"]`);

    function render(state) {
      boardEl.innerHTML = '';
      const { pieces, flip, lastMove, premove, selected, check, mustCapture, hill, hints } = state;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          // row/col are visual indices (0=top/left). Translate to board r/f.
          const r = flip ? row : 7 - row;
          const f = flip ? 7 - col : col;
          const sq = r * 8 + f;
          const div = document.createElement('div');
          div.className = 'square ' + ((r + f) % 2 === 0 ? 'dark' : 'light');
          div.dataset.sq = sq;

          if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add('last-move');
          if (mustCapture && mustCapture.has(sq)) div.classList.add('must-capture');
          if (hill && hill.has(sq)) div.classList.add('hill');
          if (premove && (premove.from === sq || premove.to === sq)) div.classList.add('premove');
          if (selected === sq) div.classList.add('selected');
          if (check === sq) div.classList.add('check');

          // Coordinate colour comes from CSS (opposite square colour, themeable).
          if (col === 0) {
            const c = document.createElement('div');
            c.className = 'coord rank';
            c.textContent = r + 1;
            div.appendChild(c);
          }
          if (row === 7) {
            const c = document.createElement('div');
            c.className = 'coord file';
            c.textContent = String.fromCharCode(97 + f);
            div.appendChild(c);
          }

          const piece = pieces[sq];
          if (piece) {
            const img = document.createElement('img');
            img.src = handlers.pieceSrc(piece);
            img.classList.add('piece');
            if (piece.t === 'p') img.classList.add('pawn');
            img.draggable = false;
            img.alt = piece.c + piece.t;
            div.appendChild(img);
          }

          const hint = hints && hints.get(sq);
          if (hint) {
            const dot = document.createElement('div');
            dot.className = 'hint';
            if (hint !== 'move') dot.classList.add(hint);
            div.appendChild(dot);
          }

          div.addEventListener('click', () => handlers.onSquareClick(sq));
          boardEl.appendChild(div);
        }
      }
      return animate(state.animation);
    }

    // A move is applied to the position at once; the board then shows the
    // piece on its destination and slides it in from where it came (FLIP-style,
    // via the Web Animations API). render() rebuilds the DOM, and is called
    // again almost straight after a move, so each render re-attaches the
    // animation at its current elapsed time, and the slide carries on.
    function animate(anim) {
      if (!anim) return false;
      const elapsed = performance.now() - anim.start;
      if (elapsed >= MOVE_ANIM_MS) return false;

      for (const p of anim.pieces) {
        const fromEl = sqEl(p.from);
        const toEl = sqEl(p.to);
        const img = toEl && toEl.querySelector('img.piece');
        if (!fromEl || !img) continue;
        const a = fromEl.getBoundingClientRect();
        const b = toEl.getBoundingClientRect();
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        toEl.classList.add('animating');   // paint above the squares it crosses
        const slide = img.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: MOVE_ANIM_MS, easing: 'ease-out' }
        );
        slide.currentTime = elapsed;
        slide.finished.then(() => toEl.classList.remove('animating'), () => {});
      }

      if (anim.dropped != null) {
        const toEl = sqEl(anim.dropped);
        const img = toEl && toEl.querySelector('img.piece');
        if (img) {
          const appear = img.animate(
            [{ opacity: 0, transform: 'scale(1.25)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration: MOVE_ANIM_MS, easing: 'ease-out' }
          );
          appear.currentTime = elapsed;
        }
      }

      // The captured piece stays visible under the arriving piece and fades
      // out, rather than blinking away before the capturer has landed.
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
          const fade = ghost.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: MOVE_ANIM_MS, easing: 'ease-in' }
          );
          fade.currentTime = elapsed;
          fade.finished.then(() => ghost.remove(), () => {});
        }
      }
      return true;
    }

    function destroy() {
      detachDrag();
      detachArrows();
      boardEl.removeEventListener('contextmenu', onContextMenu);
      boardEl.innerHTML = '';
    }

    return { render, destroy };
  }

  return { create };
})();
