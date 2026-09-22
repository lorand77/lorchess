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
const rejoinEl      = document.getElementById("rejoin");

let searching = false;   // in the quick-match queue
let myseek = null;       // our own open seek, if any
let handicapRemoved = null; // squares to clear for material odds, or null
let ratedBeforeHandicap = true; // restored when the handicap is cleared
let friendIds = new Set();  // to star friends in the players list
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

// 'e2' -> 12. Enough to highlight a UCI move on a preview board without
// pulling the whole chess engine into this page.
const sqFromAlg = (a) => (a.charCodeAt(0) - 97) + (parseInt(a[1], 10) - 1) * 8;
function lastMoveOf(uci) {
  if (typeof uci !== "string" || uci.length < 4) return null;
  return { from: sqFromAlg(uci.slice(0, 2)), to: sqFromAlg(uci.slice(2, 4)) };
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
  handicapBtn.textContent = on ? "⚖ Edit handicap…" : "⚖ Handicap…";
  handicapSumEl.textContent = on ? describe(handicapRemoved) + " — casual only" : "";
  handicapClear.style.display = on ? "" : "none";
  ratedCheck.disabled = on;
  if (on) ratedCheck.checked = false;
  else ratedCheck.checked = ratedBeforeHandicap;

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
  if (!handicapRemoved) ratedBeforeHandicap = ratedCheck.checked;
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
  // The user chip beside this already names them, so just report the link.
  onWelcome: (data) => {
    setStatus("connected", "ok");
    statusEl.title = "Connected as " + data.username;
  },
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

// The friends list lives on /friends.html now. All this page needs is who they
// are, so it can star them in Players online.
socket.on("friends:changed", refreshFriends);

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
  const strip = document.getElementById("liveStrip");
  document.getElementById("gameCount").textContent = games.length ? "(" + games.length + ")" : "";
  gameListEl.innerHTML = "";

  // Nothing in progress: take the whole strip off the page rather than leaving
  // an empty box sitting there.
  if (!games.length) {
    strip.style.display = "none";
    return;
  }
  strip.style.display = "";

  const me = myId();
  for (const g of games) {
    const card = el("div", "live-game");

    const wrap = el("div", "mini-board-wrap");
    const board = el("div");
    wrap.appendChild(board);
    // Always from White's side: a preview has no "your" colour. Decorative
    // only — .mini-board sets pointer-events: none.
    if (MiniBoard.render(board, g.fen, { lastMove: g.last })) card.appendChild(wrap);

    const meta = el("div", "live-game-meta");
    const vs = el("div", "vs");
    const side = (p) => {
      vs.appendChild(el("span", "name", p.username));
      if (p.rating != null) vs.appendChild(el("span", "rating", "(" + p.rating + ")"));
    };
    side(g.white);
    vs.appendChild(document.createTextNode(" vs "));
    side(g.black);
    meta.appendChild(vs);

    const tags = el("div");
    tags.appendChild(el("span", "tag", g.tc));
    tags.appendChild(el("span", "tag " + (g.rated ? "rated" : "casual"), g.rated ? "rated" : "casual"));
    if (g.handicap) tags.appendChild(el("span", "tag handicap", g.handicap));
    meta.appendChild(tags);

    meta.appendChild(el("div", "muted small",
      (g.ply ? "move " + Math.ceil(g.ply / 2) : "just started") +
      (g.spectators ? " · 👁 " + g.spectators : "")));

    const mine = g.white.userId === me || g.black.userId === me;
    meta.appendChild(mine
      ? button("Rejoin", "primary", () => { location.href = "/game.html?id=" + g.gameId; })
      : watchButton(g.gameId));

    card.appendChild(meta);
    gameListEl.appendChild(card);
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
    if (friendIds.has(p.userId)) who.appendChild(el("span", "friend-star", "★"));
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
  // You are always in this list, so "empty" really means "alone". Say something
  // useful rather than leaving a list of one with nothing to do.
  if (players.length <= 1) {
    const hint = el("p", "muted empty");
    hint.appendChild(document.createTextNode("Nobody else is here yet — post a challenge and it'll be waiting, or "));
    const ai = el("a", "nav-link", "play LorFish");
    ai.href = "/game.html?mode=ai";
    hint.appendChild(ai);
    hint.appendChild(document.createTextNode("."));
    playerListEl.appendChild(hint);
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
// The friends panel now lives on /friends.html. Here we only need the set of
// friend ids, so Players online can mark them with a star.

async function refreshFriends() {
  if (!window.Friends) return;
  try {
    await Friends.load();
  } catch (e) {
    return; // keep whatever we had
  }
  friendIds = new Set(Friends.state.friends.map((f) => f.userId));
  renderPlayers();
}

// --- puzzles: the two cards in the right column ---
// Both draw a real position with MiniBoard, read-only. The daily card shows the
// board every solver sees today; the "more puzzles" card PINS the puzzle it
// previews and passes its id through, so clicking Train serves that same board
// instead of a different random one.

async function loadPuzzleCards() {
  await Promise.all([loadDailyCard(), loadTrainCard()]);
}

async function loadDailyCard() {
  const card = document.getElementById("dailyCard");
  try {
    const res = await fetch("/api/puzzles/daily", { credentials: "same-origin" });
    if (!res.ok) {
      card.style.display = "none"; // no puzzles imported yet
      return;
    }
    const d = await res.json();
    const p = d.puzzle;
    const drawn = MiniBoard.render(document.getElementById("dailyBoard"), p.setupFen, {
      flip: p.playerColor === "b",
      lastMove: lastMoveOf(p.firstMove),
    });
    if (!drawn) {
      card.style.display = "none";
      return;
    }
    document.getElementById("dailyMeta").textContent =
      (p.playerColor === "w" ? "White" : "Black") + " to move";
    document.getElementById("dailyStreak").textContent =
      d.streak > 0 ? "🔥 " + d.streak + "-day streak" : "No streak yet";

    const cta = document.getElementById("dailyCta");
    cta.textContent = d.done ? (d.solved ? "Solved ✓ — review" : "Review") : "Solve";
    card.classList.toggle("solved", !!d.done);
  } catch (e) {
    card.style.display = "none";
  }
}

async function loadTrainCard() {
  const card = document.getElementById("trainCard");
  try {
    const res = await fetch("/api/puzzles/next", { credentials: "same-origin" });
    if (!res.ok) {
      card.style.display = "none";
      return;
    }
    const d = await res.json();
    const p = d.puzzle;
    const drawn = MiniBoard.render(document.getElementById("trainBoard"), p.setupFen, {
      flip: p.playerColor === "b",
      lastMove: lastMoveOf(p.firstMove),
    });
    if (!drawn) {
      card.style.display = "none";
      return;
    }
    document.getElementById("trainMeta").textContent = "Puzzle rating " + d.rating;
    // Pin it: the board above is the board you get.
    document.getElementById("trainCta").href = "/puzzles.html?id=" + encodeURIComponent(p.id);
  } catch (e) {
    card.style.display = "none";
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
  loadPuzzleCards();
  renderSeeks();
  renderGames();
  renderPlayers();
})();

// Exposed for debugging.
window.lorSocket = socket;

// Achievements are pushed to every socket a user holds, so one earned in a
// game that ended while this tab was in the lobby still shows up here.
socket.on("achievements:earned", (info) => {
  if (info && typeof AchievementToast !== "undefined") AchievementToast.show(info.list);
});
