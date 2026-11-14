"use strict";

// The game page's board for four-player chess: the 14x14 cross of
// src/shared/fourPlayer.js, turned so the player's own colour sits at the
// bottom, as each of the four sees it on chess.com. The same interface as
// gridBoardView.js — ui.js says what to show, this shows it — with squares
// numbered as the engine numbers them (y * 14 + x, 0 = a1), so boardDrag.js
// and boardArrows.js work on it unchanged. The 3x3 corners are empty cells,
// not squares: nothing can be dropped or drawn there.
//
// Pieces come in four colours from the ordinary white images, tinted here
// (an SVG colour filter, multiplying white by the colour): no new artwork,
// and a user's own uploaded white pieces are tinted the same way.
//
//   const view = FourBoardView.create(boardEl, handlers)
//     handlers.pieceSrc(piece)    image URL for { t, c } — asked for the white
//                                 piece, { t, c: 'w' }, which this tints
//     handlers.onSquareClick, onContextMenu, canDrag / onPick / onDrop,
//     dragSources                 as gridBoardView.js
//
//   view.render(state) as gridBoardView.js, except:
//     pieces    the engine's 196 squares, each { t, c } (c 'r', 'b', 'y' or
//               'g') or null; the corners are always null
//     bottom    the colour at the bottom ('r' unless given), instead of flip
//     check     the square of a king in check, or a Set of them: one move can
//               check both opponents
//   and returns whether the animation is still running.
//
//   view.destroy() as gridBoardView.js.
//
// Needs fourPlayer.js loaded first (FourPlayer: the board's shape and turns).

window.FourBoardView = (function () {
  const MOVE_ANIM_MS = 200;
  const N = 14;
  // chess.com's four colours; the page uses them for names and clocks too.
  const COLOURS = { r: '#bf3b43', b: '#4185bf', y: '#c09526', g: '#4e9161' };

  // One hidden <svg> per page holding the four tints, made when the first
  // board is. A filter multiplies each channel: the white piece's light fill
  // takes the colour, its black outline stays black.
  function addTints() {
    if (document.getElementById('four-tints')) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.id = 'four-tints';
    svg.setAttribute('class', 'four-tints');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(NS, 'defs');
    for (const [c, hex] of Object.entries(COLOURS)) {
      const [r, g, b] = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3));
      const filter = document.createElementNS(NS, 'filter');
      filter.id = 'four-tint-' + c;
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const matrix = document.createElementNS(NS, 'feColorMatrix');
      matrix.setAttribute('type', 'matrix');
      matrix.setAttribute('values', `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
      filter.appendChild(matrix);
      defs.appendChild(filter);
    }
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  function create(boardEl, handlers) {
    addTints();
    boardEl.classList.add('four');
    const detachDrag = BoardDrag.attach(boardEl, {
      sources: handlers.dragSources || [],
      canDrag: handlers.canDrag,
      onPick: handlers.onPick,
      onDrop: handlers.onDrop,
    });
    const detachArrows = BoardArrows.attach(boardEl);
    const onContextMenu = (e) => { if (handlers.onContextMenu) handlers.onContextMenu(e); };
    boardEl.addEventListener('contextmenu', onContextMenu);

    const sqEl = (sq) => boardEl.querySelector(`.square[data-sq="${sq}"]`);

    function pieceImg(piece, cls) {
      const img = document.createElement('img');
      img.src = handlers.pieceSrc({ t: piece.t, c: 'w' });
      img.className = cls + ' four-' + piece.c;
      if (piece.t === 'p') img.classList.add('pawn');
      img.draggable = false;
      return img;
    }

    function render(state) {
      boardEl.innerHTML = '';
      const { pieces, lastMove, premove, selected, check, mustCapture, hints } = state;
      const bottom = state.bottom || 'r';
      // Quarter turns from the screen to the board: the screen shows the
      // board as `bottom` sees it, its own army along the lowest rows.
      const turns = FourPlayer.COLORS.indexOf(bottom);
      const inCheck = (sq) => (check instanceof Set ? check.has(sq) : check === sq);
      // Labels name what stays the same along a screen column or row: files
      // and ranks for Red and Yellow, ranks and files for Blue and Green.
      const label = (x, y, along) => ((turns % 2 === 0) === (along === 'col') ? String.fromCharCode(97 + x) : String(y + 1));

      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const [x, y] = FourPlayer.rotate(col, N - 1 - row, turns);
          if (!FourPlayer.onBoard(x, y)) {
            const v = document.createElement('div');
            v.className = 'void';
            boardEl.appendChild(v);
            continue;
          }
          const sq = FourPlayer.sqOf(x, y);
          const div = document.createElement('div');
          // Light on the right, as in ordinary chess: Red's corner k1 and
          // Yellow's d14 are light. On a board of even size a quarter turn
          // swaps the colours, so Blue's and Green's corners are dark.
          div.className = 'square ' + ((x + y) % 2 === 0 ? 'light' : 'dark');
          div.dataset.sq = sq;

          if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add('last-move');
          if (mustCapture && mustCapture.has(sq)) div.classList.add('must-capture');
          if (premove && (premove.from === sq || premove.to === sq)) div.classList.add('premove');
          if (selected === sq) div.classList.add('selected');
          if (inCheck(sq)) div.classList.add('check');

          // On the edge of the cross: the first square of each screen row,
          // the last of each screen column.
          const firstInRow = col === (row < 3 || row > 10 ? 3 : 0);
          const lastInCol = row === (col < 3 || col > 10 ? 10 : N - 1);
          if (firstInRow) {
            const c = document.createElement('div');
            c.className = 'coord rank';
            c.textContent = label(x, y, 'row');
            div.appendChild(c);
          }
          if (lastInCol) {
            const c = document.createElement('div');
            c.className = 'coord file';
            c.textContent = label(x, y, 'col');
            div.appendChild(c);
          }

          const piece = pieces[sq];
          if (piece) {
            const img = pieceImg(piece, 'piece');
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

          div.addEventListener('click', () => { if (handlers.onSquareClick) handlers.onSquareClick(sq); });
          boardEl.appendChild(div);
        }
      }
      return animate(state.animation);
    }

    // As gridBoardView.js: slide the moved piece in from where it came, and
    // fade out what it took.
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
          const ghost = pieceImg(anim.captured.piece, 'ghost');
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
      detachDrag();
      detachArrows();
      boardEl.removeEventListener('contextmenu', onContextMenu);
      boardEl.classList.remove('four');
      boardEl.innerHTML = '';
    }

    return { render, destroy };
  }

  return { create, COLOURS };
})();
