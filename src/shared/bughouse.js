"use strict";

// Bughouse's seats and boards: who partners whom, what each board's result is
// for a team's, and how the two boards are played and replayed together. One
// board's rules are chess.js's (setVariant('bughouse')); what joins the two is
// here — a capture on one board is passed to the partner on the other. Shared
// by the server, which stores and runs matches (src/game/matches.js), and the
// pages that will show one.
//
// Team A plays White on board 0 and Black on board 1; team B the other two
// seats. So partners always play opposite colours, and a piece passed keeps
// its colour: a black knight taken on board 0 by A's White is a black knight
// for A's Black on board 1.
//
// Loaded as a browser <script> after chess.js, engines.js and uci.js (their
// globals are used there), and as a Node `require`.

const Bughouse = (function () {
  const node = typeof module !== 'undefined' && module.exports;
  const deps = () => (node
    ? { createEngine: require('./engines').createEngine, moveFromUci: require('./uci').moveFromUci }
    : { createEngine, moveFromUci });

  const other = (c) => (c === 'w' ? 'b' : 'w');

  // The team a seat belongs to.
  function teamOf(board, color) {
    return (board === 0) === (color === 'w') ? 'A' : 'B';
  }

  // The seat of a seat's partner: the other board, the other colour.
  function partnerOf(board, color) {
    return { board: 1 - board, color: other(color) };
  }

  // A team's two seats, board 0's first.
  function seatsOf(team) {
    return team === 'A'
      ? [{ board: 0, color: 'w' }, { board: 1, color: 'b' }]
      : [{ board: 0, color: 'b' }, { board: 1, color: 'w' }];
  }

  // Each board's result ('1-0' etc., board 0's first) for a match won by a
  // team, or drawn.
  function boardResults(result) {
    if (result === 'draw') return ['1/2-1/2', '1/2-1/2'];
    return result === 'A' ? ['1-0', '0-1'] : ['0-1', '1-0'];
  }

  // Two fresh boards at the start.
  function createBoards() {
    const { createEngine } = deps();
    return [createEngine('bughouse'), createEngine('bughouse')];
  }

  // Play `move`, a legal move of boards[board], and pass what it captured to
  // the other board. Returns what was passed ({ t, c }), or null.
  function play(boards, board, move) {
    const chess = boards[board];
    chess.makeMove(move);
    const passed = chess.history[chess.history.length - 1].passed || null;
    if (passed) boards[1 - board].receive(passed.c, passed.t);
    return passed;
  }

  // Both boards rebuilt from a match's moves, [{ board, uci }] in the order
  // they were made (the server keeps them in moves.id order). Order matters:
  // a drop can only follow the capture, on the other board, that supplied it.
  // Throws on a move that is not legal where it falls.
  function replay(moves) {
    const { moveFromUci } = deps();
    const boards = createBoards();
    moves.forEach((m, i) => {
      const move = boards[m.board] && moveFromUci(boards[m.board], m.uci);
      if (!move) throw new Error(`Bughouse replay: move ${i + 1} (${m.uci} on board ${m.board}) is not legal there`);
      play(boards, m.board, move);
    });
    return boards;
  }

  // What a player can call to their partner, by key. Fixed phrases rather
  // than free text: they say what Bughouse players say, need no storing or
  // moderating, and the server only ever passes on one of these.
  const CALLS = [
    { key: 'need-p', text: 'Need a pawn' },
    { key: 'need-n', text: 'Need a knight' },
    { key: 'need-b', text: 'Need a bishop' },
    { key: 'need-r', text: 'Need a rook' },
    { key: 'need-q', text: 'Need a queen' },
    { key: 'no-trades', text: "Don't trade" },
    { key: 'trade', text: 'Trade!' },
    { key: 'sit', text: "I'm stalling" },
    { key: 'go', text: 'Go!' },
    { key: 'mate', text: 'I have mate' },
  ];
  const callText = (key) => (CALLS.find((c) => c.key === key) || {}).text || null;

  return { teamOf, partnerOf, seatsOf, boardResults, createBoards, play, replay, CALLS, callText };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Bughouse };
}
