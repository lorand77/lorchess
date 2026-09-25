"use strict";

// REST persistence for AI games. The browser is authoritative for its own solo
// game (it runs the rules and the engine), so the server simply records what
// the client reports — there's no move validation here. That trust is why the
// write routes accept AI games only: a PvP game is validated and recorded by
// the socket handlers, and its record must not be editable from here.

const express = require("express");
const queries = require("../db/queries");
const { requireAuth } = require("../auth/middleware");
const { Chess, STANDARD_START } = require("../shared/chess");
const config = require("../config");
const achievements = require("../achievements/service");

const router = express.Router();

// The reserved AI account id (seeded in db/index.js). Games store it as the
// white_id/black_id of the AI side; individual AI moves record by_user = NULL.
const AI_ID = queries.getUserByUsername.get(config.AI_USERNAME).id;

const VALID_RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);
// The ways the client's rules engine can end a game (terminationReason in
// ui.js). Anything else is refused: the value is stored and later shown in the
// game history, so it must never be free text.
const VALID_TERMINATIONS = new Set(["checkmate", "stalemate", "insufficient", "threefold", "fifty-move"]);

const turnOf = (fen) => (String(fen).split(/\s+/)[1] === "b" ? "b" : "w");

router.use(requireAuth);

// Load a game for one of the write routes below: the session user must be a
// participant, and the game an AI game. PvP games belong to the socket layer.
function loadOwnAiGame(req, res) {
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
  if (game.mode !== "ai") {
    res.status(403).json({ error: "PvP games are played over the socket." });
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
  // The client's own board has already loaded this FEN, but the record must
  // not hold a position the rules engine refuses: everything that later
  // replays the game (review, achievements, history) runs it through loadFen.
  if (fen !== STANDARD_START) {
    try {
      new Chess().loadFen(fen);
    } catch (err) {
      return res.status(400).json({ error: `Invalid start position: ${err.message}` });
    }
  }
  const aiDepth = parseInt(depth, 10) || 2;

  const info = queries.createGame.run(
    whiteId, blackId, "ai", aiColor, aiDepth, fen, fen, turnOf(fen),
    null, null, 0, "standard"   // untimed, unrated
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

// GET /api/games/user/:id — someone else's games, for the Games tab of their
// profile. LorFish is not a player, so it has no profile and no list.
router.get("/user/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad user id." });
  if (id === AI_ID || !queries.getUserById.get(id)) {
    return res.status(404).json({ error: "No such player." });
  }
  res.json(queries.listGamesForUser.all(id, id));
});

// GET /api/games/:id — a single game with both player names and its full
// move list (san + uci + fen_after per ply) for the replay viewer. Anyone may
// replay a game that is over; one still in progress is its players' alone —
// everyone else watches it live, through the spectator room.
router.get("/:id", (req, res) => {
  const game = queries.getGameById.get(Number(req.params.id));
  if (!game) return res.status(404).json({ error: "No such game." });
  const uid = req.session.userId;
  if (game.status === "active" && game.white_id !== uid && game.black_id !== uid) {
    return res.status(403).json({ error: "That game is still being played." });
  }
  const white = queries.getUserById.get(game.white_id);
  const black = queries.getUserById.get(game.black_id);
  res.json({
    ...game,
    white_username: white ? white.username : "?",
    black_username: black ? black.username : "?",
    moves: queries.getMovesForGame.all(game.id),
  });
});

// POST /api/games/:id/moves — append one move and advance the position.
router.post("/:id/moves", (req, res) => {
  const game = loadOwnAiGame(req, res);
  if (!game) return;
  if (game.status !== "active") {
    return res.status(409).json({ error: "Game is not active." });
  }
  const { ply, san, uci, fenAfter, byColor, premove } = req.body || {};
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
    queries.insertMove.run(game.id, ply, san, uci, fenAfter, byUser, premove === true ? 1 : 0);
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
  const game = loadOwnAiGame(req, res);
  if (!game) return;
  if (game.status !== "active") {
    return res.status(409).json({ error: "Game is not active." });
  }
  const { result } = req.body || {};
  const termination = (req.body && req.body.termination) || null;
  if (!VALID_RESULTS.has(result)) {
    return res.status(400).json({ error: "Invalid result." });
  }
  if (termination !== null && !VALID_TERMINATIONS.has(termination)) {
    return res.status(400).json({ error: "Invalid termination." });
  }
  queries.finishGame.run(result, termination, game.id);
  const earned = achievements.onGameFinished(game.id);
  res.json({ ok: true, achievements: earned[req.session.userId] || [] });
});

// POST /api/games/:id/truncate — undo support: drop moves after `toPly` and
// reset the stored position to the (client-reported) current one.
router.post("/:id/truncate", (req, res) => {
  const game = loadOwnAiGame(req, res);
  if (!game) return;
  if (game.status !== "active") {
    return res.status(409).json({ error: "Game is not active." });
  }
  const { toPly, fen } = req.body || {};
  if (!Number.isInteger(toPly) || toPly < 0 || typeof fen !== "string") {
    return res.status(400).json({ error: "Invalid truncate payload." });
  }
  queries.deleteMovesAfter.run(game.id, toPly);
  queries.updateGamePosition.run(fen, turnOf(fen), game.id);
  res.json({ ok: true, toPly });
});

// POST /api/games/:id/abandon — the player walked away from an unfinished AI
// game (New Game, a colour change, Load FEN). A game with no moves is deleted:
// it was never played. One with moves is aborted, so the history shows it as
// given up rather than as "in progress" for ever.
router.post("/:id/abandon", (req, res) => {
  const game = loadOwnAiGame(req, res);
  if (!game) return;
  if (game.status !== "active") {
    return res.status(409).json({ error: "Game is not active." });
  }
  if (queries.getMovesForGame.all(game.id).length === 0) {
    queries.deleteGame.run(game.id);
    return res.json({ ok: true, deleted: true });
  }
  queries.abortGame.run("abandoned", game.id);
  res.json({ ok: true, deleted: false });
});

module.exports = router;
