"use strict";

// The friends API: who may ask whom, who may answer, and that only the two
// people a friendship belongs to can touch it. Every change nudges both of
// them over the socket.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser, connectSocket, waitFor } = require("../helpers/server");
const queries = require("../../src/db/queries");
const config = require("../../src/config");

let srv, aiId;
before(async () => {
  srv = await startServer();
  aiId = queries.getUserByUsername.get(config.AI_USERNAME).id;
});
after(async () => { await srv.close(); });

const ask = (from, to) => from.c.post("/api/friends/requests", { toUserId: to.user.id });
const accept = (who, id) => who.c.post(`/api/friends/requests/${id}/accept`);
const decline = (who, id) => who.c.post(`/api/friends/requests/${id}/decline`);
const remove = (who, id) => who.c.del(`/api/friends/${id}`);
const lists = async (who) => (await who.c.get("/api/friends")).body;
const ids = (list) => list.map((f) => f.userId);

describe("a friend request", () => {
  let me;
  before(async () => { me = await registerUser(srv.baseUrl, "asker"); });

  test("must name a real, active user other than yourself and LorFish", async () => {
    for (const [body, status, error] of [
      [{}, 400, /Missing toUserId/],
      [{ toUserId: "abc" }, 400, /Missing toUserId/],
      [{ toUserId: -3 }, 400, /Missing toUserId/],
      [{ toUserId: me.user.id }, 400, /yourself/],
      [{ toUserId: aiId }, 400, /LorFish/],
      [{ toUserId: 999999 }, 404, /No such user/],
    ]) {
      const res = await me.c.post("/api/friends/requests", body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.match(res.body.error, error);
    }
    assert.deepEqual(await lists(me), { friends: [], incoming: [], outgoing: [] });
  });

  test("is not sent twice, and is not sent to someone who is already a friend", async () => {
    const them = await registerUser(srv.baseUrl, "target");
    const sent = await ask(me, them);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.status, "pending");

    const dup = await ask(me, them);
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already sent/);

    assert.equal((await accept(them, sent.body.id)).status, 200);
    for (const [from, to] of [[me, them], [them, me]]) {
      const res = await ask(from, to);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /already friends/);
    }
  });

  test("to someone who already asked you accepts their request", async () => {
    const them = await registerUser(srv.baseUrl, "eager");
    const theirs = await ask(them, me);
    const mine = await ask(me, them);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, { ok: true, status: "accepted", id: theirs.body.id });
    assert.ok(ids((await lists(them)).friends).includes(me.user.id));
  });
});

describe("answering a request", () => {
  let asker, addressee, outsider, reqId;
  before(async () => {
    asker = await registerUser(srv.baseUrl, "from");
    addressee = await registerUser(srv.baseUrl, "to");
    outsider = await registerUser(srv.baseUrl, "nosy");
  });

  test("an outsider sees no such request, whatever they try", async () => {
    reqId = (await ask(asker, addressee)).body.id;
    for (const res of [
      await accept(outsider, reqId),
      await decline(outsider, reqId),
      await remove(outsider, reqId),
      await accept(outsider, 999999),
    ]) {
      assert.equal(res.status, 404);
      assert.match(res.body.error, /No such request/);
    }
    assert.equal((await lists(addressee)).incoming.length, 1, "the request is untouched");
  });

  test("only the addressee may accept or decline; the sender may only withdraw", async () => {
    assert.equal((await accept(asker, reqId)).status, 409);
    assert.equal((await decline(asker, reqId)).status, 409);
    const wrongWay = await remove(addressee, reqId);
    assert.equal(wrongWay.status, 409);
    assert.match(wrongWay.body.error, /Use decline/);

    assert.equal((await remove(asker, reqId)).status, 200, "the sender withdraws");
    assert.deepEqual((await lists(addressee)).incoming, []);
    assert.deepEqual((await lists(asker)).outgoing, []);
  });

  test("declining deletes the request, and it cannot then be accepted", async () => {
    const id = (await ask(asker, addressee)).body.id;
    assert.equal((await decline(addressee, id)).status, 200);
    assert.deepEqual(await lists(asker), { friends: [], incoming: [], outgoing: [] });
    assert.equal((await accept(addressee, id)).status, 404);
  });

  test("an accepted friendship cannot be accepted or declined again, but either side may end it", async () => {
    const id = (await ask(asker, addressee)).body.id;
    assert.equal((await accept(addressee, id)).status, 200);
    const again = await accept(addressee, id);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /Nothing to accept/);
    assert.match((await decline(addressee, id)).body.error, /Nothing to decline/);

    assert.equal((await remove(addressee, id)).status, 200, "the addressee may unfriend too");
    assert.deepEqual((await lists(asker)).friends, []);
  });
});

test("another player's friends list refuses bad ids and LorFish", async () => {
  const me = await registerUser(srv.baseUrl, "viewer");
  for (const [id, status] of [["abc", 400], ["0", 400], [String(aiId), 404], ["999999", 404]]) {
    assert.equal((await me.c.get(`/api/friends/user/${id}`)).status, status, id);
  }
});

test("every change nudges both users' open sockets", async () => {
  const a = await registerUser(srv.baseUrl, "nudgeA");
  const b = await registerUser(srv.baseUrl, "nudgeB");
  const sa = await connectSocket(srv.baseUrl, a.c.cookie());
  const sb = await connectSocket(srv.baseUrl, b.c.cookie());

  const both = () => Promise.all([waitFor(sa, "friends:changed"), waitFor(sb, "friends:changed")]);
  let nudged = both();
  const id = (await ask(a, b)).body.id;
  await nudged;
  nudged = both();
  await accept(b, id);
  await nudged;
  nudged = both();
  await remove(a, id);
  await nudged;
  sa.close(); sb.close();
});
