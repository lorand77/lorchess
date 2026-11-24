"use strict";

// The customization panel. Colour, board style, piece set and fog edits are
// applied to the page immediately (via Theme.apply) as a live preview and
// persisted with Save; image uploads go straight to the server and then the
// theme is reloaded from it. The styles and sets are looks.js's. The Games
// panel's switch is this browser's own and is saved as soon as it changes.

(function () {
  const PIECES = [
    ["w", "K", "King"], ["w", "Q", "Queen"], ["w", "R", "Rook"],
    ["w", "B", "Bishop"], ["w", "N", "Knight"], ["w", "P", "Pawn"],
    ["b", "K", "King"], ["b", "Q", "Queen"], ["b", "R", "Rook"],
    ["b", "B", "Bishop"], ["b", "N", "Knight"], ["b", "P", "Pawn"],
  ];
  const BOARD_PRESETS = [
    ["Classic", "#f0d9b5", "#b58863"],
    ["Green", "#eeeed2", "#769656"],
    ["Blue", "#dee3e6", "#8ca2ad"],
    ["Walnut", "#e8d0aa", "#8b5a2b"],
    ["Grey", "#d9d9d9", "#7a7a7a"],
    ["Purple", "#e6dcf0", "#8a6fb0"],
  ];
  const BG_PRESETS = [
    ["Charcoal", "#323232"], ["Midnight", "#1c2331"], ["Forest", "#1f2d24"],
    ["Slate", "#3b4252"], ["Wine", "#3a2228"], ["Black", "#111111"],
    ["Light grey", "#ececec"], ["Paper", "#f4f1ea"], ["Mist", "#e6ecf2"], ["White", "#ffffff"],
  ];
  // Standard start position, rank 8 down to rank 1.
  const START = ["rnbqkbnr", "pppppppp", "", "", "", "", "PPPPPPPP", "RNBQKBNR"];

  const $ = (id) => document.getElementById(id);
  const boardEl = $("previewBoard");
  const inputs = { light: $("lightColor"), dark: $("darkColor"), bgColor: $("bgColor") };
  const hexes = { light: $("lightHex"), dark: $("darkHex"), bgColor: $("bgHex") };
  const saveBtn = $("saveBtn");
  const revertBtn = $("revertBtn");
  const msgEl = $("settingsMsg");

  let saved = null; // last settings confirmed by the server
  let draft = null; // colours currently previewed

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let msgTimer = null;
  function say(text, ok) {
    msgEl.textContent = text || "";
    msgEl.className = "settings-msg " + (ok ? "ok" : "bad");
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => { msgEl.textContent = ""; }, 4000);
  }

  async function api(method, path, body, headers) {
    const res = await fetch("/api/settings" + path, {
      method,
      credentials: "same-origin",
      headers,
      body,
    });
    if (res.status === 401) { location.replace("/login.html"); throw new Error("Not logged in."); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON (e.g. body-parser 413) */ }
    if (!res.ok) throw new Error(data.error || (res.status === 413 ? "File too large." : "Request failed."));
    return data;
  }

  // Gambling Madness's wheel: a choice for this browser (dealWheel.js), saved
  // as it is ticked, apart from the colours' Save.
  const wheelToggle = $("dealWheelToggle");
  wheelToggle.checked = DealWheel.wanted();
  wheelToggle.addEventListener("change", () => {
    DealWheel.setWanted(wheelToggle.checked);
    say(wheelToggle.checked ? "The wheel will spin." : "The wheel is off.", true);
  });

  const pick = (s) => ({
    scheme: s.scheme, light: s.light, dark: s.dark, bgColor: s.bgColor,
    pieceSet: s.pieceSet, boardStyle: s.boardStyle, fogStyle: s.fogStyle,
  });
  const dirty = () => !!saved && Object.keys(draft).some((k) => draft[k] !== saved[k]);

  // ---- preview board ----
  function renderPreview() {
    boardEl.innerHTML = "";
    START.forEach((rank, row) => {
      for (let col = 0; col < 8; col++) {
        const r = 7 - row, f = col;
        const sq = el("div", "square " + ((r + f) % 2 === 0 ? "dark" : "light"));
        if (col === 0) sq.appendChild(el("div", "coord rank", String(r + 1)));
        if (row === 7) sq.appendChild(el("div", "coord file", String.fromCharCode(97 + f)));
        const ch = rank[col];
        if (ch) {
          const img = document.createElement("img");
          const color = ch === ch.toUpperCase() ? "w" : "b";
          img.src = Theme.pieceSrc(color, ch.toLowerCase());
          if (ch.toLowerCase() === "p") img.classList.add("pawn");
          img.draggable = false;
          img.alt = "";
          sq.appendChild(img);
        }
        boardEl.appendChild(sq);
      }
    });
  }

  // ---- colours ----
  const schemeInputs = document.querySelectorAll('input[name="scheme"]');

  function setInputs(colors) {
    for (const k of Object.keys(inputs)) {
      inputs[k].value = colors[k];
      hexes[k].textContent = colors[k];
    }
    for (const r of schemeInputs) r.checked = r.value === colors.scheme;
    for (const r of document.querySelectorAll('input[name="boardStyle"]')) r.checked = r.value === colors.boardStyle;
    for (const r of document.querySelectorAll('input[name="pieceSet"]')) r.checked = r.value === colors.pieceSet;
    for (const r of document.querySelectorAll('input[name="fogStyle"]')) r.checked = r.value === colors.fogStyle;
    // Flat and Shaded are drawn in the colours being tried.
    for (const sw of document.querySelectorAll('.style-swatch.own')) {
      sw.querySelector(".light").style.background = colors.light;
      sw.querySelector(".dark").style.background = colors.dark;
    }
  }

  function previewDraft() {
    Theme.apply({ ...saved, ...draft });
    setInputs(draft);
    saveBtn.disabled = revertBtn.disabled = !dirty();
    // The preview board and the piece slots show the set being tried.
    if (saved) { renderPreview(); renderPieces(); }
  }

  // ---- board style and piece set: one radio each, from looks.js ----
  function choices(host, name, list, sample) {
    for (const item of list) {
      const label = el("label", "scheme-opt");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = item.key;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        draft[name] = item.key;
        previewDraft();
      });
      label.append(input, sample(item), document.createTextNode(" " + item.label));
      host.appendChild(label);
    }
  }
  // A style's swatch: a light and a dark square, as that style draws them.
  choices($("boardStyles"), "boardStyle", BOARD_STYLES, (item) => {
    const sw = el("span", "style-swatch" + (item.ownColours ? " own" : ""));
    sw.dataset.style = item.key;
    sw.append(el("span", "light"), el("span", "dark"));
    return sw;
  });
  choices($("fogStyles"), "fogStyle", FOG_STYLES, (item) => {
    const sw = el("span", "fog-sample");
    sw.dataset.fog = item.key;
    return sw;
  });
  choices($("pieceSets"), "pieceSet", PIECE_SETS, (item) => {
    const img = document.createElement("img");
    img.className = "set-sample";
    img.src = pieceUrl(item.key, "w", "n");
    img.alt = "";
    return img;
  });

  for (const k of Object.keys(inputs)) {
    inputs[k].addEventListener("input", () => {
      draft[k] = inputs[k].value.toLowerCase();
      previewDraft();
    });
  }

  // Switching scheme also brings the page colour along, but only if it is still
  // the other scheme's default — a colour the user chose themselves stays put.
  for (const r of schemeInputs) {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const other = r.value === "light" ? "dark" : "light";
      if (draft.bgColor === Theme.SCHEME_BG[other]) draft.bgColor = Theme.SCHEME_BG[r.value];
      draft.scheme = r.value;
      previewDraft();
    });
  }

  function presetButtons(host, presets, onPick) {
    for (const p of presets) {
      const b = el("button", "", "");
      const sw = el("span", "preset-swatch");
      sw.style.setProperty("--a", p[1]);
      sw.style.setProperty("--b", p[2] || p[1]);
      b.append(sw, document.createTextNode(p[0]));
      b.addEventListener("click", () => onPick(p));
      host.appendChild(b);
    }
  }
  presetButtons($("boardPresets"), BOARD_PRESETS, (p) => {
    draft.light = p[1]; draft.dark = p[2]; previewDraft();
  });
  presetButtons($("bgPresets"), BG_PRESETS, (p) => {
    draft.bgColor = p[1]; previewDraft();
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      saved = await api("PUT", "", JSON.stringify(draft), { "Content-Type": "application/json" });
      await Theme.load(); // refresh the cached copy other pages paint from
      draft = pick(saved);
      previewDraft();
      say("Saved.", true);
    } catch (err) {
      say(err.message, false);
      saveBtn.disabled = false;
    }
  });

  revertBtn.addEventListener("click", () => {
    draft = pick(saved);
    previewDraft();
  });

  // ---- images ----
  async function upload(kind, file) {
    return api("PUT", "/assets/" + kind, file, { "Content-Type": file.type || "application/octet-stream" });
  }

  async function afterAssetChange(promise, okText) {
    try {
      saved = await promise;
      await Theme.load();
      draft = { ...draft }; // keep unsaved colour edits on top of the new server state
      previewDraft();
      renderAssets();
      say(okText, true);
    } catch (err) {
      say(err.message, false);
    }
  }

  // Single-image slots, each a row of <kind>File, <kind>Thumb and <kind>Remove.
  const IMAGE_SLOTS = [
    ["bg", "Background image"],
    ["sqLight", "Light square image"],
    ["sqDark", "Dark square image"],
  ];
  for (const [kind, name] of IMAGE_SLOTS) {
    const file = $(kind + "File");
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      file.value = "";
      if (f) afterAssetChange(upload(kind, f), name + " uploaded.");
    });
    $(kind + "Remove").addEventListener("click", () =>
      afterAssetChange(api("DELETE", "/assets/" + kind), name + " removed."));
  }

  const grid = $("pieceGrid");
  function renderPieces() {
    grid.innerHTML = "";
    for (const [c, t, name] of PIECES) {
      const kind = c + t;
      const slot = el("label", "piece-slot");
      slot.title = "Replace " + (c === "w" ? "white " : "black ") + name.toLowerCase();
      const img = document.createElement("img");
      img.src = Theme.pieceSrc(c, t.toLowerCase());
      img.alt = "";
      const custom = !!Theme.current.assets[kind];
      slot.appendChild(img);
      slot.appendChild(el("span", custom ? "custom" : "", (c === "w" ? "White " : "Black ") + name));
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (f) afterAssetChange(upload(kind, f), name + " replaced.");
      });
      slot.appendChild(input);
      if (custom) {
        const x = el("button", "clear", "×");
        x.type = "button";
        x.title = "Back to the default " + name.toLowerCase();
        x.addEventListener("click", (e) => {
          e.preventDefault();
          afterAssetChange(api("DELETE", "/assets/" + kind), name + " reset.");
        });
        slot.appendChild(x);
      }
      grid.appendChild(slot);
    }
  }

  $("piecesReset").addEventListener("click", async () => {
    const custom = PIECES.map(([c, t]) => c + t).filter((k) => Theme.current.assets[k]);
    if (!custom.length) return say("All pieces are already the defaults.", true);
    if (!confirm("Reset all " + custom.length + " custom piece image(s)?")) return;
    try {
      for (const k of custom) saved = await api("DELETE", "/assets/" + k);
      await Theme.load();
      previewDraft();
      renderAssets();
      say("Pieces reset.", true);
    } catch (err) {
      say(err.message, false);
    }
  });

  $("resetAllBtn").addEventListener("click", () => {
    if (!confirm("Reset colours, board and background images, and pieces to the defaults?")) return;
    afterAssetChange(api("POST", "/reset"), "Everything reset.").then(() => {
      draft = pick(saved);
      previewDraft();
    });
  });

  function renderAssets() {
    for (const [kind] of IMAGE_SLOTS) {
      const url = Theme.assetUrl(kind);
      const thumb = $(kind + "Thumb");
      thumb.style.display = $(kind + "Remove").style.display = url ? "" : "none";
      if (url) thumb.src = url;
    }
    renderPieces();
    renderPreview();
  }

  // ---- boot ----
  Theme.load()
    .then((s) => {
      saved = s;
      draft = pick(s);
      previewDraft();
      renderAssets();
    })
    .catch(() => say("Could not load your settings.", false));
})();
