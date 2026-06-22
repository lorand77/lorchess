# LorChess — Design Document

A chess web application where authenticated users play **against the LorFish AI** or **in real-time against other logged-in users**. Node.js backend + SQLite, reusing the existing vanilla-JS UI and AI.

## Context

The repo is greenfield except for a complete **vanilla-JS** chess app in `tmp/`:

- `tmp/chess.js` — framework-agnostic `Chess` class (move gen, legality, FEN, SAN, draw/mate detection). Defines globals `W`/`B`. Runs in browser **and** Node.
- `tmp/lorfish.js` — custom synchronous engine "LorFish" (`LorFish.getBestMove(chess, depth)`, ~1400–1800). Depends tightly on `chess.js`. **Blocks the main thread** during search — the original code papers over this with a `setTimeout` paint hack + a Web-Audio "scanner" sound.
- `tmp/ui.js` + `styles.css` + `index.html` + `assets/` — DOM board (CSS grid, click-to-move), promotion modal, captured pieces, PGN export, FEN load, sounds. The opponent is **hardwired** to LorFish.

There is no backend, DB, auth, or `package.json`. This design adds them while **reusing the UI and AI nearly verbatim**.

**Decisions (confirmed):** AI runs **client-side in a Web Worker**; DB is **SQLite (better-sqlite3)**; **full scope** (auth + AI + real-time PvP) delivered in milestones; **keep the vanilla UI**, adapt minimally.

## Tech stack

- **Express 5** — static UI + REST auth.
- **Socket.IO** — rooms, auto-reconnect, acks for real-time PvP (vs hand-rolling `ws`).
- **better-sqlite3** — single-file, synchronous, zero-ops. Schema written to port to Postgres later.
- **Raw SQL** via a thin prepared-statement module (only ~3 tables; no ORM).
- **express-session** + `better-sqlite3-session-store` — session cookie shared with the Socket.IO handshake (one auth mechanism for REST and WS).
- **argon2** for password hashing (fall back to `bcrypt`/`@node-rs/argon2` if the native build is troublesome in the devcontainer).
- **No bundler.** UI stays static vanilla JS.

## Directory structure

```
/workspaces/lorchess
├── package.json            # "type":"commonjs"; scripts below
├── .gitignore              # node_modules, data/*.sqlite, .env
├── data/lorchess.sqlite    # created at runtime
├── src/                    # server (Node)
│   ├── server.js           # express + http + socket.io wiring; shares session w/ sockets
│   ├── config.js           # env/constants (PORT, SESSION_SECRET, DB_PATH)
│   ├── db/{index.js, schema.sql, queries.js, reset.js}
│   ├── auth/{routes.js, middleware.js}      # register/login/logout/me, requireAuth
│   ├── game/{matchmaking.js, rooms.js, socket.js}
│   └── shared/{chess.js, lorfish.js}        # MOVED from tmp/, UMD-wrapped (single source of truth)
└── public/                 # static
    ├── login.html, lobby.html, game.html    # game.html ADAPTED from tmp/index.html
    ├── css/styles.css                        # MOVED from tmp/
    ├── js/{engineWorker.js, moveSource.js, net.js, ui.js}   # ui.js ADAPTED; others NEW
    └── assets/                               # MOVED from tmp/assets
```

**Single source of truth for engine code:** keep `chess.js`/`lorfish.js` only in `src/shared/`, UMD-wrap them (`if (typeof module!=='undefined'&&module.exports) module.exports={Chess,W,B}` at the bottom, keep top-level globals for browser/worker), and have Express serve `src/shared/*.js` at the `/js/...` route. Same file loads as a browser `<script>` global, a Web Worker `importScripts`, and a Node `require`.

## Authentication

- `POST /api/register {username,password}` — validate, check uniqueness, `argon2.hash`, insert, create session.
- `POST /api/login` — `argon2.verify`, `req.session.regenerate` (anti-fixation), store `req.session.userId`.
- `POST /api/logout` — `req.session.destroy`. `GET /api/me` — current user or 401.
- **REST protection:** `requireAuth` middleware. **Page protection:** lobby/game pages call `/api/me` on load and redirect to login on 401.
- **Socket auth (critical):** share the Express session middleware with Socket.IO; `io.use(...)` rejects handshakes without `socket.request.session.userId`. No separate token.

## Database schema (`src/db/schema.sql`, idempotent `IF NOT EXISTS`)

- **users**: `id, username UNIQUE, password_hash, rating DEFAULT 1200, created_at`.
- **games**: `id, white_id, black_id, mode('ai'|'pvp'), ai_color, ai_depth, status('active'|'finished'|'aborted'), result, termination, start_fen, current_fen, turn DEFAULT 'w', created_at, finished_at`.
- **moves**: `id, game_id, ply, san, uci, fen_after, by_user(NULL=AI), created_at, UNIQUE(game_id,ply)` + index on `(game_id,ply)`.

`current_fen` + `turn` make reconnection trivial; `moves` gives full PGN/history. Use a reserved "LorFish" system user row for the AI side so FKs/queries stay uniform.

## AI gameplay — client-side Web Worker

- `public/js/engineWorker.js`: `importScripts('/js/chess.js','/js/lorfish.js')`, receives `{fen, moves, depth}`, rebuilds `Chess` (loadFen + **replay moves** so `positionCounts`/threefold is correct, since `loadFen` resets it), calls `LorFish.getBestMove`, posts back `{from,to,promo}`.
- Main thread's old `makeEngineMove` becomes async: post to worker → await reply → apply move. **This removes the `setTimeout` paint hack and the missing `Scanner.mp3` dependency** (the freeze the hacks worked around no longer exists). Scanner can become a CSS-only animation or be dropped.
- AI games are still persisted server-side (games/moves rows); client is authoritative for its own solo game in v1.

## Real-time multiplayer

Server holds authoritative state. `src/game/rooms.js`: `Map<gameId,{chess:Chess, players:{w,b}, sockets, timers}>`.

- **Matchmaking** (`matchmaking.js`): `lobby:join`/`lobby:leave`/`lobby:list`. Quick-match FIFO queue → pair two waiters, randomize colors, create `games` row + room, emit `game:start {gameId,color,opponent}`, redirect both to `game.html?id=<gameId>`.
- **Rooms:** Socket.IO room `game:<id>`. On `game:join`, validate participant, send `game:state {fen,moves,yourColor,turn,status}`.
- **Authoritative `move:make {gameId,from,to,promo}`** (`socket.js`): (1) get room's server `Chess`; (2) **turn enforcement** — reject if `socket.userId`'s color ≠ `chess.turn`; (3) **legality** — match against `chess.legalMoves()`, reject if absent (never trust client); (4) `moveToSan` + `makeMove`; (5) persist move row + update `current_fen`/`turn`, set result/termination on game over; (6) broadcast `move:made {from,to,promo,san,fen,turn}`; (7) `game:over` if finished.
- **Disconnect/reconnect:** on disconnect, start a 30–60s grace timer, broadcast `opponent:disconnected`; keep state in rooms+DB. Reconnect cancels timer, resends `game:state`. Timer fires → forfeit (`termination='disconnect'`), `game:over`, free room. On server boot, v1 marks orphaned `active` games as `aborted` (document this; full rehydrate-by-replay is a later enhancement).

## Reusing the UI — the "move source" abstraction

The one real refactor. Introduce `public/js/moveSource.js` so the board talks to a source instead of calling LorFish/socket directly:

- `AiMoveSource` — `onLocalMove` posts position to the Web Worker; reply → `applyRemoteMove`. (Replaces `makeEngineMove`.)
- `RemoteMoveSource` (PvP) — `onLocalMove` emits `move:make`; listens for `move:made` → `applyRemoteMove`. `canHumanMoveNow` also checks it's my color/turn (server still enforces).
- `LocalMoveSource` (optional hot-seat).

**`ui.js` edits (surgical):** replace direct `LorFish` use + the auto-engine `setTimeout` with `moveSource.onLocalMove(...)`; add `applyRemoteMove(move)` (= the apply branch of old `makeEngineMove`: `moveToSan`→`makeMove`→sound→render), reused by AI and Remote; gate `onSquareClick` via `moveSource.canHumanMoveNow(chess.turn)`; color fixed by server in PvP (existing `flip` handles Black). Disable undo/load-FEN in PvP. **PGN/captured/promotion/sound code reused unchanged.** `game.html` selects the source via `?mode=ai` vs `?id=<gameId>`.

## Build / run

`package.json` scripts: `start: node src/server.js`, `dev: node --watch src/server.js`, `db:reset: node src/db/reset.js`. Use Node v24 `--watch` (no nodemon) and `--env-file=.env` (or `dotenv`). Deps: `express`, `socket.io`, `better-sqlite3`, `better-sqlite3-session-store`, `express-session`, `argon2`. No transpile/bundle.

## Milestones (delivery order)

1. **Skeleton + AI works.** package.json, Express serving `public/`, move tmp assets, UMD-wrap engine, AI in Web Worker behind `AiMoveSource`. Single-player works, no freeze, no login.
2. **DB + Auth.** schema/db module, argon2, sessions, register/login/logout/me, login page, gated pages.
3. **AI games persisted** per user (games/moves rows, reserved LorFish user).
4. **Socket.IO infra** with shared-session authenticated handshake.
5. **PvP core.** Matchmaking/lobby, rooms, `RemoteMoveSource`, authoritative `move:make` validation via server-side chess.js, broadcast, persistence, game-over.
6. **Robustness.** Disconnect grace + reconnect `game:state` resend; resign/abort; boot cleanup of orphaned games.
7. **Optional polish.** ELO updates, clocks/timeouts, spectators, live lobby.

## Trickiest parts

- **Blocking engine** → must run in a Web Worker (the original hacks exist because it blocks).
- **One engine, three runtimes** (browser global / worker `importScripts` / Node `require`) via the UMD wrapper + serving `src/shared` at `/js`.
- **Authoritative validation + repetition state** — replay `moves` to rebuild `positionCounts` (since `loadFen` resets it).
- **Decoupling the opponent** from the board via `MoveSource`.

## Verification

- **M1:** `npm run dev`, open `game.html?mode=ai`, play a full game vs AI — board never freezes, AI replies, checkmate/draw detected, PGN exports.
- **M2:** register → logout → login; `/api/me` gates pages; bad password rejected; session persists across reload.
- **M3:** AI game creates `games`/`moves` rows (inspect SQLite); moves recorded with correct SAN/FEN.
- **M5:** two browser sessions (two users) quick-match, get opposite colors, moves relay in real time; **illegal/out-of-turn `move:make` rejected by server** (test via crafted socket emit); checkmate ends both clients with correct result; rows persisted.
- **M6:** close one tab mid-game → opponent sees `opponent:disconnected`; reopen within grace → board restored via `game:state`; exceed grace → forfeit recorded.
