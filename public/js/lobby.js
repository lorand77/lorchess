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
    const mine = (g) => g.white_id === me.id || g.black_id === me.id;
    const activePvp = games.find(
      (g) => g.status === "active" && g.mode === "pvp" && mine(g)
    );
    // An AI game row is created as soon as game.html opens, so only offer to
    // resume ones that actually have moves in them.
    const activeAi = games.find(
      (g) => g.status === "active" && g.mode === "ai" && mine(g) && g.move_count > 0
    );

    const lines = [];
    if (activePvp) {
      const opp = activePvp.white_id === me.id ? activePvp.black_username : activePvp.white_username;
      lines.push(
        `You have a game in progress. ` +
        `<a class="rejoin-link" href="/game.html?id=${activePvp.id}">↩ Rejoin vs ${escapeHtml(opp || "opponent")}</a>`
      );
    }
    if (activeAi) {
      const n = activeAi.move_count;
      lines.push(
        `Unfinished game vs LorFish (${n} ${n === 1 ? "move" : "moves"}). ` +
        `<a class="rejoin-link" href="/game.html?id=${activeAi.id}">↩ Resume</a>`
      );
    }

    if (lines.length) {
      rejoinEl.innerHTML = lines.join("<br>");
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
