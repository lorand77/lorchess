"use strict";

// Game review: run Stockfish over every position of a finished game and turn
// the scores into something a player can read — which moves threw away winning
// chances, what the engine would have played, and how accurately each side
// played overall.
//
// Stockfish 19 (the "lite single-threaded" WebAssembly build, vendored under
// /js/vendor/stockfish/) runs in its own Web Worker and speaks UCI text over
// postMessage. It is loaded only when a review starts, so nobody downloads it
// who doesn't use it, and it runs in the browser so reviews cost the server
// nothing. LorFish still plays; it is too weak to judge a game fairly.
//
// This file drives the engine one position at a time and owns the scoring, the
// classification and the summary. The page's own Chess board replays the game
// alongside it: it knows whose turn it is, when the game is already over
// (Stockfish is never asked about a finished position), and how to spell the
// engine's choice in SAN.
//
//   GameReview.run({ startFen, uciMoves, movetime, onProgress, onDone, onError })
//     -> { cancel() }
//
// A note on sign conventions, because they are easy to get wrong: UCI reports
// each score from the SIDE TO MOVE's point of view. So for move i, `before` is
// already the mover's perspective, and the score after their move is reported
// from the opponent's — negate it to compare like with like.

window.GameReview = (function () {
  const ENGINE_URL = "/js/vendor/stockfish/stockfish-19-lite-single.js";

  // Mate is encoded as LorFish does it — 100000 minus the plies to mate — so a
  // mate from either engine reads back the same way in formatScore.
  const MATE = 100000;

  // Generous, because a phone can take a while over the first ~1.8 MB download
  // and a search can overrun movetime on a busy device. They only exist so a
  // wedged engine turns into an error instead of a progress bar that never ends.
  const LOAD_TIMEOUT = 60000;
  const SEARCH_GRACE = 10000;

  // Judged by how much of the mover's expected score a move gave away, in
  // percentage points (Lichess's thresholds). Losing 1.5 pawns when level is a
  // blunder; losing it when already a rook up barely matters.
  const INACCURACY = 5;
  const MISTAKE = 10;
  const BLUNDER = 15;

  // Mate scores are ±99000-ish. Comparing those directly makes one missed mate
  // swamp a whole game's average, so clamp before measuring loss.
  const CAP = 1000;
  const clamp = (cp) => Math.max(-CAP, Math.min(CAP, cp));

  // Expected score (0-100) for a centipawn evaluation — the standard logistic
  // used for accuracy percentages.
  const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp))) - 1);

  // Lichess's accuracy curve over the drop in expected score.
  const moveAccuracy = (drop) =>
    Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

  const isMate = (score) => Math.abs(score) >= 99000;

  // Forced mates are judged on their own, as Lichess does: clamped to ±1000,
  // walking into a mate from an already lost position barely moves the
  // expected score, yet it is the move that ends the game. `before` and
  // `after` are both from the mover's side.
  function mateKind(before, after) {
    const severity = (cp) => (cp > 999 ? "inaccuracy" : cp > 700 ? "mistake" : "blunder");
    // Allowed a forced mate: the worse the position already was, the less it cost.
    if (!isMate(before) && isMate(after) && after < 0) return severity(-before);
    // Let a forced mate of their own slip away.
    if (isMate(before) && before > 0 && !(isMate(after) && after > 0)) {
      return isMate(after) ? "blunder" : severity(after);
    }
    return null;
  }

  function classify(drop, playedBest, mate) {
    if (playedBest) return "best";
    if (mate) return mate;
    if (drop >= BLUNDER) return "blunder";
    if (drop >= MISTAKE) return "mistake";
    if (drop >= INACCURACY) return "inaccuracy";
    return "good";
  }

  const SYMBOL = { blunder: "??", mistake: "?", inaccuracy: "?!", best: "", good: "" };
  const LABEL = {
    blunder: "Blunder", mistake: "Mistake", inaccuracy: "Inaccuracy",
    best: "Best move", good: "Good",
  };

  // Turn the per-position scores into per-move verdicts. `evals[i]` is the
  // assessment of the position before move i; there is one more eval than there
  // are moves (the final position).
  function summarise(evals, uciMoves) {
    const moves = [];
    for (let i = 0; i < uciMoves.length; i++) {
      const before = evals[i];
      const after = evals[i + 1];
      if (!before || before.score == null || !after || after.score == null) continue;

      const mover = before.turn; // 'w' | 'b'
      const scoreBefore = clamp(before.score);
      // Terminal outcomes have explicit scores too: stalemating from a won
      // position loses the advantage, while delivering mate preserves it.
      const scoreAfter = -clamp(after.score);
      const loss = Math.max(0, scoreBefore - scoreAfter);
      const drop = Math.max(0, winPct(scoreBefore) - winPct(scoreAfter));
      const playedBest = !!(before.best && before.best.uci === uciMoves[i]);
      const kind = classify(drop, playedBest, mateKind(before.score, -after.score));

      moves.push({
        ply: i + 1,
        mover,
        uci: uciMoves[i],
        loss,
        kind,
        symbol: SYMBOL[kind],
        label: LABEL[kind],
        evalBefore: before.score,
        evalAfter: after && after.score != null ? -after.score : null,
        best: before.best || null,
        // The depth this position was searched to in the time it was given.
        depth: before.depth || null,
        accuracy: moveAccuracy(drop),
      });
    }

    const side = (colour) => {
      const mine = moves.filter((m) => m.mover === colour);
      if (!mine.length) {
        return { moves: 0, accuracy: null, acpl: null, best: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
      }
      const count = (k) => mine.filter((m) => m.kind === k).length;
      return {
        moves: mine.length,
        accuracy: mine.reduce((s, m) => s + m.accuracy, 0) / mine.length,
        acpl: mine.reduce((s, m) => s + m.loss, 0) / mine.length,
        best: count("best"),
        inaccuracy: count("inaccuracy"),
        mistake: count("mistake"),
        blunder: count("blunder"),
      };
    };

    // The span of depths reached, so the report can say how hard it looked.
    const depths = evals.map((e) => e && e.depth).filter((d) => d);
    const range = depths.length
      ? { min: Math.min(...depths), max: Math.max(...depths) }
      : null;

    return { moves, white: side("w"), black: side("b"), depths: range };
  }

  // UCI "score mate N" -> the MATE encoding. N counts moves, positive when the
  // side to move is the one mating; 0 means it has already been mated.
  function mateScore(n) {
    if (n > 0) return MATE - (2 * n - 1);
    return -(MATE + 2 * n);
  }

  // One "info ..." line -> { depth, score }, or null when it carries no usable
  // score. Bound lines are skipped: a search that runs out of time mid-iteration
  // often ends on "lowerbound"/"upperbound", which is only a provisional value.
  function parseInfo(line) {
    const t = line.split(" ");
    if (t[0] !== "info" || t[1] === "string") return null;
    if (t.includes("lowerbound") || t.includes("upperbound")) return null;
    const mpv = t.indexOf("multipv");
    if (mpv !== -1 && t[mpv + 1] !== "1") return null;
    const s = t.indexOf("score");
    const d = t.indexOf("depth");
    if (s === -1 || d === -1) return null;
    const value = parseInt(t[s + 2], 10);
    if (!Number.isFinite(value)) return null;
    if (t[s + 1] === "cp") return { depth: parseInt(t[d + 1], 10), score: value };
    if (t[s + 1] === "mate") return { depth: parseInt(t[d + 1], 10), score: mateScore(value) };
    return null;
  }

  function findUci(chess, uci) {
    if (typeof uci !== "string" || uci.length < 4) return null;
    const from = (uci.charCodeAt(0) - 97) + (Number(uci[1]) - 1) * 8;
    const to = (uci.charCodeAt(2) - 97) + (Number(uci[3]) - 1) * 8;
    return chess.findMove(from, to, uci[4] || null);
  }

  // `createEngine` exists for the tests, which drive the same code with a
  // scripted engine or a Stockfish child process instead of a Web Worker.
  function run(opts) {
    const { startFen, uciMoves, movetime, onProgress, onDone, onError } = opts;
    const createEngine = opts.createEngine || (() => new Worker(ENGINE_URL));
    const total = uciMoves.length;
    const evals = [];
    const board = new Chess();
    if (startFen) board.loadFen(startFen);
    else board.reset();
    // Always the start position plus the moves, never the current FEN: that is
    // how Stockfish learns the repetition history, and how Chess960 castling
    // rights stay unambiguous.
    const base = startFen ? "position fen " + startFen : "position startpos";

    let engine;
    let ply = 0;
    let last = null;   // the latest usable info line of the current search
    let ready = false;
    let finished = false;
    let timer = null;

    const send = (cmd) => engine.postMessage(cmd);
    const arm = (ms, msg) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(msg), ms);
    };
    function stop() {
      finished = true;
      clearTimeout(timer);
      engine.terminate();
    }
    function fail(msg) {
      if (finished) return;
      stop();
      if (onError) onError(new Error(msg));
    }

    function report(ev) {
      evals[ply] = Object.assign({ turn: board.turn }, ev);
      if (onProgress) onProgress({ done: ply + 1, total: total + 1 });
    }

    // Step the board past move `ply`. False once the record stops making sense.
    function advance() {
      if (ply < total) {
        const mv = findUci(board, uciMoves[ply]);
        if (!mv) {
          fail("Illegal move in the game record: " + uciMoves[ply]);
          return false;
        }
        board.makeMove(mv);
      }
      ply++;
      return true;
    }

    // Walk forward to the next position that needs a search, scoring finished
    // positions on the way: draws score zero and checkmate a loss for the side
    // to move, including rule draws where legal moves still exist.
    function next() {
      while (ply <= total) {
        if (!board.isGameOver()) {
          last = null;
          send(base + (ply ? " moves " + uciMoves.slice(0, ply).join(" ") : ""));
          send("go movetime " + movetime);
          arm(movetime + SEARCH_GRACE, "The engine stopped responding.");
          return;
        }
        report({ score: board.isCheckmate() ? -MATE : 0, best: null, depth: null });
        if (!advance()) return;
      }
      stop();
      if (onDone) onDone(summarise(evals, uciMoves));
    }

    // A missing score is left missing — summarise leaves that move ungraded
    // rather than inventing a verdict.
    function searched(bestUci) {
      clearTimeout(timer);
      const mv = bestUci && bestUci !== "(none)" ? findUci(board, bestUci) : null;
      report({
        score: last ? last.score : null,
        // Once it sees a forced mate Stockfish runs straight to its maximum
        // depth (245); that says nothing about how hard it looked.
        depth: last && !isMate(last.score) ? last.depth : null,
        best: mv ? { uci: bestUci, san: board.moveToSan(mv) } : null,
      });
      if (advance()) next();
    }

    try {
      engine = createEngine();
    } catch (err) {
      finished = true;
      if (onError) onError(new Error("This browser can't run the review engine."));
      return { cancel() {} };
    }

    engine.onmessage = (e) => {
      if (finished || typeof e.data !== "string") return;
      const line = e.data.trim();
      if (line.startsWith("info")) {
        const info = parseInfo(line);
        if (info) last = info;
      } else if (line.startsWith("bestmove")) {
        searched(line.split(/\s+/)[1]);
      } else if (line === "uciok") {
        // Castling arrives spelled by the rook square ("e1h1"), in standard
        // games too; UCI_Chess960 is the mode in which Stockfish reads — and
        // writes — it that way.
        send("setoption name UCI_Chess960 value true");
        send("setoption name Hash value 16");
        send("ucinewgame");
        send("isready");
      } else if (line === "readyok" && !ready) {
        ready = true;
        next();
      }
    };
    engine.onerror = (err) => {
      if (err && err.preventDefault) err.preventDefault();
      fail((err && err.message) || "The review engine failed to load.");
    };

    arm(LOAD_TIMEOUT, "The review engine took too long to load.");
    send("uci");

    return {
      cancel() {
        if (!finished) stop();
      },
    };
  }

  // Pretty-print a centipawn score the way a chess player expects: "+1.24",
  // "-0.30", or "M4" / "-M2" for mate, always from White's side. `perspective`
  // is the side `cp` is expressed for. Mate is 100000 minus the plies to it, so
  // the distance reads straight back; mates are counted in moves, as players
  // count them.
  function formatScore(cp, perspective) {
    if (cp == null) return "—";
    const v = perspective === "b" ? -cp : cp;
    if (Math.abs(v) >= 99000) {
      const plies = Math.max(1, MATE - Math.abs(v));
      return (v > 0 ? "M" : "-M") + Math.ceil(plies / 2);
    }
    return (v > 0 ? "+" : v < 0 ? "-" : "") + (Math.abs(v) / 100).toFixed(2);
  }

  return { run, summarise, formatScore, classify, parseInfo, mateScore, SYMBOL, LABEL };
})();
