"use strict";

// One Bughouse board in src/shared/chess.js, by chess.com's rules: drops as in
// Crazyhouse, but a capture is passed to the partner's board (recorded on the
// move, not pocketed here) and pieces arrive from it by receive(). A check a
// drop could block is not mate — the side waits for a piece — nor is having
// no move a stalemate, and no rule draws a board. Matches, partners and the
// other board are the server's business, not the engine's.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Chess, STANDARD_START } = require("../../src/shared/chess");
const { perft } = require("../helpers/perft");
const { fromFen, play } = require("../helpers/board");
const positions = require("../fixtures/perft.json");

const bug = (fen = STANDARD_START) => fromFen(fen, "bughouse");
const passedBy = (chess) => chess.history[chess.history.length - 1].passed;

describe("Bughouse", () => {
  test("with empty pockets it moves exactly as standard chess", () => {
    for (let depth = 1; depth <= 3; depth++) {
      assert.equal(perft(bug(), depth), perft(fromFen(STANDARD_START), depth), `start, depth ${depth}`);
    }
    // Captures fill no pocket here, so even a position full of them does.
    for (const pos of positions.slice(1, 4)) {
      assert.equal(perft(bug(pos.fen), 2), pos.depths[2], pos.name);
    }
  });

  test("starts from the standard setup with empty pockets", () => {
    const chess = bug();
    assert.equal(chess.isBughouse, true);
    assert.equal(chess.hasPockets, true);
    assert.equal(chess.fen(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1");
    assert.equal(new Chess().setVariant("bughouse").variant, "bughouse");
  });

  test("a capture is passed to the partner, not pocketed here", () => {
    const chess = bug();
    play(chess, "e2e4", "d7d5", "e4d5");
    assert.deepEqual(passedBy(chess), { t: "p", c: "b" }, "a black pawn, for the partner playing Black");
    assert.equal(chess.pocketText(), "", "nothing in either pocket on this board");
    play(chess, "d8d5");
    assert.deepEqual(passedBy(chess), { t: "p", c: "w" });
    play(chess, "b1c3");
    assert.equal(passedBy(chess), undefined, "a quiet move passes nothing");
    chess.undoMove();
    chess.undoMove();
    assert.equal(chess.fen(), "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR[] b KQkq - 0 2");
  });

  test("a promoted piece is passed as the pawn it was, and so is one taken en passant", () => {
    // The black queen on h3 was a pawn; the g2 pawn takes it.
    const taker = bug("4k3/8/8/8/8/7q~/6P1/4K3[] w - - 0 1");
    play(taker, "g2h3");
    assert.deepEqual(passedBy(taker), { t: "p", c: "b" }, "the queen goes back as a pawn");
    // A pawn promoting on this board is marked too: a7-a8=Q+, and the rook
    // that takes it passes a pawn.
    const promoting = bug("4k3/P7/8/8/8/8/r7/4K3[] w - - 0 1");
    play(promoting, "a7a8q", "a2a8");
    assert.deepEqual(passedBy(promoting), { t: "p", c: "w" });
    const ep = bug("4k3/8/8/3pP3/8/8/8/4K3[] w - d6 0 1");
    play(ep, "e5d6");
    assert.deepEqual(passedBy(ep), { t: "p", c: "b" });
  });

  test("pieces arrive by receive(), to be dropped; receiving is never undone", () => {
    const chess = bug("4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    const before = chess.positionKey();
    chess.receive("w", "n");
    chess.receive("w", "p");
    assert.equal(chess.pocketText(), "NP");
    assert.match(chess.fen(), /\[NP\]/);
    assert.notEqual(chess.positionKey(), before, "what is in hand is part of the position");
    const drop = chess.findDrop("n", 27);   // N@d4
    assert.ok(drop);
    chess.makeMove(drop);
    chess.undoMove();
    assert.equal(chess.pocketText(), "NP");
    assert.throws(() => chess.receive("w", "k"), /no such pocket piece/);
    assert.throws(() => chess.receive("x", "n"), /no such colour/);
    assert.throws(() => fromFen(STANDARD_START, "crazyhouse").receive("w", "n"), /Only a Bughouse board/);
    // A FEN carries the pockets, as Crazyhouse's does.
    assert.equal(bug("4k3/8/8/8/8/8/8/4K3[Nq] b - - 0 1").pocketText(), "Nq");
  });

  test("a check a drop could block is not mate: the side waits for a piece", () => {
    // Re8+: f8 lies between rook and king, and nothing is in Black's hand.
    const chess = bug("6k1/5ppp/8/8/8/8/8/K3R3[] w - - 0 1");
    const check = chess.findMove(4, 60);
    assert.equal(chess.moveToSan(check), "Re8+", "a check, not a mate");
    chess.makeMove(check);
    assert.deepEqual(chess.legalMoves(), []);
    assert.equal(chess.isCheckmate(), false);
    assert.equal(chess.isGameOver(), false);
    assert.equal(chess.isWaiting(), true);
    assert.equal(chess.result(), "*");
    // A knight arrives: N@f8 blocks, and the game goes on.
    chess.receive("b", "n");
    assert.ok(chess.findDrop("n", 61));
    assert.equal(chess.isWaiting(), false);
  });

  test("a check no drop can block is mate", () => {
    // Smothered: no square between a knight and the king it checks.
    const smothered = bug("6rk/5Npp/8/8/8/8/8/K7[] b - - 0 1");
    assert.equal(smothered.isCheckmate(), true);
    assert.equal(smothered.isGameOver(), true);
    assert.equal(smothered.result(), "1-0");
    assert.equal(smothered.termination(), "checkmate");
    assert.equal(smothered.isWaiting(), false);
    // A queen at the king's side, defended: nothing to drop between.
    const contact = bug("6k1/6Q1/6K1/8/8/8/8/8[] b - - 0 1");
    assert.equal(contact.isCheckmate(), true);
    // Double check, rook along the rank and knight: one drop can't block both.
    const double = bug("R5k1/4Nppp/8/8/8/8/8/K7[nr] b - - 0 1");
    assert.equal(double.isCheckmate(), true, "even with pieces in hand");
  });

  test("with no move and no check, a side waits; no rule draws a board", () => {
    const stalemated = bug("7k/5Q2/6K1/8/8/8/8/8[] b - - 0 1");
    assert.equal(stalemated.isStalemate(), false);
    assert.equal(stalemated.isGameOver(), false);
    assert.equal(stalemated.isWaiting(), true);
    stalemated.receive("b", "p");
    assert.ok(stalemated.legalMoves().some((m) => m.drop));

    const bare = bug("7k/8/8/8/8/8/8/K7[] w - - 0 1");
    assert.equal(bare.isInsufficientMaterial(), false, "the partner can send anything");
    assert.equal(bare.hasMatingMaterial("w"), true);
    assert.equal(bare.isGameOver(), false);
    assert.equal(bug("7k/8/8/8/8/8/8/K7[] w - - 100 80").isGameOver(), false, "no fifty-move rule");
    const knights = bug("7k/7p/8/8/8/8/P7/K5N1[] w - - 0 1");
    for (let i = 0; i < 2; i++) play(knights, "g1f3", "h8g8", "f3g1", "g8h8");
    assert.equal(knights.isGameOver(), false, "no threefold");
    assert.equal(knights.termination(), null);
  });

  test("Crazyhouse keeps its own captures as before", () => {
    const chess = fromFen(STANDARD_START, "crazyhouse");
    play(chess, "e2e4", "d7d5", "e4d5");
    assert.equal(chess.pocketText(), "P");
    assert.equal(passedBy(chess), undefined);
  });
});
