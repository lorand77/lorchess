"use strict";

// Renders GET /api/leaderboard as a ranked table and highlights the current
// user's row. Built with DOM nodes, not HTML strings: usernames are
// user-supplied.

(async function () {
  const content = document.getElementById("leaderboardContent");

  let user, rows;
  try {
    const [meRes, lbRes] = await Promise.all([
      fetch("/api/me", { credentials: "same-origin" }),
      fetch("/api/leaderboard", { credentials: "same-origin" }),
    ]);
    if (meRes.status === 401 || lbRes.status === 401) {
      location.replace("/login.html");
      return;
    }
    user = await meRes.json();
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

  const table = el("table", "history-table lb-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const [label, cls] of [
    ["#", ""], ["Player", ""], ["Rating", "num"],
    ["Games", "num"], ["W", "num"], ["L", "num"], ["D", "num"],
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
    who.appendChild(el("span", "name", r.username));
    if (r.id === user.id) who.appendChild(el("span", "tag you", "you"));
    tr.appendChild(who);

    tr.appendChild(el("td", "num rating-cell", String(r.rating)));
    tr.appendChild(el("td", "num", String(r.games)));
    tr.appendChild(el("td", "num out-win", String(r.wins)));
    tr.appendChild(el("td", "num out-loss", String(r.losses)));
    tr.appendChild(el("td", "num out-draw", String(r.draws)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  content.innerHTML = "";
  content.appendChild(table);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
})();
