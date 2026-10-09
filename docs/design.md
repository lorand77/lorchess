# LorChess — Design Notes

What the code does and, more importantly, why. This describes the **current
state**, not a plan: when a decision changes, change it here in the same
commit. How to run and deploy is in `setup.md`; conventions for working in the
repo are in `docs/CLAUDE.md`.

LorChess is a chess web app. Signed-in users play **LorFish** (the built-in
engine) or **each other in real time**, with server-side clocks and Elo, in
standard chess, Chess960, Atomic or Pawn Wars. Around the games: puzzles,
an analysis board, achievements, friends, a leaderboard, spectating, in-game
chat and a promo-code membership. Node.js + SQLite on the server, vanilla JS
in the browser, no build step.

## Tech stack

- **Express 5** — static pages + REST API.
- **Socket.IO** — rooms, auto-reconnect, acks for real-time PvP (vs hand-rolling `ws`).
- **better-sqlite3** — single-file, synchronous, zero-ops. Schema written to port to Postgres later.
- **Raw SQL** via prepared statements in `src/db/queries.js`; no ORM.
- **express-session** + `better-sqlite3-session-store` — one session cookie serves REST and the Socket.IO handshake.
- **argon2** for password hashing.
- **Stockfish 19 (WebAssembly)**, vendored in `public/js/vendor/stockfish/`, for game review and the analysis board; it runs in the browser.
- **No bundler, no framework.** Static HTML pages with their scripts in `public/js/`.

## Engine: one file, three runtimes

`src/shared/chess.js` is a framework-agnostic `Chess` class: move generation,
legality, FEN, SAN, draw/mate detection, Chess960 castling from arbitrary
squares, and the Atomic and Pawn Wars rule sets. `src/shared/lorfish.js` is
**LorFish**, a synchronous search engine ported from a sunfish-derived Python
original (roughly 1400–1800 strength). It depends tightly on `chess.js`.

Weaker play comes from choosing, not from a broken search. The root already
scores every move exactly, so a `temperature` option picks among them at random,
weighted by exp(−loss / T): small slips are common, dropped pieces rare, and a
mate the search sees is never passed up. Depth sets what the bot can see at all;
at depth 1 it never notices an opponent's quiet threat, the classic beginner
miss. `tools/lorfish/levels.js` plays settings against each other (`match`),
breaks down the mistakes each one makes (`profile`), and rates the levels
(`tournament`, then `fit`). The settings were chosen with small `match` runs;
the ratings come from one larger run.

Every rated game is a LorFish level against the vendored Stockfish, never two
LorFish settings or two Stockfish settings: players that share one evaluation
exaggerate the gaps between them (self-play, taking depth 2 as 1400, first
spread the levels far wider than Stockfish does). `sf<elo>` is Stockfish with
`UCI_LimitStrength` at that `UCI_Elo`, pinned at its label. Stockfish goes no
lower than 1320, so below it `sf1320r<pct>` plays a random legal move pct% of
the time: stepping stones with no rating of their own, linking a chain sf1320 –
Casual – r10 – Beginner – r35 – Novice. Games start from openings by a hot
depth-1 bot that full-strength Stockfish scores within ±50 cp
(`tools/lorfish/openings.txt`), each played twice with colours swapped, the
same ones for every pairing. `tools/lorfish/eloFit.js` fits every rating at
once by maximum likelihood, with intervals from resampling the openings. The
full report, the plans and every game are in
[`experiments/2026-10-ai-ratings/`](../experiments/2026-10-ai-ratings/README.md).

The run (Oct 2026, 7,740 games, Stockfish 100 ms a move) gave, with 95%
intervals: Novice 383 (338–428), Beginner 822 (785–858), Casual 1323
(1305–1343), Intermediate 1626 (1592–1662) and Advanced 1971 (1919–2026):
each 80–170 above what earlier runs of 20 games a level gave. The playing levels in
`src/shared/aiLevels.js` carry these rounded to 100s: Novice (~400, depth 1 at
T=300), Beginner (~800, depth 1 at T=120), Casual (~1300, depth 1 at T=10),
Intermediate (~1600, depth 2) and Advanced (~2000, depth 4). The ratings are
on Stockfish's engine scale rather than a human one, and the lite build
probably plays below its `UCI_Elo`, which would make them read high. The
intervals grow down the chain, and they leave out how far Stockfish's own
labels are off. Games still going at 300 plies count as draws; 104 did, 67 of
them Novice's, and dropping them puts Novice at 364 and moves no other level
more than 4.

Dead-material detection follows the variant: in Atomic, opposing bishops on
the same square colour can explode a king and must not trigger the standard
bishop-ending draw. The Atomic material cases follow the
[python-chess variant reference](https://python-chess.readthedocs.io/en/latest/_modules/chess/variant.html#AtomicBoard.has_insufficient_material).

Repetition keys include en passant only when a legal capture exists. An
uncapturable FEN target, including one blocked by a pin, does not distinguish
otherwise identical positions; FEN output still preserves the original target.

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
drifted (see the header of `variants.js`). They also carry what varies per
entry — a variant's start position (`startOf`) and a clock's speed class
(`speedOf`) — so matchmaking and the format badges read the catalogue instead
of keeping lists of their own that would drift the same way.

## Authentication

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`.
  Register and login both go through `startSession`, which calls
  `req.session.regenerate` first (anti-fixation) and then stores `userId`.
- **REST protection:** `requireAuth` middleware. **Page protection:**
  `public/js/authGuard.js` calls `/api/me` on load and bounces to login on 401.
  That is a UX redirect, not a security boundary; every privileged action is
  enforced server-side.
- **Socket auth:** the same session middleware is attached to the Socket.IO
  engine (`io.engine.use`). The session is reloaded from SQLite at the socket
  handshake and before every incoming event; missing or expired sessions
  cannot act, and established sockets are disconnected on validation failure.
  These checks do not refresh or recreate a session. No separate token.
  Sockets also join a room per session ID: logout and session regeneration
  disconnect every tab using the old session before returning success, running
  the usual presence and game-disconnect cleanup. Separate logins on the same
  account remain connected.
- Cookie: `httpOnly`, `sameSite: lax`, `secure: "auto"` behind `trust proxy`
  (Caddy terminates TLS), 7 days. Sessions are rows in SQLite.
- Usernames that differ only in case are one name: registration refuses the
  second, and a `COLLATE NOCASE` unique index backs that check where the
  database allows it (an old database with such pairs boots with a warning).
  Login matches the exact spelling.
- **Username policy** (`src/auth/usernamePolicy.js`): beyond 3–20 of
  `[A-Za-z0-9_]`, registration refuses names containing "lor" anywhere (the
  site's prefix; this knowingly costs Taylor and Lord), names that pass for
  staff or for a UI label (admin, mod, bot, guest, White…), and English slurs
  and profanity. Names are compared lowercased, without underscores, with
  digits read as letters and stretched letters squeezed; short words only
  count as a whole part of the name (split on `_` and camelCase), so classic
  and Essex pass. Runs of three or more digits are numbers, not letters
  (Ryan1995). Every refusal gets one generic message so the lists cannot be
  probed, and the lists never reach the browser. Existing accounts are not
  re-checked.
- **Deactivation** (`users.deactivated_at`, set by `npm run user:deactivate`):
  a flag, not a deletion, so game history keeps its names, the name stays
  taken, and reactivation restores everything. It is not `password_hash NULL`,
  which already means "the AI account". Login refuses it after the password
  check (so the message leaks nothing to someone without the password);
  `requireAuth` and the socket session check refuse it too, because a login
  racing the command can create a session after the command deleted them.
  The command runs in its own process and cannot reach live sockets, so the
  server sweeps them every `DEACTIVATION_SWEEP_MS`; the normal disconnect path
  then clears seeks and challenges and forfeits a live game after the grace.
  Leaderboard, friends lists and friend requests filter deactivated users in
  SQL; profiles use `getActiveUserById` and 404. `getUserById` itself is left
  unfiltered: `/api/me`, the lobby and achievements read it for the user
  themselves.
- **Deletion** (`npm run user:delete`, `src/db/deleteUser.js`) is built on
  deactivation. The `users` row cannot go, because PvP games, moves and the
  opponents' rating history point at it. So it stays, renamed `deleted-<id>`
  (a name registration can never produce), stripped of password, preferences
  and membership, and deactivated. Everything that is only the user's is
  deleted in one transaction, games against LorFish included; used promo codes
  keep `redeemed_by`, or they would become valid again. The old name is free
  to register again. The command refuses while a PvP game is live, shows
  counts, and wants the username typed back. It turns on `secure_delete` and
  checkpoints the WAL afterwards, so the content does not linger in the file.
- **Throttling** (`src/auth/throttle.js`): argon2 is expensive on purpose, so
  register and login are limited. Per client IP, failed logins (unknown users
  included) and registrations that reach the hash are counted over a sliding
  window and answered with 429 past the limit; successful logins and rejected
  registrations do not count. A global cap on argon2 calls in flight (one per
  vCPU) answers 503 instead of queueing, which holds even against many IPs.
  The client IP is `req.ip`, i.e. what Caddy put in `X-Forwarded-For`; that is
  only trustworthy because port 3000 is not reachable except through Caddy.
  State is in memory and a restart clears it. No per-account limit: it would
  let anyone lock a player out by typing their name. Passwords are 6–128
  characters; a longer one fails login without being verified.

## Terms and privacy

`public/terms.html` and `public/privacy.html` are plain static pages without
`shell.js` or `authGuard.js`, because people must be able to read them before
they have an account; `test/integration/static.legal.test.js` keeps them public.
They are linked from the login card ("By registering you agree to …") and from
the bottom of the nav rail. Acceptance is implied by registering and is not
recorded. A checkbox plus a `terms_version` column would be the next step, if
the terms ever need to be enforced against someone.

The privacy policy states facts that the code and operations decide. If one of
these changes, update the page and its date in the same commit:
chat is swept after `CHAT_RETENTION_DAYS` (30); sessions last 7 days
(`src/auth/session.js`); IPs live in the throttle's memory for
`AUTH_WINDOW_MS` (15 min) and are written only on the `auth.*` log lines;
what the logs hold and their 14-day lifetime (see Logging); Caddy keeps no
access log; uploaded images and colours are served only to their owner;
nothing is visible when signed out; there is no analytics; backups go to
Backblaze B2 and are kept for at most 90 days (`scripts/backup.sh` deletes
them after 30).

## Logging

The server runs unattended, and by the time someone reports "my game vanished
last night" the process that knew why has moved on or restarted. The log is
the only record, so it is written for that reader: someone on the server with
`less` and `grep`, days later, reconstructing what happened.

- **One module, `src/log.js`, no dependency.** Server code logs through it and
  never calls `console.*` directly. The CLI scripts in `src/db/` and
  `scripts/` are exempt: their `console.log` is a tool talking to the person
  running it, not a log.
- **Format: logfmt, one line per event, all to stdout.**
  ```
  2026-10-09T21:14:03.120Z INFO  game.over game=318 result=0-1 termination=resign
  2026-10-09T21:14:05.004Z ERROR socket.handler_failed user=7 name=bob event=move err="TypeError: Cannot read properties of undefined"
      at applyMove (src/game/socket.js:412:9)
  ```
  Time (UTC, ISO), level, event name, then `key=value` fields; values with
  spaces, quotes, `=` or anything outside printable ASCII are JSON-quoted, so
  no value can break the line or fake a field. An error is written as
  `name: message`, its stack frames on indented lines below. Every level goes to stdout so pm2's `lorchess-out.log` holds the whole
  story in order; `lorchess-error.log` then only gets what bypasses the logger
  (Node's own crash output, native-module warnings), so anything there is
  worth a look. The logger stamps the time itself; pm2's `--time` stays off.
- **Levels.** `error`: something failed and someone should look. `warn`:
  unexpected or slow, but served. `info`: a normal event worth a record.
  `debug`: detail for an investigation. `LOG_LEVEL` (`src/config.js`) defaults
  to `info`; an unknown value logs `log.bad_level` and uses `info`. The tests
  run `silent`, `TEST_LOG=1` makes them `debug`, and `captureLogs()` in
  `test/helpers/logs.js` lets a test assert that a line was written.
- **Event names are fixed, `area.event`** in snake_case, so a search for one
  finds all of it and this list is the full set. Fields are flat and
  lower-case; IDs are numbers (`game=318`, `user=12`).
- **Context is explicit.** `log.child(fields)` returns a logger that adds
  those fields to every line. Each `/api` request gets an 8-hex `req` id and
  `req.log` (with `req`, `user`, `name`); each socket gets `socket.log` (with
  `user`, `name`). Handlers log through those, so an error line and its
  request line share a `req`.

Events:

- **Process** (`src/server.js`): `process.start` (version, node, url, db
  path), `process.resumable` (games left by the previous run, reconnect
  window), `process.stop` (signal; on SIGTERM/SIGINT the process exits at
  once, which is safe because every move is already in SQLite and games
  resume on the next start), `process.crash` (`error`, on
  `uncaughtException`/`unhandledRejection`; the process then exits 1 and pm2
  restarts it).
- **HTTP:** `http.request` once per `/api` request when the response
  finishes: `method`, `route` (the matched pattern, e.g. `/api/games/:id`,
  never the query string), `status`, `ms`, and `user`/`name` when signed in.
  `error` for 5xx, `warn` at 1 s or slower, `info` otherwise. 4xx stays
  `info`: a signed-out page load gets a 401 from `/api/me` every time. Static
  files are not logged.
- **Auth** (the only lines with `ip`): `auth.register`, `auth.login`,
  `auth.login_failed`, `auth.throttled` (`warn`, with `kind=login|register`),
  `auth.busy` (`warn`, the argon2 cap), `auth.logout`. A failed login carries
  `user`/`name` only if the name matches an account, otherwise
  `unknown_user=true`: the typed string is never logged, because people
  sometimes type their password into the username field.
- **Sockets:** `socket.connect`, `socket.disconnect` (`reason`),
  `socket.handler_failed` and `socket.task_failed` (`error`; the per-event
  wrapper and `safely`). No line per move or chat message.
- **Games:** `game.start` (`white`/`white_name`, `black`/`black_name`, time
  control, `rated`, variant), `game.over` (`result`, `termination`),
  `game.rematch`, `game.restart_sweep` (`aborted` count),
  `game.corrupt_record` (`error`: ply, move, FEN).
- **Background and data:** `db.migrated`, `db.case_duplicates` (`warn`),
  `chat.retention` (`removed`, or `error` when the sweep fails),
  `achievements.check_failed` (`error`: check, game, user),
  `lobby.broadcast_failed` (`error`).

What is never logged, and where personal data may appear:

- **Users** appear as `user=<id> name=<username>`, always together: the name
  for reading, the id because a deleted account's name can be registered again.
- **IPs** appear only on the `auth.*` lines above, for dealing with password
  guessing and mass sign-ups. Never on requests, sockets or games.
- **Never:** passwords or hashes, session ids, cookies, request bodies, query
  strings, chat text, uploaded content. As a safety net the logger writes
  `[redacted]` for any field whose name has one of the words `password`,
  `hash`, `secret`, `token`, `session`, `sid`, `cookie` or `authorization`
  (`password_hash`, `sessionID`); the rule is not to pass them.
- **Lifetime:** pm2 writes the files and `pm2-logrotate` keeps 14 daily files
  (`setup.md`), so a line lives at most 14 days. Logs are not in the backups:
  `scripts/backup.sh` copies only the database. `public/privacy.html` says
  all of this; change it with anything in this list.

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
  `clock_started` records that both players once took their seats, so a
  rebuilt room still knows that a player who never came cannot be forfeited.
- **The AI side is a real user.** A reserved `LorFish` account
  (`config.AI_USERNAME`, `password_hash NULL` so it can never log in) owns the
  AI side of games, so foreign keys and queries stay uniform.
- **Chat is temporary.** Messages exist so two players can talk during a game
  and arrange a rematch afterwards. `src/db/retention.js` sweeps them
  `CHAT_RETENTION_DAYS` after the game ends (−1 keeps everything); only the
  per-user tally survives, for the "Chatty" achievement.
- **Puzzles can be re-imported.** `npm run puzzles:import -- --wipe` clears
  only puzzles nothing refers to; rows behind attempts, skips, daily picks or
  badges stay and are refreshed in place.
- **Only a solved daily extends the streak.** It once counted any finished
  attempt, so giving up without a move kept a streak going. Failing today's
  daily ends the streak at once: `/daily` reports 0 instead of a number that
  would be gone tomorrow. A solve however it was first made counts: viewing
  today's puzzle credits the streak if a solved attempt exists (idempotent per
  day). Retries never move the rating or the streak. Streaks built under the
  old rule were left as they were.
- **A daily allows five tries** (`DAILY_TRIES`), to make solve-only fair. A
  wrong move answers `miss` with the tries left and reveals nothing, and the
  page takes the move back so the player goes on from there; the fifth fails
  the attempt. The server counts them in `puzzle_misses`, or a reload would
  hand out fresh ones, and moves the count to `puzzle_attempts.misses` when
  the attempt is recorded. Tries apply to the first attempt at any puzzle that
  has been a daily; rated puzzles and retries still end at the first wrong
  move, since a rated puzzle's rating is about getting it right first time.
  Giving up ends the attempt whatever is left, after a confirmation on the
  daily page.
- **Daily puzzles are unrated,** today's and any earlier day's: everyone gets
  the same board and the solution gets around. The first attempt is still
  recorded (`puzzle_attempts.rated = 0`, rating unchanged) so "done", the
  streak and the puzzle badges work; the K factor and the rating chart skip it.
  The rated stream never hands out a daily, and lets go of a held puzzle that
  has since been picked as one. "Ever a daily" rather than "today's" also
  keeps a daily finished just after midnight UTC unrated.
- **Themes are a hint, shown before solving.** `publicView` carries a puzzle's
  Lichess themes and the page lists them under the task line; only the
  solution stays on the server until the attempt is over.
  The rated trainer updates its puzzle ID in the URL on Next and Skip, so a
  refresh returns to the displayed puzzle without turning it into an old retry.

## AI games: client-side Web Worker

LorFish's search is synchronous and blocks whatever thread runs it. It runs in
`public/js/engineWorker.js`, so the page never freezes. (The original UI hid the
freeze behind a `setTimeout` paint hack and a "scanner" sound; neither is
needed.) The worker `importScripts` the engine, receives
`{ id, startFen, moves, depth, temperature }` and **replays the moves** instead of loading the
current FEN, because `loadFen` and `reset` wipe `positionCounts` and threefold
repetition would be wrong.

The browser is authoritative for its own AI game. `public/js/gameStore.js`
mirrors it to the server (`POST /api/games`, `/:id/moves`, `/:id/end`,
`/:id/truncate` for undo) best-effort and in order, so history, stats and
achievements see it; nothing about play waits on the server. This is also why
AI games from a pasted FEN earn no game-feat achievements (see below). Because
those routes take the client's word, they accept **active AI games only**: a
PvP record is written by the socket layer alone, and a finished game of either
kind is closed to them. The `termination` they store is an allowlist, since it
is shown in the game history. Starting another game abandons the one on the
board (`/:id/abandon`): a game nobody moved in is deleted, one with moves is
aborted, so nothing sits "in progress" for ever.
Once an AI game is created, the page replaces its URL with `?id=<gameId>` so
refresh resumes that board. New Game and Load FEN replace the bookmark too; a
late response for an earlier board cannot overwrite it.
The board, PGN and move source reset synchronously before persistence resolves.
Moves played while creation is pending queue against that game, and completion
only updates the bookmark; it never resets a board that has already advanced.
The AI level and the player's colour are fixed per game, and chosen before it:
the lobby's LorFish panel is a plain GET form to
`game.html?mode=ai&level=<key>&color=w|b`. The game page only shows them; New
Game and Load FEN keep both, and changing either means going back to the lobby.
The lobby's level picker starts at the level of the user's newest AI game,
found in the game list it already fetches for "Resume", so it needs no stored
preference and follows the user between devices. Missing or unknown values play
White at the default level. Until a new game has an id, its URL carries the
level and colour, so a refresh in that window sets up the same game again.
Worker requests use the game's captured level, which is also saved for
resume and strength-dependent achievements. The levels are an allowlist in
`src/shared/aiLevels.js`: the lobby's picker is built from it, and `POST /api/games`
resolves the client's key against it and stores the depth that level searches,
never a depth the client sent. Games from before levels stored only a depth;
the migration gives depth 2 and 4 their levels, and a request carrying a bare
depth (a page loaded before the change) is read the same way. Only
Intermediate and Advanced count for the beat-LorFish achievements: the weaker
two would make them free.
Load FEN validates a scratch board before changing the current game. Already
finished positions (mate, stalemate or a rule draw) are rejected in both the UI
and creation API, so they cannot leave an unplayable game marked active.

## Game review: Stockfish in the browser

LorFish plays, but it is far too weak (about 2000 at its strongest) to judge a game.
Review uses **Stockfish 19**, the "lite single-threaded" WebAssembly build
from the `stockfish` npm package (nmrugg/stockfish.js), vendored as two files
under `public/js/vendor/stockfish/` rather than added as a dependency. It runs
in the member's browser, so reviews cost the server nothing.

- **Why that build.** About 1.8 MB (1.2 MB gzipped) with its small NNUE net
  built into the `.wasm`. The full-net builds are ~100 MB. The multi-threaded
  builds need `SharedArrayBuffer`, which means COOP/COEP cross-origin isolation
  on the page; the single-threaded one needs neither.
- **Loaded on first use.** `gameReview.js` starts the worker when a review
  starts, not with the page, so replays that are only looked through download
  nothing. The browser caches it afterwards. Express already serves `.wasm` as
  `application/wasm`, which lets the browser compile it as it downloads.
- **Driven over UCI** by `gameReview.js`, one position at a time:
  `position startpos|fen <start> moves …` then `go movetime 300`; there is one
  setting, not a choice of depths. The start position plus the moves, never the
  current FEN, so Stockfish sees the repetition history. `UCI_Chess960` is
  always on because game records spell castling by the rook square (`e1h1`),
  standard games included; it is the mode in which Stockfish reads and writes
  that. Bound (`lowerbound`/`upperbound`) info lines are ignored: a search cut
  off by time often ends on one, and it is only provisional.
- **The page's own `Chess` replays alongside**: it knows whose turn it is,
  turns the engine's best move into SAN, and decides when the game is already
  over. Finished positions are scored without asking Stockfish: draws (rule
  draws included) score zero, checkmate a loss for the side to move. A missing
  evaluation is left ungraded, so missing data cannot disguise a stalemate
  blunder as a good move.
- **Verdicts follow Lichess.** A move is judged by the expected score it gives
  away (win% from centipawns, clamped at ±1000): 5, 10, 15 points make an
  inaccuracy, mistake, blunder. Forced mates are judged first, on their own:
  walking into one, or letting one's own slip, is a blunder unless the
  position was already lost (or still won) by 7 or 10 pawns, which makes it
  a mistake or an inaccuracy. Clamped, a mate would barely move the expected
  score from an already bad position. The centipawn loss is still shown. UCI mate
  scores are converted to LorFish's encoding (100000 minus plies) so one
  formatter serves both. A mate's search depth is dropped: Stockfish runs
  straight to depth 245 once it sees one.
- **The eval bar** beside the replay board shows White's expected score in
  the position on screen, on the same win% curve the verdicts use, so it
  moves as far as the winning chances do rather than with raw centipawns. A
  forced mate fills it. It is shown, empty, on every game that could be
  reviewed, so the board does not jump when a review lands. It sits right of
  the board with the number above it, and takes its 18 px out of the board's
  width instead of widening the page, so the replay still fits wherever the
  board alone did.
- **Membership is a UI gate only**, as before: the engine files are public
  static assets, so this is a "please don't", not a "cannot".
- The tests drive the real engine too: `stockfish-19-lite-single.js` also runs
  under Node, reading UCI on stdin, so `test/unit/gameReview.test.js` reviews
  short games against it in a child process.

Only Standard and Chess960 are reviewable (`reviewable` in `variants.js`);
Stockfish does not know the Atomic or Pawn Wars rules.

## Analysis board

`analysis.html` is a free board: either side moves, nothing is saved, and the
server is never asked about a move. The page's own `Chess` decides legality,
and Stockfish evaluates whatever position is on the board. The bar, the number
above it and the score formatting are the replay's.

- **Open to everyone**, unlike game review. It is the same engine, but a board
  you set up by hand is not a review of your games, and a free analysis board
  is what players expect from a chess site.
- **One line, not a tree.** Stepping back and playing a different move
  replaces the moves after it; playing the move that was already next keeps
  them. Variations would need a move tree and a way to show it, and nobody has
  asked for them yet.
- **The URL is the state**: `?fen=<start>&moves=e2e4,e7e5`, castling spelled
  by the rook square as in game records. A refresh or a shared link reopens the
  same board, and another page can link into it.
- **Live search** (`public/js/liveEval.js`) uses the review's engine settings
  and parsing but searches one position until it changes. UCI makes the change
  the tricky part: after `stop` the engine still sends the old search's last
  info lines and exactly one `bestmove`, and until that arrives every line
  belongs to the old position. So nothing is reported meanwhile, the next
  search waits for that `bestmove`, and positions asked for in between replace
  one another. Each search stops at depth 22 or after 15 s, so a page left open
  does not keep a core busy. Finished positions are scored without asking
  Stockfish, as in the review.
- Standard rules only. A Chess960 FEN loads; Atomic and Pawn Wars positions
  would get standard-chess answers, so there is no variant picker.
- **A Practice tab** (`#practice`, beside `#analysis`) is the same board with
  the engine off and the bar hidden: both sides are played by hand, the board
  turns to face the side to move, and Undo takes the last move back rather
  than stepping through the line. Each tab keeps its own game, so practising
  never disturbs an analysis. The URL stays the analysis board's; the practice
  moves are kept in `sessionStorage`, enough to survive a refresh.

## Real-time PvP

The server holds the authoritative state. `src/game/rooms.js` keeps one
in-memory room per live PvP game: the server-side `Chess`, both players, their
sockets, clocks and timers.

- **Finding a game.** Two paths, both purely in-memory because an offer means
  nothing once a socket closes. Quick-match (`matchmaking.js`) keeps FIFO
  queues per time control, rated flag and variant, so a bullet seeker is never
  handed a classical game. The live lobby (`lobby.js`) has open **seeks**
  anyone may take and **challenges** addressed to one user. Either path creates
  the `games` row and the room and emits `game:start`; clients navigate to
  `game.html?id=<gameId>`. Handicap positions arrive as a sparse map of changes
  to the starting squares, never a FEN; the server rebuilds the position.
  **One game at a time:** a player in a live PvP game (`rooms.liveGameOf`, read
  from the database so a game awaiting resumption counts) may neither offer,
  accept nor quick-match, and the moment a match starts both players' other
  offers are withdrawn (`matchmaking.onMatchStarted`). Without that, a stale
  challenge accepted mid-game would drag its owner's page to the new game and
  forfeit the one they were playing. A **rematch** swaps the colours and keeps
  the terms: an odds game's handicap is mirrored (`handicap.mirror`) so the
  same player keeps giving the odds, while Chess960 draws a fresh position.
- **`move:make`** (`handleMove` in `socket.js`): confirm the sender is a
  player in an active room who has taken their seat (sent `game:join` at least
  once — judged per player, not per socket, so a move a reconnecting client
  buffered is still good, while a player who never joined has no seat and the
  clock would never start against them) →
  **turn enforcement** → **legality** against the
  server's own `findMove` (never trust the client) → charge the mover's clock,
  and flag if it ran out → apply → persist move, position and clocks in one
  transaction → broadcast `move:made` to the room (mover included; everyone
  applies on confirmation) → `game:over`, or re-arm the flag timer for the
  other side. If the write fails, the room is rolled back to the position and
  clock it had and the mover's ack fails. Every socket handler, timer callback
  and the connection setup run under a try/catch for the same reason: Socket.IO has none of its own, and
  better-sqlite3 throws synchronously, so an unguarded error would take the
  process, and every live game, down with it.
- **Clocks and rating.** Clocks are server-side; clients render snapshots.
  A flag loses unless the other side could not have mated by any series of
  legal moves, even with the flagging side's help (FIDE 6.9 as Lichess reads
  it, `Chess.hasMatingMaterial`: a bare king never; a lone knight only if the
  opponent still has a rook, bishop, knight or pawn; bishops all on one colour
  only if the opponent has a knight, a pawn or a bishop on the other colour —
  a queen, or a rook against a bishop, can always take or interpose), in which
  case it is a draw. Elo (`elo.js`, K from `config.ELO_K`)
  moves after rated games, and every update writes `rating_history`.
- **Disconnects.** When a player's last socket drops, a forfeit timer starts
  (`config.DISCONNECT_GRACE_MS`, env `GRACE_MS`, default 45 s) and the opponent
  sees `opponent:disconnected`. Rejoining cancels it and `game:join` hands back
  the full state. Expiry forfeits (`termination = 'disconnect'`), or aborts if no
  move was ever played. Resigning before the first move is an abort as well,
  never a rated loss. The same timer is armed against both players the moment a
  match is created (a second `matchmaking.onMatchStarted` hook), so a game
  nobody turns up for aborts instead of sitting `active` — which, with one game
  at a time, would lock both players out. A player who never took their seat
  cannot lose one either, however many moves the other side made while waiting.
  For the same reason a record that will not replay is aborted
  (`termination = 'corrupt-record'`) rather than left blocking its players.
- **Restarts.** Nothing is thrown away at boot. A PvP game left `active` is
  rebuilt from the DB the moment a participant connects (`loadRoomFromDb`).
  A join checks the stored participants before rebuilding anything, so a
  rejected outsider cannot keep an unresumed game out of the restart sweep.
  A finished game never keeps a room: rejoining one (a reload on the result
  screen) answers with its final state and drops the rebuilt room at once,
  since nothing else ever drops a live room.
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
The AI source also reports a failed search through `env.onEngineError`; the
page shows the reason with a Retry that calls `kickIfEngineTurn()`.
Three implementations:

- `createAiMoveSource` — posts the position to the engine worker and applies
  the reply, no sooner than 1 s after the request: shallow levels answer in
  milliseconds, which reads as a glitch. A slower search is not delayed further.
  The page shows LorFish thinking until the move lands, and `cancel()` drops a
  held move along with the request.
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

**Drawings on the board** (`public/js/boardArrows.js`) work like Lichess:
right-drag for an arrow, right-click for a circle, and Shift/Ctrl, Alt or both
for red, blue or yellow. They are on the game, replay and puzzle boards. They
are scratch notes that stay in the page: the server never sees them, so an
opponent cannot either. Every page re-renders its board with `innerHTML = ''`,
so the SVG overlay cannot just sit inside it. A `MutationObserver` re-appends
it after each render, and that is also where a change in piece placement is
noticed and the drawings are cleared. A left click on the board clears them
too. Shapes are stored as square numbers and placed by measuring the squares,
so flipping needs nothing extra. The only requirement on a host board is the
one `boardDrag.js` already has: `.square[data-sq]`.

## Trickiest parts

- **Blocking engine** → must run in a Web Worker; the old paint hacks existed only because it blocks.
- **One engine, three runtimes** via the UMD tail + serving `src/shared` at `/js`.
- **Authoritative validation + repetition state** — worker, server and the PvP client (on every `game:join`, from the `moves` in the state) rebuild positions by replaying moves, because `loadFen` resets `positionCounts` and a plain FEN cannot always say which rook a Chess960 castling right refers to.
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
- **Stats** are aggregate queries (games, wins per time control and per
  variant, castles, puzzle streaks, rating, chat count, anniversary)
  re-evaluated after every game, puzzle, chat message, login and visit to the
  page. Every variant but Standard has a `<key>_wins` badge, and "Jack of All
  Trades" wants a win in each one; a win against LorFish counts for Standard,
  the only variant AI games are played in.
- Awarding is an upsert that only writes when the tier goes up, so every
  evaluation is idempotent; `npm run achievements:backfill` replays history.

Storage: `user_achievements` (one row per user per key, highest tier, the game
or puzzle that earned it) and `rating_history` (written with every Elo update,
for "rating before this game" and the rollercoaster badge). `moves.think_ms`
records server-measured think time on PvP moves.

Hooks: `concludeGame` (PvP, pushes `achievements:earned` to each player's
sockets), `POST /api/games/:id/end` (AI, returned in the reply), the puzzle
`finish` helper (returned in the reply), `chat:send`, login, and a visit to
anyone's Achievements tab (the viewed user's time-based badges are evaluated
too, so a public tab is never behind its owner's). The UI shows
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
Premoves use the same legal-move resolver as ordinary moves, including
king-to-rook castling gestures in standard chess and Chess960.

A premoved move is flagged on its way to the server (`premove` in the socket
payload / AI move POST) and stored in `moves.premove`. PvP believes the flag
only when the server-measured think time is under `PREMOVE_MAX_MS`, so a
crafted payload can't claim a premove it had time to consider. The
"Clairvoyant" achievement reads it: win with every move after your first
premoved.
