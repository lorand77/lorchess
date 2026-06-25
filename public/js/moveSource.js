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
//   applyMove(move, record)      setThinking(bool)      onReject(msg?)

// ---- AI: LorFish in a Web Worker ----
function createAiMoveSource(env) {
  const worker = new Worker("/js/engineWorker.js");
  let busy = false;
  let reqId = 0;
  let activeReq = 0;

  worker.onmessage = (e) => {
    const data = e.data || {};
    if (data.id !== activeReq) return; // stale reply from an abandoned game
    busy = false;
    env.setThinking(false);
    if (data.error) {
      console.error("Engine worker:", data.error);
      return;
    }
    if (data.move) env.applyMove(data.move, true);
  };
  worker.onerror = (err) => {
    busy = false;
    env.setThinking(false);
    console.error("Engine worker crashed:", (err && err.message) || err);
  };

  function requestEngineMove() {
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
    submitMove(move) {
      env.applyMove(move, true); // apply the human move locally + persist
      if (env.isGameOver()) return;
      if (env.getTurn() === env.getHumanColor()) return;
      requestEngineMove();
    },
    kickIfEngineTurn() {
      if (!env.isGameOver() && env.getTurn() !== env.getHumanColor()) requestEngineMove();
    },
    cancel() {
      activeReq = ++reqId;
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
    submitMove(move) {
      if (busy) return;
      busy = true;
      socket.emit(
        "move:make",
        { gameId, from: move.from, to: move.to, promo: move.promo || null },
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
