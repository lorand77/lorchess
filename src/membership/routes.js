"use strict";

// Membership. There is nothing to buy yet: the only way in is a promo code,
// and every code works exactly once.
//
//   GET  /api/membership          { member, since }
//   POST /api/membership/redeem   { code } -> { ok, since } | 4xx { error }
//
// Codes are created out-of-band by `npm run promo:new` (src/db/promoCodes.js).

const express = require("express");
const db = require("../db/index");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");

const router = express.Router();
router.use(requireAuth);

// Codes are nine digits, but people paste them with spaces or dashes in.
const normalize = (raw) => String(raw == null ? "" : raw).replace(/[\s-]/g, "");
const CODE_RE = /^[0-9]{9}$/;

// Guessing rate limit. The odds of hitting one of a handful of live codes in a
// 10^9 space are already negligible, but an unthrottled endpoint invites
// someone to try anyway — and it costs one Map to stop them.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map(); // userId -> timestamps of recent tries

function tooManyAttempts(userId) {
  const now = Date.now();
  const recent = (attempts.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(userId, recent);
    return true;
  }
  recent.push(now);
  attempts.set(userId, recent);
  return false;
}

function view(userId) {
  const row = queries.getMembership.get(userId);
  const since = row && row.member_since ? row.member_since : null;
  return { member: !!since, since };
}

router.get("/", (req, res) => res.json(view(req.session.userId)));

router.post("/redeem", (req, res) => {
  const uid = req.session.userId;
  const current = view(uid);
  // Already a member: stop here so a second code isn't burned for nothing.
  if (current.member) {
    return res.status(409).json({ error: "You're already a member.", ...current });
  }
  if (tooManyAttempts(uid)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const code = normalize(req.body && req.body.code);
  if (!code) return res.status(400).json({ error: "Enter a promo code first." });
  if (!CODE_RE.test(code)) {
    return res.status(400).json({ error: "Incorrect promo code." });
  }

  // Claim and grant together: if the process dies between them, neither
  // happened, so a code is never consumed without the membership it buys.
  const redeem = db.transaction(() => {
    const claimed = queries.claimPromoCode.run(uid, code).changes === 1;
    if (!claimed) return false;
    queries.setMemberSince.run(uid);
    return true;
  });

  if (!redeem()) {
    // Distinguish "used" from "wrong" on purpose: it is far more useful to the
    // person holding a spent code, and with the rate limit above the extra
    // information is worth nothing to someone guessing.
    const existing = queries.getPromoCode.get(code);
    if (existing) {
      return res.status(409).json({ error: "That code has already been used." });
    }
    return res.status(404).json({ error: "Incorrect promo code." });
  }

  res.json({ ok: true, ...view(uid) });
});

module.exports = router;
