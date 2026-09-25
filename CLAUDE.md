# LorChess

Chess web app: Node 24, Express 5, Socket.IO and better-sqlite3 on the server;
vanilla JS in the browser. No bundler, no framework, no build step.
The reasoning behind the architecture is in `design.md`; running and deploying
is in `setup.md`. Read `design.md` before changing anything under `src/game/`,
`src/shared/` or `public/js/ui.js`.

## Commands

- `npm test` — whole suite, about 20 s. Run it before calling any change done.
- `npm run test:deep` — full perft and puzzle sets; slow. `TEST_LOG=1` shows
  the server's logs, which the tests silence by default.
- `npm run dev` — http://localhost:3000 with `--watch`; loads `.env` if present.
  Every env-driven constant is declared in `src/config.js`.
- `npm run db:reset` deletes the local database and `npm run puzzles:import`
  downloads ~300 MB. Ask before running either.

## Layout

- `src/app.js` builds the app; `src/server.js` only listens. Tests boot
  `app.js` on a random port against a throwaway database, one per test file.
- `src/<area>/routes.js` — Express routers mounted at `/api/<area>` in `app.js`.
  `src/game/socket.js` owns every Socket.IO event, `src/game/rooms.js` the
  in-memory PvP state.
- `src/shared/` — engine and catalogues loaded by browser, Web Worker and Node
  alike; served at `/js/`. The only place engine code lives.
- `public/*.html` pages with their scripts in `public/js/`; `ui.js` is the game page.
- `test/unit`, `test/integration` — `node --test`.

## Conventions

- No new dependencies. Node built-ins first; if a package seems necessary, ask.
- CommonJS, `"use strict"`, double quotes, semicolons. Match the file you are in.
- Raw SQL prepared statements in `src/db/queries.js`; no ORM, no query builder.
- Every module opens with a comment saying what it does and why. Keep that up.
- Never trust the client. Legality, turn, clocks, time control, variant,
  handicap and the premove flag are decided or re-checked on the server.
- Commit subjects are short and imperative; a `feat:`/`fix:` prefix is optional.
- When a design decision changes, update `design.md` in the same commit.

## Gotchas

- `schema.sql` only CREATEs. A new column on an existing table also needs an
  `addColumnIfMissing` line in `src/db/index.js`, or old databases never get it.
- Test files must `require("../helpers/server")` before anything under `src/`;
  the database path is fixed when `src/db/index.js` loads.
- `src/shared/*.js` runs in three runtimes: keep the UMD tail at the bottom and
  use no Node-only or DOM-only APIs.
- Time controls, variants and achievements are allowlists in `src/shared/`.
  Add entries there, not in ad-hoc lists elsewhere.
- Native modules need a rebuild after `npm install` because `ignore-scripts` is
  on globally: see "run the app" in `setup.md`.
