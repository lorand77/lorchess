"use strict";

// A "move source" decouples the board from its opponent. When the human picks a
// legal move the board calls moveSource.submitMove(move); the source decides
// what happens. Moves that should appear on the board are applied through
// env.applyMove(move, record) — the single apply path for engine moves, the
// player's own confirmed moves, and the opponent's moves alike.
//
// Common interface: { kind, canHumanMoveNow(turn), submitMove(move),
//                      kickIfEngineTurn(), cancel() }
//
// `env` (supplied by ui.js):
//   getHumanColor() -> 'w'|'b'   getTurn() -> 'w'|'b'   isGameOver() -> bool
//   getDepth() -> int            getPosition() -> { startFen, moves }
//   applyMove(move, record, opts) setThinking(bool)     onReject(msg?)
//   onEngineError(msg)  the engine could not move; the page offers a retry
//   opts.premove marks a move the human queued before the opponent replied.

// ---- AI: LorFish in a Web Worker ----
function createAiMoveSource(env) {
  let worker = null;
  let busy = false;
  let reqId = 0;
  let activeReq = 0;

  // The worker is single-threaded and its search is synchronous, so the only
  // way to stop a search is to terminate the worker. One is kept warm between
  // moves; it is dropped when a search has to be abandoned midway or after it
  // has crashed, and the next request starts a fresh one.
  function spawn() {
    const w = new Worker("/js/engineWorker.js");
    w.onmessage = (e) => {
      const data = e.data || {};
      if (data.id !== activeReq) return; // stale reply from an abandoned game
      busy = false;
      env.setThinking(false);
      if (data.error) return fail(data.error);
      if (data.move) env.applyMove(data.move, true);
    };
    w.onerror = (err) => {
      const wasBusy = busy;
      busy = false;
      env.setThinking(false);
      // Whatever state it is in now, don't trust it with the next request.
      w.terminate();
      if (worker === w) worker = null;
      if (wasBusy) fail((err && err.message) || "the engine crashed");
      else console.error("Engine worker:", (err && err.message) || err);
    };
    return w;
  }

  // The engine could not produce a move. The turn is still its own, so the
  // player would be stuck waiting; tell the page, which offers to ask again.
  function fail(message) {
    console.error("Engine worker:", message);
    if (env.onEngineError) env.onEngineError(String(message));
  }

  function requestEngineMove() {
    if (!worker) worker = spawn();
    busy = true;
    env.setThinking(true);
    activeReq = ++reqId;
    const pos = env.getPosition();
    worker.postMessage({
      id: activeReq,
      startFen: pos.startFen,
      moves: pos.moves,
      depth: env.getDepth(),
    });
  }

  return {
    kind: "ai",
    canHumanMoveNow(turn) {
      return !busy && turn === env.getHumanColor();
    },
    submitMove(move, opts) {
      env.applyMove(move, true, opts); // apply the human move locally + persist
      if (env.isGameOver()) return;
      if (env.getTurn() === env.getHumanColor()) return;
      requestEngineMove();
    },
    // Also the retry after a failure: it asks again if it is the engine's move.
    kickIfEngineTurn() {
      if (!env.isGameOver() && env.getTurn() !== env.getHumanColor()) requestEngineMove();
    },
    cancel() {
      activeReq = ++reqId;
      // A search still running would hold the next game's first request behind
      // it, for as long as the abandoned position takes; drop the worker instead.
      if (busy && worker) {
        worker.terminate();
        worker = null;
      }
      busy = false;
      env.setThinking(false);
    },
  };
}

// ---- PvP: moves relayed through the authoritative server ----
// The socket's move:made/game-event listeners are registered ONCE in ui.js
// (initPvp) and dispatched to the current source via onServerMove — so a
// reconnect (which rebuilds the source) never stacks duplicate listeners.
function createRemoteMoveSource(env, { socket, gameId, yourColor }) {
  let busy = false; // a move is awaiting server confirmation

  return {
    kind: "remote",
    canHumanMoveNow(turn) {
      return !busy && turn === yourColor;
    },
    submitMove(move, opts) {
      if (busy) return;
      busy = true;
      socket.emit(
        "move:make",
        {
          gameId,
          from: move.from,
          // Castling points at the rook (see Chess.findMove): in Chess960 the
          // king's destination on its own can be ambiguous with a quiet move.
          to: move.castle && move.rookFrom != null ? move.rookFrom : move.to,
          promo: move.promo || null,
          premove: !!(opts && opts.premove),
        },
        (resp) => {
          if (!resp || !resp.ok) {
            busy = false; // rejected — let the player try again
            if (env.onReject) env.onReject(resp && resp.error);
          }
        }
      );
    },
    // The server broadcasts every accepted move to the whole room, including the
    // mover — so BOTH players apply moves only here. Single source of truth.
    onServerMove(m) {
      busy = false;
      env.applyMove({ from: m.from, to: m.to, promo: m.promo }, false);
    },
    kickIfEngineTurn() {}, // no engine in PvP
    cancel() {
      busy = false;
    },
  };
}

// ---- Spectator: a read-only board fed by the server's broadcasts ----
// Same onServerMove entry point as the remote source, but the human can never
// move; the server would reject a non-player anyway.
function createSpectatorMoveSource(env) {
  return {
    kind: "spectator",
    canHumanMoveNow() {
      return false;
    },
    submitMove() {},
    onServerMove(m) {
      env.applyMove({ from: m.from, to: m.to, promo: m.promo }, false);
    },
    kickIfEngineTurn() {},
    cancel() {},
  };
}
