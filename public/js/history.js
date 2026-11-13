"use strict";

// The profile's Games tab: the profile owner's games, with the variant, the
// result from their side and a link into the replay viewer. AI games name the
// LorFish level and its rating (src/shared/aiLevels.js). On your own profile an
// unfinished game offers Resume; on someone else's, a live PvP game offers
// Watch (an AI game runs in its player's browser, so there is nothing to watch).
// Every column but the last sorts the table, on the page: the whole list is
// already here, newest first, so no request is needed.

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

  // Each game's cells, and what each sortable column sorts it by.
  const rows = games.map((g) => {
    const asWhite = g.white_id === user.id;
    const opp = asWhite ? g.black_username : g.white_username;
    const oppId = Number(asWhite ? g.black_id : g.white_id);
    let oppCell = g.mode === "pvp" && oppId
      ? playerLink(oppId, opp || "?").outerHTML
      : escapeHtml(opp || "?");
    const strength = g.mode === "ai" ? aiStrength(g) : null;
    if (strength) oppCell += ` <span class="muted small">${escapeHtml(strength)}</span>`;
    const res = outcome(g, asWhite);
    const mode = g.mode === "ai" ? "vs AI" : "PvP";
    const variant = variantLabel(g.variant);
    const side = asWhite ? "White" : "Black";
    return {
      html:
        `<td>${fmtDate(g.created_at)}</td>` +
        `<td>${mode}</td>` +
        `<td>${escapeHtml(variant)}</td>` +
        `<td>${side}</td>` +
        `<td>${oppCell}</td>` +
        `<td class="${res.cls}">${res.text}</td>` +
        `<td>${action(g)}</td>`,
      // The id only ever grows, so it orders games started in the same second.
      by: { date: g.id, mode, variant, side, opponent: (opp || "").toLowerCase(), result: res.rank },
    };
  });

  // [heading, sort key (null: not sortable), the way it sorts first].
  const COLUMNS = [
    ["Date", "date", "desc"], ["Mode", "mode", "asc"], ["Variant", "variant", "asc"],
    [you ? "You" : "As", "side", "asc"], ["Opponent", "opponent", "asc"],
    ["Result", "result", "asc"], ["", null],
  ];
  let sort = "date";
  let dir = "desc";

  const table = document.createElement("table");
  table.className = "history-table";
  content.innerHTML = "";
  content.appendChild(table);
  render();

  // Clicking the sorted column flips it; any other starts its own way. The
  // sort is stable over the newest-first list, so games that tie stay newest
  // first.
  function sortBy(key) {
    if (key === sort) dir = dir === "asc" ? "desc" : "asc";
    else {
      sort = key;
      dir = COLUMNS.find((c) => c[1] === key)[2];
    }
    render();
    // The table is drawn afresh: keep the keyboard on the heading just used.
    table.querySelector("th.sorted .lb-sort").focus();
  }

  function render() {
    const head = document.createElement("tr");
    for (const [label, key] of COLUMNS) {
      const th = document.createElement("th");
      if (key) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lb-sort";
        b.textContent = label;
        if (key === sort) {
          th.classList.add("sorted");
          th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
          const arrow = document.createElement("span");
          arrow.className = "lb-arrow";
          arrow.textContent = dir === "asc" ? "▲" : "▼";
          b.appendChild(arrow);
        }
        b.addEventListener("click", () => sortBy(key));
        th.appendChild(b);
      } else {
        th.textContent = label;
      }
      head.appendChild(th);
    }
    const sign = dir === "asc" ? 1 : -1;
    const sorted = rows.slice().sort((a, b) => {
      const x = a.by[sort], y = b.by[sort];
      return sign * (typeof x === "number" ? x - y : x.localeCompare(y));
    });
    const thead = document.createElement("thead");
    thead.appendChild(head);
    const tbody = document.createElement("tbody");
    for (const r of sorted) {
      const tr = document.createElement("tr");
      tr.innerHTML = r.html;
      tbody.appendChild(tr);
    }
    table.replaceChildren(thead, tbody);
  }

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

  // "Casual (~1000)". Games from before levels have only a depth, shown as
  // that; null if neither, as on the replay page.
  function aiStrength(g) {
    if (AI_LEVELS_BY_KEY.has(g.ai_level)) return aiLevelLabel(g.ai_level);
    if (g.ai_depth) return `depth ${g.ai_depth}`;
    return null;
  }

  // The result from the profile owner's side; `rank` is its place when the
  // table is sorted by result: wins first, then draws, losses, games still
  // going and aborted ones.
  function outcome(g, asWhite) {
    if (g.status === "active") return { text: "In progress", cls: "out-progress", rank: 3 };
    if (g.status === "aborted") return { text: "Aborted", cls: "out-draw", rank: 4 };
    if (g.result === "1/2-1/2") return { text: "Draw", cls: "out-draw", rank: 1 };
    const won = (g.result === "1-0" && asWhite) || (g.result === "0-1" && !asWhite);
    const term = g.termination ? ` (${escapeHtml(g.termination)})` : "";
    return { text: (won ? "Win" : "Loss") + term, cls: won ? "out-win" : "out-loss", rank: won ? 0 : 2 };
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
