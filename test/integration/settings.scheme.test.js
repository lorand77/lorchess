"use strict";

// The light/dark colour scheme on /api/settings: stored with the colours,
// validated to exactly two values, and cleared by a reset.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, registerUser } = require("../helpers/server");

let srv, me;
before(async () => {
  srv = await startServer();
  ({ c: me } = await registerUser(srv.baseUrl, "styler"));
});
after(async () => { await srv.close(); });

test("dark unless chosen otherwise", async () => {
  const res = await me.get("/api/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.scheme, "dark");
});

test("light is saved, and saving colours alone leaves it alone", async () => {
  let res = await me.put("/api/settings", { scheme: "light", bgColor: "#ececec" });
  assert.equal(res.status, 200);
  assert.equal(res.body.scheme, "light");
  assert.equal(res.body.bgColor, "#ececec");

  res = await me.put("/api/settings", { light: "#eeeed2" });
  assert.equal(res.body.scheme, "light");
  assert.equal((await me.get("/api/settings")).body.scheme, "light");
});

test("anything but dark or light is refused, and nothing is saved", async () => {
  for (const scheme of ["sepia", "", "LIGHT", 1, null, ["light"]]) {
    const res = await me.put("/api/settings", { scheme, light: "#000000" });
    assert.equal(res.status, 400, JSON.stringify(scheme));
    assert.match(res.body.error, /scheme/);
  }
  const now = (await me.get("/api/settings")).body;
  assert.equal(now.scheme, "light");
  assert.equal(now.light, "#eeeed2");
});

test("reset goes back to dark", async () => {
  const res = await me.post("/api/settings/reset");
  assert.equal(res.status, 200);
  assert.equal(res.body.scheme, "dark");
});
