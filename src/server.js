"use strict";

const path = require("path");
const express = require("express");
const config = require("./config");

const app = express();

// Single source of truth for the engine: chess.js / lorfish.js live only in
// src/shared and are served at /js/*. They load three ways from this one copy —
// browser <script>, Web Worker importScripts, and Node require (later milestones).
// Mounted before the public static handler so /js/chess.js and /js/lorfish.js
// resolve here, while /js/ui.js, /js/moveSource.js, /js/engineWorker.js fall
// through to public/js below.
app.use("/js", express.static(path.join(__dirname, "shared")));

// Static UI (game.html, css, assets, public/js/*).
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(config.PORT, () => {
  console.log(`LorChess listening on http://localhost:${config.PORT}`);
  console.log(`  → play vs AI: http://localhost:${config.PORT}/game.html?mode=ai`);
});
