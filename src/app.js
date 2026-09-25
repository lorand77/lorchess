"use strict";

// Builds the Express app and the HTTP server, with Socket.IO attached, but
// does not listen. src/server.js is the entry point that listens; the
// integration tests boot the very same thing on a random port.

const http = require("http");
const path = require("path");
const express = require("express");
const sessionMiddleware = require("./auth/session");
const authRoutes = require("./auth/routes");
const gameRoutes = require("./game/routes");
const leaderboardRoutes = require("./game/leaderboard");
const friendRoutes = require("./friends/routes");
const settingsRoutes = require("./settings/routes");
const puzzleRoutes = require("./puzzles/routes");
const membershipRoutes = require("./membership/routes");
const statsRoutes = require("./stats/routes");
const achievementRoutes = require("./achievements/routes");
const { attachSockets } = require("./game/socket");

function createServer() {
  const app = express();

  // Behind a TLS-terminating reverse proxy in prod (Caddy on the EC2 server).
  // Trust one proxy hop so req.secure reflects the real HTTPS connection via
  // X-Forwarded-Proto — required for the session cookie's secure:"auto" to
  // activate over HTTPS.
  app.set("trust proxy", 1);

  // --- API: JSON body parsing, sessions, auth + game routes ---
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use("/api", authRoutes);
  app.use("/api/games", gameRoutes);
  app.use("/api/leaderboard", leaderboardRoutes);
  app.use("/api/friends", friendRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/puzzles", puzzleRoutes);
  app.use("/api/membership", membershipRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/achievements", achievementRoutes);

  // --- Static assets ---
  // Single source of truth for the engine: chess.js / lorfish.js live only in
  // src/shared and are served at /js/*. Mounted before the public static handler
  // so /js/chess.js and /js/lorfish.js resolve here, while /js/ui.js, etc. fall
  // through to public/js below.
  app.use("/js", express.static(path.join(__dirname, "shared")));

  // My Games, Achievements and Friends used to be pages of their own; they are
  // tabs of profile.html now. Keep old bookmarks and links landing on the tab.
  app.get("/history.html", (req, res) => res.redirect("/profile.html#games"));
  app.get("/friends.html", (req, res) => res.redirect("/profile.html#friends"));
  app.get("/achievements.html", (req, res) => {
    const user = Number(req.query.user);
    const who = Number.isInteger(user) && user > 0 ? "?id=" + user : "";
    res.redirect("/profile.html" + who + "#achievements");
  });

  // Static UI (login.html, lobby.html, game.html, css, assets, public/js/*).
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Wrap Express in an http.Server so Socket.IO can share the same port.
  const server = http.createServer(app);
  const io = attachSockets(server);
  return { app, server, io };
}

module.exports = { createServer };
