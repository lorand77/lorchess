"use strict";

// Lists the current user's games (GET /api/games) with result from their
// perspective and a link into the replay viewer.

(async function () {
  const content = document.getElementById("historyContent");

  let user, games;
  try {
    const [meRes, gamesRes] = await Promise.all([
      fetch("/api/me", { credentials: "same-origin" }),
      fetch("/api/games", { credentials: "same-origin" }),
    ]);
    if (meRes.status === 401 || gamesRes.status === 401) {
      location.replace("/login.html");
      return;
    }
    user = await meRes.json();
    games = await gamesRes.json();
  } catch (e) {
    content.textContent = "Failed to load games.";
    return;
  }

  if (!games.length) {
    content.innerHTML = '<p class="muted">No games yet. <a href="/lobby.html">Play one →</a></p>';
    return;
  }

  const table = document.createElement("table");
  table.className = "history-table";
  table.innerHTML =
    "<thead><tr><th>Date</th><th>Mode</th><th>You</th><th>Opponent</th><th>Result</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const g of games) {
    const youWhite = g.white_id === user.id;
    const opp = youWhite ? g.black_username : g.white_username;
    const res = outcome(g, youWhite);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${fmtDate(g.created_at)}</td>` +
      `<td>${g.mode === "ai" ? "vs AI" : "PvP"}</td>` +
      `<td>${youWhite ? "White" : "Black"}</td>` +
      `<td>${escapeHtml(opp || "?")}</td>` +
      `<td class="${res.cls}">${res.text}</td>` +
      `<td><a class="replay-link" href="/replay.html?id=${g.id}">Replay →</a></td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.innerHTML = "";
  content.appendChild(table);

  function outcome(g, youWhite) {
    if (g.status === "active") return { text: "In progress", cls: "out-progress" };
    if (g.status === "aborted") return { text: "Aborted", cls: "out-draw" };
    if (g.result === "1/2-1/2") return { text: "Draw", cls: "out-draw" };
    const youWon = (g.result === "1-0" && youWhite) || (g.result === "0-1" && !youWhite);
    const term = g.termination ? ` (${g.termination})` : "";
    return { text: (youWon ? "Win" : "Loss") + term, cls: youWon ? "out-win" : "out-loss" };
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
})();
