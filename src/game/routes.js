"use strict";

// REST persistence for AI games. In v1 the browser is authoritative for its own
// solo game (it runs the rules and the engine), so the server simply records
// what the client reports — there's no move validation here. Authoritative
// server-side validation arrives with PvP over sockets (M5).

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const config = require("../config");

const router = express.Router();

// The reserved AI account id (seeded in db/index.js). Games store it as the
// white_id/black_id of the AI side; individual AI moves record by_user = NULL.
const AI_ID = queries.getUserByUsername.get(config.AI_USERNAME).id;

const STANDARD_START =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const VALID_RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);

const turnOf = (fen) => (String(fen).split(/\s+/)[1] === "b" ? "b" : "w");

router.use(requireAuth);

// Load a game and ensure the session user is a (human) participant.
function loadOwnedGame(req, res) {
  const game = queries.getGameById.get(Number(req.params.id));
  if (!game) {
    res.status(404).json({ error: "No such game." });
    return null;
  }
  const uid = req.session.userId;
  if (game.white_id !== uid && game.black_id !== uid) {
    res.status(403).json({ error: "Not your game." });
    return null;
  }
  return game;
}

// POST /api/games — create a new AI game for the current user.
router.post("/", (req, res) => {
  const { humanColor, depth, startFen } = req.body || {};
  const human = humanColor === "b" ? "b" : "w";
  const aiColor = human === "w" ? "b" : "w";
  const uid = req.session.userId;
  const whiteId = human === "w" ? uid : AI_ID;
  const blackId = human === "w" ? AI_ID : uid;
  const fen =
    typeof startFen === "string" && startFen.trim() ? startFen.trim() : STANDARD_START;
  const aiDepth = parseInt(depth, 10) || 2;

  const info = queries.createGame.run(
    whiteId, blackId, "ai", aiColor, aiDepth, fen, fen, turnOf(fen)
  );
  res.status(201).json({
    gameId: Number(info.lastInsertRowid),
    humanColor: human,
    aiColor,
    turn: turnOf(fen),
  });
});

// GET /api/games — the user's games, newest first.
router.get("/", (req, res) => {
  const uid = req.session.userId;
  res.json(queries.listGamesForUser.all(uid, uid));
});

// GET /api/games/:id — a single game with its full move list.
router.get("/:id", (req, res) => {
  const game = loadOwnedGame(req, res);
  if (!game) return;
  res.json({ ...game, moves: queries.getMovesForGame.all(game.id) });
});

// POST /api/games/:id/moves — append one move and advance the position.
router.post("/:id/moves", (req, res) => {
  const game = loadOwnedGame(req, res);
  if (!game) return;
  if (game.status !== "active") {
    return res.status(409).json({ error: "Game is not active." });
  }
  const { ply, san, uci, fenAfter, byColor } = req.body || {};
  if (
    !Number.isInteger(ply) ||
    typeof san !== "string" ||
    typeof uci !== "string" ||
    typeof fenAfter !== "string" ||
    (byColor !== "w" && byColor !== "b")
  ) {
    return res.status(400).json({ error: "Invalid move payload." });
  }

  // Map the mover's color to a user id; the AI side records as NULL.
  const moverId = byColor === "w" ? game.white_id : game.black_id;
  const byUser = moverId === AI_ID ? null : moverId;

  try {
    queries.insertMove.run(game.id, ply, san, uci, fenAfter, byUser);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Move already recorded." });
    }
    throw err;
  }
  queries.updateGamePosition.run(fenAfter, turnOf(fenAfter), game.id);
  res.status(201).json({ ok: true, ply });
});

// POST /api/games/:id/end — finalize a finished game.
router.post("/:id/end", (req, res) => {
  const game = loadOwnedGame(req, res);
  if (!game) return;
  const { result, termination } = req.body || {};
  if (!VALID_RESULTS.has(result)) {
    return res.status(400).json({ error: "Invalid result." });
  }
  queries.finishGame.run(result, termination || null, game.id);
  res.json({ ok: true });
});

// POST /api/games/:id/truncate — undo support: drop moves after `toPly` and
// reset the stored position to the (client-reported) current one.
router.post("/:id/truncate", (req, res) => {
  const game = loadOwnedGame(req, res);
  if (!game) return;
  const { toPly, fen } = req.body || {};
  if (!Number.isInteger(toPly) || toPly < 0 || typeof fen !== "string") {
    return res.status(400).json({ error: "Invalid truncate payload." });
  }
  queries.deleteMovesAfter.run(game.id, toPly);
  queries.updateGamePosition.run(fen, turnOf(fen), game.id);
  res.json({ ok: true, toPly });
});

module.exports = router;
