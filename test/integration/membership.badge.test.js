"use strict";

// The member flag that lists carry so the client can put a 💎 after a
// member's name: the leaderboard and the friends list.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");
const queries = require("../../src/db/queries");

let srv, member, plain;
before(async () => {
  srv = await startServer();
  member = await registerUser(srv.baseUrl, "member");
  plain = await registerUser(srv.baseUrl, "plain");

  queries.insertPromoCode.run("123456789");
  const res = await member.c.post("/api/membership/redeem", { code: "123456789" });
  assert.equal(res.status, 200);
});
after(async () => { await srv.close(); });

test("the leaderboard marks members and only members", async () => {
  const res = await plain.c.get("/api/leaderboard");
  assert.equal(res.status, 200);
  const byId = new Map(res.body.map((r) => [r.id, r]));
  assert.ok(byId.get(member.user.id).member);
  assert.ok(!byId.get(plain.user.id).member);
});

test("the friends list marks members on both ends of a request", async () => {
  const sent = await plain.c.post("/api/friends/requests", { toUserId: member.user.id });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));

  const mine = await plain.c.get("/api/friends");
  assert.equal(mine.body.outgoing.length, 1);
  assert.equal(mine.body.outgoing[0].member, true);

  const theirs = await member.c.get("/api/friends");
  assert.equal(theirs.body.incoming.length, 1);
  assert.equal(theirs.body.incoming[0].member, false);
});
