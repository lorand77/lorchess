"use strict";

// Player stats: the headline numbers as stat tiles, the record as one
// part-to-whole bar, and two lines over time. ?id=<userId> shows someone else.

(function () {
  const id = new URLSearchParams(location.search).get("id");
  const nameEl = document.getElementById("statsName");
  const metaEl = document.getElementById("statsMeta");
  const errEl = document.getElementById("statsError");
  const bodyEl = document.getElementById("statsBody");

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A stat tile: the number leads, the label explains it.
  function tile(parent, value, label, cls) {
    const t = el("div", "stat-tile" + (cls ? " " + cls : ""));
    t.append(el("div", "stat-value", value), el("div", "stat-label", label));
    parent.appendChild(t);
  }

  const pct = (v) => (v == null ? "—" : v.toFixed(1) + "%");
  const fmtDate = (s) => {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? "" : d.toLocaleDateString();
  };

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
      errEl.textContent = "Couldn't load those stats.";
      return;
    }
    render(data);
  }

  // Someone else's stats: word it for a visitor, and offer their
  // achievements and a friend control.
  function renderVisitor(u) {
    for (const s of document.querySelectorAll("[data-them]")) s.textContent = s.dataset.them;
    const actions = document.getElementById("statsActions");
    actions.innerHTML = "";
    const ach = el("a", "nav-link", "🏅 Achievements");
    ach.href = "/achievements.html?user=" + encodeURIComponent(u.id);
    actions.appendChild(ach);
    actions.style.display = "";
    if (!window.Friends) return;
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
      })
      .catch(() => { /* the stats page works fine without it */ });
  }

  function render(d) {
    const u = d.user;
    const you = d.you !== false;
    if (!you) renderVisitor(u);
    nameEl.textContent = u.username;
    if (u.member) nameEl.appendChild(memberBadge());
    document.title = "LorChess — " + u.username;
    metaEl.textContent = "Joined " + fmtDate(u.createdAt);
    bodyEl.style.display = "";

    const ratings = document.getElementById("ratingRow");
    tile(ratings, String(u.rating), "Rating");
    tile(ratings, u.puzzleRating == null ? "—" : String(u.puzzleRating), "Puzzle rating");

    // --- games ---
    const g = d.games.pvp;
    const gs = document.getElementById("gameStats");
    tile(gs, String(g.played), "Played");
    tile(gs, String(g.wins), "Won", "good");
    tile(gs, String(g.losses), "Lost", "bad");
    tile(gs, String(g.draws), "Drawn");
    tile(gs, pct(g.winRate), "Win rate");

    Chart.recordBar(document.getElementById("recordBar"), g);

    const rows = document.getElementById("colourRows");
    for (const [label, r] of [["White", d.games.white], ["Black", d.games.black]]) {
      const tr = el("tr");
      for (const v of [label, r.played, r.wins, r.losses, r.draws, pct(r.winRate)]) {
        tr.appendChild(el("td", null, String(v)));
      }
      rows.appendChild(tr);
    }

    Chart.line(document.getElementById("ratingChart"), {
      points: (d.games.ratingHistory || []).map((h) => ({
        at: h.at,
        value: h.value,
        note: h.delta == null ? "" : "(" + (h.delta >= 0 ? "+" : "") + h.delta + ")",
      })),
      color: Chart.COLORS.green,
      ariaLabel: "Rating over time",
      empty: you
        ? "Your rating history starts with your next rated game against another player."
        : "No rated games against other players yet.",
    });

    // --- puzzles ---
    const p = d.puzzles;
    const ps = document.getElementById("puzzleStats");
    tile(ps, String(p.attempted), "Attempted");
    tile(ps, String(p.solved), "Solved", "good");
    tile(ps, String(p.failed), "Failed", "bad");
    tile(ps, pct(p.successRate), "Success rate");

    Chart.line(document.getElementById("puzzleChart"), {
      points: p.history.map((h) => ({ at: h.at, value: h.value })),
      color: Chart.COLORS.violet,
      ariaLabel: "Puzzle rating over time",
      empty: you
        ? "Solve a few puzzles and your rating history appears here."
        : "No rated puzzle attempts yet.",
    });

    // --- vs LorFish ---
    const ai = d.games.ai;
    if (!ai.played) {
      document.getElementById("aiPanel").style.display = "none";
    } else {
      const as = document.getElementById("aiStats");
      tile(as, String(ai.played), "Played");
      tile(as, String(ai.wins), "Won", "good");
      tile(as, String(ai.losses), "Lost", "bad");
      tile(as, String(ai.draws), "Drawn");
      tile(as, pct(ai.winRate), "Win rate");
    }
  }

  load();
})();
