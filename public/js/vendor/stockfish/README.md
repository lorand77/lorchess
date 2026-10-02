# Stockfish 19 for game review

Vendored, unmodified, from the npm package `stockfish@19.0.0`
(https://github.com/nmrugg/stockfish.js, tag v19.0.0), `bin/` directory:

| File | sha256 |
|---|---|
| `stockfish-19-lite-single.js` | `d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6` |
| `stockfish-19-lite-single.wasm` | `57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387` |

The "lite single-threaded" build: small NNUE net built into the `.wasm`, and no
`SharedArrayBuffer`, so no cross-origin isolation headers are needed.
`Copying.txt` is the package's licence (GPLv3). Why and how it is used:
the "Game review" section of `design.md`.

Source: the npm package holds only the built files, so the GPL source offer
points at the git tag instead, pinned to its commit
`9cb3e5066d48f1a35d792afeda36eff37ae60570`
(https://github.com/nmrugg/stockfish.js/tree/9cb3e5066d48f1a35d792afeda36eff37ae60570).
The C++ engine is in `src/` there and `build.js` compiles it. `public/terms.html`
links to it; update that link when upgrading.

To upgrade: `npm pack stockfish@<version>` somewhere outside the repo, copy the
two `bin/stockfish-*-lite-single.*` files and `Copying.txt` here, update
`ENGINE_URL` in `public/js/gameReview.js`, the test paths, and this file.
