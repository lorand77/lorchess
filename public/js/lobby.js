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

// Exposed for debugging / later milestones.
window.lorSocket = socket;
