"use strict";

// A "move source" decouples the board from its opponent. The board applies the
// human's move locally, then calls onLocalMove(); the source decides when and
// what the opponent replies, handing the reply back via env.applyRemoteMove().
//
// M1 ships only the AI source (LorFish in a Web Worker). RemoteMoveSource (PvP)
// and LocalMoveSource (hot-seat) arrive in later milestones behind this same
// interface — { canHumanMoveNow, onLocalMove, kickIfEngineTurn, cancel }.
//
// `env` is supplied by ui.js:
//   getHumanColor() -> 'w'|'b'      getTurn() -> 'w'|'b'
//   isGameOver() -> bool            getDepth() -> int
//   getPosition() -> { startFen, moves:[{from,to,promo}] }
//   applyRemoteMove(move)           setThinking(bool)

function createAiMoveSource(env) {
  const worker = new Worker("/js/engineWorker.js");
  let busy = false;
  let reqId = 0;
  let activeReq = 0;

  worker.onmessage = (e) => {
    const data = e.data || {};
    // Ignore replies from a search we abandoned (new game / color switch).
    if (data.id !== activeReq) return;
    busy = false;
    env.setThinking(false);
    if (data.error) {
      console.error("Engine worker:", data.error);
      return;
    }
    if (data.move) env.applyRemoteMove(data.move);
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

    // The human may move when it's their color and the engine isn't searching.
    canHumanMoveNow(turn) {
      return !busy && turn === env.getHumanColor();
    },

    // Called right after a human move is applied to the local board.
    onLocalMove() {
      if (env.isGameOver()) return;
      if (env.getTurn() === env.getHumanColor()) return;
      requestEngineMove();
    },

    // At game start the engine may have the first move (human plays Black).
    kickIfEngineTurn() {
      if (!env.isGameOver() && env.getTurn() !== env.getHumanColor()) {
        requestEngineMove();
      }
    },

    // Abandon any in-flight search; its eventual reply will be ignored.
    cancel() {
      activeReq = ++reqId;
      busy = false;
      env.setThinking(false);
    },
  };
}
