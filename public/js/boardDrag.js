"use strict";

// Drag-and-drop for a chess board, layered on top of the existing tap-to-move
// without replacing it. Pointer Events are used throughout, so mouse, touch and
// stylus all run the same code path — there is no separate touch handler.
//
// How it coexists with click-to-move: a press only becomes a drag once the
// pointer travels DRAG_THRESHOLD pixels. Below that it is a tap, and this module
// does nothing at all, leaving the board's own click handlers to behave exactly
// as before. When a drag does happen, the click that the browser synthesises on
// release is swallowed so it can't be read as a second tap.
//
// The board is re-rendered from scratch (innerHTML = '') on every state change,
// which can happen mid-drag — the opponent moves, a clock ticks a redraw. So
// nothing here holds a long-lived element reference: squares are always looked
// up by their data-sq attribute at the moment they're needed, and the dragged
// image is a clone parented to <body>, which no re-render can touch.
//
// Host board requirements:
//   - squares are `.square` elements inside the container, with `data-sq="<0-63>"`
//   - a piece is an `img.piece` inside its square
//
// Handlers:
//   canDrag(sq) -> bool     may the user pick up whatever is on this square?
//   onPick(sq)              they did; select it and show hints (may re-render)
//   onDrop(from, to)        released over square `to`, or null if cancelled /
//                           dropped off the board

window.BoardDrag = (function () {
  const DRAG_THRESHOLD = 5;   // px before a press counts as a drag, not a tap
  const TOUCH_LIFT = 0.55;    // raise the piece this fraction of a square above
                              // a finger, so it isn't hidden under it

  function attach(boardEl, handlers) {
    if (!boardEl || !handlers) return function () {};
    // Marks the board as a drag surface: CSS uses it to turn off touch panning
    // so a swipe that starts on the board moves a piece instead of scrolling.
    boardEl.classList.add("board-draggable");

    let drag = null;          // in-flight press/drag, see onPointerDown
    let suppressClick = false;

    const squareEl = (sq) =>
      boardEl.querySelector('.square[data-sq="' + sq + '"]');

    // Which square is under a viewport point? Hit-tests the real DOM, so it
    // naturally ignores the dragged clone (pointer-events: none) and resolves
    // hint/coordinate children up to their square.
    function squareAt(x, y) {
      const hit = document.elementFromPoint(x, y);
      const sq = hit && hit.closest ? hit.closest(".square") : null;
      if (!sq || !boardEl.contains(sq)) return null;
      const n = Number(sq.dataset.sq);
      return Number.isInteger(n) ? n : null;
    }

    const squareSize = () => boardEl.getBoundingClientRect().width / 8;

    function onPointerDown(e) {
      // Any new press invalidates a pending click suppression. Dropping outside
      // the board produces no click on us, so without this the flag could
      // linger and eat the next genuine tap.
      suppressClick = false;
      if (drag) return;
      if (e.button != null && e.button !== 0) return; // left button / touch only
      const sqDiv = e.target.closest && e.target.closest(".square");
      if (!sqDiv || !boardEl.contains(sqDiv)) return;
      const from = Number(sqDiv.dataset.sq);
      if (!Number.isInteger(from)) return;
      if (!handlers.canDrag(from)) return;

      drag = {
        pointerId: e.pointerId,
        from,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        touch: e.pointerType === "touch",
        ghost: null,
        lift: 0,
        hover: null,
      };
    }

    // Promote a press into a real drag: select the piece, then lift a clone of
    // it out of the board and follow the pointer with it.
    function beginDrag(e) {
      // onPick shows the move hints, which re-renders — so only look the piece
      // up afterwards, or we'd hold a detached node.
      handlers.onPick(drag.from);
      const src = squareEl(drag.from);
      const img = src && src.querySelector("img.piece");
      if (!img) { endDrag(); return; }

      const rect = img.getBoundingClientRect();
      const ghost = img.cloneNode(true);
      ghost.classList.add("drag-piece");
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      document.body.appendChild(ghost);
      img.classList.add("dragging");

      drag.started = true;
      drag.ghost = ghost;
      drag.lift = drag.touch ? squareSize() * TOUCH_LIFT : 0;
      moveGhost(e.clientX, e.clientY);
    }

    // Position the clone and highlight whatever square it is over. Hit-testing
    // uses the clone's centre rather than the raw pointer, so on touch — where
    // the piece rides above the finger — you aim with the piece you can see.
    function moveGhost(x, y) {
      const gy = y - drag.lift;
      drag.ghost.style.left = x + "px";
      drag.ghost.style.top = gy + "px";

      const over = squareAt(x, gy);
      if (over === drag.hover) return;
      const prev = drag.hover == null ? null : squareEl(drag.hover);
      if (prev) prev.classList.remove("drag-over");
      drag.hover = over;
      const next = over == null ? null : squareEl(over);
      if (next) next.classList.add("drag-over");
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
            Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
        beginDrag(e);
        if (!drag || !drag.started) return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        // Never moved: this was a tap. Stand aside and let the board's own
        // click handler deal with it, exactly as before this module existed.
        drag = null;
        return;
      }
      const from = drag.from;
      const to = drag.hover;
      endDrag();
      suppressClick = true; // the click after a drag is not a tap
      handlers.onDrop(from, to);
    }

    function cancelDrag() {
      if (!drag) return;
      const from = drag.from;
      const started = drag.started;
      endDrag();
      if (started) handlers.onDrop(from, null);
    }

    // Tear down the visual state. Everything is re-queried rather than
    // remembered, because the board may have re-rendered since the drag began.
    function endDrag() {
      if (!drag) return;
      if (drag.ghost) drag.ghost.remove();
      if (drag.hover != null) {
        const el = squareEl(drag.hover);
        if (el) el.classList.remove("drag-over");
      }
      const src = squareEl(drag.from);
      const img = src && src.querySelector("img.piece");
      if (img) img.classList.remove("dragging");
      drag = null;
    }

    function onClickCapture(e) {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") cancelDrag();
    }

    boardEl.addEventListener("pointerdown", onPointerDown);
    // Capture phase, so the swallowed click never reaches a square's own
    // listener (those are attached in the bubble phase by render()).
    boardEl.addEventListener("click", onClickCapture, true);
    // On window, not the board: a drag routinely travels outside it, and the
    // board's DOM is replaced underneath us mid-drag.
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("blur", cancelDrag);
    window.addEventListener("keydown", onKeyDown);

    return function detach() {
      endDrag();
      boardEl.classList.remove("board-draggable");
      boardEl.removeEventListener("pointerdown", onPointerDown);
      boardEl.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", cancelDrag);
      window.removeEventListener("blur", cancelDrag);
      window.removeEventListener("keydown", onKeyDown);
    };
  }

  return { attach };
})();
