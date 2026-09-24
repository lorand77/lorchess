"use strict";

// Boots the real LorChess server in-process on a random port, against a
// throwaway SQLite database, and provides a small HTTP client that keeps the
// session cookie between requests the way a browser would.
//
// The database path is fixed the moment this module loads, so require it
// BEFORE anything under src/ (src/db/index.js opens the database when loaded).
// Each test file runs in its own process, so each gets its own database.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorchess-test-"));
process.env.DB_PATH = path.join(dir, "test.sqlite");
process.env.SESSION_SECRET = "test-secret";
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

// Start the server. Returns { baseUrl, io, close }. Servers may be started one
// after another against the same database, which is how a restart is tested.
async function startServer() {
  // The first load opens the database and logs its migrations; keep the test
  // output clean.
  const log = console.log;
  console.log = () => {};
  let createServer;
  try { ({ createServer } = require("../../src/app")); } finally { console.log = log; }
  const { server, io } = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    io,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        io.close(() => resolve());
      }),
  };
}

// A minimal HTTP client with a cookie jar. Responses come back as
// { status, body, headers }, with body parsed as JSON when it is JSON.
function client(baseUrl) {
  const jar = new Map();

  async function request(method, urlPath, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*(Expires=Thu, 01 Jan 1970|Max-Age=0)/i.test(a));
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed === null ? text : parsed, headers: res.headers };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, body = {}) => request("POST", p, body),
    put: (p, body = {}) => request("PUT", p, body),
    del: (p) => request("DELETE", p),
    cookie: (name = "connect.sid") => jar.get(name),
    setCookie: (name, value) => jar.set(name, value),
    clearCookies: () => jar.clear(),
  };
}

// A username that is unique within the process and valid for /api/register.
let counter = 0;
function uniqueName(base) {
  counter++;
  return `${base}_${process.pid.toString(36)}${counter}`.slice(0, 20);
}

// Register a fresh user on a fresh client; returns { c, user }.
async function registerUser(baseUrl, base = "user", password = "hunter22") {
  const c = client(baseUrl);
  const username = uniqueName(base);
  const res = await c.post("/api/register", { username, password });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return { c, user: res.body, password };
}

module.exports = { startServer, client, uniqueName, registerUser };
