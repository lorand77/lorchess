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
const variantSelect = document.getElementById("variantSelect");
const handicapBtn   = document.getElementById("handicapBtn");
const handicapSumEl = document.getElementById("handicapSummary");
const handicapClear = document.getElementById("handicapClear");
const seekListEl    = document.getElementById("seekList");
const playerListEl  = document.getElementById("playerList");
const gameListEl    = document.getElementById("gameList");
const incomingEl    = document.getElementById("incoming");
const rejoinEl      = document.getElementById("rejoin");

let searching = false;   // in the quick-match queue
let awaitingQueue = false; // lobby:join sent, no lobby:waiting back yet
let myseek = null;       // our own open seek, if any
let handicapChanges = null; // start-square changes for material odds, or null
let ratedBeforeForced = true;   // what "Rated" was before the form forced it off
let ratedForced = false;        // whether "Rated" is currently held off
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

// The squares of a UCI move, to highlight on a preview board. uci.js reads
// them without pulling the whole chess engine into this page.
function lastMoveOf(uci) {
  const m = parseUci(uci);
  return m ? { from: m.from, to: m.to } : null;
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
  // Material odds and casual-only variants are never rated. The server
  // enforces this independently.
  rated: ratedForced ? false : ratedCheck.checked,
  variant: variantSelect.value,
  handicap: handicapChanges ? { squares: handicapChanges } : null,
});

// LorFish's levels come from src/shared/aiLevels.js, the list the server
// resolves against. The form is a plain GET to game.html, which reads level
// and colour from the URL and offers no way to change them mid-game.
const aiLevelSelect = document.getElementById("aiLevelSelect");
for (const level of AI_LEVELS) {
  const selected = level.key === DEFAULT_AI_LEVEL;
  aiLevelSelect.add(new Option(aiLevelLabel(level.key), level.key, selected, selected));
}

// The variants LorFish plays, from the catalogue. The levels' ratings were
// measured in standard chess, so in any other variant they go by name alone.
// A team game whose seats LorFish can take (Bughouse) is here too, as a match
// rather than an AI game: you and LorFish against two more LorFish, timed,
// which the server starts and plays (bughouse:bots) instead of the game
// page's own worker.
const aiVariantSelect = document.getElementById("aiVariantSelect");
for (const v of VARIANTS.filter((v) => v.bot || hasSeatBots(v.key))) {
  aiVariantSelect.add(new Option(v.label, v.key, v.key === "standard", v.key === "standard"));
}
const aiClockSelect = document.getElementById("aiClockSelect");
for (const tc of TIME_CONTROLS) aiClockSelect.add(new Option(tc.label, tc.key, tc.key === DEFAULT_TC, tc.key === DEFAULT_TC));
function renderAiVariant() {
  for (const opt of aiLevelSelect.options) opt.textContent = aiLevelLabel(opt.value, aiVariantSelect.value);
  const team = isTeamGame(aiVariantSelect.value);
  document.getElementById("aiColorField").style.display = team ? "none" : "";
  document.getElementById("aiClockField").style.display = team ? "" : "none";
  document.getElementById("aiNote").textContent = team
    ? "You and LorFish against two more LorFish, on two boards. Timed and casual."
    : "Untimed and unrated.";
}
aiVariantSelect.addEventListener("change", renderAiVariant);
document.querySelector("#aiPanel form").addEventListener("submit", (e) => {
  if (!isTeamGame(aiVariantSelect.value)) return; // an AI game: the form's own GET
  e.preventDefault();
  const errEl = document.getElementById("aiError");
  errEl.textContent = "";
  socket.emit("bughouse:bots", { tc: aiClockSelect.value, level: aiLevelSelect.value }, (resp) => {
    if (!resp || !resp.ok) errEl.textContent = (resp && resp.error) || "Could not start the match.";
  });
});

// The picker starts at the level of the user's last AI game, read from their
// game list (see checkActiveGame), so the choice follows them across devices.
// Only once per page load, and never over a level they have already picked.
let aiLevelSettled = false;
aiLevelSelect.addEventListener("change", () => { aiLevelSettled = true; });

function restoreAiLevel(games) {
  if (aiLevelSettled) return;
  aiLevelSettled = true;
  // Newest first; games from before levels may have none, so skip those.
  const last = games.find((g) => g.mode === "ai" && AI_LEVELS_BY_KEY.has(g.ai_level));
  if (last) aiLevelSelect.value = last.ai_level;
}

// A handicap is defined as removals from the standard setup, so the two can't
// be combined. Whichever you pick second disables the other.
// The picker comes from the shared catalogue, so a new variant appears here the
// moment it is added to src/shared/variants.js.
for (const v of VARIANTS) {
  const opt = document.createElement("option");
  opt.value = v.key;
  opt.textContent = v.label;
  if (v.key === "standard") opt.selected = true;
  variantSelect.appendChild(opt);
}

// LorFish's level for the empty seats of a table.
const tableLevelSelect = document.getElementById("tableLevelSelect");
for (const level of AI_LEVELS) {
  const selected = level.key === DEFAULT_AI_LEVEL;
  tableLevelSelect.add(new Option(aiLevelLabel(level.key, "bughouse"), level.key, selected, selected));
}

function renderVariant() {
  // A team game seats four: no quick match or one-to-one offer, so no colour,
  // rating or handicap either. The panel opens a table instead, which the
  // time chosen here clocks and, where it can (Bughouse), LorFish fills
  // where nobody sits.
  const team = isTeamGame(variantSelect.value);
  const show = (id, on) => { document.getElementById(id).style.display = on ? "" : "none"; };
  show("quickMatchBtn", !team);
  show("seekBtn", !team);
  show("tableOpenBtn", team);
  show("colorField", !team);
  show("ratedField", !team);
  show("handicapRow", !team);
  show("tableLevelField", team && hasSeatBots(variantSelect.value));
  renderPlayers(); // the Challenge buttons follow
  // A handicap edits the standard opening setup, so it only means anything in
  // variants that start from it.
  const allowed = usesStandardSetup(variantSelect.value);
  handicapBtn.disabled = !allowed;
  handicapBtn.title = allowed
    ? ""
    : "A handicap only applies to games that start from the standard setup";
  if (!allowed && handicapChanges) {
    handicapChanges = null;
    renderHandicap();
  }
  renderRated();
}
variantSelect.addEventListener("change", renderVariant);

// "Rated" is held off while the game can't be rated — a handicap is set, or the
// variant is casual only — and put back to what the player had once it can be.
// Only on those two transitions: this also runs on every reconnect, and must
// not re-tick a box the player unticked.
function renderRated() {
  const casualVariant = !isRateable(variantSelect.value);
  const forced = !!handicapChanges || casualVariant;
  ratedCheck.disabled = forced;
  ratedCheck.title = casualVariant
    ? variantLabel(variantSelect.value) + " games are casual for now"
    : forced ? "A handicap game is always casual" : "";
  if (forced && !ratedForced) {
    ratedBeforeForced = ratedCheck.checked;
    ratedCheck.checked = false;
  } else if (!forced && ratedForced) {
    ratedCheck.checked = ratedBeforeForced;
  }
  ratedForced = forced;
}

// --- handicap ---

// Reflect the current handicap in the form: show the terms, and hold "Rated"
// off, since the server will refuse to rate the game either way.
function renderHandicap() {
  const on = !!handicapChanges;
  // With a handicap set, only the variants that start from the standard setup
  // stay selectable.
  if (on && !usesStandardSetup(variantSelect.value)) variantSelect.value = "standard";
  for (const opt of variantSelect.options) {
    opt.disabled = on && !usesStandardSetup(opt.value);
  }
  handicapBtn.textContent = on ? "⚖ Edit handicap…" : "⚖ Handicap…";
  handicapSumEl.textContent = on ? describe(handicapChanges) + " — casual only" : "";
  handicapClear.style.display = on ? "" : "none";
  renderRated();

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
    squares: handicapChanges || {},
    onSave: (squares) => {
      handicapChanges = Object.keys(squares).length ? squares : null;
      renderHandicap();
    },
  });
});

handicapClear.addEventListener("click", () => {
  handicapChanges = null;
  renderHandicap();
});

// --- socket ---

const socket = connectSocket({
  onConnect: () => {
    setStatus("connected", "ok");
    seekBtn.disabled = false;
    renderHandicap(); // also decides whether Quick Match is offered
    renderVariant();
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
  awaitingQueue = false;
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
  socket.emit("lobby:join", { tc: offer.tc, rated: offer.rated, variant: offer.variant });
  searching = true;
  awaitingQueue = true;
  quickBtn.textContent = "Cancel";
  matchStatusEl.textContent = "searching for an opponent…";
});

socket.on("lobby:waiting", (info) => {
  awaitingQueue = false;
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
  renderTables();
});

socket.on("challenge:list", (list) => {
  myChallenges = list || { incoming: [], outgoing: [] };
  renderIncoming();
  renderPlayers(); // outgoing challenges change the per-player button
});

socket.on("challenge:declined", (info) => {
  showError(((info && info.username) || "They") + " declined your challenge.");
});

socket.on("lobby:error", (info) => {
  showError(info && info.error);
  // A refused lobby:join never entered the queue: nothing to keep searching for.
  if (awaitingQueue) {
    awaitingQueue = false;
    resetSearch();
  }
});

// The friends list lives on the profile's Friends tab now. All this page needs is who they
// are, so it can star them in Players online.
socket.on("friends:changed", refreshFriends);

function renderSeeks() {
  const seeks = lastState.seeks;
  // Tables are open offers too, listed just below (renderTables).
  const open = seeks.length + (lastState.tables || []).length;
  document.getElementById("seekCount").textContent = open ? "(" + open + ")" : "";
  seekListEl.innerHTML = "";
  if (!open) {
    seekListEl.appendChild(el("p", "muted empty", "No open challenges. Post one above."));
    return;
  }
  for (const s of seeks) {
    const row = el("div", "row");
    const who = el("span", "row-main");
    who.appendChild(playerLink(s.userId, s.username, { newTab: true }));
    if (s.member) who.appendChild(memberBadge());
    who.appendChild(el("span", "rating", "(" + s.rating + ")"));
    who.appendChild(el("span", "tag", tcLabel(s.tc)));
    who.appendChild(el("span", "tag " + (s.rated ? "rated" : "casual"), s.rated ? "rated" : "casual"));
    if (s.variant && s.variant !== "standard") who.appendChild(el("span", "tag variant", variantLabel(s.variant)));
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
      vs.appendChild(playerLink(p.userId, p.username, { newTab: true }));
      if (p.member) vs.appendChild(memberBadge());
      if (p.rating != null) vs.appendChild(el("span", "rating", "(" + p.rating + ")"));
    };
    side(g.white);
    vs.appendChild(document.createTextNode(" vs "));
    side(g.black);
    meta.appendChild(vs);

    const tags = el("div");
    tags.appendChild(el("span", "tag", g.tc));
    tags.appendChild(el("span", "tag " + (g.rated ? "rated" : "casual"), g.rated ? "rated" : "casual"));
    if (g.variant && g.variant !== "standard") tags.appendChild(el("span", "tag variant", variantLabel(g.variant)));
    if (g.board != null) tags.appendChild(el("span", "tag", "board " + (g.board + 1)));
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
    who.appendChild(playerLink(p.userId, p.username, { newTab: true }));
    if (p.member) who.appendChild(memberBadge());
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
        const b = button("Challenge", "", () =>
          socket.emit("challenge:create", { toUserId: p.userId, ...currentOffer() })
        );
        // A team game isn't offered one to one: open a table for them to sit at.
        if (isTeamGame(variantSelect.value)) {
          b.disabled = true;
          b.title = variantLabel(variantSelect.value) + " is played at a table: open one for them to sit at";
        }
        row.appendChild(b);
      }
    }
    playerListEl.appendChild(row);
  }
  // You are always in this list, so "empty" really means "alone". Say something
  // useful rather than leaving a list of one with nothing to do.
  if (players.length <= 1) {
    const hint = el("p", "muted empty");
    hint.appendChild(document.createTextNode("Nobody else is here yet — post a challenge and it'll be waiting, or "));
    // To the panel, not into a game: level and colour are picked there.
    const ai = el("a", "nav-link", "play LorFish AI");
    ai.href = "#aiPanel";
    ai.addEventListener("click", () => document.getElementById("aiPlayBtn").focus());
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
    const from = el("strong");
    from.appendChild(playerLink(c.from.userId, c.from.username, { newTab: true, cls: "player-link" }));
    text.appendChild(from);
    if (c.from.member) text.appendChild(memberBadge());
    text.appendChild(el("span", "rating", "(" + c.from.rating + ")"));
    text.appendChild(document.createTextNode(" challenges you — "));
    text.appendChild(el("span", "tag", tcLabel(c.tc)));
    text.appendChild(el("span", "tag " + (c.rated ? "rated" : "casual"), c.rated ? "rated" : "casual"));
    if (c.variant && c.variant !== "standard") text.appendChild(el("span", "tag variant", variantLabel(c.variant)));
    if (c.handicap) text.appendChild(el("span", "tag handicap", c.handicap));
    text.appendChild(el("span", "muted small", colorNote(c.color)));
    box.appendChild(text);
    box.appendChild(button("Accept", "primary", () => socket.emit("challenge:accept", { id: c.id })));
    box.appendChild(button("Decline", "", () => socket.emit("challenge:decline", { id: c.id })));
    incomingEl.appendChild(box);
  }
}

// --- friends ---
// The friends panel now lives on the profile's Friends tab. Here we only need the set of
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
      (p.playerColor === "w" ? "White" : "Black") + " to move · unrated" +
      (!d.done && d.triesLeft != null ? " · " + d.triesLeft + (d.triesLeft === 1 ? " try" : " tries") : "");
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

// --- tables ---
// A team game picked in the Play panel opens a table (for Bughouse, the
// Play-the-computer panel starts a match with LorFish at once, above). Open
// tables are listed with the open challenges (renderTables): people pick
// seats, and the fourth to sit starts the game; at a Bughouse table the host
// may start it sooner, LorFish in the empty seats. Either way game:start
// (below) takes everyone to their board.
document.getElementById("tableOpenBtn").addEventListener("click", () => {
  socket.emit("table:create", { variant: variantSelect.value, tc: tcSelect.value, level: tableLevelSelect.value });
});

// The seats, a row each pair as the table shows them, with each seat's label.
// Bughouse: board 1 is A0 (White) against B0, board 2 B1 (White) against A1;
// team A is A0 and A1, team B the other two. Four-player chess: a row per
// team, Red and Yellow, then Blue and Green.
const TABLE_ROWS = {
  bughouse: [
    ["Board 1", [["A0", "White, team A"], ["B0", "Black, team B"]]],
    ["Board 2", [["B1", "White, team B"], ["A1", "Black, team A"]]],
  ],
  fourplayer: [
    ["Red & Yellow", [["r", "Red"], ["y", "Yellow"]]],
    ["Blue & Green", [["b", "Blue"], ["g", "Green"]]],
  ],
};

// Open tables, below the open challenges and in the same rows: the host and
// terms on top, then the seats in pairs — a name, or a button to sit there.
function renderTables() {
  const listEl = document.getElementById("tableList");
  const tables = lastState.tables || [];
  listEl.innerHTML = "";
  const me = myId();
  const mine = lastState.players.find((p) => p.userId === me);
  const playing = !!(mine && mine.playing);
  for (const t of tables) {
    const row = el("div", "row table-row");
    row.dataset.table = t.id;
    // The host is always seated somewhere (A0 to begin with).
    const host = Object.values(t.seats).find((p) => p && p.userId === t.hostId);
    const head = el("div", "row-main");
    head.appendChild(el("span", "name", `${host ? host.username : "?"}'s table`));
    head.appendChild(el("span", "tag", tcLabel(t.tc)));
    head.appendChild(el("span", "tag casual", "casual"));
    head.appendChild(el("span", "tag variant", variantLabel(t.variant)));
    const bots = hasSeatBots(t.variant);
    head.appendChild(el("span", "muted small", bots
      ? "empty seats: LorFish " + aiLevelLabel(t.level, t.variant)
      : "starts when all four seats are taken"));
    const seated = Object.values(t.seats).some((p) => p && p.userId === me);
    if (t.hostId === me) {
      if (bots) head.appendChild(button("Start now", "primary", () => socket.emit("table:start", { id: t.id })));
      head.appendChild(button("Close", "", () => socket.emit("table:leave")));
    } else if (seated) {
      head.appendChild(button("Leave", "", () => socket.emit("table:leave")));
    }
    row.appendChild(head);
    const seats = el("div", "table-seats");
    for (const [title, pair] of TABLE_ROWS[t.variant]) {
      seats.appendChild(el("span", "muted small", title));
      for (const [seat, label] of pair) seats.appendChild(seatCell(t, seat, label, playing));
    }
    row.appendChild(seats);
    listEl.appendChild(row);
  }
}

// One seat: who sits there, labelled with the seat, or a button to sit there.
function seatCell(table, seat, label, playing) {
  const p = table.seats[seat];
  const cell = el("span", "table-seat");
  cell.dataset.seat = seat;
  if (p) {
    cell.appendChild(el("span", p.userId === myId() ? "name" : null, p.username + (p.userId === myId() ? " (you)" : "")));
    cell.appendChild(el("span", "muted small", label));
  } else {
    const b = button(`Sit: ${label}`, "", () => socket.emit("table:sit", { id: table.id, seat }));
    b.disabled = playing;
    cell.appendChild(b);
  }
  return cell;
}

// --- starting a game ---

socket.on("game:start", (info) => {
  matchStatusEl.textContent = "matched! starting game…";
  location.href = "/game.html?id=" + info.gameId;
});

// --- resuming an unfinished game ---
// Fetched on load, and again only when something that could change the answer
// happens: my own "playing" flag flips, the set of live games changes, or the
// tab comes back into view. Not on every broadcast — those arrive up to once a
// second while any game is being played. The first answer also sets the
// LorFish level picker (restoreAiLevel).

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
    restoreAiLevel(games);
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

let resumeKey = null;
socket.on("lobby:state", (state) => {
  const mine = (state.players || []).find((p) => p.userId === myId());
  const key = (mine ? mine.playing : "?") + "|" + (state.games || []).map((g) => g.gameId).join(",");
  if (key === resumeKey) return;
  resumeKey = key;
  checkActiveGame();
});
window.addEventListener("focus", checkActiveGame);

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
