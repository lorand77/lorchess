"use strict";

// Membership page — a placeholder for now. There are no memberships to buy and
// no codes that work: every submission is rejected. Redemption is deliberately
// NOT wired to the server, because there is nothing to check against yet; when
// real codes exist this has to move to an authenticated endpoint, since a
// client-side check could be bypassed trivially.

(function () {
  const form = document.getElementById("promoForm");
  const input = document.getElementById("promoCode");
  const errorEl = document.getElementById("promoError");
  if (!form || !input || !errorEl) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) {
      errorEl.textContent = "Enter a promo code first.";
      input.focus();
      return;
    }
    // No code is valid yet.
    errorEl.textContent = "Incorrect promo code.";
    input.select();
  });

  // Clear the rejection as soon as they start editing, so the message always
  // refers to what is currently in the box.
  input.addEventListener("input", () => {
    errorEl.textContent = "";
  });
})();
