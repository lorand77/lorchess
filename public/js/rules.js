"use strict";

// The Rules page (rules.html): one tab per section, General first and then
// every variant in the catalogue's order. The rule text is the page's own; the
// tab names and each variant's "at a glance" line (players, rated or casual,
// LorFish, odds, review) come from the catalogue (variants.js), so they can't
// disagree with what the lobby offers. The tab shown is the URL's hash
// (rules.html#atomic), so a link can open one.

(function () {
  const nav = document.getElementById("rulesTabs");
  const sections = Array.prototype.slice.call(document.querySelectorAll(".rules-section"));

  for (const s of sections) {
    const key = s.dataset.key;
    const a = document.createElement("a");
    a.href = "#" + key;
    a.dataset.tab = key;
    a.setAttribute("role", "tab");
    a.textContent = key === "general" ? "General" : variantLabel(key);
    nav.appendChild(a);
    const glance = s.querySelector(".rules-glance");
    if (glance) glance.textContent = glanceOf(key);
  }

  // "Two players · rated or casual · against LorFish from the lobby · odds
  // games · Stockfish review".
  function glanceOf(key) {
    const parts = [isFreeForAll(key) ? "Four players, each for themselves" : isTeamGame(key) ? "Four players, two teams" : "Two players"];
    parts.push(isRateable(key) ? "rated or casual" : "casual only");
    if (hasBot(key)) parts.push("play LorFish from the lobby");
    else if (hasSeatBots(key)) parts.push("LorFish can fill empty seats");
    parts.push(usesStandardSetup(key) ? "odds games allowed" : "no odds games");
    parts.push(isReviewable(key) ? "Stockfish game review" : "no Stockfish review");
    return parts.join(" · ");
  }

  function show() {
    let key = decodeURIComponent(location.hash.slice(1));
    if (!sections.some((s) => s.dataset.key === key)) key = "general";
    for (const s of sections) s.hidden = s.dataset.key !== key;
    for (const a of nav.querySelectorAll("[data-tab]")) {
      const on = a.dataset.tab === key;
      a.classList.toggle("current", on);
      a.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  window.addEventListener("hashchange", show);
  show();
})();
