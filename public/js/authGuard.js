"use strict";

// Page guard for authenticated pages. Loaded before the page's own scripts:
// if /api/me returns 401, bounce to the login page; otherwise expose the user
// as window.currentUser, render the user bar + logout button, and dispatch a
// "user:known" event on window for scripts that ran before the answer came.
//
// Note: this is a UX redirect, not a security boundary. All privileged actions
// are enforced server-side (requireAuth on the API, and authoritative socket
// checks in PvP). The page may flash briefly before the redirect — acceptable.

// Also home to the shared player-name helpers, because this is the one script
// every signed-in page loads.

// A player's name as a link to their profile. `newTab` is for live pages (the
// lobby, friends, a game), where navigating away would drop the socket — and
// with it any open seek, challenge or game.
window.playerLink = function (userId, username, opts) {
  const o = opts || {};
  const a = document.createElement("a");
  a.className = o.cls == null ? "name" : o.cls;
  a.textContent = username;
  // Your own name goes to your own profile, so the rail marks it as yours.
  const mine = window.currentUser && window.currentUser.id === Number(userId);
  a.href = mine ? "/profile.html" : "/profile.html?id=" + encodeURIComponent(userId);
  a.title = "View profile";
  if (o.newTab) { a.target = "_blank"; a.rel = "noopener"; }
  return a;
};

// The 💎 shown after a member's name wherever players are listed.
window.memberBadge = function () {
  const b = document.createElement("span");
  b.className = "member-icon";
  b.textContent = "💎";
  b.title = "Member";
  b.setAttribute("aria-label", "Member");
  return b;
};

(function () {
  // Only a 401 means "not signed in". Anything else — the server restarting,
  // a proxy error page, a dropped connection — is retried a few times, then the
  // user bar says so and offers a retry. Nobody is sent to the login page (and
  // off a half-edited settings page, or out of a puzzle) for a blip.
  const RETRY_MS = [500, 1000, 2000, 4000];
  function check(attempt) {
    fetch("/api/me", { credentials: "same-origin" })
      .then((res) => {
        if (res.status === 401) {
          location.replace("/login.html");
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((user) => {
        if (!user) return;
        window.currentUser = user;
        renderUserBar(user);
        window.dispatchEvent(new CustomEvent("user:known", { detail: user }));
      })
      .catch(() => {
        if (attempt < RETRY_MS.length) setTimeout(() => check(attempt + 1), RETRY_MS[attempt]);
        else renderUnreachable();
      });
  }
  check(0);

  function renderUnreachable() {
    const bar = document.getElementById("userbar");
    if (!bar) return;
    bar.innerHTML = "";
    const msg = document.createElement("span");
    msg.className = "who";
    msg.textContent = "Can't reach the server.";
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => check(0));
    bar.append(msg, retry);
  }

  function renderUserBar(user) {
    const bar = document.getElementById("userbar");
    if (!bar) return;
    bar.innerHTML = "";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = user.username;
    const rating = document.createElement("span");
    rating.id = "ubRating"; // updated live after rated PvP games
    rating.textContent = "(" + user.rating + ")";
    const logout = document.createElement("button");
    logout.textContent = "Log out";
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      // The cached look and feel is this user's, not the browser's.
      if (window.Theme) Theme.forget();
      location.href = "/login.html";
    });
    if (user.member_since) who.appendChild(memberBadge());
    bar.append(who, rating, logout);
  }
})();
