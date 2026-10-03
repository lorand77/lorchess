# Third-party licenses

LorChess itself is MIT, see [LICENSE](../LICENSE). These parts are not:

- The vendored Stockfish engine in `public/js/vendor/stockfish/` is GPLv3
  (see the [`Copying.txt`](../public/js/vendor/stockfish/Copying.txt) and
  [`README.md`](../public/js/vendor/stockfish/README.md) there, including where
  its source is).
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
