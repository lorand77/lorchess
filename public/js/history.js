"use strict";

// The profile's Games tab: the profile owner's games, with the variant, the
// result from their side and a link into the replay viewer. AI games name the
// LorFish level and its rating (src/shared/aiLevels.js). On your own profile an
// unfinished game offers Resume; on someone else's, a live PvP game offers
// Watch (an AI game runs in its player's browser, so there is nothing to watch).
// Every column but the last sorts the table, on the page: the whole list is
// already here, newest first, so no request is needed. A four-player game has
// no White or Black: the row names the owner's colour, their partner and the
// two opponents (in free-for-all the other three, and the result is the
// owner's place and points), and its links go to the four-player pages.
// On your own tab each finished game has a star (starButton.js), and "Starred
// only" swaps the list for the games you have starred (GET /api/games/starred),
// which may be anyone's: one you didn't play shows its players and its result
// as it stands, from no one's side.

const FOUR_COLOURS = { r: "Red", b: "Blue", y: "Yellow", g: "Green" };

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

  const noGames = you
    ? 'No games yet. <a href="/lobby.html">Play one →</a>'
    : "No games yet.";
  if (!games.length && !you) {
    content.innerHTML = `<p class="muted">${noGames}</p>`;
    return;
  }

  // Your stars, as they are now: a star changed in one list shows in the other.
  const starredIds = new Set(games.filter((g) => g.starred).map((g) => g.id));
  let starredOnly = false;

  // Each game's cells, and what each sortable column sorts it by.
  const toRows = (list) => list.map((g) => {
    const mine = !!g.seat || g.white_id === user.id || g.black_id === user.id;
    if (!mine) return otherRow(g);
    if (g.seat && isFreeForAll(g.variant)) return ffaRow(g);
    if (g.seat) return fourRow(g);
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
    return row(g, mode, variant, side, oppCell, opp || "", res);
  });
  let rows = toRows(games);

  // A starred game you didn't play: its players, and its result as it stands.
  function otherRow(g) {
    const name = (id, username, bot) => (bot || !id ? escapeHtml(username || "?") : playerLink(id, username || "?").outerHTML);
    let cell, opp, text;
    if (isFourPlayer(g.variant)) {
      const order = ["r", "b", "y", "g"];
      cell = order.map((c) => name(g.seats[c].id, g.seats[c].username, g.seats[c].bot)).join(", ");
      opp = order.map((c) => g.seats[c].username).join(", ");
      text = fourResult(g);
    } else {
      const aiWhite = g.mode === "ai" && g.ai_color === "w", aiBlack = g.mode === "ai" && g.ai_color === "b";
      cell = `${name(g.white_id, g.white_username, aiWhite)} vs ${name(g.black_id, g.black_username, aiBlack)}`;
      opp = `${g.white_username || ""} vs ${g.black_username || ""}`;
      text = { "1-0": "White won", "0-1": "Black won", "1/2-1/2": "Draw" }[g.result] || "";
    }
    const res = g.status === "aborted" ? outcome(g, true) : { text: escapeHtml(text), cls: "", rank: 1 };
    return row(g, g.mode === "ai" ? "vs AI" : "PvP", variantLabel(g.variant), "—", cell, opp, res);
  }

  // A four-player result, no one's side: the team that won, or free-for-all's
  // winner (its placings start with first place: "b,r=y,g").
  function fourResult(g) {
    if (g.result === "1/2-1/2") return "Draw";
    if (isFreeForAll(g.variant)) {
      const first = String(g.result || "").split(",")[0].split("=");
      return first.length > 1 ? "Shared first" : `${FOUR_COLOURS[first[0]] || "?"} won`;
    }
    return { "1-0": "Red & Yellow won", "0-1": "Blue & Green won" }[g.result] || "";
  }

  // A four-player game: the owner's colour, the two opponents, and who their
  // partner was. Red and Yellow are the team stored as White ("1-0").
  function fourRow(g) {
    const name = (c) => {
      const s = g.seats[c];
      return s.bot ? escapeHtml(s.username) : playerLink(s.id, s.username).outerHTML;
    };
    const after = { r: "b", b: "y", y: "g", g: "r" };
    const partner = after[after[g.seat]];
    const opps = [after[g.seat], after[partner]];
    const oppCell = opps.map(name).join(" &amp; ") +
      ` <span class="muted small">with ${name(partner)}</span>`;
    const res = outcome(g, g.seat === "r" || g.seat === "y");
    const opp = opps.map((c) => g.seats[c].username).join(" & ");
    return row(g, "PvP", variantLabel(g.variant), FOUR_COLOURS[g.seat], oppCell, opp, res);
  }

  // A free-for-all game: the owner's colour, the other three, and their place
  // and points ("2nd · 20 pts"); first place sorts with the wins, the rest
  // with the losses.
  function ffaRow(g) {
    const name = (c) => {
      const s = g.seats[c];
      return s.bot ? escapeHtml(s.username) : playerLink(s.id, s.username).outerHTML;
    };
    const others = ["r", "b", "y", "g"].filter((c) => c !== g.seat);
    const oppCell = others.map(name).join(", ");
    const opp = others.map((c) => g.seats[c].username).join(", ");
    const mine = g.seats[g.seat];
    let res;
    if (g.status !== "finished") res = outcome(g, true);
    else {
      const place = mine.place + (["st", "nd", "rd"][mine.place - 1] || "th");
      const first = mine.place === 1;
      res = { text: `${place} · ${mine.points} pts`, cls: first ? "out-win" : "out-loss", rank: first ? 0 : 2 };
    }
    return row(g, "PvP", variantLabel(g.variant), FOUR_COLOURS[g.seat], oppCell, opp, res);
  }

  function row(g, mode, variant, side, oppCell, opp, res) {
    // Your own tab: the star, once the game is over.
    const star = !you ? "" : `<td class="star-cell">${g.status === "active" ? "" : `<button data-star="${g.id}"></button>`}</td>`;
    return {
      html:
        `<td>${fmtDate(g.created_at)}</td>` +
        `<td>${mode}</td>` +
        `<td>${escapeHtml(variant)}</td>` +
        `<td>${side}</td>` +
        `<td>${oppCell}</td>` +
        `<td class="${res.cls}">${res.text}</td>` +
        `<td>${action(g)}</td>` +
        star,
      // The id only ever grows, so it orders games started in the same second.
      by: { date: g.id, mode, variant, side, opponent: opp.toLowerCase(), result: res.rank },
    };
  }

  // [heading, sort key (null: not sortable), the way it sorts first].
  const COLUMNS = [
    ["Date", "date", "desc"], ["Mode", "mode", "asc"], ["Variant", "variant", "asc"],
    [you ? "You" : "As", "side", "asc"], ["Opponent", "opponent", "asc"],
    ["Result", "result", "asc"], ["", null],
    ...(you ? [["★", null]] : []),
  ];
  let sort = "date";
  let dir = "desc";

  const table = document.createElement("table");
  table.className = "history-table";
  const emptyEl = document.createElement("p");
  emptyEl.className = "muted";
  const msgEl = document.createElement("span");
  msgEl.className = "small check-text";
  content.innerHTML = "";
  if (you) content.appendChild(filterBar());
  content.append(table, emptyEl);
  render();

  // "Starred only": the games you have starred, fetched each time it is
  // ticked, since a star may have been added on a replay meanwhile.
  function filterBar() {
    const bar = document.createElement("p");
    bar.className = "history-filter";
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "starredOnly";
    label.append(box, " Starred only");
    box.addEventListener("change", async () => {
      msgEl.textContent = "";
      if (!box.checked) {
        starredOnly = false;
        rows = toRows(games);
        return render();
      }
      try {
        const res = await fetch("/api/games/starred", { credentials: "same-origin" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const list = await res.json();
        for (const g of list) starredIds.add(g.id);
        starredOnly = true;
        rows = toRows(list);
        render();
      } catch (e) {
        box.checked = false;
        msgEl.textContent = "Couldn't load your starred games.";
      }
    });
    bar.append(label, " ", msgEl);
    return bar;
  }

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
    // Unstarring in "Starred only" leaves the row, so the star can go back on.
    for (const b of tbody.querySelectorAll("button[data-star]")) {
      const id = Number(b.dataset.star);
      StarButton.attach(b, id, starredIds.has(id), {
        onChange: (on) => { if (on) starredIds.add(id); else starredIds.delete(id); msgEl.textContent = ""; },
        onError: (e) => { msgEl.textContent = e; },
      });
    }
    table.hidden = !rows.length;
    emptyEl.hidden = !!rows.length;
    emptyEl.innerHTML = starredOnly
      ? "No starred games yet. Star one with ☆ here, or on its replay."
      : noGames;
  }

  function action(g) {
    if (g.status !== "active") {
      // Opened from someone else's profile, the replay takes their side.
      const as = you ? "" : "&as=" + user.id;
      const replay = isFourPlayer(g.variant) ? "fourReplay.html" : "replay.html";
      return `<a class="replay-link" href="/${replay}?id=${g.id}${as}">Replay →</a>`;
    }
    const page = isFourPlayer(g.variant) ? "four.html" : "game.html";
    if (you) return `<a class="replay-link" href="/${page}?id=${g.id}">Resume →</a>`;
    if (g.mode === "pvp") return `<a class="replay-link" href="/${page}?watch=${g.id}">Watch →</a>`;
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
