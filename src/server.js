"use strict";

const http = require("http");
const path = require("path");
const express = require("express");
const config = require("./config");
const sessionMiddleware = require("./auth/session");
const authRoutes = require("./auth/routes");
const gameRoutes = require("./game/routes");
const { attachSockets } = require("./game/socket");
const rooms = require("./game/rooms");

// Boot cleanup: abort games left 'active' by a previous run (their in-memory
// rooms didn't survive the restart). Run once at startup, before serving.
const aborted = rooms.cleanupOrphanedGames();
if (aborted > 0) console.log(`Aborted ${aborted} orphaned game(s) from a previous run.`);

const app = express();

// Behind a TLS-terminating reverse proxy in prod (Caddy on the droplet,
// Railway's edge). Trust one proxy hop so req.secure reflects the real HTTPS
// connection via X-Forwarded-Proto — required for the session cookie's
// secure:"auto" to activate over HTTPS.
app.set("trust proxy", 1);

// --- API: JSON body parsing, sessions, auth + game routes ---
app.use(express.json());
app.use(sessionMiddleware);
app.use("/api", authRoutes);
app.use("/api/games", gameRoutes);

// --- Static assets ---
// Single source of truth for the engine: chess.js / lorfish.js live only in
// src/shared and are served at /js/*. Mounted before the public static handler
// so /js/chess.js and /js/lorfish.js resolve here, while /js/ui.js, etc. fall
// through to public/js below.
app.use("/js", express.static(path.join(__dirname, "shared")));

// Static UI (login.html, lobby.html, game.html, css, assets, public/js/*).
app.use(express.static(path.join(__dirname, "..", "public")));

// Wrap Express in an http.Server so Socket.IO can share the same port.
const server = http.createServer(app);
attachSockets(server);

server.listen(config.PORT, () => {
  console.log(`LorChess listening on http://localhost:${config.PORT}`);
  console.log(`  → login:  http://localhost:${config.PORT}/login.html`);
});
