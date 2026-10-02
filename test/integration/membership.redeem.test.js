"use strict";

// Redeeming a membership promo code: a code buys exactly one membership, a
// member cannot burn a second one, malformed and unknown codes are refused,
// and guessing is rate-limited per user.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, registerUser, db } = require("../helpers/server");
const queries = require("../../src/db/queries");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const redeem = (who, code) => who.c.post("/api/membership/redeem", { code });
const codeRow = (code) => db().prepare("SELECT * FROM promo_codes WHERE code = ?").get(code);

test("membership needs a session", async () => {
  const anon = client(srv.baseUrl);
  assert.equal((await anon.get("/api/membership")).status, 401);
  assert.equal((await anon.post("/api/membership/redeem", { code: "111111111" })).status, 401);
});

test("a valid code makes the user a member, once, and is then spent", async () => {
  const first = await registerUser(srv.baseUrl, "redeemer");
  const second = await registerUser(srv.baseUrl, "latecomer");
  queries.insertPromoCode.run("200000001");

  assert.deepEqual((await first.c.get("/api/membership")).body, { member: false, since: null });

  // Spaces and dashes are pasted in all the time and must not matter.
  const ok = await redeem(first, " 200-000 001 ");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.member, true);
  assert.ok(ok.body.since);
  assert.deepEqual((await first.c.get("/api/membership")).body, { member: true, since: ok.body.since });
  assert.equal(codeRow("200000001").redeemed_by, first.user.id);

  // The same code is spent for everyone else, and says so.
  const spent = await redeem(second, "200000001");
  assert.equal(spent.status, 409);
  assert.match(spent.body.error, /already been used/);
  assert.equal((await second.c.get("/api/membership")).body.member, false);
});

test("a member is stopped before a second code is consumed", async () => {
  const who = await registerUser(srv.baseUrl, "twice");
  queries.insertPromoCode.run("200000002");
  queries.insertPromoCode.run("200000003");
  assert.equal((await redeem(who, "200000002")).status, 200);

  const again = await redeem(who, "200000003");
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already a member/);
  assert.equal(again.body.member, true);
  assert.equal(codeRow("200000003").redeemed_by, null, "the second code is still unused");
});

test("missing, malformed and unknown codes are refused without granting anything", async () => {
  const who = await registerUser(srv.baseUrl, "guesser");
  for (const [code, status, error] of [
    [undefined, 400, /Enter a promo code/],
    ["", 400, /Enter a promo code/],
    ["12345678", 400, /Incorrect/],      // eight digits
    ["1234567890", 400, /Incorrect/],    // ten
    ["12345678x", 400, /Incorrect/],
    ["999999999", 404, /Incorrect/],     // well-formed, but nobody minted it
  ]) {
    const res = await redeem(who, code);
    assert.equal(res.status, status, `code ${JSON.stringify(code)}`);
    assert.match(res.body.error, error);
  }
  assert.equal((await who.c.get("/api/membership")).body.member, false);
});

test("guessing is rate-limited per user, and the limit holds even for a good code", async () => {
  const who = await registerUser(srv.baseUrl, "hammer");
  const other = await registerUser(srv.baseUrl, "bystander");
  queries.insertPromoCode.run("200000004");

  for (let i = 0; i < 10; i++) {
    assert.equal((await redeem(who, String(300000000 + i))).status, 404, `attempt ${i + 1}`);
  }
  const blocked = await redeem(who, "200000004");
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many attempts/);
  assert.equal(codeRow("200000004").redeemed_by, null);

  // Someone else's tries are counted separately.
  assert.equal((await redeem(other, "200000004")).status, 200);
});
