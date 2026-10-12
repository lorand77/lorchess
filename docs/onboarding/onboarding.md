# LorChess — Onboarding Plan

A plan of the topics for walking a new developer through LorChess, from the big
picture down to the code, and then production. **Part 1** is the big picture,
**Part 2** the tech and code, **Part 3** production.

💬 marks a point where the repo shows *what* was decided but not *why*. Fill
these in before the session: they are the most useful part to hear.

---

## Before session 1 (the new developer does this alone)

- Set up the dev environment by following the DEV half of [setup.md](setup.md):
  WSL2, Docker, the dev container and Node 24.
- Run `npm install`, the native rebuild, `npm start` and `npm test`. Getting all
  of these to pass is the first goal.
- Read [README.md](../README.md) and skim [design.md](design.md). Full
  understanding is not expected yet.
- Play the app: a game against LorFish, a PvP game in two browsers, a puzzle
  and a game review.

---

# Part 1: The big picture

## 1. The product (demo, no code)

- Play through every feature live: an AI game, a PvP game between two browsers,
  spectating, chat, puzzles (daily and rated), game review, achievements,
  friends, leaderboard and membership.
- Who uses it, how many users there are and what matters to them. 💬
- What "production" means here: real users, real games in progress and real
  personal data. Mistakes are visible.

## 2. The system in one picture

The path of one request:

```
Browser ──DNS (name.com)──► EC2 public IP
        ──HTTPS :443──► Caddy (TLS, reverse proxy)
        ──HTTP :3000──► Node process (pm2)
                         ├─ Express: static pages + REST /api/*
                         ├─ Socket.IO: live games, lobby, chat
                         └─ better-sqlite3 ──► data/lorchess.sqlite (+WAL)
nightly cron ──► backup.sh ──► Backblaze B2
```

- **Where code runs.** There are three places: the server, the browser page and
  the browser Web Worker (LorFish and Stockfish). The rules engine runs in all
  of them.
- **What state lives where.** The database stores games, users and sessions.
  Server memory holds live rooms, matchmaking queues, the lobby and throttle
  counters. The browser runs its own AI games.
- **Repo map.** `src/` is the server, `src/shared/` is shared with the browser,
  `public/` holds pages and browser code, `test/` the tests, `scripts/` the
  ops scripts, `tools/` developer tools such as LorFish's rating harness and
  `experiments/` dated experiment reports with their data. The docs split into [design.md](design.md) (why),
  [setup.md](setup.md) (how to run) and [CLAUDE.md](CLAUDE.md) (rules).

## 3. The architecture decisions and their trade-offs

For each decision, cover what it buys, what it costs and when it would need
revisiting:

- **One monolith in one process.** It is simple to reason about, deploy and
  debug. The cost is that in-memory state (rooms, queues, throttle) only works
  because there is exactly one process. Two processes would need shared state,
  such as a Socket.IO Redis adapter.
- **SQLite instead of Postgres or MySQL.** There is no database server to run,
  backup is a single file, and synchronous queries are fast. The cost is a
  single writer and a database tied to one machine's disk, which shapes the
  hosting choice in section 14. The schema is written so it could move to
  Postgres later.
- **No framework, bundler or build step.** What is in git is what runs.
  Debugging happens in the browser on the real files, there is nothing to
  upgrade, and the attack surface is small. The cost is more manual DOM code.
- **About seven dependencies, used on purpose.** Each one is supply-chain risk
  and upgrade work. Prefer Node built-ins.
- **The server is authoritative for PvP; the client is authoritative for AI
  games.** That is why cheating in PvP is prevented, why AI-game records are
  trusted less, and why AI games cost the server nothing.
- **Heavy compute runs in the browser** (LorFish, Stockfish). The server stays
  small and cheap.
- **Scaling limits.** Ask: what breaks first if users grow 10×, and what would
  you change? Likely answers are CPU for argon2, a single process for sockets,
  and one disk.
- 💬 Which of these were deliberate from day one, and which were learned the
  hard way (for example the allowlists, and surviving restarts)?

## 4. How a change goes from idea to production

- Idea → branch → code and tests → `npm test` → review → merge to `main` on
  GitHub → `git pull` on the server → `pm2 restart`.
- What is missing compared with a large company: no CI, no staging environment
  and no automated deploy. That is a fair choice for a small app, but it means
  the **discipline is manual**: tests run locally and deploys are deliberate.
- Dev and production run the same OS: the dev container is Ubuntu "resolute",
  the same Ubuntu 26.04 that runs on the server.

---

# Part 2: Tech and code

## 5. Node essentials

- One thread and an event loop. Blocking code freezes everything, which is why
  LorFish runs in a worker and why every socket handler has a try/catch.
- CommonJS `require` and the module cache. npm, the lockfile and native modules
  (the rebuild step). Built-ins replace packages: `--env-file`, `--watch`,
  `node --test`.

## 6. HTTP and Express

- Read [src/app.js](../src/app.js) from top to bottom (it is the whole middleware
  chain), then trace `POST /api/login` through the throttle, argon2, session
  regeneration and the cookie.

## 7. Data: SQLite

- WAL mode, prepared statements in [src/db/queries.js](../src/db/queries.js),
  transactions, and the gotcha that `schema.sql` only CREATEs while
  `addColumnIfMissing` handles new columns.
- Modelling choices: the AI side is a real user, deactivation is a flag, and
  deletion renames the account instead of removing it.
- Exercise: query the local database with `sqlite3`.

## 8. Real-time with Socket.IO

- Rooms, acks and reconnects, with one session shared by REST and sockets. Walk
  through `handleMove` in [src/game/socket.js](../src/game/socket.js) and **"never
  trust the client"**.

## 9. The shared engine

- [src/shared/](../src/shared/) runs in three runtimes thanks to the UMD tail. The
  catalogues are allowlists. Positions are rebuilt by replaying moves, never by
  loading a FEN. Stockfish is vendored WASM and is never edited.

## 10. The front end

- One HTML page per script. The move-source abstraction in
  [public/js/ui.js](../public/js/ui.js). `authGuard.js` is a convenience, not
  security. DevTools: network, WS frames and the console.

## 11. Security

- argon2, throttling, cookie flags, `trust proxy`, the username policy, and
  privacy promises tied to code.

## 12. Testing

- Unit and integration tests, [test/helpers/server.js](../test/helpers/server.js),
  coverage thresholds and `test:deep`. Exercise: write one integration test.

## 13. Conventions

- The [CLAUDE.md](CLAUDE.md) rules, commit style, updating `design.md` in the
  same commit, and using AI tools responsibly.

---

# Part 3: Production

## 14. Hosting choices: why EC2 and Ubuntu

The hosting options in general, and how this app's needs rule each one in or out:

| Option | Fits LorChess? |
|---|---|
| Serverless (Lambda, Vercel functions) | ❌ No long-lived WebSockets, no local disk for SQLite, no in-memory rooms |
| PaaS (Railway, Render, Heroku) | ⚠️ Works, but SQLite needs a persistent volume, deploys restart the app, and there is less control. **This is where LorChess ran before** |
| Containers / Kubernetes | ❌ Far too much machinery for one process |
| VPS / IaaS (EC2, Lightsail, Hetzner, DigitalOcean) | ✅ One long-running process, a local disk and full control |

- **The move from Railway to EC2 (summer 2026).** The appendix in
  [setup.md](setup.md) records what a PaaS needed: a volume, environment
  variables and edge TLS. 💬 The actual reasons, such as cost, control, volume
  limits or wanting to learn the server side.
- **Why AWS EC2 specifically** compared with Lightsail or Hetzner. 💬 For
  example ecosystem, credits or experience.
- **Why t4g.small:** Graviton ARM is cheaper per vCPU. One consequence is that
  native modules (better-sqlite3, argon2) must be compiled **on the server**:
  never copy `node_modules` from a laptop.
- **Sizing and where it shows in the code:**
  - The 2 vCPUs are why `HASH_MAX_CONCURRENT=2`.
  - 2 GB of RAM holds Node, Caddy and in-memory rooms.
  - The 8 GB disk holds the database, the ~300 MB puzzle import, 7 days of
    local backups, logs and OS updates. This is the resource to watch.
- **Why Ubuntu LTS:** a long support window for security patches, `apt`, the
  most documentation, and the same OS as the dev container.
- **Why Node from NodeSource:** Ubuntu's own Node package lags behind, and
  NodeSource provides the exact major version (24 LTS) the project targets.

## 15. Anatomy of the server

- **Access:** SSH with a key as `ubuntu` (has sudo), then work as `lorchess`
  (no sudo).
- **Why a dedicated non-root user:** if the app is compromised, the attacker
  gets one user's files, not the machine.
- **Filesystem:**
  - `/home/lorchess/lorchess` is the git checkout.
  - `data/` holds the database plus its `-wal` and `-shm` files.
  - `/home/lorchess/backups/` holds the local backups.
  - `.env` is `chmod 600`.
  - `/etc/caddy/Caddyfile` is the proxy config.
- **Who runs what:**
  - **systemd** runs Caddy.
  - **pm2** runs Node: it restarts on crash, keeps logs, and survives reboots
    via `pm2 startup`.
  - **cron** runs `backup.sh` at 03:00.
- **Network:**
  - The DNS A record at name.com points to the instance's IP.
  - The security group opens 22, 80 and 443. Port **3000 stays closed**,
    because the throttle trusts `X-Forwarded-For` only when Caddy is the sole
    entry point.
  - Caddy gets and renews Let's Encrypt certificates automatically, using port
    80 for the challenge.
  - The cookie's `secure: "auto"` works through `trust proxy`.
- 💬 Is the IP an **Elastic IP**? If it is not, stopping and starting the
  instance changes the IP and DNS breaks.

## 16. Running it day to day

- **Config and secrets:** `.env` only holds `SESSION_SECRET` and `NODE_ENV`,
  and everything else defaults in [src/config.js](../src/config.js). Rotating the
  secret logs everyone out. Never commit it, and never paste it into chat or AI
  tools.
- **What a deploy does** (`git pull` → `npm install` → `pm2 restart`):
  - **Every socket drops.** Live PvP games are rebuilt from the database when
    players return, and those not resumed within `RESUME_WINDOW_MS` (10 min)
    are aborted. So deploy at quiet times.
  - **Schema changes run at boot** through `addColumnIfMissing`. They are
    add-only, which keeps rollback safe.
  - **Rollback:** `git checkout <previous>`, then `pm2 restart`. Columns that
    were added stay, which is harmless.
  - **Native modules:** if their versions change, a rebuild may be needed.
- **Admin CLIs:** `user:password`, `user:deactivate`/`user:reactivate`,
  `user:delete` and `promo:new`.
  - They are safe while the app is running, and they must run as `lorchess` in
    the project directory so they pick up `.env`.
  - Deletion needs the owner's identity verified first, using the "change board
    colours to a value you name" check.
- **Never run against production:** `db:reset`. `puzzles:import` downloads
  ~300 MB and only runs after asking.

## 17. Data safety: backups and privacy

- [scripts/backup.sh](../scripts/backup.sh):
  - Uses `VACUUM INTO`, which gives a consistent copy while the app keeps
    writing. Explain why `cp` of a live WAL database is wrong.
  - Keeps 7 days locally and uploads to B2 with rclone, where copies are
    deleted after 30 days.
- **RPO and RTO in plain words:**
  - Up to about 24 h of data can be lost.
  - Recovery time is however long a restore takes.
- **Restore procedure:** stop pm2, copy the backup over the database, delete
  the `-wal` and `-shm` files, start pm2.
- **Restore drill:** restore last night's B2 backup **into a dev environment**
  and check that it works. A backup is only known to work once a restore has
  been tested.
- **Privacy:** backups contain personal data, the privacy policy promises at
  most 90 days, deletion requests eventually reach backups through expiry, and
  Caddy keeps no access log.

## 18. Keeping it healthy

- **Logs:** `pm2 logs`, `pm2 monit`. 💬 Is log rotation set up
  (pm2-logrotate)? On an 8 GB disk, logs that are never rotated will eventually
  fill it.
- **Monitoring:** 💬 none is documented. Who finds out the site is down, and
  how? An external uptime check is cheap. Also cover disk-usage checks
  (`df -h`) and backup-log checks.
- **Updates:**
  - Ubuntu security patches (💬 unattended-upgrades?).
  - Node minor and LTS versions.
  - npm packages, with the 7-day `min-release-age` and the Socket scanner as
    gates.
- **Failure scenarios.** For each one, ask "what happens and what do we do?":
  - The Node process crashes.
  - A bad deploy goes out.
  - The disk fills up.
  - The certificate fails to renew.
  - The instance dies completely: rebuild from [setup.md](setup.md) plus a B2
    restore. That is the strongest argument for keeping setup.md accurate.
  - `SESSION_SECRET` leaks.
  - Somebody hammers the login endpoint.
- **Incident habit:** reproduce locally, read logs and stack traces, write a
  failing test, fix it, deploy, and write a short note.

## 19. Access and responsibilities

- 💬 Decide what access the new developer gets: GitHub (who can push to
  `main`), SSH to production (none, read-only, or supervised), AWS console, B2,
  name.com.
- Suggested progression: shadow a deploy, then deploy while supervised, then
  deploy alone. The same goes for admin CLIs and the restore drill.

---

## Pacing

- **Week 1:** Part 1 (sections 1–4) plus sections 5–6, with a small REST change
  as the exercise.
- **Week 2:** sections 7–13, with a first real ticket.
- **Week 3:** Part 3 (sections 14–19), with a restore drill, a shadowed deploy
  and the failure-scenario discussion.

## Good first tasks

- Add a stats field from the API through to the profile page.
- Cover a branch the coverage report shows as untested.
- Add an achievement (catalogue, service, toast, backfill).
- In ops: write the missing runbook items identified in section 18, such as log
  rotation or an uptime check.
