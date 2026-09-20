"use strict";

// The customization panel. Colour edits are applied to the page immediately
// (via Theme.apply) as a live preview and persisted with Save; image uploads
// go straight to the server and then the theme is reloaded from it.

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

  const pick = (s) => ({ light: s.light, dark: s.dark, bgColor: s.bgColor });
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
  function setInputs(colors) {
    for (const k of Object.keys(inputs)) {
      inputs[k].value = colors[k];
      hexes[k].textContent = colors[k];
    }
  }

  function previewDraft() {
    Theme.apply({ ...saved, ...draft });
    setInputs(draft);
    saveBtn.disabled = revertBtn.disabled = !dirty();
  }

  for (const k of Object.keys(inputs)) {
    inputs[k].addEventListener("input", () => {
      draft[k] = inputs[k].value.toLowerCase();
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

  const bgFile = $("bgFile");
  const bgThumb = $("bgThumb");
  const bgRemove = $("bgRemove");
  bgFile.addEventListener("change", () => {
    const f = bgFile.files && bgFile.files[0];
    bgFile.value = "";
    if (f) afterAssetChange(upload("bg", f), "Background image uploaded.");
  });
  bgRemove.addEventListener("click", () => afterAssetChange(api("DELETE", "/assets/bg"), "Background image removed."));

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
    if (!confirm("Reset colours, background, and pieces to the defaults?")) return;
    afterAssetChange(api("POST", "/reset"), "Everything reset.").then(() => {
      draft = pick(saved);
      previewDraft();
    });
  });

  function renderAssets() {
    const bg = Theme.assetUrl("bg");
    bgThumb.style.display = bg ? "" : "none";
    bgRemove.style.display = bg ? "" : "none";
    if (bg) bgThumb.src = bg;
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
