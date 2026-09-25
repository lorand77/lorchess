"use strict";

// The profile's Stats tab: the headline numbers as stat tiles, the record as
// one part-to-whole bar, and two lines over time. profile.js has already
// fetched the data (it needs the user for the page header) and passes it in.

(window.profileTabs = window.profileTabs || {}).stats = function ({ data: d, you }) {
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
  const u = d.user;

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
};
