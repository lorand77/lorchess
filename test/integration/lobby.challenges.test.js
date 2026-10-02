"use strict";

// Direct challenges and the offer checks that guard them: only the addressee
// can accept or decline, only the sender can withdraw, re-challenging replaces
// the old offer, and an accepted challenge starts the game on the challenger's
// terms. Also the handicaps the server refuses to set up, and accepting your
// own seek.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer, registerUser, connectSocket, emitAck, waitFor, expectNo, db,
} = require("../helpers/server");
const { sq } = require("../helpers/board");

let srv, alice, bob, carol;
before(async () => {
  srv = await startServer();
  alice = await registerUser(srv.baseUrl, "alice");
  bob = await registerUser(srv.baseUrl, "bob");
  carol = await registerUser(srv.baseUrl, "carol");
});
after(async () => { await srv.close(); });

const connectAs = (who) => connectSocket(srv.baseUrl, who.c.cookie());
const idOf = (who) => who.user.id;
const gameRow = (id) => db().prepare("SELECT * FROM games WHERE id = ?").get(id);

// challenge:list is pushed on many occasions; wait for the one that says `pred`.
function waitForList(socket, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const handler = (list) => {
      if (!pred(list)) return;
      clearTimeout(timer);
      socket.off("challenge:list", handler);
      resolve(list);
    };
    const timer = setTimeout(() => {
      socket.off("challenge:list", handler);
      reject(new Error("no matching challenge:list"));
    }, timeoutMs);
    socket.on("challenge:list", handler);
  });
}

// Alice challenges Bob; resolves to the challenge as Bob sees it.
async function challenge(a, b, payload) {
  const arrived = waitForList(b, (l) => l.incoming.length === 1);
  a.emit("challenge:create", { toUserId: idOf(bob), ...payload });
  return (await arrived).incoming[0];
}

describe("a direct challenge", () => {
  let a, b, c;
  before(async () => {
    a = await connectAs(alice);
    b = await connectAs(bob);
    c = await connectAs(carol);
  });
  after(() => { a.close(); b.close(); c.close(); });

  test("re-challenging the same player replaces the old offer", async () => {
    const first = await challenge(a, b, { tc: "5+0" });
    const replaced = waitForList(b, (l) => l.incoming.length === 1 && l.incoming[0].id !== first.id);
    a.emit("challenge:create", { toUserId: idOf(bob), tc: "10+0" });
    const list = await replaced;
    assert.equal(list.incoming[0].tc, "10+0");

    const gone = waitForList(b, (l) => l.incoming.length === 0);
    a.emit("challenge:cancel", { id: list.incoming[0].id });
    await gone;
  });

  test("an outsider can neither accept, decline nor cancel it", async () => {
    const offer = await challenge(a, b, { tc: "5+0" });
    const quiet = [expectNo(a, "game:start"), expectNo(c, "game:start"), expectNo(a, "challenge:declined")];
    c.emit("challenge:accept", { id: offer.id });
    c.emit("challenge:decline", { id: offer.id });
    c.emit("challenge:cancel", { id: offer.id });
    assert.deepEqual(await Promise.all(quiet), [true, true, true]);

    // Nor can the challenger accept their own, or the addressee cancel it.
    const stillQuiet = expectNo(a, "game:start");
    a.emit("challenge:accept", { id: offer.id });
    b.emit("challenge:cancel", { id: offer.id });
    assert.equal(await stillQuiet, true);

    const listed = waitForList(b, () => true);
    b.emit("lobby:enter");
    assert.deepEqual((await listed).incoming.map((x) => x.id), [offer.id], "still open");

    const gone = waitForList(b, (l) => l.incoming.length === 0);
    a.emit("challenge:cancel", { id: offer.id });
    await gone;
  });

  test("declining tells the challenger and clears it on both sides", async () => {
    const offer = await challenge(a, b, { tc: "5+0" });
    const told = waitFor(a, "challenge:declined");
    const cleared = waitForList(a, (l) => l.outgoing.length === 0);
    b.emit("challenge:decline", { id: offer.id });
    assert.deepEqual(await told, { username: bob.user.username });
    await cleared;

    const err = waitFor(b, "lobby:error");
    b.emit("challenge:accept", { id: offer.id });
    assert.match((await err).error, /expired/);
  });

  test("accepting starts the game with the challenger's colour and clock", async () => {
    const offer = await challenge(a, b, { tc: "1+0", color: "b", rated: false });
    const startA = waitFor(a, "game:start");
    const startB = waitFor(b, "game:start");
    // The addressee's own idea of colour and clock is ignored.
    b.emit("challenge:accept", { id: offer.id, color: "b", tc: "10+0" });
    const [sa, sb] = await Promise.all([startA, startB]);
    try {
      assert.equal(sa.gameId, sb.gameId);
      assert.equal(sa.color, "b");
      assert.equal(sb.color, "w");
      const row = gameRow(sa.gameId);
      assert.equal(row.white_id, idOf(bob));
      assert.equal(row.black_id, idOf(alice));
      assert.equal(row.initial_ms, 60000);
      assert.equal(row.increment_ms, 0);
      assert.equal(row.rated, 0);
    } finally {
      // Tidy up even on failure, or both players stay busy for the tests after
      // this one. Nobody has moved, so resigning aborts.
      await emitAck(b, "game:join", { gameId: sa.gameId });
      const over = waitFor(b, "game:over");
      b.emit("game:resign", { gameId: sa.gameId });
      assert.equal((await over).result, "*");
    }
  });
});

describe("a seek", () => {
  test("cannot be accepted by the player who posted it", async () => {
    const a = await connectAs(alice);
    const entered = waitFor(a, "lobby:state");
    a.emit("lobby:enter");
    await entered;
    const posted = waitFor(a, "lobby:state");
    a.emit("seek:create", { tc: "5+0" });
    const seek = (await posted).seeks.find((s) => s.userId === idOf(alice));
    assert.ok(seek, "the seek is posted");

    const err = waitFor(a, "lobby:error");
    a.emit("seek:accept", { id: seek.id });
    assert.match((await err).error, /your own/);
    a.emit("seek:cancel", { id: seek.id });
    a.close();
  });
});

describe("a handicap the server will not set up", () => {
  // Every start square except the kings, emptied: bare kings, a dead draw.
  const bare = {};
  for (let s = 0; s < 64; s++) {
    if ((s < 16 || s >= 48) && s !== sq("e1") && s !== sq("e8")) bare[s] = null;
  }

  for (const [label, payload, error] of [
    [
      "on a shuffled back rank",
      { tc: "5+0", variant: "chess960", handicap: { squares: { [sq("d1")]: null } } },
      /standard setup/,
    ],
    ["that leaves bare kings", { tc: "5+0", handicap: { squares: bare } }, /too little material/],
    [
      "that starts with a king in check",
      // Black's e-pawn becomes a rook and White's e-pawn goes: Re7 checks Ke1.
      { tc: "5+0", handicap: { squares: { [sq("e7")]: "r", [sq("e2")]: null } } },
      /king in check/,
    ],
  ]) {
    test(`is refused ${label}, as a seek and as a challenge`, async () => {
      const a = await connectAs(alice);
      const b = await connectAs(bob);
      for (const [event, extra] of [["seek:create", {}], ["challenge:create", { toUserId: idOf(bob) }]]) {
        const err = waitFor(a, "lobby:error");
        const quiet = expectNo(b, "challenge:list");
        a.emit(event, { ...payload, ...extra });
        assert.match((await err).error, error, event);
        assert.equal(await quiet, true, `${event}: nothing reaches Bob`);
      }
      a.close(); b.close();
    });
  }
});
