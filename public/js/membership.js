"use strict";

// Membership page. A promo code is currently the only way in, and every code is
// single-use — enforced by the server, which claims it with one conditional
// UPDATE. This file only asks and reports.

(function () {
  const joinView   = document.getElementById("joinView");
  const memberView = document.getElementById("memberView");
  const loadingEl  = document.getElementById("membershipLoading");
  const form       = document.getElementById("promoForm");
  const input      = document.getElementById("promoCode");
  const btn        = document.getElementById("promoBtn");
  const errorEl    = document.getElementById("promoError");
  const sinceEl    = document.getElementById("memberSince");

  // SQLite writes datetime('now') as UTC, "2026-09-22 14:05:01".
  function formatDate(s) {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? s : d.toLocaleDateString();
  }

  function show(state) {
    loadingEl.style.display = "none";
    joinView.style.display = state.member ? "none" : "";
    memberView.style.display = state.member ? "" : "none";
    if (state.member) {
      sinceEl.textContent = state.since ? "Member since " + formatDate(state.since) : "";
    }
  }

  async function load() {
    try {
      const res = await fetch("/api/membership", { credentials: "same-origin" });
      if (res.status === 401) { location.replace("/login.html"); return; }
      if (!res.ok) throw new Error();
      show(await res.json());
    } catch (e) {
      // Can't tell either way — offer the form rather than a dead page.
      show({ member: false });
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) {
      errorEl.textContent = "Enter a promo code first.";
      input.focus();
      return;
    }
    btn.disabled = true;
    errorEl.textContent = "";
    try {
      const res = await fetch("/api/membership/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.status === 401) { location.replace("/login.html"); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = data.error || "Incorrect promo code.";
        input.select();
        return;
      }
      show(data);
    } catch (err) {
      errorEl.textContent = "Couldn't reach the server. Try again.";
    } finally {
      btn.disabled = false;
    }
  });

  // Clear the rejection as soon as they edit, so it always refers to what's
  // currently in the box.
  input.addEventListener("input", () => { errorEl.textContent = ""; });

  load();
})();
