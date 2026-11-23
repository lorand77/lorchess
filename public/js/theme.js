"use strict";

// Applies the user's look & feel on every page: light or dark scheme, board
// colours, board style and square images, page background (colour or
// uploaded image), and the piece set or custom piece images. Settings
// come from GET /api/settings; a copy is cached in localStorage so the page
// paints with the right colours before the fetch returns.
//
// Consumers: styles.css reads the CSS variables set here, and the board style
// from <html data-board-style>; ui.js / replay.js ask Theme.pieceSrc() for
// piece image URLs and redraw on "theme:changed". The piece sets and board
// styles are looks.js's, which every page loads first.

window.Theme = (function () {
  const CACHE_KEY = "lorchess.theme";
  const DEFAULTS = {
    scheme: "dark", light: "#f0d9b5", dark: "#b58863", bgColor: "#323232",
    pieceSet: DEFAULT_PIECE_SET, boardStyle: DEFAULT_BOARD_STYLE, assets: {},
  };
  // Each scheme's own default page colour. The Customize page swaps between
  // them when the scheme changes, unless the user picked a colour of their own.
  const SCHEME_BG = { dark: "#323232", light: "#ececec" };
  let current = { ...DEFAULTS };

  // URL of an uploaded slot ('bg', 'wK', …) or null if the user has none.
  function assetUrl(kind, settings) {
    const s = settings || current;
    const v = s.assets && s.assets[kind];
    return v ? "/api/settings/assets/" + kind + "?v=" + encodeURIComponent(v) : null;
  }

  // Image for a piece: custom upload if present, else the chosen set's.
  function pieceSrc(color, type, settings) {
    const s = settings || current;
    return assetUrl(color + type.toUpperCase(), s) || pieceUrl(s.pieceSet, color, type);
  }

  function apply(settings) {
    current = { ...DEFAULTS, ...(settings || {}), assets: (settings && settings.assets) || {} };
    // styles.css keys the light palette off this attribute.
    document.documentElement.dataset.scheme = current.scheme === "light" ? "light" : "dark";
    const st = document.documentElement.style;
    // A textured board style brings its own colours, for the coordinates and
    // the small boards; Flat and Shaded keep the player's.
    const style = BOARD_STYLES_BY_KEY.get(resolveBoardStyle(current.boardStyle));
    document.documentElement.dataset.boardStyle = style.key;
    st.setProperty("--sq-light", style.ownColours ? current.light : style.light);
    st.setProperty("--sq-dark", style.ownColours ? current.dark : style.dark);
    st.setProperty("--page-bg", current.bgColor);
    const bg = assetUrl("bg");
    st.setProperty("--page-bg-image", bg ? 'url("' + bg + '")' : "none");
    // Square images lie over the square colours, which show while they load.
    for (const [kind, prop] of [["sqLight", "--sq-light-image"], ["sqDark", "--sq-dark-image"]]) {
      const url = assetUrl(kind);
      st.setProperty(prop, url ? 'url("' + url + '")' : "none");
    }
    window.dispatchEvent(new CustomEvent("theme:changed", { detail: current }));
  }

  function cache(settings) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }

  // Drop the cache, on logout: the next person at this browser gets the
  // defaults, not the previous user's colours and background.
  function forget() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* private mode */ }
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

  return { apply, load, forget, pieceSrc, assetUrl, DEFAULTS, SCHEME_BG, get current() { return current; } };
})();
