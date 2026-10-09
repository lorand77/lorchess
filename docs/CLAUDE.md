# LorChess

Chess web app: Node 24, Express 5, Socket.IO and better-sqlite3 on the server;
vanilla JS in the browser. No bundler, no framework, no build step.
The reasoning behind the architecture is in `docs/design.md`; running and
deploying is in `docs/setup.md`. Read `docs/design.md` before changing anything
under `src/game/`, `src/shared/` or `public/js/ui.js`.

## Commands

- `npm test` — whole suite, about 20 s. Run it before calling any change done.
- `npm run test:deep` — full perft and puzzle sets; slow. `TEST_LOG=1` shows
  the server's logs, which the tests silence by default.
- `npm run test:coverage` — the suite with Node's built-in coverage report;
  fails if lines, branches or functions drop below 98 / 91 / 97 %. Files no
  test loads (`src/server.js`, CLI scripts, `public/js/`) are not listed.
- `npm run dev` — http://localhost:3000 with `--watch`; loads `.env` if present.
  Every env-driven constant is declared in `src/config.js`.
- `npm run db:reset` deletes the local database and `npm run puzzles:import`
  downloads ~300 MB. Ask before running either.

## Layout

- `src/app.js` builds the app; `src/server.js` only listens. Tests boot
  `app.js` on a random port against a throwaway database, one per test file.
- `src/<area>/routes.js` — Express routers mounted at `/api/<area>` in `app.js`
  (auth is mounted at `/api` itself; the leaderboard router is `src/game/leaderboard.js`).
  `src/game/socket.js` owns every Socket.IO event, `src/game/rooms.js` the
  in-memory PvP state.
- `src/shared/` — engine and catalogues loaded by browser, Web Worker and Node
  alike; served at `/js/`. The only place LorFish and the rules live.
- `public/js/vendor/stockfish/` — vendored Stockfish 19 (WebAssembly), used by
  game review and the analysis board. Third-party files: replace them, never edit them.
- `public/*.html` pages with their scripts in `public/js/`; `ui.js` is the game page.
- `test/unit`, `test/integration` — `node --test`.
- `scripts/` — ops scripts (backups, the puzzle fixture). `tools/lorfish/` —
  LorFish's rating harness (`levels.js`, `eloFit.js`, the opening set), run by
  hand and never loaded by the app.
- `experiments/<yyyy-mm>-<topic>/` — one folder per experiment: the plans, every
  raw result and a `README.md` report. A record of what was run: add a new
  folder for a rerun rather than editing an old one.

## Conventions

- No new dependencies. Node built-ins first; if a package seems necessary, ask.
- CommonJS, `"use strict"`, double quotes, semicolons. Match the file you are in.
- Raw SQL prepared statements in `src/db/queries.js`; no ORM, no query builder.
- Every module opens with a comment saying what it does and why. Keep that up.
- Never trust the client. Legality, turn, clocks, time control, variant,
  handicap and the premove flag are decided or re-checked on the server.
- Commit subjects are short and imperative; a `feat:`/`fix:` prefix is optional.
- When a design decision changes, update `docs/design.md` in the same commit.
- Server code logs through `src/log.js` with a fixed event name and fields
  (`log.info("game.over", { game, result })`), never `console.*`. The events,
  and what must never be logged, are under "Logging" in `docs/design.md`.
  What the logs hold is stated in `public/privacy.html`: keep it true.

## Gotchas

- `schema.sql` only CREATEs. A new column on an existing table also needs an
  `addColumnIfMissing` line in `src/db/index.js`, or old databases never get it.
- Test files must `require("../helpers/server")` before anything that loads
  `src/db/index.js` (pure modules such as `src/shared/*` are fine without it);
  the database path is fixed when `src/db/index.js` loads.
- `src/shared/*.js` runs in three runtimes: keep the UMD tail at the bottom and
  use no Node-only or DOM-only APIs.
- Time controls, variants and achievements are allowlists in `src/shared/`.
  Add entries there, not in ad-hoc lists elsewhere.
- Native modules need a rebuild after `npm install` because `ignore-scripts` is
  on globally: see "run the app" in `docs/setup.md`.
