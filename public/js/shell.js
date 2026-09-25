"use strict";

// The app chrome: a top bar and the left navigation rail, built on every page
// that includes this file. There is no templating in this project, so the
// alternative was pasting the same markup into eight HTML files and keeping
// them in sync by hand — this keeps the navigation in exactly one place.
//
// Load it BEFORE authGuard.js. It relocates the page's existing #userbar into
// the top bar rather than making a second one, so authGuard still finds it by
// id when its /api/me request comes back.
//
// Deliberately NOT used on game.html or replay.html: those are board views, and
// they keep their own focused header.

(function () {
  const ITEMS = [
    { href: "/lobby.html",        icon: "▶",  label: "Play" },
    { href: "/puzzles.html",      icon: "🧩", label: "Puzzles" },
    { href: "/stats.html",      icon: "📊", label: "Stats" },
    { href: "/history.html",      icon: "📜", label: "My Games" },
    { href: "/achievements.html", icon: "🏅", label: "Achievements" },
    { href: "/friends.html",      icon: "👥", label: "Friends" },
    { href: "/settings.html",     icon: "🎨", label: "Customize" },
    { href: "/leaderboard.html",  icon: "🏆", label: "Leaderboard" },
    { href: "/membership.html",   icon: "💎", label: "Membership" },
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const body = document.body;
  if (!body || body.classList.contains("has-shell")) return;

  // Everything already on the page becomes the main column. Scripts are left
  // where they are: moving them around achieves nothing and only risks
  // surprises with execution order.
  const existing = [];
  for (const node of Array.prototype.slice.call(body.childNodes)) {
    if (node.nodeType === 1 && node.tagName === "SCRIPT") continue;
    existing.push(node);
  }

  // --- top bar ---
  const topbar = el("header", "topbar");
  const brand = el("a", "brand", "♟ LorChess");
  brand.href = "/lobby.html";
  const right = el("div", "topbar-right");

  // Pages with a live socket fill this in; it stays hidden while empty, so
  // static pages don't advertise a connection they never make.
  const conn = el("span", "conn-dot pending");
  conn.id = "connStatus";
  conn.title = "Server connection";

  // Reuse the page's own userbar so authGuard's lookup still works.
  let userbar = document.getElementById("userbar");
  if (!userbar) {
    userbar = el("div", "userbar");
    userbar.id = "userbar";
  }
  right.append(conn, userbar);
  topbar.append(brand, right);

  // --- left rail ---
  const rail = el("nav", "app-rail");
  rail.setAttribute("aria-label", "Sections");
  const here = location.pathname.replace(/\/$/, "") || "/lobby.html";
  // Someone else's stats or achievements page is not "yours": keep those rail
  // items as links back to your own.
  const params = new URLSearchParams(location.search);
  const someoneElses = params.has("id") || params.has("user");
  for (const item of ITEMS) {
    const current = here === item.href &&
      !(someoneElses && (here === "/stats.html" || here === "/achievements.html"));
    // The page you are on is not a link to itself.
    const node = el(current ? "span" : "a", "rail-item" + (current ? " current" : ""));
    if (current) node.setAttribute("aria-current", "page");
    else node.href = item.href;
    node.append(el("span", "rail-icon", item.icon), el("span", "rail-label", item.label));
    rail.appendChild(node);
  }

  const main = el("div", "app-main");
  for (const node of existing) main.appendChild(node);

  // The rail replaces "← Lobby", but not a contextual back-link like replay's
  // "← My Games", which says where you came from rather than just naming a page.
  for (const link of main.querySelectorAll(".toplink")) {
    const a = link.querySelector("a");
    if (a && new URL(a.href, location.origin).pathname === "/lobby.html") link.remove();
  }

  body.insertBefore(main, body.firstChild);
  body.insertBefore(rail, main);
  body.insertBefore(topbar, rail);
  body.classList.add("has-shell");
})();
