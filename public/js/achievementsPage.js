"use strict";

// The profile's Achievements tab: the whole catalogue, grouped, with what this
// user has earned. On someone else's profile only their earned badges are
// returned; the locked ones still render so the tab reads the same.

(window.profileTabs = window.profileTabs || {}).achievements = async function ({ you, userId }) {
  const content = document.getElementById("achContent");
  const summary = document.getElementById("achSummary");

  const url = you ? "/api/achievements/me" : "/api/achievements/user/" + encodeURIComponent(userId);

  let data;
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.status === 401) { location.replace("/login.html"); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    summary.textContent = "Failed to load achievements.";
    return;
  }

  // Something time-based (the anniversary) may have just been awarded.
  if (you && data.fresh && data.fresh.length) AchievementToast.show(data.fresh);

  const earned = {};
  for (const e of data.earned) earned[e.key] = e;

  const total = ACHIEVEMENTS.length;
  const got = ACHIEVEMENTS.filter((a) => earned[a.key]).length;
  const maxed = ACHIEVEMENTS.filter((a) => earned[a.key] && earned[a.key].tier >= maxTier(a)).length;
  summary.textContent = `${got} of ${total} unlocked · ${maxed} at the highest tier`;

  content.innerHTML = "";
  for (const g of GROUPS) {
    const items = ACHIEVEMENTS.filter((a) => a.group === g.key);
    if (!items.length) continue;
    const panel = el("section", "panel");
    const h = el("h2", "", g.title + " ");
    h.appendChild(el("span", "count", `${items.filter((a) => earned[a.key]).length}/${items.length}`));
    panel.appendChild(h);
    if (g.key === "hidden") {
      panel.appendChild(el("p", "muted small ach-hint", "These reveal themselves only once earned."));
    }
    const grid = el("div", "ach-grid");
    for (const a of items) grid.appendChild(card(a, earned[a.key]));
    panel.appendChild(grid);
    content.appendChild(panel);
  }

  function card(a, e) {
    const locked = !e;
    const secret = locked && a.hidden;
    const tier = e ? e.tier : 0;
    const max = maxTier(a);
    const c = el("div", "ach-card" + (locked ? " locked" : "") + (tier >= max && !locked ? " maxed" : ""));

    c.appendChild(el("div", "ach-icon", secret ? "❔" : a.icon));

    const body = el("div", "ach-body");
    body.appendChild(el("div", "ach-name", secret ? "???" : a.name));
    body.appendChild(el("div", "ach-desc", secret ? "Hidden achievement." : describeAchievement(a, locked ? 1 : tier)));

    if (a.tiers && !secret) {
      const pips = el("div", "ach-tiers");
      a.tiers.forEach((n, i) => {
        const p = el("span", "ach-pip" + (i < tier ? " on" : ""), "");
        p.title = TIER_NAMES[i] + ": " + describeAchievement(a, i + 1);
        pips.appendChild(p);
      });
      const label = el("span", "ach-tier-label", tier ? TIER_NAMES[tier - 1] : "Locked");
      pips.appendChild(label);
      body.appendChild(pips);
    }

    if (e) {
      const meta = el("div", "ach-meta muted small");
      meta.appendChild(document.createTextNode("Earned " + fmtDate(e.earned_at)));
      if (e.game_id) {
        meta.appendChild(document.createTextNode(" · "));
        const link = el("a", "nav-link", "view game →");
        link.href = "/replay.html?id=" + e.game_id;
        meta.appendChild(link);
      }
      body.appendChild(meta);
    }
    c.appendChild(body);
    return c;
  }

  // SQLite datetime('now') is UTC like "2026-06-26 13:35:07".
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s.replace(" ", "T") + "Z");
    return isNaN(d) ? s : d.toLocaleDateString();
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
};
