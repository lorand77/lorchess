"use strict";

// Page guard for authenticated pages. Loaded before the page's own scripts:
// if /api/me returns 401, bounce to the login page; otherwise expose the user
// as window.currentUser and render the user bar + logout button.
//
// Note: this is a UX redirect, not a security boundary. All privileged actions
// are enforced server-side (requireAuth on the API, and authoritative socket
// checks in PvP). The page may flash briefly before the redirect — acceptable.

(function () {
  fetch("/api/me", { credentials: "same-origin" })
    .then((res) => {
      if (res.status === 401) {
        location.replace("/login.html");
        return null;
      }
      return res.json();
    })
    .then((user) => {
      if (!user) return;
      window.currentUser = user;
      renderUserBar(user);
    })
    .catch(() => {
      // If the check itself fails (server down), send them to login.
      location.replace("/login.html");
    });

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
      location.href = "/login.html";
    });
    bar.append(who, rating, logout);
  }
})();
