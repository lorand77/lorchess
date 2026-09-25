# LorChess — Design Notes

What the code does and, more importantly, why. This describes the **current
state**, not a plan: when a decision changes, change it here in the same
commit. How to run and deploy is in `setup.md`; conventions for working in the
repo are in `CLAUDE.md`.

LorChess is a chess web app. Signed-in users play **LorFish** (the built-in
engine) or **each other in real time**, with server-side clocks and Elo, in
standard chess, Chess960, Atomic or Pawn Wars. Around the games: puzzles,
achievements, friends, a leaderboard, spectating, in-game chat and a
promo-code membership. Node.js + SQLite on the server, vanilla JS in the
browser, no build step.

## Tech stack

- **Express 5** — static pages + REST API.
- **Socket.IO** — rooms, auto-reconnect, acks for real-time PvP (vs hand-rolling `ws`).
- **better-sqlite3** — single-file, synchronous, zero-ops. Schema written to port to Postgres later.
- **Raw SQL** via prepared statements in `src/db/queries.js`; no ORM.
- **express-session** + `better-sqlite3-session-store` — one session cookie serves REST and the Socket.IO handshake.
- **argon2** for password hashing.
- **No bundler, no framework.** Static HTML pages with their scripts in `public/js/`.

## Engine: one file, three runtimes

`src/shared/chess.js` is a framework-agnostic `Chess` class: move generation,
legality, FEN, SAN, draw/mate detection, Chess960 castling from arbitrary
squares, and the Atomic and Pawn Wars rule sets. `src/shared/lorfish.js` is
**LorFish**, a synchronous search engine ported from a sunfish-derived Python
original (roughly 1400–1800 strength). It depends tightly on `chess.js`.

The engine and the catalogues next to it (`achievements.js`, `timeControls.js`,
`variants.js`, `chess960.js`, `handicap.js`) live **only** in `src/shared/` and
load three ways: as a browser `<script>` global, via `importScripts` in the
engine Web Worker, and as a Node `require`. The UMD tail
(`if (typeof module !== 'undefined' && module.exports) module.exports = {...}`)
makes one file serve all three; Express mounts `src/shared/` at `/js/` ahead of
`public/`, so `/js/chess.js` resolves there while `/js/ui.js` falls through.

One copy means the server validates with exactly the rules the browser plays
by. The catalogues are **allowlists**: seeks, challenges and moves arrive over a
socket, and the server resolves the client's key (time control, variant,
handicap) against the shared table rather than trusting the payload. They exist
because this knowledge was once duplicated in three places and the copies
drifted (see the header of `variants.js`).

## Authentication

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`.
  Register and login both go through `startSession`, which calls
  `req.session.regenerate` first (anti-fixation) and then stores `userId`.
- **REST protection:** `requireAuth` middleware. **Page protection:**
  `public/js/authGuard.js` calls `/api/me` on load and bounces to login on 401.
  That is a UX redirect, not a security boundary; every privileged action is
  enforced server-side.
- **Socket auth:** the same session middleware is attached to the Socket.IO
  engine (`io.engine.use`), and `io.use` rejects handshakes without
  `session.userId`. No separate token.
- Cookie: `httpOnly`, `sameSite: lax`, `secure: "auto"` behind `trust proxy`
  (Caddy terminates TLS), 7 days. Sessions are rows in SQLite.

## Database

`src/db/schema.sql` only ever `CREATE`s, which is idempotent. Adding a column to
a table that already exists needs `ALTER`, so those go through
`addColumnIfMissing` in `src/db/index.js`, which runs at every boot and brings
an older database up to date. A new column on an existing table therefore needs
a line there, or existing databases never get it.

Design notes:

- **PvP games survive restarts.** `games.current_fen`/`turn` and
  `clock_w_ms`/`clock_b_ms` are written on every move; `moves` holds the full
  record (`san`, `uci`, `fen_after`, server-measured `think_ms`, `premove`).
  Position from `moves`, clocks from the row: that is all a room needs.
- **The AI side is a real user.** A reserved `LorFish` account
  (`config.AI_USERNAME`, `password_hash NULL` so it can never log in) owns the
  AI side of games, so foreign keys and queries stay uniform.
- **Chat is temporary.** Messages exist so two players can talk during a game
  and arrange a rematch afterwards. `src/db/retention.js` sweeps them
  `CHAT_RETENTION_DAYS` after the game ends (−1 keeps everything); only the
  per-user tally survives, for the "Chatty" achievement.

## AI games: client-side Web Worker

LorFish's search is synchronous and blocks whatever thread runs it. It runs in
`public/js/engineWorker.js`, so the page never freezes. (The original UI hid the
freeze behind a `setTimeout` paint hack and a "scanner" sound; neither is
needed.) The worker `importScripts` the engine, receives
`{ startFen, moves, depth }` and **replays the moves** instead of loading the
current FEN, because `loadFen` and `reset` wipe `positionCounts` and threefold
repetition would be wrong. The same worker streams per-ply evaluations for game
review (`type: "review"`).

The browser is authoritative for its own AI game. `public/js/gameStore.js`
mirrors it to the server (`POST /api/games`, `/:id/moves`, `/:id/end`)
best-effort and in order, so history, stats and achievements see it; nothing
about play waits on the server. This is also why AI games from a pasted FEN
earn no game-feat achievements (see below).

## Real-time PvP

The server holds the authoritative state. `src/game/rooms.js` keeps one
in-memory room per live PvP game: the server-side `Chess`, both players, their
sockets, clocks and timers.

- **Finding a game.** Two paths, both purely in-memory because an offer means
  nothing once a socket closes. Quick-match (`matchmaking.js`) keeps FIFO
  queues per time control and rated flag, so a bullet seeker is never handed a
  classical game. The live lobby (`lobby.js`) has open **seeks** anyone may
  take and **challenges** addressed to one user. Either path creates the
  `games` row and the room and emits `game:start`; clients navigate to
  `game.html?id=<gameId>`. Handicap positions arrive as a sparse map of changes
  to the starting squares, never a FEN; the server rebuilds the position.
- **`move:make`** (`handleMove` in `socket.js`): confirm the sender is a
  player in an active room → **turn enforcement** → **legality** against the
  server's own `findMove` (never trust the client) → charge the mover's clock,
  and flag if it ran out → apply → persist move, position and clocks →
  broadcast `move:made` to the room (mover included; everyone applies on
  confirmation) → `game:over`, or re-arm the flag timer for the other side.
- **Clocks and rating.** Clocks are server-side; clients render snapshots.
  Elo (`elo.js`, K from `config.ELO_K`) moves after rated games, and every
  update writes `rating_history`.
- **Disconnects.** When a player's last socket drops, a forfeit timer starts
  (`DISCONNECT_GRACE_MS`, default 45 s) and the opponent sees
  `opponent:disconnected`. Rejoining cancels it and `game:join` hands back the
  full state. Expiry forfeits (`termination = 'disconnect'`), or aborts if no
  move was ever played.
- **Restarts.** Nothing is thrown away at boot. A PvP game left `active` is
  rebuilt from the DB the moment a participant connects (`loadRoomFromDb`).
  `RESUME_WINDOW_MS` (default 10 min) after boot, a sweep aborts the games
  nobody came back for (`termination = 'server-restart'`). AI games keep no
  server state, so a restart never interrupted them.
- **Spectating.** `game.html?watch=<id>` joins a live game read-only via
  `game:watch`. Spectator chat reaches only other spectators; player chat
  reaches only the opponent.

## The board talks to a "move source"

`public/js/ui.js` never calls LorFish or the socket directly. It talks to a
**move source** (`public/js/moveSource.js`) with one interface:
`{ kind, canHumanMoveNow(turn), submitMove(move), kickIfEngineTurn(), cancel() }`.
Three implementations:

- `createAiMoveSource` — posts the position to the engine worker and applies
  the reply.
- `createRemoteMoveSource` — emits `move:make`, applies `move:made` from the
  server. `canHumanMoveNow` also checks that it is your colour and no move is
  awaiting confirmation (the server enforces regardless). Socket listeners are
  registered once in `ui.js` and dispatched to the current source through
  `onServerMove`, so a reconnect that rebuilds the source never stacks
  duplicate handlers.
- `createSpectatorMoveSource` — applies server moves; the human can never move.

Every move that reaches the board — the engine's, the opponent's, the player's
own once confirmed — goes through the single `env.applyMove` path, so sounds,
captured pieces, PGN and premove consumption behave the same in every mode.
Undo is disabled in PvP. `game.html` picks the source from the URL:
`?watch=<id>` spectates, `?id=<id>` plays a PvP game, and no parameter starts
(or resumes) an AI game.

## Trickiest parts

- **Blocking engine** → must run in a Web Worker; the old paint hacks existed only because it blocks.
- **One engine, three runtimes** via the UMD tail + serving `src/shared` at `/js`.
- **Authoritative validation + repetition state** — worker and server rebuild positions by replaying `moves`, because `loadFen` resets `positionCounts`.
- **Decoupling the opponent** from the board via the move source.
- **Surviving restarts** — position and clocks are persisted on every move, so a room can be rebuilt from the DB.
- **Trusting nothing from the socket** — legality, turn, time, time control, variant, handicap and the premove flag are all decided or re-checked server-side.

## Achievements

Chess.com-style badges. The catalogue (name, icon, tiers, description, hidden
flag) is `src/shared/achievements.js`, served at `/js/achievements.js` for the
page and `require`d by the server. Everything that decides whether something
was earned lives in `src/achievements/service.js`:

- **Game feats** replay a finished game's moves (en passant, smothered mate,
  comeback, mirror match, …) and run for each human participant. Pasted-FEN AI
  games earn nothing here; only the standard start or a server-built handicap
  counts, since the AI client is authoritative for its own game.
- **Stats** are aggregate queries (games, wins per time control, castles,
  puzzle streaks, rating, chat count, anniversary) re-evaluated after every
  game, puzzle, chat message, login and visit to the page.
- Awarding is an upsert that only writes when the tier goes up, so every
  evaluation is idempotent; `npm run achievements:backfill` replays history.

Storage: `user_achievements` (one row per user per key, highest tier, the game
or puzzle that earned it) and `rating_history` (written with every Elo update,
for "rating before this game" and the rollercoaster badge). `moves.think_ms`
records server-measured think time on PvP moves.

Hooks: `concludeGame` (PvP, pushes `achievements:earned` to each player's
sockets), `POST /api/games/:id/end` (AI, returned in the reply), the puzzle
`finish` helper (returned in the reply), `chat:send`, and login. The UI shows
unlock toasts (`public/js/achievementToast.js`) on the game, puzzle and lobby
pages; the profile's Achievements tab (`profile.html#achievements`) lists the
catalogue, and `?id=<id>` shows someone else's.

## Premoves

One move may be queued while the opponent is on move (`premove` in ui.js).
Picking up a piece then shows every square it could reach on an empty board;
dropping or clicking one of them queues the move and tints both squares. The
premove is consumed in `applyMove` the moment a move makes it our turn: if it
is legal in the new position it is submitted through the normal move source
(so PvP still goes through the server's validation), otherwise it is dropped.
Promotion premoves always take a queen. Any click or a right-click cancels it.

A premoved move is flagged on its way to the server (`premove` in the socket
payload / AI move POST) and stored in `moves.premove`. PvP believes the flag
only when the server-measured think time is under `PREMOVE_MAX_MS`, so a
crafted payload can't claim a premove it had time to consider. The
"Clairvoyant" achievement reads it: win with every move after your first
premoved.
