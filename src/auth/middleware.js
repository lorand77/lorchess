"use strict";

// Gate for REST routes that require a logged-in user. Pages protect themselves
// client-side by calling /api/me and redirecting on 401 (see public/js/authGuard.js).
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: "Authentication required." });
}

module.exports = { requireAuth };
