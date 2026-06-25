"use strict";

// Records the local AI game to the server. The browser stays authoritative for
// gameplay (M1 design); this just mirrors each move into the DB for history.
//
// Persistence is best-effort: network failures are logged, never block play.
// Writes are serialized through a promise `chain` so moves land in order (so
// games.current_fen ends up reflecting the latest move), and every write waits
// on `ready` so move POSTs can't outrun the create-game POST.

function createGameStore() {
  let gameId = null;
  let ready = Promise.resolve();
  let chain = Promise.resolve();

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // Run an action after the game exists, on the serialized write chain.
  function enqueue(fn) {
    chain = chain.then(async () => {
      await ready;
      if (!gameId) return;
      try {
        await fn();
      } catch (err) {
        console.warn("gameStore:", err.message);
      }
    });
    return chain;
  }

  return {
    // Create a new server-side game; resolves when the id is known.
    newGame({ humanColor, depth, startFen }) {
      gameId = null;
      ready = post("/api/games", {
        humanColor,
        depth,
        startFen: startFen || null,
      })
        .then((data) => {
          gameId = data.gameId;
        })
        .catch((err) => {
          console.warn("gameStore: game not persisted —", err.message);
          gameId = null;
        });
      // Reset the write chain to wait on this new game.
      chain = ready;
      return ready;
    },

    recordMove(move) {
      return enqueue(() => post(`/api/games/${gameId}/moves`, move));
    },

    endGame(result, termination) {
      return enqueue(() => post(`/api/games/${gameId}/end`, { result, termination }));
    },

    truncate(toPly, fen) {
      return enqueue(() => post(`/api/games/${gameId}/truncate`, { toPly, fen }));
    },

    currentId() {
      return gameId;
    },
  };
}
