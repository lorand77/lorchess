"use strict";

// Gambling Madness: the wheel that spins over the board when a turn is dealt.
// It is only a show. The deal is made before it starts (by the server, or by
// the page against LorFish), the board stays usable while it turns, and any
// click on the board stops it. It has one equal slice per type the side to
// move could have been dealt, since each is as likely, so the wheel shows the
// real odds. Off with the system's "reduce motion", or with the switch on the
// Customize page, which is kept in this browser (localStorage).

const DealWheel = (function () {
  const KEY = "lorchess.dealWheel";
  const SPIN_MS = 900;   // under LorFish's quickest reply (moveSource.js), so its wheel stops first
  const FADE_MS = 200;
  const TURNS = 3;       // whole turns before it settles
  // Each type's slice colour, the same on every wheel.
  const COLOURS = { p: "#7fa650", n: "#5b8bd0", b: "#c97bd1", r: "#d9963b", q: "#d35b5b", k: "#d8c24a" };

  let current = null;    // { el, anim, onDone, timer }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // The switch on the Customize page; on unless turned off.
  function wanted() {
    try { return localStorage.getItem(KEY) !== "off"; } catch (e) { return true; }
  }
  function setWanted(on) {
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch (e) { /* private mode */ }
  }
  function enabled() {
    return wanted() && !reducedMotion();
  }

  // Spin over `board`, inside `host` (its positioned wrapper), and stop on
  // `dealt`, one of `types`. `src(t)` is a type's piece image; `onDone` runs
  // once the wheel has gone, stopped or skipped. Returns whether it spun.
  function spin(host, board, opts) {
    stop();
    const types = opts.types || [];
    const i = types.indexOf(opts.dealt);
    if (!enabled() || i < 0 || typeof Element.prototype.animate !== "function") return false;
    const slice = 360 / types.length;

    const el = document.createElement("div");
    el.className = "deal-wheel";
    el.setAttribute("aria-hidden", "true");
    el.style.top = board.offsetTop + board.offsetHeight / 2 + "px";
    const disc = document.createElement("div");
    disc.className = "deal-wheel-disc";
    disc.style.background = "conic-gradient(" + types.map((t, k) =>
      `${COLOURS[t]} ${k * slice}deg ${(k + 1) * slice}deg`).join(", ") + ")";
    types.forEach((t, k) => {
      const a = (k + 0.5) * slice * Math.PI / 180;
      const img = document.createElement("img");
      img.src = opts.src(t);
      img.alt = "";
      img.dataset.type = t;
      img.style.left = 50 + 31 * Math.sin(a) + "%";
      img.style.top = 50 - 31 * Math.cos(a) + "%";
      disc.appendChild(img);
    });
    const pointer = document.createElement("div");
    pointer.className = "deal-wheel-pointer";
    el.append(disc, pointer);
    host.appendChild(el);

    // Clockwise until the dealt slice is under the pointer at the top,
    // somewhere inside it rather than always on its middle.
    const jitter = (Math.random() - 0.5) * slice * 0.6;
    const end = TURNS * 360 - (i + 0.5) * slice + jitter;
    const anim = disc.animate(
      [{ transform: "rotate(0deg)" }, { transform: `rotate(${end}deg)` }],
      { duration: SPIN_MS, easing: "cubic-bezier(.12,.7,.2,1)", fill: "forwards" });
    const me = { el, anim, onDone: opts.onDone, timer: null };
    current = me;
    anim.finished.then(() => {
      if (current !== me) return;
      el.classList.add("done");
      me.timer = setTimeout(() => { if (current === me) stop(); }, FADE_MS);
    }, () => { /* cancelled by stop() */ });
    return true;
  }

  // Take the wheel away now, if one is up, and tell its owner.
  function stop() {
    const me = current;
    if (!me) return;
    current = null;
    clearTimeout(me.timer);
    me.anim.cancel();
    me.el.remove();
    if (me.onDone) me.onDone();
  }

  return { spin, skip: stop, spinning: () => !!current, enabled, wanted, setWanted, KEY, SPIN_MS };
})();
