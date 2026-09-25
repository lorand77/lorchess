"use strict";

// The profile page: whose it is, then four tabs — Stats, My Games,
// Achievements, Friends. ?id=<userId> shows someone else's, which has only the
// two tabs that make sense for a visitor.
//
// Each tab's script (stats.js, history.js, achievementsPage.js, friendsPage.js)
// registers a function in window.profileTabs; this runs it the first time that
// tab is shown, so opening the page doesn't also open the Friends socket or
// fetch a game list nobody asked for. The tab lives in the URL hash, so tabs
// can be linked to and back/forward moves between them.

(function () {
  const id = new URLSearchParams(location.search).get("id");
  const nameEl = document.getElementById("profileName");
  const metaEl = document.getElementById("profileMeta");
  const errEl = document.getElementById("profileError");
  const tabsEl = document.getElementById("profileTabs");
  const tabs = window.profileTabs || {};
  const started = {};
  let ctx;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const fmtDate = (s) => {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? "" : d.toLocaleDateString();
  };

  // The stats payload carries the user and whether they are you, which the
  // header and the choice of tabs both need — so it is fetched here, once, and
  // handed to the Stats tab rather than fetched again there.
  async function load() {
    let data;
    try {
      const res = await fetch("/api/stats" + (id ? "/" + encodeURIComponent(id) : ""),
        { credentials: "same-origin" });
      if (res.status === 401) { location.replace("/login.html"); return; }
      if (res.status === 404) { errEl.textContent = "No such player."; return; }
      if (!res.ok) throw new Error();
      data = await res.json();
    } catch (e) {
      errEl.textContent = "Couldn't load that profile.";
      return;
    }

    const u = data.user;
    const you = data.you !== false;
    // Your own id in the URL is still your own profile, with all four tabs.
    ctx = { data, you, userId: you ? null : u.id };

    nameEl.textContent = u.username;
    if (u.member) nameEl.appendChild(memberBadge());
    document.title = "LorChess — " + u.username;
    metaEl.textContent = "Joined " + fmtDate(u.createdAt);
    if (!you) renderVisitor(u);

    for (const a of tabsEl.querySelectorAll("[data-own]")) a.hidden = !you;
    tabsEl.style.display = "";
    show();
    window.addEventListener("hashchange", show);
  }

  // Someone else's profile: word it for a visitor, and offer a friend control.
  function renderVisitor(u) {
    for (const s of document.querySelectorAll("[data-them]")) s.textContent = s.dataset.them;
    if (!window.Friends) return;
    const actions = document.getElementById("profileActions");
    Friends.load()
      .then(() => {
        const slot = el("span", "friend-slot");
        const draw = () => {
          slot.innerHTML = "";
          slot.appendChild(Friends.button(u.id, draw, {
            onError: (msg) => { errEl.textContent = msg || ""; },
          }));
        };
        draw();
        actions.appendChild(slot);
        actions.style.display = "";
      })
      .catch(() => { /* the profile works fine without it */ });
  }

  function show() {
    let key = location.hash.slice(1);
    const link = tabsEl.querySelector(`[data-tab="${CSS.escape(key)}"]`);
    if (!link || link.hidden) key = "stats";

    for (const a of tabsEl.querySelectorAll("[data-tab]")) {
      const on = a.dataset.tab === key;
      a.classList.toggle("current", on);
      a.setAttribute("aria-selected", String(on));
    }
    for (const panel of document.querySelectorAll(".profile-tab")) {
      panel.hidden = panel.id !== "tab-" + key;
    }

    if (!started[key] && tabs[key]) {
      started[key] = true;
      tabs[key](ctx);
    }
  }

  load();
})();
