"use strict";

const path = require("path");
const express = require("express");
const config = require("./config");
const sessionMiddleware = require("./auth/session");
const authRoutes = require("./auth/routes");

const app = express();

// --- API: JSON body parsing, sessions, auth routes ---
app.use(express.json());
app.use(sessionMiddleware);
app.use("/api", authRoutes);

// --- Static assets ---
// Single source of truth for the engine: chess.js / lorfish.js live only in
// src/shared and are served at /js/*. Mounted before the public static handler
// so /js/chess.js and /js/lorfish.js resolve here, while /js/ui.js, etc. fall
// through to public/js below.
app.use("/js", express.static(path.join(__dirname, "shared")));

// Static UI (login.html, game.html, css, assets, public/js/*).
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(config.PORT, () => {
  console.log(`LorChess listening on http://localhost:${config.PORT}`);
  console.log(`  → login:  http://localhost:${config.PORT}/login.html`);
});
