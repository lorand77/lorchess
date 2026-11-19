"use strict";

// A game's star: a button that stars the game for the signed-in user, or takes
// the star off (POST /api/games/:id/star). Stars are private, a list of games
// to find again under "Starred only" on your Games tab. Used by the replay
// pages, the game pages once a game is over, and each row of your Games tab.
//
//   StarButton.attach(button, gameId, starred, { label: true })
//
// `label` writes "Star" / "Starred" beside the star; without it the button is
// the star alone. A refusal (the limit, say) is shown in the button's title
// and in `opts.onError(message)` if given.

const StarButton = (function () {
  function paint(btn, on, label) {
    btn.textContent = (on ? "★" : "☆") + (label ? (on ? " Starred" : " Star") : "");
    btn.classList.add("star-btn");
    btn.classList.toggle("starred", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Take the star off this game" : "Star this game, to find it again on your Games tab";
    btn.dataset.starred = on ? "1" : "0";
  }

  // Star (`on`) or unstar game `id`. Resolves to { starred } or { error }.
  async function set(id, on) {
    try {
      const res = await fetch("/api/games/" + id + "/star", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: on }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || "Couldn't change the star." };
      return { starred: !!data.starred };
    } catch (e) {
      return { error: "Couldn't reach the server." };
    }
  }

  function attach(btn, id, starred, opts) {
    const o = opts || {};
    let on = !!starred;
    btn.type = "button";
    paint(btn, on, o.label);
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await set(id, !on);
      btn.disabled = false;
      if (r.error) {
        btn.title = r.error;
        if (o.onError) o.onError(r.error);
        return;
      }
      on = r.starred;
      paint(btn, on, o.label);
      if (o.onChange) o.onChange(on);
    };
    return btn;
  }

  return { attach, set };
})();
