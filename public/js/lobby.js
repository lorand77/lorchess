"use strict";

// Lobby: shows the authenticated socket status and runs quick-match. On a match
// the server emits game:start and we navigate into the PvP game page.

const statusEl = document.getElementById("connStatus");
const quickBtn = document.getElementById("quickMatchBtn");
const matchStatusEl = document.getElementById("matchStatus");

let searching = false;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "conn-dot " + cls;
}

const socket = connectSocket({
  onConnect: () => {
    setStatus("connected", "ok");
    quickBtn.disabled = false;
  },
  onWelcome: (data) => setStatus("connected as " + data.username, "ok"),
  onDisconnect: () => {
    setStatus("disconnected", "bad");
    quickBtn.disabled = true;
    resetSearch();
  },
  onError: (err) => setStatus("connection error (" + err.message + ")", "bad"),
});

function resetSearch() {
  searching = false;
  quickBtn.textContent = "Quick Match";
  matchStatusEl.textContent = "";
}

quickBtn.addEventListener("click", () => {
  if (searching) {
    socket.emit("lobby:leave");
    resetSearch();
    return;
  }
  socket.emit("lobby:join");
  searching = true;
  quickBtn.textContent = "Cancel";
  matchStatusEl.textContent = "searching for an opponent…";
});

socket.on("lobby:waiting", () => {
  matchStatusEl.textContent = "waiting for an opponent…";
});

socket.on("game:start", (info) => {
  matchStatusEl.textContent = "matched! starting game…";
  location.href = "/game.html?id=" + info.gameId;
});

// --- rejoin an in-progress game ---
// If you left a live PvP game for the lobby, surface a button to go back into
// it (you must rejoin before the disconnect grace timer forfeits you).
const rejoinEl = document.getElementById("rejoin");

async function checkActiveGame() {
  try {
    const [meRes, gamesRes] = await Promise.all([
      fetch("/api/me", { credentials: "same-origin" }),
      fetch("/api/games", { credentials: "same-origin" }),
    ]);
    if (!meRes.ok || !gamesRes.ok) return;
    const me = await meRes.json();
    const games = await gamesRes.json();
    const active = games.find(
      (g) =>
        g.status === "active" &&
        g.mode === "pvp" &&
        (g.white_id === me.id || g.black_id === me.id)
    );
    if (active) {
      const opp = active.white_id === me.id ? active.black_username : active.white_username;
      rejoinEl.innerHTML =
        `You have a game in progress. ` +
        `<a class="rejoin-link" href="/game.html?id=${active.id}">↩ Rejoin vs ${escapeHtml(opp || "opponent")}</a>`;
      rejoinEl.style.display = "";
    } else {
      rejoinEl.style.display = "none";
      rejoinEl.innerHTML = "";
    }
  } catch (e) {
    /* ignore — lobby still works without this */
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

checkActiveGame();
setInterval(checkActiveGame, 5000); // keep it current as games start/end

// Exposed for debugging / later milestones.
window.lorSocket = socket;
