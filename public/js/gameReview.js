"use strict";

// Game review: run LorFish over every position of a finished game and turn the
// scores into something a player can read — which moves cost material, what the
// engine would have played, and how accurately each side played overall.
//
// The search itself happens in the engine Web Worker (see engineWorker.js);
// this file owns the scoring, the classification and the summary.
//
//   GameReview.run({ startFen, uciMoves, depth, onProgress, onDone, onError })
//     -> { cancel() }
//
// A note on sign conventions, because they are easy to get wrong: the worker
// reports each score from the SIDE TO MOVE's point of view. So for move i,
// `before` is already the mover's perspective, and the score after their move
// is reported from the opponent's — negate it to compare like with like.

window.GameReview = (function () {
  // Centipawn loss thresholds. Deliberately a little more forgiving than a
  // strong-engine review would be: LorFish is roughly a 1400-1800 player, and
  // calling every quiet inaccuracy a mistake on that basis would be dishonest.
  const INACCURACY = 50;
  const MISTAKE = 120;
  const BLUNDER = 250;

  // Mate scores are ±99000-ish. Comparing those directly makes one missed mate
  // swamp a whole game's average, so clamp before measuring loss.
  const CAP = 1000;
  const clamp = (cp) => Math.max(-CAP, Math.min(CAP, cp));

  // Expected score (0-100) for a centipawn evaluation — the standard logistic
  // used for accuracy percentages. Losing 100cp matters far more when the game
  // is level than when you are already a rook up, and this captures that.
  const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp))) - 1);

  // Lichess's accuracy curve over the drop in expected score.
  function moveAccuracy(before, after) {
    const drop = Math.max(0, winPct(before) - winPct(after));
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
  }

  function classify(loss, playedBest) {
    if (playedBest) return "best";
    if (loss >= BLUNDER) return "blunder";
    if (loss >= MISTAKE) return "mistake";
    if (loss >= INACCURACY) return "inaccuracy";
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
      if (!before || before.score == null) continue;

      const mover = before.turn; // 'w' | 'b'
      const scoreBefore = clamp(before.score);
      // No eval after means the move ended the game; the mover cannot have lost
      // anything by delivering mate or stalemate, so treat it as holding.
      const scoreAfter = after && after.score != null ? -clamp(after.score) : scoreBefore;
      const loss = Math.max(0, scoreBefore - scoreAfter);
      const playedBest = !!(before.best && before.best.uci === uciMoves[i]);
      const kind = classify(loss, playedBest);

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
        // The effective depth this position was searched at. LorFish raises it
        // as pieces come off, so this climbs through the game.
        depth: before.depth || null,
        accuracy: moveAccuracy(scoreBefore, scoreAfter),
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

    // The span of effective depths used, so the report can say plainly that the
    // endgame was searched harder than the opening.
    const depths = evals.map((e) => e && e.depth).filter((d) => d);
    const range = depths.length
      ? { min: Math.min(...depths), max: Math.max(...depths) }
      : null;

    return { moves, white: side("w"), black: side("b"), depths: range };
  }

  function run(opts) {
    const { startFen, uciMoves, depth, onProgress, onDone, onError } = opts;
    const worker = new Worker("/js/engineWorker.js");
    const evals = [];
    let cancelled = false;

    worker.onmessage = (e) => {
      if (cancelled) return;
      const d = e.data || {};
      if (d.type === "review:eval") {
        evals[d.ply] = { score: d.score, best: d.best, turn: d.turn, depth: d.depth };
        if (onProgress) onProgress({ done: d.ply + 1, total: d.total + 1 });
        return;
      }
      if (d.type === "review:done") {
        worker.terminate();
        if (onDone) onDone(summarise(evals, uciMoves));
        return;
      }
      if (d.type === "review:error") {
        worker.terminate();
        if (onError) onError(new Error(d.error || "Review failed."));
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      if (!cancelled && onError) onError(new Error((err && err.message) || "Engine crashed."));
    };

    worker.postMessage({ id: 1, type: "review", startFen: startFen || null, uciMoves, depth });

    return {
      cancel() {
        cancelled = true;
        worker.terminate();
      },
    };
  }

  // Pretty-print a centipawn score the way a chess player expects: "+1.24",
  // "-0.30", or "M4" / "-M2" for mate, always from White's side. `perspective`
  // is the side `cp` is expressed for. LorFish scores a mate as 100000 minus
  // the plies to it, so the distance reads straight back; mates are counted in
  // moves, as players count them.
  function formatScore(cp, perspective) {
    if (cp == null) return "—";
    const v = perspective === "b" ? -cp : cp;
    if (Math.abs(v) >= 99000) {
      const plies = Math.max(1, 100000 - Math.abs(v));
      return (v > 0 ? "M" : "-M") + Math.ceil(plies / 2);
    }
    return (v > 0 ? "+" : v < 0 ? "-" : "") + (Math.abs(v) / 100).toFixed(2);
  }

  return { run, summarise, formatScore, classify, SYMBOL, LABEL };
})();
