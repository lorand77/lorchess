"use strict";

// Applies the user's look & feel on every page: board colours, page
// background (colour or uploaded image), and custom piece images. Settings
// come from GET /api/settings; a copy is cached in localStorage so the page
// paints with the right colours before the fetch returns.
//
// Consumers: styles.css reads the CSS variables set here; ui.js / replay.js
// ask Theme.pieceSrc() for piece image URLs and redraw on "theme:changed".

window.Theme = (function () {
  const CACHE_KEY = "lorchess.theme";
  const DEFAULTS = { light: "#f0d9b5", dark: "#b58863", bgColor: "#323232", assets: {} };
  const PIECE_FILES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
  let current = { ...DEFAULTS };

  // URL of an uploaded slot ('bg', 'wK', …) or null if the user has none.
  function assetUrl(kind, settings) {
    const s = settings || current;
    const v = s.assets && s.assets[kind];
    return v ? "/api/settings/assets/" + kind + "?v=" + encodeURIComponent(v) : null;
  }

  // Image for a piece: custom upload if present, else the bundled PNG.
  function pieceSrc(color, type, settings) {
    return (
      assetUrl(color + type.toUpperCase(), settings) ||
      "/assets/" + color + "_" + PIECE_FILES[type] + "_1x_ns.png"
    );
  }

  function apply(settings) {
    current = { ...DEFAULTS, ...(settings || {}), assets: (settings && settings.assets) || {} };
    const st = document.documentElement.style;
    st.setProperty("--sq-light", current.light);
    st.setProperty("--sq-dark", current.dark);
    st.setProperty("--page-bg", current.bgColor);
    const bg = assetUrl("bg");
    st.setProperty("--page-bg-image", bg ? 'url("' + bg + '")' : "none");
    window.dispatchEvent(new CustomEvent("theme:changed", { detail: current }));
  }

  function cache(settings) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }

  async function load() {
    const res = await fetch("/api/settings", { credentials: "same-origin" });
    if (!res.ok) throw new Error("settings " + res.status);
    const s = await res.json();
    cache(s);
    apply(s);
    return s;
  }

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cached) apply(cached);
  } catch (e) { /* no cache */ }
  load().catch(() => { /* not logged in or offline: defaults stay */ });

  return { apply, load, pieceSrc, assetUrl, DEFAULTS, get current() { return current; } };
})();
