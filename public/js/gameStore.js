"use strict";

// Records the local AI game to the server. The browser stays authoritative for
// gameplay; this just mirrors each move into the DB for history.
//
// Persistence is best-effort: network failures are logged, never block play.
// Writes are serialized through a promise `chain` so moves land in order (so
// games.current_fen ends up reflecting the latest move), and every write waits
// on its game's `ready` so move POSTs can't outrun the create-game POST.
//
// Each write captures the game it belongs to when it is QUEUED, not when it
// runs. Starting a new game right after the old one ended is the normal thing
// to do, and the old game's final writes may still be in flight then; they must
// land on the old game, never on the new one.

function createGameStore() {
  // The game new writes go to: { id, ready }. Replaced wholesale by newGame()
  // and resume(), so a queued write's reference keeps pointing at its own game.
  let game = { id: null, ready: Promise.resolve() };
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

  // Run an action for the current game once it exists, on the serialized write
  // chain. `fn` receives the game id. Resolves with the action's result (the
  // server's JSON reply), or undefined when the game isn't persisted or the
  // write failed.
  function enqueue(fn) {
    const target = game;
    chain = chain.then(async () => {
      await target.ready;
      if (!target.id) return undefined;
      try {
        return await fn(target.id);
      } catch (err) {
        console.warn("gameStore:", err.message);
        return undefined;
      }
    });
    return chain;
  }

  return {
    // Create a new server-side game; resolves when the id is known.
    newGame({ humanColor, depth, startFen }) {
      const next = { id: null, ready: null };
      next.ready = post("/api/games", {
        humanColor,
        depth,
        startFen: startFen || null,
      })
        .then((data) => {
          next.id = data.gameId;
        })
        .catch((err) => {
          console.warn("gameStore: game not persisted —", err.message);
          next.id = null;
        });
      game = next;
      // Writes for this game queue behind its creation. Whatever the previous
      // game still had queued carries on, against that game's own id.
      chain = next.ready;
      return next.ready;
    },

    // Attach to a game that already exists on the server, for resuming an
    // in-progress AI game. Unlike newGame() this creates nothing — it just
    // points subsequent writes at `id`.
    resume(id) {
      game = { id, ready: Promise.resolve() };
      chain = game.ready;
      return game.ready;
    },

    recordMove(move) {
      return enqueue((id) => post(`/api/games/${id}/moves`, move));
    },

    endGame(result, termination) {
      return enqueue((id) => post(`/api/games/${id}/end`, { result, termination }));
    },

    truncate(toPly, fen) {
      return enqueue((id) => post(`/api/games/${id}/truncate`, { toPly, fen }));
    },

    // Walk away from the game on the board without finishing it (New Game, a
    // colour change, Load FEN). Queued against the game that is current NOW,
    // so it is safe to call right before newGame().
    abandon() {
      return enqueue((id) => post(`/api/games/${id}/abandon`, {}));
    },

    currentId() {
      return game.id;
    },
  };
}
