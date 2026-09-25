"use strict";

// The profile's Games tab: the profile owner's games, with the result from
// their side and a link into the replay viewer. On your own profile an
// unfinished game offers Resume; on someone else's, a live PvP game offers
// Watch (an AI game runs in its player's browser, so there is nothing to watch).

(window.profileTabs = window.profileTabs || {}).games = async function ({ data, you, userId }) {
  const content = document.getElementById("historyContent");
  const user = data.user;
  const url = you ? "/api/games" : "/api/games/user/" + encodeURIComponent(userId);

  let games;
  try {
    const gamesRes = await fetch(url, { credentials: "same-origin" });
    if (gamesRes.status === 401) {
      location.replace("/login.html");
      return;
    }
    if (gamesRes.status === 404) {
      content.textContent = "No such player.";
      return;
    }
    if (!gamesRes.ok) throw new Error("HTTP " + gamesRes.status);
    games = await gamesRes.json();
  } catch (e) {
    content.textContent = "Failed to load games.";
    return;
  }

  if (!games.length) {
    content.innerHTML = you
      ? '<p class="muted">No games yet. <a href="/lobby.html">Play one →</a></p>'
      : '<p class="muted">No games yet.</p>';
    return;
  }

  const table = document.createElement("table");
  table.className = "history-table";
  table.innerHTML =
    `<thead><tr><th>Date</th><th>Mode</th><th>${you ? "You" : "As"}</th><th>Opponent</th><th>Result</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const g of games) {
    const asWhite = g.white_id === user.id;
    const opp = asWhite ? g.black_username : g.white_username;
    const oppId = Number(asWhite ? g.black_id : g.white_id);
    const oppCell = g.mode === "pvp" && oppId
      ? playerLink(oppId, opp || "?").outerHTML
      : escapeHtml(opp || "?");
    const res = outcome(g, asWhite);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${fmtDate(g.created_at)}</td>` +
      `<td>${g.mode === "ai" ? "vs AI" : "PvP"}</td>` +
      `<td>${asWhite ? "White" : "Black"}</td>` +
      `<td>${oppCell}</td>` +
      `<td class="${res.cls}">${res.text}</td>` +
      `<td>${action(g)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.innerHTML = "";
  content.appendChild(table);

  function action(g) {
    if (g.status !== "active") {
      // Opened from someone else's profile, the replay takes their side.
      const as = you ? "" : "&as=" + user.id;
      return `<a class="replay-link" href="/replay.html?id=${g.id}${as}">Replay →</a>`;
    }
    if (you) return `<a class="replay-link" href="/game.html?id=${g.id}">Resume →</a>`;
    if (g.mode === "pvp") return `<a class="replay-link" href="/game.html?watch=${g.id}">Watch →</a>`;
    return "";
  }

  function outcome(g, asWhite) {
    if (g.status === "active") return { text: "In progress", cls: "out-progress" };
    if (g.status === "aborted") return { text: "Aborted", cls: "out-draw" };
    if (g.result === "1/2-1/2") return { text: "Draw", cls: "out-draw" };
    const won = (g.result === "1-0" && asWhite) || (g.result === "0-1" && !asWhite);
    const term = g.termination ? ` (${escapeHtml(g.termination)})` : "";
    return { text: (won ? "Win" : "Loss") + term, cls: won ? "out-win" : "out-loss" };
  }

  // SQLite datetime('now') is UTC like "2026-06-26 13:35:07".
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T") + "Z");
    if (isNaN(d)) return s;
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
};
