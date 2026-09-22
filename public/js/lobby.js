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
const handicapBtn   = document.getElementById("handicapBtn");
const handicapSumEl = document.getElementById("handicapSummary");
const handicapClear = document.getElementById("handicapClear");
const seekListEl    = document.getElementById("seekList");
const playerListEl  = document.getElementById("playerList");
const gameListEl    = document.getElementById("gameList");
const incomingEl    = document.getElementById("incoming");
const friendReqsEl  = document.getElementById("friendRequests");
const friendListEl  = document.getElementById("friendList");
const friendCountEl = document.getElementById("friendCount");
const rejoinEl      = document.getElementById("rejoin");

let searching = false;   // in the quick-match queue
let myseek = null;       // our own open seek, if any
let handicapRemoved = null; // squares to clear for material odds, or null
let lastState = { players: [], seeks: [], games: [] };
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
  // Material odds are never rated. The server enforces this independently.
  rated: handicapRemoved ? false : ratedCheck.checked,
  handicap: handicapRemoved ? { removed: handicapRemoved } : null,
});

// --- handicap ---

// Reflect the current handicap in the form: show the terms, and hold "Rated"
// off, since the server will refuse to rate the game either way.
function renderHandicap() {
  const on = !!handicapRemoved;
  handicapBtn.textContent = on ? "Edit handicap…" : "Handicap…";
  handicapSumEl.textContent = on ? describe(handicapRemoved) + " — casual only" : "";
  handicapClear.style.display = on ? "" : "none";
  ratedCheck.disabled = on;
  if (on) ratedCheck.checked = false;

  // Quick Match pairs you with a stranger sight unseen, so odds would be an
  // unpleasant surprise. Handicaps go out as offers instead, where whoever
  // accepts can read the terms first.
  quickBtn.disabled = on || !socket.connected;
  quickBtn.title = on
    ? "Handicap games go out as a challenge so your opponent can see the terms first"
    : "";
  if (on && searching) {
    socket.emit("lobby:leave");
    resetSearch();
  }
}

handicapBtn.addEventListener("click", () => {
  PositionEditor.open({
    removed: handicapRemoved || [],
    onSave: (removed) => {
      handicapRemoved = removed.length ? removed : null;
      renderHandicap();
    },
  });
});

handicapClear.addEventListener("click", () => {
  handicapRemoved = null;
  renderHandicap();
});

// --- socket ---

const socket = connectSocket({
  onConnect: () => {
    setStatus("connected", "ok");
    seekBtn.disabled = false;
    renderHandicap(); // also decides whether Quick Match is offered
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
  lastState = state || { players: [], seeks: [], games: [] };
  if (!lastState.games) lastState.games = [];
  myseek = lastState.seeks.find((s) => s.userId === myId()) || null;
  seekBtn.textContent = myseek ? "Cancel Challenge" : "Post Challenge";
  renderSeeks();
  renderGames();
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

// Friends live in the DB (REST); the socket only nudges us to refetch.
socket.on("friends:changed", refreshFriends);
socket.on("lobby:state", renderFriends); // online / playing badges

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
    if (s.handicap) who.appendChild(el("span", "tag handicap", s.handicap));
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

// A link-styled button into the spectator view of a live game.
function watchButton(gameId) {
  return button("Watch", "", () => { location.href = "/game.html?watch=" + gameId; });
}

function renderGames() {
  const games = lastState.games;
  document.getElementById("gameCount").textContent = games.length ? "(" + games.length + ")" : "";
  gameListEl.innerHTML = "";
  if (!games.length) {
    gameListEl.appendChild(el("p", "muted empty", "No games in progress."));
    return;
  }
  const me = myId();
  for (const g of games) {
    const row = el("div", "row");
    const who = el("span", "row-main");
    const side = (p) => {
      who.appendChild(el("span", "name", p.username));
      if (p.rating != null) who.appendChild(el("span", "rating", "(" + p.rating + ")"));
    };
    side(g.white);
    who.appendChild(el("span", "vs", "vs"));
    side(g.black);
    who.appendChild(el("span", "tag", g.tc));
    who.appendChild(el("span", "tag " + (g.rated ? "rated" : "casual"), g.rated ? "rated" : "casual"));
    if (g.spectators) who.appendChild(el("span", "muted small", "👁 " + g.spectators));
    row.appendChild(who);
    const mine = g.white.userId === me || g.black.userId === me;
    row.appendChild(
      mine
        ? button("Rejoin", "primary", () => { location.href = "/game.html?id=" + g.gameId; })
        : watchButton(g.gameId)
    );
    gameListEl.appendChild(row);
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
        // They're mid-game, with no lobby page open to receive the challenge —
        // offer to watch instead.
        if (p.gameId) row.appendChild(watchButton(p.gameId));
        else {
          const b = button("Challenge", "", () => {});
          b.disabled = true;
          b.title = "Already in a game";
          row.appendChild(b);
        }
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
    if (c.handicap) text.appendChild(el("span", "tag handicap", c.handicap));
    text.appendChild(el("span", "muted small", colorNote(c.color)));
    box.appendChild(text);
    box.appendChild(button("Accept", "primary", () => socket.emit("challenge:accept", { id: c.id })));
    box.appendChild(button("Decline", "", () => socket.emit("challenge:decline", { id: c.id })));
    incomingEl.appendChild(box);
  }
}

// --- friends ---

async function refreshFriends() {
  try {
    await Friends.load();
  } catch (e) {
    /* leave the last known list up */
  }
  renderFriends();
}

function renderFriends() {
  if (!window.Friends) return;
  const { friends, incoming, outgoing } = Friends.state;
  const online = new Map(lastState.players.map((p) => [p.userId, p]));
  const outgoingTo = new Map(myChallenges.outgoing.map((c) => [c.to.userId, c]));
  friendCountEl.textContent = friends.length ? "(" + friends.length + ")" : "";

  // Requests waiting on me, one strip each — same shape as game challenges.
  friendReqsEl.innerHTML = "";
  for (const r of incoming) {
    const box = el("div", "challenge-box");
    const text = el("span", "row-main");
    text.appendChild(el("strong", null, r.username));
    text.appendChild(el("span", "rating", "(" + r.rating + ")"));
    text.appendChild(document.createTextNode(" wants to be friends"));
    box.appendChild(text);
    box.appendChild(button("Accept", "primary", () => friendAction(Friends.accept(r.id))));
    box.appendChild(button("Decline", "", () => friendAction(Friends.decline(r.id))));
    friendReqsEl.appendChild(box);
  }

  friendListEl.innerHTML = "";
  for (const f of friends) {
    const p = online.get(f.userId);
    const row = el("div", "row");
    const who = el("span", "row-main");
    who.appendChild(el("span", "name", f.username));
    who.appendChild(el("span", "rating", "(" + f.rating + ")"));
    if (!p) who.appendChild(el("span", "tag offline", "offline"));
    else if (p.playing) who.appendChild(el("span", "tag playing", "playing"));
    else who.appendChild(el("span", "tag online", "online"));
    row.appendChild(who);

    const pending = outgoingTo.get(f.userId);
    if (pending) {
      row.appendChild(button("Withdraw", "", () => socket.emit("challenge:cancel", { id: pending.id })));
    } else if (p && p.playing && p.gameId) {
      row.appendChild(watchButton(p.gameId));
    } else {
      const b = button("Challenge", "primary", () =>
        socket.emit("challenge:create", { toUserId: f.userId, ...currentOffer() })
      );
      if (!p || p.playing) {
        b.disabled = true;
        b.title = p ? "Already in a game" : "Offline";
      }
      row.appendChild(b);
    }
    row.appendChild(button("Remove", "", () => {
      if (confirm("Remove " + f.username + " from your friends?")) friendAction(Friends.remove(f.id));
    }));
    friendListEl.appendChild(row);
  }
  for (const r of outgoing) {
    const row = el("div", "row");
    const who = el("span", "row-main");
    who.appendChild(el("span", "name", r.username));
    who.appendChild(el("span", "rating", "(" + r.rating + ")"));
    who.appendChild(el("span", "tag pending", "request sent"));
    row.appendChild(who);
    row.appendChild(button("Withdraw", "", () => friendAction(Friends.remove(r.id))));
    friendListEl.appendChild(row);
  }
  if (!friends.length && !outgoing.length) {
    const empty = el("p", "muted empty");
    empty.appendChild(document.createTextNode("No friends yet. Add some from the "));
    const a = el("a", "nav-link", "leaderboard");
    a.href = "/leaderboard.html";
    empty.appendChild(a);
    empty.appendChild(document.createTextNode(" or after a game."));
    friendListEl.appendChild(empty);
  }
}

// Run a Friends action; the server's friends:changed nudge does the refetch,
// but refetch here too so the UI is right even if the socket is down.
function friendAction(promise) {
  promise.catch((err) => showError(err.message)).then(refreshFriends);
}

// --- puzzles: daily streak line ---

async function loadDailyLine() {
  const line = document.getElementById("dailyLine");
  if (!line) return;
  try {
    const res = await fetch("/api/puzzles/me", { credentials: "same-origin" });
    if (!res.ok) return;
    const me = await res.json();
    line.innerHTML = "";
    line.appendChild(document.createTextNode("🧩 Puzzle rating " + me.rating + " · "));
    line.appendChild(document.createTextNode(
      me.streak > 0 ? "🔥 " + me.streak + "-day daily streak · " : "No daily streak yet · "
    ));
    const a = el("a", "nav-link", me.dailyDone ? "today's puzzle done ✓" : "today's puzzle is waiting");
    a.href = "/puzzles.html?daily";
    line.appendChild(a);
  } catch (e) {
    /* the lobby works without it */
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
  refreshFriends();
  loadDailyLine();
  renderSeeks();
  renderPlayers();
})();

// Exposed for debugging.
window.lorSocket = socket;

// Achievements are pushed to every socket a user holds, so one earned in a
// game that ended while this tab was in the lobby still shows up here.
socket.on("achievements:earned", (info) => {
  if (info && typeof AchievementToast !== "undefined") AchievementToast.show(info.list);
});
