"use strict";

// Renders GET /api/leaderboard as a ranked table, highlights the current
// user's row, and puts a friend control (Add / Requested / Accept / Friends)
// on every other row. Built with DOM nodes, not HTML strings: usernames are
// user-supplied.

(async function () {
  const content = document.getElementById("leaderboardContent");

  let user, rows;
  try {
    const [meRes, lbRes] = await Promise.all([
      fetch("/api/me", { credentials: "same-origin" }),
      fetch("/api/leaderboard", { credentials: "same-origin" }),
      Friends.load(),
    ]);
    if (meRes.status === 401 || lbRes.status === 401) {
      location.replace("/login.html");
      return;
    }
    user = await meRes.json();
    window.currentUser = window.currentUser || user; // Friends.button needs my id
    rows = await lbRes.json();
  } catch (e) {
    content.textContent = "Failed to load the leaderboard.";
    return;
  }

  if (!rows.length) {
    content.innerHTML = "";
    content.appendChild(el("p", "muted", "Nobody here yet."));
    return;
  }

  const errorEl = el("p", "lobby-error");
  content.innerHTML = "";
  content.appendChild(errorEl);
  const tableHost = el("div");
  content.appendChild(tableHost);
  render();

  function showError(msg) {
    errorEl.textContent = msg || "";
    if (msg) setTimeout(() => { errorEl.textContent = ""; }, 4000);
  }

  function render() {
    const table = el("table", "history-table lb-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const [label, cls] of [
      ["#", ""], ["Player", ""], ["Rating", "num"], ["Puzzles", "num"],
      ["Games", "num"], ["W", "num"], ["L", "num"], ["D", "num"], ["", ""],
    ]) {
      hr.appendChild(el("th", cls, label));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    rows.forEach((r, i) => {
      const tr = el("tr", r.id === user.id ? "me" : "");
      tr.appendChild(el("td", "rank", String(i + 1)));

      const who = el("td");
      const nameLink = el("a", "name", r.username);
      nameLink.href = "/achievements.html?user=" + r.id;
      nameLink.title = "Achievements";
      who.appendChild(nameLink);
      if (r.member) who.appendChild(memberBadge());
      if (r.id === user.id) who.appendChild(el("span", "tag you", "you"));
      tr.appendChild(who);

      tr.appendChild(el("td", "num rating-cell", String(r.rating)));
      tr.appendChild(el("td", "num", String(r.puzzle_rating)));
      tr.appendChild(el("td", "num", String(r.games)));
      tr.appendChild(el("td", "num out-win", String(r.wins)));
      tr.appendChild(el("td", "num out-loss", String(r.losses)));
      tr.appendChild(el("td", "num out-draw", String(r.draws)));

      const ctl = el("td", "friend-cell");
      ctl.appendChild(Friends.button(r.id, render, { onError: showError }));
      tr.appendChild(ctl);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    tableHost.innerHTML = "";
    tableHost.appendChild(table);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
})();
