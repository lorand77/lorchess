"use strict";

// Incoming-chat toasts on the game page, so a message is noticed without
// watching the chat panel. Same corner and motion as achievementToast.js, but
// shorter-lived and one at a time: a newer message replaces the one showing,
// so a burst never piles up. The chat log itself is unchanged; clicking the
// toast scrolls to it. ChatToast.show({ username, text }).

const ChatToast = (function () {
  const SHOW_MS = 3000;
  const MAX_CHARS = 120;
  let host = null;
  let current = null;

  // Shares the achievement stack (whichever module gets there first makes it),
  // so a chat toast and an unlock toast stack instead of overlapping.
  function container() {
    if (host) return host;
    host = document.querySelector(".ach-toasts");
    if (host) return host;
    host = document.createElement("div");
    host.className = "ach-toasts";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  function hide(box) {
    clearTimeout(box.timer);
    box.classList.remove("show");
    setTimeout(() => box.remove(), 300);
    if (current === box) current = null;
  }

  function show(m) {
    if (!m || !m.text) return;
    if (current) hide(current);

    const box = document.createElement("button");
    box.type = "button";
    box.className = "chat-toast";
    box.title = "Go to chat";

    const who = document.createElement("span");
    who.className = "chat-toast-who";
    who.textContent = "💬 " + (m.username || "Chat");
    const text = document.createElement("span");
    text.className = "chat-toast-text";
    text.textContent = m.text.length > MAX_CHARS ? m.text.slice(0, MAX_CHARS - 1) + "…" : m.text;
    box.append(who, text);

    box.addEventListener("click", () => {
      const panel = document.getElementById("chat");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const input = document.getElementById("chatInput");
      if (input) input.focus({ preventScroll: true });
      hide(box);
    });

    container().appendChild(box);
    current = box;
    requestAnimationFrame(() => box.classList.add("show"));
    box.timer = setTimeout(() => hide(box), SHOW_MS);
  }

  return { show };
})();
