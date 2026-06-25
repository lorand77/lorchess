"use strict";

// Connects the authenticated socket and reflects its status in the UI. This is
// the visible proof of the M4 shared-session handshake; M5 builds matchmaking
// on top of this same connection.

const statusEl = document.getElementById("connStatus");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "conn-dot " + cls;
}

const socket = connectSocket({
  onConnect: () => setStatus("connected", "ok"),
  onWelcome: (data) => setStatus("connected as " + data.username, "ok"),
  onDisconnect: () => setStatus("disconnected", "bad"),
  onError: (err) => setStatus("connection error (" + err.message + ")", "bad"),
});

// Expose for later milestones / debugging.
window.lorSocket = socket;
