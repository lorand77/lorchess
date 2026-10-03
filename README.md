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
- [CLAUDE.md](CLAUDE.md): conventions for working in the repo

## License

MIT, see [LICENSE](LICENSE). Exceptions:

- The vendored Stockfish engine in `public/js/vendor/stockfish/` is GPLv3
  (see the `Copying.txt` and `README.md` there, including where its source is).
- The npm dependency `better-sqlite3-session-store` is GPL-3.0-only. It is
  not in this repository, but the server loads it, so anyone who distributes
  the app with its dependencies (a Docker image, a bundled release) must do
  so under the GPLv3, including its source. Running the app on your own
  server is not distribution.
- The chess piece images `public/assets/*_1x_ns.png` are "JohnPablok's
  improved Cburnett chess set" by JohnPablok, based on the pieces by Colin M.
  L. Burnett, from
  [OpenGameArt](https://opengameart.org/content/chess-pieces-and-board-squares),
  licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
  They are used unmodified; edited versions must stay CC BY-SA.
