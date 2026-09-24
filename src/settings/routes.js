"use strict";

// Per-user look & feel. Colours are a small JSON blob on the users row;
// uploaded images (page background, individual piece slots) are BLOBs in
// user_assets and served back only to their owner.
//
//   GET    /api/settings                 -> { scheme, light, dark, bgColor, assets: { kind: version } }
//   PUT    /api/settings                 { scheme?, light?, dark?, bgColor? }
//                                        (scheme is "dark" or "light"; the rest are hex colours)
//   POST   /api/settings/reset           back to defaults, drop all uploads
//   PUT    /api/settings/assets/:kind    raw image body (png/jpeg/gif/webp/svg)
//   DELETE /api/settings/assets/:kind
//   GET    /api/settings/assets/:kind    the image (cache-busted by ?v=version)

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");

const router = express.Router();
router.use(requireAuth);

const DEFAULTS = { scheme: "dark", light: "#f0d9b5", dark: "#b58863", bgColor: "#323232" };
const COLOR_KEYS = ["light", "dark", "bgColor"];
const SCHEMES = new Set(["dark", "light"]);
const HEX = /^#[0-9a-f]{6}$/i;

const PIECE_KINDS = ["w", "b"].flatMap((c) => ["K", "Q", "R", "B", "N", "P"].map((t) => c + t));
const KINDS = new Set(["bg", ...PIECE_KINDS]);
const MAX_BYTES = { bg: 3 * 1024 * 1024, piece: 512 * 1024 };
const RAW_LIMIT = "3mb";

function readPrefs(userId) {
  const row = queries.getUserPrefs.get(userId);
  let stored = {};
  try {
    stored = JSON.parse((row && row.prefs) || "{}") || {};
  } catch (e) {
    stored = {};
  }
  const prefs = { ...DEFAULTS };
  if (SCHEMES.has(stored.scheme)) prefs.scheme = stored.scheme;
  for (const k of COLOR_KEYS) if (HEX.test(stored[k] || "")) prefs[k] = stored[k].toLowerCase();
  return prefs;
}

function settingsFor(userId) {
  const assets = {};
  for (const a of queries.listUserAssets.all(userId)) assets[a.kind] = a.updated_at;
  return { ...readPrefs(userId), assets };
}

router.get("/", (req, res) => res.json(settingsFor(req.session.userId)));

router.put("/", (req, res) => {
  const uid = req.session.userId;
  const body = req.body || {};
  const prefs = readPrefs(uid);
  if (body.scheme !== undefined) {
    if (!SCHEMES.has(body.scheme)) {
      return res.status(400).json({ error: 'scheme must be "dark" or "light".' });
    }
    prefs.scheme = body.scheme;
  }
  for (const k of COLOR_KEYS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "string" || !HEX.test(body[k])) {
      return res.status(400).json({ error: `${k} must be a hex colour like #b58863.` });
    }
    prefs[k] = body[k].toLowerCase();
  }
  queries.setUserPrefs.run(JSON.stringify(prefs), uid);
  res.json(settingsFor(uid));
});

router.post("/reset", (req, res) => {
  const uid = req.session.userId;
  queries.setUserPrefs.run(null, uid);
  queries.deleteAllUserAssets.run(uid);
  res.json(settingsFor(uid));
});

// Identify the image by its bytes, never by the client's Content-Type.
function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

function kindParam(req, res) {
  const kind = String(req.params.kind || "");
  if (!KINDS.has(kind)) {
    res.status(404).json({ error: "Unknown slot." });
    return null;
  }
  return kind;
}

router.put("/assets/:kind", express.raw({ type: () => true, limit: RAW_LIMIT }), (req, res) => {
  const kind = kindParam(req, res);
  if (!kind) return;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: "No image data received." });
  }
  const max = kind === "bg" ? MAX_BYTES.bg : MAX_BYTES.piece;
  if (buf.length > max) {
    return res.status(413).json({ error: `Image too large (max ${Math.round(max / 1024)} KB).` });
  }
  const mime = sniff(buf);
  if (!mime) return res.status(415).json({ error: "Use a PNG, JPEG, GIF, WebP, or SVG image." });
  queries.upsertUserAsset.run(req.session.userId, kind, mime, buf);
  res.json(settingsFor(req.session.userId));
});

router.delete("/assets/:kind", (req, res) => {
  const kind = kindParam(req, res);
  if (!kind) return;
  queries.deleteUserAsset.run(req.session.userId, kind);
  res.json(settingsFor(req.session.userId));
});

router.get("/assets/:kind", (req, res) => {
  const kind = kindParam(req, res);
  if (!kind) return;
  const row = queries.getUserAsset.get(req.session.userId, kind);
  if (!row) return res.status(404).end();
  res.set({
    "Content-Type": row.mime,
    "Content-Length": row.data.length,
    // The URL carries ?v=<updated_at>, so a long private cache is safe.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    // An SVG opened directly could otherwise run script; as an <img> it never
    // does, and this keeps a direct visit inert too.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.send(row.data);
});

module.exports = router;
