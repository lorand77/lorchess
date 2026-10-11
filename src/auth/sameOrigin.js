"use strict";

// Refuses requests that a page on another origin makes with the user's cookie.
// Every *.lorand77.dev app is the same *site* as LorChess, so SameSite=Lax
// still sends them the session cookie, and CORS stops neither a WebSocket nor
// a body-less "simple" POST. The browser's Origin header is what tells them
// apart. Used by the /api routes and the Socket.IO handshake.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// True when the Origin header names the host the request was sent to. A
// request without one is not from a browser page (browsers send it on every
// WebSocket and every non-GET fetch), so it can only use a cookie it already
// holds. "null" (sandboxed frames, file://) does not parse and is refused.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host === String(req.headers.host || "").toLowerCase();
}

// Express middleware for /api: reads may come from anywhere (CORS keeps the
// answer from a foreign page), changes only from LorChess's own pages.
function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method) || sameOrigin(req)) return next();
  res.status(403).json({ error: "Cross-origin request refused." });
}

module.exports = { sameOrigin, requireSameOrigin };
