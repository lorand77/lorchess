"use strict";

// The profile's Friends tab: pending requests, then your friends with live
// presence and a one-click challenge. Friendships come from /api/friends (REST); the socket
// only supplies two things — a `friends:changed` nudge telling us to refetch,
// and `lobby:state` for the online / playing badges. The socket opens the
// first time the tab is shown, not with the page.
//
// On someone else's profile it is only their list of friends (no requests,
// no presence, no challenges), from /api/friends/user/:id.

(window.profileTabs = window.profileTabs || {}).friends = function ({ you, userId }) {
  if (!you) return visitorList(userId);
  document.getElementById("friendsOwn").hidden = false;

  const reqsEl    = document.getElementById("friendRequests");
  const listEl    = document.getElementById("friendList");
  const errorEl   = document.getElementById("friendsError");
  const tcSelect  = document.getElementById("tcSelect");
  const colorSel  = document.getElementById("colorSelect");
  const ratedCb   = document.getElementById("ratedCheck");

  let players = new Map();            // userId -> presence entry
  let outgoingChallenges = new Map(); // userId -> pending game challenge
  let incomingChallenges = [];        // challenges to me, answerable from here

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.addEventListener("click", onClick);
    return b;
  }
  function showError(msg) {
    errorEl.textContent = msg || "";
    if (msg) setTimeout(() => { errorEl.textContent = ""; }, 4000);
  }

  for (const tc of TIME_CONTROLS) {
    const opt = el("option", null, tc.label);
    opt.value = tc.key;
    if (tc.key === DEFAULT_TC) opt.selected = true;
    tcSelect.appendChild(opt);
  }
  const currentOffer = () => ({
    tc: tcSelect.value,
    color: colorSel.value,
    rated: ratedCb.checked,
  });

  const socket = connectSocket({
    onConnect: () => socket.emit("lobby:enter"), // subscribe to presence only
    onError: (err) => showError("Connection error: " + err.message),
  });

  socket.on("lobby:state", (state) => {
    players = new Map((state.players || []).map((p) => [p.userId, p]));
    render();
  });
  socket.on("challenge:list", (list) => {
    outgoingChallenges = new Map(((list && list.outgoing) || []).map((c) => [c.to.userId, c]));
    incomingChallenges = (list && list.incoming) || [];
    render();
  });
  socket.on("lobby:error", (info) => showError(info && info.error));
  socket.on("challenge:declined", (info) =>
    showError(((info && info.username) || "They") + " declined your challenge."));
  socket.on("friends:changed", refresh);
  // A challenge accepted from here starts a game for both sides.
  socket.on("game:start", (info) => { location.href = "/game.html?id=" + info.gameId; });

  async function refresh() {
    try {
      await Friends.load();
    } catch (e) {
      /* keep the last known list on screen */
    }
    render();
  }

  // Run a Friends mutation; the server's friends:changed nudge refetches, but
  // refetch here too so the page is right even with the socket down.
  function act(promise) {
    promise.catch((err) => showError(err.message)).then(refresh);
  }

  function watchButton(gameId) {
    const b = el("button", "", "Watch");
    b.addEventListener("click", () => { location.href = "/game.html?watch=" + gameId; });
    return b;
  }

  function render() {
    if (!window.Friends) return;
    const { friends, incoming, outgoing } = Friends.state;

    reqsEl.innerHTML = "";
    for (const r of incoming) {
      const box = el("div", "challenge-box");
      const text = el("span", "row-main");
      const from = el("strong");
      from.appendChild(playerLink(r.userId, r.username, { newTab: true, cls: "player-link" }));
      text.appendChild(from);
      if (r.member) text.appendChild(memberBadge());
      text.appendChild(el("span", "rating", "(" + r.rating + ")"));
      text.appendChild(document.createTextNode(" wants to be friends"));
      box.appendChild(text);
      box.appendChild(button("Accept", "primary", () => act(Friends.accept(r.id))));
      box.appendChild(button("Decline", "", () => act(Friends.decline(r.id))));
      reqsEl.appendChild(box);
    }
    // Game challenges addressed to me, so one that arrives while I sit on this
    // tab can be answered here and not only from the lobby.
    for (const c of incomingChallenges) {
      const box = el("div", "challenge-box");
      const text = el("span", "row-main");
      const from = el("strong");
      from.appendChild(playerLink(c.from.userId, c.from.username, { newTab: true, cls: "player-link" }));
      text.appendChild(from);
      if (c.from.member) text.appendChild(memberBadge());
      text.appendChild(el("span", "rating", "(" + c.from.rating + ")"));
      const tc = findTimeControl(c.tc);
      const terms = [tc ? tc.label : c.tc, c.rated ? "rated" : "casual"];
      if (c.variant && c.variant !== "standard") terms.push(c.variant);
      if (c.handicap) terms.push("handicap: " + c.handicap);
      text.appendChild(document.createTextNode(" challenges you · " + terms.join(" · ")));
      box.appendChild(text);
      box.appendChild(button("Accept", "primary", () => socket.emit("challenge:accept", { id: c.id })));
      box.appendChild(button("Decline", "", () => socket.emit("challenge:decline", { id: c.id })));
      reqsEl.appendChild(box);
    }

    listEl.innerHTML = "";
    for (const f of friends) {
      const p = players.get(f.userId);
      const row = el("div", "row");
      const who = el("span", "row-main");
      who.appendChild(playerLink(f.userId, f.username, { newTab: true }));
      if (f.member) who.appendChild(memberBadge());
      who.appendChild(el("span", "rating", "(" + f.rating + ")"));
      if (!p) who.appendChild(el("span", "tag offline", "offline"));
      else if (p.playing) who.appendChild(el("span", "tag playing", "playing"));
      else who.appendChild(el("span", "tag online", "online"));
      row.appendChild(who);

      const pending = outgoingChallenges.get(f.userId);
      if (pending) {
        row.appendChild(button("Withdraw", "", () => socket.emit("challenge:cancel", { id: pending.id })));
      } else if (p && p.playing && p.gameId) {
        row.appendChild(watchButton(p.gameId));
      } else {
        const b = button("Challenge", "primary", () =>
          socket.emit("challenge:create", { toUserId: f.userId, ...currentOffer() }));
        if (!p || p.playing) {
          b.disabled = true;
          b.title = p ? "Already in a game" : "Offline";
        }
        row.appendChild(b);
      }
      row.appendChild(button("Remove", "", () => {
        if (confirm("Remove " + f.username + " from your friends?")) act(Friends.remove(f.id));
      }));
      listEl.appendChild(row);
    }

    for (const r of outgoing) {
      const row = el("div", "row");
      const who = el("span", "row-main");
      who.appendChild(playerLink(r.userId, r.username, { newTab: true }));
      if (r.member) who.appendChild(memberBadge());
      who.appendChild(el("span", "rating", "(" + r.rating + ")"));
      who.appendChild(el("span", "tag pending", "request sent"));
      row.appendChild(who);
      row.appendChild(button("Withdraw", "", () => act(Friends.remove(r.id))));
      listEl.appendChild(row);
    }

    if (!friends.length && !outgoing.length && !incoming.length) {
      const empty = el("p", "muted empty");
      empty.appendChild(document.createTextNode("No friends yet. Add some from the "));
      const a = el("a", "nav-link", "leaderboard");
      a.href = "/leaderboard.html";
      empty.appendChild(a);
      empty.appendChild(document.createTextNode(" or after a game."));
      listEl.appendChild(empty);
    }
  }

  refresh();
};

async function visitorList(userId) {
  const listEl = document.getElementById("friendList");
  listEl.textContent = "Loading…";
  let friends;
  try {
    const res = await fetch("/api/friends/user/" + encodeURIComponent(userId), { credentials: "same-origin" });
    if (res.status === 401) { location.replace("/login.html"); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    friends = (await res.json()).friends;
  } catch (e) {
    listEl.textContent = "Failed to load friends.";
    return;
  }

  listEl.innerHTML = "";
  if (!friends.length) {
    const empty = document.createElement("p");
    empty.className = "muted empty";
    empty.textContent = "No friends yet.";
    listEl.appendChild(empty);
    return;
  }
  for (const f of friends) {
    const row = document.createElement("div");
    row.className = "row";
    const who = document.createElement("span");
    who.className = "row-main";
    who.appendChild(playerLink(f.userId, f.username));
    if (f.member) who.appendChild(memberBadge());
    const rating = document.createElement("span");
    rating.className = "rating";
    rating.textContent = "(" + f.rating + ")";
    who.appendChild(rating);
    row.appendChild(who);
    listEl.appendChild(row);
  }
}
