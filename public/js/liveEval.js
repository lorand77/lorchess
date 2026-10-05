"use strict";

// Live evaluation for the analysis board: Stockfish searches whatever position
// is on the board and keeps reporting as it deepens, and when the position
// changes the old search is stopped and the new one started.
//
// Game review (gameReview.js) walks a finished game one search after another
// and only ever waits for each to end. Here the position changes under a
// running search, and UCI makes that the tricky part: after "stop" the engine
// still sends the old search's last info lines and exactly one "bestmove".
// Until that bestmove arrives, every line belongs to the old position, so
// nothing is reported and the next search waits for it. Positions requested
// meanwhile replace one another; only the latest is searched.
//
//   LiveEval.create({ onUpdate, onError, depth, movetime }) -> {
//     analyse({ startFen, uciMoves, turn }),  // search this position
//     stop(),                                 // stop searching, report nothing more
//     destroy(),
//   }
//
// onUpdate({ score, depth, pv, done }): score from White's side in the MATE
// encoding of gameReview.js, pv the principal variation in UCI, done once the
// search has reached its limit. Same engine, same settings and same parsing as
// the review, which this file borrows from GameReview.

window.LiveEval = (function () {
  const ENGINE_URL = "/js/vendor/stockfish/stockfish-19-lite-single.js";
  const LOAD_TIMEOUT = 60000;
  const SEARCH_GRACE = 10000;
  // A search ends at whichever comes first. Without a limit the engine would
  // keep one core busy for as long as the page sat open on a position.
  const DEPTH = 22;
  const MOVETIME = 15000;

  // The moves of the principal variation, from an info line already accepted
  // by GameReview.parseInfo.
  function parsePv(line) {
    const t = line.split(" ");
    const i = t.indexOf("pv");
    return i === -1 ? [] : t.slice(i + 1).filter(Boolean);
  }

  function create(opts) {
    const { onUpdate, onError } = opts;
    const createEngine = opts.createEngine || (() => new Worker(ENGINE_URL));
    const depth = opts.depth || DEPTH;
    const movetime = opts.movetime || MOVETIME;

    let engine = null;
    // loading -> idle <-> searching -> stopping -> idle; failed for good.
    let state = "new";
    let want = null;     // the position to search next, if any
    let current = null;  // the position being searched
    let timer = null;

    const send = (cmd) => engine.postMessage(cmd);
    const arm = (ms, msg) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(msg), ms);
    };

    function fail(msg) {
      if (state === "failed") return;
      state = "failed";
      clearTimeout(timer);
      if (engine) engine.terminate();
      if (onError) onError(new Error(msg));
    }

    function boot() {
      try {
        engine = createEngine();
      } catch (err) {
        state = "failed";
        if (onError) onError(new Error("This browser can't run the analysis engine."));
        return;
      }
      state = "loading";
      engine.onmessage = (e) => {
        if (state !== "failed" && typeof e.data === "string") receive(e.data.trim());
      };
      engine.onerror = (err) => {
        if (err && err.preventDefault) err.preventDefault();
        fail((err && err.message) || "The analysis engine failed to load.");
      };
      arm(LOAD_TIMEOUT, "The analysis engine took too long to load.");
      send("uci");
    }

    function start() {
      current = want;
      want = null;
      state = "searching";
      // The start position plus the moves, as in the review: Stockfish then
      // knows the repetition history, and Chess960 castling stays unambiguous.
      const base = current.startFen ? "position fen " + current.startFen : "position startpos";
      send(base + (current.uciMoves.length ? " moves " + current.uciMoves.join(" ") : ""));
      send("go depth " + depth + " movetime " + movetime);
      arm(movetime + SEARCH_GRACE, "The analysis engine stopped responding.");
    }

    function receive(line) {
      if (line === "uciok") {
        // Castling is spelled by the rook square ("e1h1"); see gameReview.js.
        send("setoption name UCI_Chess960 value true");
        send("setoption name Hash value 16");
        send("ucinewgame");
        send("isready");
      } else if (line === "readyok" && state === "loading") {
        clearTimeout(timer);
        state = "idle";
        if (want) start();
      } else if (line.startsWith("info") && state === "searching") {
        const info = GameReview.parseInfo(line);
        if (!info) return;
        const white = current.turn === "b" ? -info.score : info.score;
        onUpdate({ score: white, depth: info.depth, pv: parsePv(line), done: false });
      } else if (line.startsWith("bestmove")) {
        clearTimeout(timer);
        if (state === "searching") onUpdate({ done: true });
        if (state === "searching" || state === "stopping") {
          state = "idle";
          if (want) start();
        }
      }
    }

    return {
      analyse(position) {
        want = position;
        if (state === "new") boot();
        else if (state === "idle") start();
        else if (state === "searching") {
          state = "stopping";
          send("stop");
          arm(SEARCH_GRACE, "The analysis engine stopped responding.");
        }
        // loading / stopping: picked up when the engine is ready again.
      },
      stop() {
        want = null;
        if (state === "searching") {
          state = "stopping";
          send("stop");
          arm(SEARCH_GRACE, "The analysis engine stopped responding.");
        }
      },
      destroy() {
        if (state === "failed" || state === "new") { state = "failed"; return; }
        state = "failed";
        clearTimeout(timer);
        engine.terminate();
      },
    };
  }

  return { create, parsePv };
})();
