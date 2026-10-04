# LorChess

A chess web app: play **LorFish**, the built-in engine, or other people in real
time.

**Live:** https://lorchess.lorand77.dev

## Features

- Real-time games against other players, with clocks kept on the server and
  Elo ratings
- Games against LorFish, which runs in the browser in a Web Worker
- Variants: standard chess, Chess960, Atomic and Pawn Wars
- Puzzles, achievements, friends, a leaderboard, spectating, in-game chat and
  game replays

## Stack

Node.js 24, Express 5, Socket.IO and SQLite (better-sqlite3) on the server;
vanilla JavaScript in the browser, with no framework and no build step. The
browser, the engine's Web Worker and the server all load the same chess rules
file (`src/shared/`), so the server checks moves with the rules the client
plays by.

## Getting started

```sh
npm install
npm run dev    # http://localhost:3000
npm test
```

Native modules need a rebuild after `npm install`; see `docs/setup.md`.

## Docs

- [docs/design.md](docs/design.md): architecture and the reasons behind it
- [docs/setup.md](docs/setup.md): running and deploying
- [docs/CLAUDE.md](docs/CLAUDE.md): conventions for working in the repo
- [docs/licenses.md](docs/licenses.md): third-party licenses

## License

MIT, see [LICENSE](LICENSE). The vendored Stockfish engine, the
`better-sqlite3-session-store` dependency and the chess piece images are under
other licenses: see [docs/licenses.md](docs/licenses.md).

