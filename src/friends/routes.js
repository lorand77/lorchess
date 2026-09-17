"use strict";

// Friends API. A friendship is a single row between two users that starts
// 'pending' (a request) and becomes 'accepted' when the addressee agrees.
// Requesting someone who has already requested you accepts their request.
//
//   GET    /api/friends                    -> { friends, incoming, outgoing }
//   POST   /api/friends/requests           { toUserId }
//   POST   /api/friends/requests/:id/accept
//   POST   /api/friends/requests/:id/decline
//   DELETE /api/friends/:id                (unfriend, or withdraw own request)
//
// Every mutation pushes `friends:changed` to both users' open sockets so their
// lobby / leaderboard / game pages refetch — the socket is a nudge, the REST
// response is the truth.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const lobby = require("../game/lobby");
const config = require("../config");

const router = express.Router();
router.use(requireAuth);

const AI_ID = queries.getUserByUsername.get(config.AI_USERNAME).id;

function view(row) {
  return {
    id: row.id,
    userId: row.other_id,
    username: row.other_username,
    rating: row.other_rating,
    since: row.responded_at || row.created_at,
  };
}

function listFor(userId) {
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const row of queries.listFriendshipsForUser.all({ me: userId })) {
    if (row.status === "accepted") out.friends.push(view(row));
    else if (row.addressee_id === userId) out.incoming.push(view(row));
    else out.outgoing.push(view(row));
  }
  return out;
}

function changed(...userIds) {
  for (const id of userIds) lobby.notifyUser(id, "friends:changed", {});
}

router.get("/", (req, res) => {
  res.json(listFor(req.session.userId));
});

router.post("/requests", (req, res) => {
  const me = req.session.userId;
  const toId = Number(req.body && req.body.toUserId);
  if (!Number.isInteger(toId) || toId <= 0) {
    return res.status(400).json({ error: "Missing toUserId." });
  }
  if (toId === me) return res.status(400).json({ error: "You can't friend yourself." });
  if (toId === AI_ID) return res.status(400).json({ error: "LorFish has no friends." });
  if (!queries.getUserById.get(toId)) return res.status(404).json({ error: "No such user." });

  const existing = queries.findFriendship.get({ a: me, b: toId });
  if (existing) {
    if (existing.status === "accepted") {
      return res.status(409).json({ error: "You're already friends." });
    }
    if (existing.requester_id === me) {
      return res.status(409).json({ error: "Request already sent." });
    }
    // They asked first — treat our request as an acceptance.
    queries.acceptFriendRequest.run(existing.id);
    changed(me, toId);
    return res.json({ ok: true, status: "accepted", id: existing.id });
  }

  const info = queries.createFriendRequest.run(me, toId);
  changed(me, toId);
  res.status(201).json({ ok: true, status: "pending", id: Number(info.lastInsertRowid) });
});

// Load a friendship row the session user is party to, or 404.
function loadOwn(req, res) {
  const row = queries.getFriendshipById.get(Number(req.params.id));
  const me = req.session.userId;
  if (!row || (row.requester_id !== me && row.addressee_id !== me)) {
    res.status(404).json({ error: "No such request." });
    return null;
  }
  return row;
}

router.post("/requests/:id/accept", (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  if (row.status !== "pending" || row.addressee_id !== req.session.userId) {
    return res.status(409).json({ error: "Nothing to accept." });
  }
  queries.acceptFriendRequest.run(row.id);
  changed(row.requester_id, row.addressee_id);
  res.json({ ok: true });
});

router.post("/requests/:id/decline", (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  if (row.status !== "pending" || row.addressee_id !== req.session.userId) {
    return res.status(409).json({ error: "Nothing to decline." });
  }
  queries.deleteFriendship.run(row.id);
  changed(row.requester_id, row.addressee_id);
  res.json({ ok: true });
});

// Either party may end a friendship; only the sender may withdraw a request
// (the addressee declines instead — same effect, clearer intent).
router.delete("/:id", (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  if (row.status === "pending" && row.requester_id !== req.session.userId) {
    return res.status(409).json({ error: "Use decline for a request sent to you." });
  }
  queries.deleteFriendship.run(row.id);
  changed(row.requester_id, row.addressee_id);
  res.json({ ok: true });
});

module.exports = router;
