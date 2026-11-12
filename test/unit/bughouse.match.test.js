"use strict";

// Bughouse's two boards together (src/shared/bughouse.js): who partners whom,
// each board's result for a team's, and a capture on one board passed to the
// partner on the other, played live or replayed from the stored moves in the
// order they were made.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bughouse } = require("../../src/shared/bughouse");
const { moveFromUci } = require("../../src/shared/uci");

const seats = [[0, "w"], [0, "b"], [1, "w"], [1, "b"]];

test("team A plays White on board 0 and Black on board 1; partners play opposite colours", () => {
  assert.deepEqual(seats.map(([b, c]) => Bughouse.teamOf(b, c)), ["A", "B", "B", "A"]);
  for (const [board, color] of seats) {
    const partner = Bughouse.partnerOf(board, color);
    assert.notEqual(partner.board, board);
    assert.notEqual(partner.color, color);
    assert.equal(Bughouse.teamOf(partner.board, partner.color), Bughouse.teamOf(board, color));
  }
  for (const team of ["A", "B"]) {
    assert.ok(Bughouse.seatsOf(team).every((s) => Bughouse.teamOf(s.board, s.color) === team), team);
  }
});

test("each board's result follows from the team's", () => {
  assert.deepEqual(Bughouse.boardResults("A"), ["1-0", "0-1"], "A's White wins board 0, A's Black board 1");
  assert.deepEqual(Bughouse.boardResults("B"), ["0-1", "1-0"]);
  assert.deepEqual(Bughouse.boardResults("draw"), ["1/2-1/2", "1/2-1/2"]);
});

test("a capture on one board arrives on the other, for the partner to drop", () => {
  const boards = Bughouse.createBoards();
  const go = (board, uci) => Bughouse.play(boards, board, moveFromUci(boards[board], uci));
  go(0, "e2e4");
  go(0, "d7d5");
  assert.deepEqual(go(0, "e4d5"), { t: "p", c: "b" });
  assert.equal(boards[0].pocketText(), "", "nothing stays on the board it was taken on");
  assert.equal(boards[1].pocketText(), "p", "A's Black on board 1 has a black pawn to drop");
  go(1, "g1f3");                       // board 1's White moves first there
  assert.ok(moveFromUci(boards[1], "P@e5"), "and drops it");
  assert.equal(go(1, "P@e5"), null, "a drop passes nothing");
});

test("a replay rebuilds both boards, and only in the order the moves were made", () => {
  const moves = [
    { board: 0, uci: "e2e4" }, { board: 1, uci: "g1f3" }, { board: 0, uci: "d7d5" },
    { board: 0, uci: "e4d5" }, { board: 1, uci: "P@e5" },
  ];
  const [zero, one] = Bughouse.replay(moves);
  assert.equal(zero.fen(), "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR[] b KQkq - 0 2");
  assert.equal(one.fen(), "rnbqkbnr/pppppppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R[] w KQkq - 0 2");
  // The drop before the capture that supplied it: not legal where it falls.
  const early = [moves[0], moves[1], moves[4], moves[2], moves[3]];
  assert.throws(() => Bughouse.replay(early), /move 3 \(P@e5 on board 1\) is not legal there/);
  assert.throws(() => Bughouse.replay([{ board: 2, uci: "e2e4" }]), /not legal there/);
  assert.deepEqual(Bughouse.replay([]).map((b) => b.fen()), [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
  ]);
});
