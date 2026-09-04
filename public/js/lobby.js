"use strict";

// The live lobby. Everything on this page is driven by socket pushes:
// `lobby:state` carries the player and seek lists, `challenge:list` carries
// this user's own pending challenges. Nothing polls.

const statusEl      = document.getElementById("connStatus");
const quickBtn      = document.getElementById("quickMatchBtn");
const seekBtn       = document.getElementById("seekBtn");
const matchStatusEl = document.getElementById("matchStatus");
const errorEl       = document.getElementById("lobbyError");
const tcSelect      = document.getElementById("tcSelect");
const colorSelect   = document.getElementById("colorSelect");
const ratedCheck    = document.getElementById("ratedCheck");
const seekListEl    = document.getElementById("seekList");
const playerListEl  = document.getElementById("playerList");
const incomingEl    = document.getElementById("incoming");
const rejoinEl      = document.getElementById("rejoin");

let searching = false;   // in the quick-match queue
let myseek = null;       // our own open seek, if any
let lastState = { players: [], seeks: [] };
let myChallenges = { incoming: [], outgoing: [] };

// --- helpers ---

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "conn-dot " + cls;
}

function showError(msg) {
  errorEl.textContent = msg || "";
  if (msg) setTimeout(() => { errorEl.textContent = ""; }, 4000);
}

const myId = () => (window.currentUser ? window.currentUser.id : null);

function tcLabel(key) {
  const tc = findTimeControl(key);
  return tc ? tc.label : key;
}

// Colour as the OFFERING side described it, read from the taker's point of view.
function colorNote(color) {
  if (color === "w") return "they play White";
  if (color === "b") return "they play Black";
  return "random colours";
}

// Build an element tree rather than an HTML string: usernames are user-supplied
// and textContent can't be talked into executing anything.
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, cls, onClick) {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

// --- the offer form ---

for (const tc of TIME_CONTROLS) {
  const opt = el("option", null, tc.label);
  opt.value = tc.key;
  if (tc.key === DEFAULT_TC) opt.selected = true;
  tcSelect.appendChild(opt);
}

const currentOffer = () => ({
  tc: tcSelect.value,
  color: colorSelect.value,
  rated: ratedCheck.checked,
});

// --- socket ---

const socket = connectSocket({
  onConnect: () => {
    setStatus("connected", "ok");
    quickBtn.disabled = false;
    seekBtn.disabled = false;
    socket.emit("lobby:enter");
  },
  onWelcome: (data) => setStatus("connected as " + data.username, "ok"),
  onDisconnect: () => {
    setStatus("disconnected", "bad");
    quickBtn.disabled = true;
    seekBtn.disabled = true;
    resetSearch();
  },
  onError: (err) => setStatus("connection error (" + err.message + ")", "bad"),
});

// --- quick match ---

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
  const offer = currentOffer();
  socket.emit("lobby:join", { tc: offer.tc, rated: offer.rated });
  searching = true;
  quickBtn.textContent = "Cancel";
  matchStatusEl.textContent = "searching for an opponent…";
});

socket.on("lobby:waiting", (info) => {
  matchStatusEl.textContent =
    "waiting for a " + tcLabel(info && info.tc) + " opponent…";
});

// --- posting an open seek ---

seekBtn.addEventListener("click", () => {
  if (myseek) {
    socket.emit("seek:cancel", { id: myseek.id });
    return;
  }
  socket.emit("seek:create", currentOffer());
});

// --- rendering ---

socket.on("lobby:state", (state) => {
  lastState = state || { players: [], seeks: [] };
  myseek = lastState.seeks.find((s) => s.userId === myId()) || null;
  seekBtn.textContent = myseek ? "Cancel Challenge" : "Post Challenge";
  renderSeeks();
  renderPlayers();
});

socket.on("challenge:list", (list) => {
  myChallenges = list || { incoming: [], outgoing: [] };
  renderIncoming();
  renderPlayers(); // outgoing challenges change the per-player button
});

socket.on("challenge:declined", (info) => {
  showError(((info && info.username) || "They") + " declined your challenge.");
});

socket.on("lobby:error", (info) => showError(info && info.error));

function renderSeeks() {
  const seeks = lastState.seeks;
  document.getElementById("seekCount").textContent = seeks.length ? "(" + seeks.length + ")" : "";
  seekListEl.innerHTML = "";
  if (!seeks.length) {
    seekListEl.appendChild(el("p", "muted empty", "No open challenges. Post one above."));
    return;
  }
  for (const s of seeks) {
    const row = el("div", "row");
    const who = el("span", "row-main");
    who.appendChild(el("span", "name", s.username));
    who.appendChild(el("span", "rating", "(" + s.rating + ")"));
    who.appendChild(el("span", "tag", tcLabel(s.tc)));
    who.appendChild(el("span", "tag " + (s.rated ? "rated" : "casual"), s.rated ? "rated" : "casual"));
    who.appendChild(el("span", "muted small", colorNote(s.color)));
    row.appendChild(who);
    row.appendChild(
      s.userId === myId()
        ? button("Cancel", "", () => socket.emit("seek:cancel", { id: s.id }))
        : button("Accept", "primary", () => socket.emit("seek:accept", { id: s.id }))
    );
    seekListEl.appendChild(row);
  }
}

function renderPlayers() {
  const players = lastState.players;
  document.getElementById("playerCount").textContent =
    players.length ? "(" + players.length + ")" : "";
  playerListEl.innerHTML = "";
  const outgoingTo = new Map(myChallenges.outgoing.map((c) => [c.to.userId, c]));

  for (const p of players) {
    const row = el("div", "row");
    const who = el("span", "row-main");
    who.appendChild(el("span", "name", p.username));
    who.appendChild(el("span", "rating", "(" + p.rating + ")"));
    if (p.userId === myId()) who.appendChild(el("span", "tag you", "you"));
    if (p.playing) who.appendChild(el("span", "tag playing", "playing"));
    row.appendChild(who);

    if (p.userId !== myId()) {
      const pending = outgoingTo.get(p.userId);
      if (pending) {
        row.appendChild(
          button("Withdraw", "", () => socket.emit("challenge:cancel", { id: pending.id }))
        );
      } else if (p.playing) {
        // They're mid-game, with no lobby page open to receive the challenge.
        const b = button("Challenge", "", () => {});
        b.disabled = true;
        b.title = "Already in a game";
        row.appendChild(b);
      } else {
        row.appendChild(
          button("Challenge", "", () =>
            socket.emit("challenge:create", { toUserId: p.userId, ...currentOffer() })
          )
        );
      }
    }
    playerListEl.appendChild(row);
  }
  if (!players.length) {
    playerListEl.appendChild(el("p", "muted empty", "Nobody else is here right now."));
  }
}

function renderIncoming() {
  incomingEl.innerHTML = "";
  for (const c of myChallenges.incoming) {
    const box = el("div", "challenge-box");
    const text = el("span", "row-main");
    text.appendChild(el("strong", null, c.from.username));
    text.appendChild(el("span", "rating", "(" + c.from.rating + ")"));
    text.appendChild(document.createTextNode(" challenges you — "));
    text.appendChild(el("span", "tag", tcLabel(c.tc)));
    text.appendChild(el("span", "tag " + (c.rated ? "rated" : "casual"), c.rated ? "rated" : "casual"));
    text.appendChild(el("span", "muted small", colorNote(c.color)));
    box.appendChild(text);
    box.appendChild(button("Accept", "primary", () => socket.emit("challenge:accept", { id: c.id })));
    box.appendChild(button("Decline", "", () => socket.emit("challenge:decline", { id: c.id })));
    incomingEl.appendChild(box);
  }
}

// --- starting a game ---

socket.on("game:start", (info) => {
  matchStatusEl.textContent = "matched! starting game…";
  location.href = "/game.html?id=" + info.gameId;
});

// --- resuming an unfinished game ---
// Fetched once on load and refreshed whenever the lobby state changes (a game
// ending is broadcast), rather than on the old five-second timer.

async function checkActiveGame() {
  try {
    const res = await fetch("/api/games", { credentials: "same-origin" });
    if (!res.ok) return;
    const games = await res.json();
    const me = myId();
    if (me == null) return;
    const mine = (g) => g.white_id === me || g.black_id === me;
    const activePvp = games.find((g) => g.status === "active" && g.mode === "pvp" && mine(g));
    // An AI game row is created as soon as game.html opens, so only offer to
    // resume ones that actually have moves in them.
    const activeAi = games.find(
      (g) => g.status === "active" && g.mode === "ai" && mine(g) && g.move_count > 0
    );

    rejoinEl.innerHTML = "";
    if (activePvp) {
      const opp = activePvp.white_id === me ? activePvp.black_username : activePvp.white_username;
      const line = el("div");
      line.appendChild(document.createTextNode("You have a game in progress. "));
      const a = el("a", "rejoin-link", "↩ Rejoin vs " + (opp || "opponent"));
      a.href = "/game.html?id=" + activePvp.id;
      line.appendChild(a);
      rejoinEl.appendChild(line);
    }
    if (activeAi) {
      const n = activeAi.move_count;
      const line = el("div");
      line.appendChild(
        document.createTextNode(
          "Unfinished game vs LorFish (" + n + (n === 1 ? " move" : " moves") + "). "
        )
      );
      const a = el("a", "rejoin-link", "↩ Resume");
      a.href = "/game.html?id=" + activeAi.id;
      line.appendChild(a);
      rejoinEl.appendChild(line);
    }
    rejoinEl.style.display = rejoinEl.childNodes.length ? "" : "none";
  } catch (e) {
    /* ignore — the lobby still works without this */
  }
}

socket.on("lobby:state", checkActiveGame);

// authGuard resolves window.currentUser asynchronously; wait for it so the
// "you" marker and own-seek detection are right on the very first render.
(function whenUserKnown() {
  if (myId() == null) return setTimeout(whenUserKnown, 50);
  checkActiveGame();
  renderSeeks();
  renderPlayers();
})();

// Exposed for debugging.
window.lorSocket = socket;
