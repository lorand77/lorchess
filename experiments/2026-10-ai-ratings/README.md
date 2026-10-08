# Rating LorFish's five levels against Stockfish (October 2026)

**Question.** What are the Elo ratings of LorFish's five playing levels
(Novice, Beginner, Casual, Intermediate, Advanced)? The labels the app showed
came from runs of about 20 games a level, good to ±150 or so.

**Answer.** 7,740 games, every one a LorFish level against Stockfish 19, fitted
jointly with Stockfish's `UCI_Elo` levels pinned at their labels:

| Level | Setting | Rating | 95% interval | Games | Old label | New label |
|---|---|---:|---|---:|---:|---:|
| Advanced | depth 4 | **1971** | 1919 to 2026 (±54) | 200 | ~1800 | ~2000 |
| Intermediate | depth 2 | **1626** | 1592 to 1662 (±35) | 400 | ~1500 | ~1600 |
| Casual | depth 1, T=10 | **1323** | 1305 to 1343 (±19) | 2,840 | ~1200 | ~1300 |
| Beginner | depth 1, T=120 | **822** | 785 to 858 (±37) | 2,800 | ~700 | ~800 |
| Novice | depth 1, T=300 | **383** | 338 to 428 (±45) | 1,500 | ~300 | ~400 |

Every level is 80–170 above its old label. The new labels shipped in
`src/shared/aiLevels.js` (commit `ef24cad`). The ratings are on Stockfish's
engine scale, not a human one, and the intervals cover only the randomness of
the games (see [Limitations](#limitations)).

## What was measured

A level is a search depth plus a temperature T (`src/shared/aiLevels.js`). At
T=0 the bot plays its best move, with ±10 cp of jitter to vary its play. At T>0
it picks every legal move with weight exp(−loss/T), where loss is how many
centipawns the move falls short of the best one. The experiment used exactly
the search the app's Web Worker runs (`LorFish.searchRoot`), so the ratings
describe the bots users play.

## Method

**Scale.** Elo only measures differences, so something has to fix where the
numbers sit. Here that is the vendored Stockfish 19 (the lite single-threaded
WebAssembly build in `public/js/vendor/stockfish/`) with `UCI_LimitStrength`
on. A Stockfish level `sf<elo>` is pinned at its `UCI_Elo` label. Stockfish
thinks 100 ms a move with a 16 MB hash.

**Below Stockfish's floor.** `UCI_Elo` goes no lower than 1320, and Beginner
and Novice are far below that. Games against sf1320 would end almost all one
way and say little. So `sf1320r<pct>` plays a random legal move pct% of the
time and Stockfish's move otherwise. These levels have no rating of their own.
The fit rates them along with the bots, which turns the low end into a chain:
sf1320 – Casual – r10 – Beginner – r35 – Novice.

**No same-family games.** Every rated game is LorFish against Stockfish. Players
that share an evaluation exaggerate the gaps between them: the first self-play
ratings spread the levels far wider than Stockfish later did. So no game pits
two LorFish levels or two Stockfish levels against each other.

**Openings.** Each game starts from an 8-ply opening played by a sloppy depth-1
bot (T=80), for variety. An opening is kept only if full-strength Stockfish at
depth 16 scores it within ±50 cp, so neither side starts out ahead. Of 2,800
candidates, 1,183 were level, all different positions. The first 700 are in
`tools/lorfish/openings.txt`. Game i of a pairing plays opening i/2, so every
pairing meets the same openings in the same order, each once with each colour.

**Games.** Normal chess rules, with no clock (LorFish searches to a fixed
depth). A game still going after 300 plies (half-moves) counts as a draw.

**Fit.** `tools/lorfish/eloFit.js` finds the ratings that make all the results
most likely under the Elo model (expected score 1 / (1 + 10^(−gap/400)), draws
worth half). It fits every game at once, by Newton's method. Each pairing gets
one extra drawn game, so a clean sweep still gives a finite rating; that moves
a 1,300-game pairing by under 1 Elo. The 95% intervals come from 1,000
bootstrap refits that resample the openings, keeping both games of an opening
together.

## Design

### Before: earlier numbers and spot checks

The old labels came from about 20 games a level against Stockfish (10 for
depth 4). Novice was linked to Beginner only through games between LorFish
settings. Four short spot checks on 7 October 2026 suggested the labels were
off:

| Spot check | Result | What it suggests |
|---|---|---|
| Advanced vs sf1800 | +7 =0 −1 in 8 | ~2140, not 1800 |
| Beginner vs sf1320 | +1 =0 −13 in 14 | ~870, not 700 |
| Novice vs Beginner | +1 =0 −13 in 14 | 450 below Beginner |
| Intermediate vs sf1550 | +7 =0 −7 in 14 | ~1550 |

They also gave per-game times: about 5 s at depth 1, 13 s at depth 2 and
400–600 s at depth 4, where LorFish takes about 10 s a move. Advanced decides
the cost of the whole experiment.

### Stage 0: openings

`levels.js openings --count 700 --within 50 --seed 1`, about 3 minutes. The pilot
used an earlier 500-opening file whose lines are the first 500 of this one.

### Stage 1: pilot (668 games, 65 minutes, seed 1)

The pilot had two jobs: find which random-move rates sit where, and locate
Advanced. It played Casual, Beginner and Novice against sf1320 with 10, 20,
35, 50 and 70% random moves, 40 games each. It also played Casual vs sf1320
(40 games) to anchor the low end and Advanced vs sf2100 (28 games).

| Player | Pilot rating | 95% interval |
|---|---:|---|
| Advanced | 1961 | 1806 to 2088 |
| Casual | 1345 | 1242 to 1444 |
| sf1320 + 10% random | 1111 | 959 to 1253 |
| sf1320 + 20% random | 919 | 755 to 1061 |
| Beginner | 802 | 639 to 944 |
| sf1320 + 35% random | 614 | 447 to 764 |
| Novice | 471 | 292 to 605 |
| sf1320 + 50% random | 377 | 200 to 530 |
| sf1320 + 70% random | 246 | 58 to 406 |

### Choosing the low-end layout

The chain's error adds up link by link, so the layout matters. Five layouts
were compared by their expected 95% half-widths. These come from the Fisher
information of the Elo model at the pilot's ratings, with no draws, so they
lean pessimistic:

| Layout | Games | Casual | Beginner | Novice |
|---|---:|---:|---:|---:|
| r10 and r35, 1,000 games a link | 5,000 | ±22 | ±46 | ±57 |
| r15 and r35, 1,000 a link | 5,000 | ±22 | ±46 | ±58 |
| r10, r20 and r35: two paths from Casual to Beginner | 5,800 | ±22 | ±44 | ±57 |
| r15, r35 and r50: two paths from Beginner to Novice | 5,000 | ±22 | ±46 | ±59 |
| r10 and r35, more games on the weaker links | 5,000 | ±24 | ±45 | ±57 |

Extra paths barely help, so the simplest layout won: r10 and r35, both already
placed by the pilot. Links went up to 1,300 games each to bring Novice to about
±50. Depth-1 games are cheap, so that cost about 18 extra minutes.

### Stage 2: main run (7,072 games, seed 2)

Each level's opponents sit within about 300 Elo of it, aiming for scores of
30–70%, where a game tells the most. Advanced went first so the short games
could fill in around its long ones. The pilot's 28 Advanced vs sf2100 games
count toward its 100. The plan is `main.txt`:

| Pairing | Games | Planned 95% half-width |
|---|---:|---|
| Advanced vs sf1800, sf2100 | 100, 72 | ±52 |
| Intermediate vs sf1400, sf1700 | 200, 200 | ±37 |
| Casual vs sf1320 | 1,300 | ±19 |
| Casual vs r10, Beginner vs r10 | 1,300, 1,300 | Beginner ±40 |
| Beginner vs r35, Novice vs r35 | 1,300, 1,300 | Novice ±50 |

## Running it

One AWS Linux machine with 8 cores, Node 24.21, 7 worker threads. Each worker
had its own Stockfish child process. Stockfish thinks for a fixed time, so
nothing else heavy ran during the games: a busy machine would have weakened it.

| Run | Date (machine clock) | Wall time | Game time summed over workers |
|---|---|---:|---:|
| Pilot | 7 Oct 2026, 22:48–23:53 | 64.7 min | 5.8 h |
| Main | 8 Oct 2026, 05:04–10:59 | 355.2 min | 41.4 h |

The pilot overran its 35-minute estimate. Its 28 long Advanced games came last,
and the final ones kept only a few workers busy. The code was
`scripts/lorfishLevels.js` at commit `ef24cad`; it has since moved to
`tools/lorfish/levels.js` with no change in behaviour.

## Results

### Every pairing (pilot and main together)

"Gap from score" is the rating difference that pairing's score implies on its
own. "Gap in fit" is the difference in the joint fit.

| Pairing | Games | +win =draw −loss | Score | Gap from score | Gap in fit | Avg plies | Avg s/game | At 300 plies |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| advanced vs sf2100 | 100 | +33 =8 −59 | 37.0% | −92 | −129 | 113 | 669.6 | 2 |
| advanced vs sf1800 | 100 | +65 =6 −29 | 68.0% | +131 | +171 | 92 | 548.1 | 0 |
| intermediate vs sf1700 | 200 | +72 =3 −125 | 36.8% | −94 | −74 | 98 | 17.5 | 1 |
| intermediate vs sf1400 | 200 | +161 =4 −35 | 81.5% | +258 | +226 | 82 | 14.6 | 1 |
| casual vs sf1320 | 1340 | +658 =37 −645 | 50.5% | +3 | +3 | 86 | 6.5 | 7 |
| casual vs sf1320r10 | 1340 | +1053 =9 −278 | 78.9% | +229 | +229 | 74 | 5.1 | 0 |
| casual vs sf1320r20 | 40 | +38 =0 −2 | 95.0% | +512 | +410 | 71 | 4.9 | 0 |
| casual vs sf1320r35 | 40 | +40 =0 −0 | 100.0% | +∞ | +726 | 64 | 3.3 | 0 |
| casual vs sf1320r50 | 40 | +40 =0 −0 | 100.0% | +∞ | +1012 | 54 | 2.4 | 0 |
| casual vs sf1320r70 | 40 | +40 =0 −0 | 100.0% | +∞ | +1149 | 46 | 1.5 | 0 |
| beginner vs sf1320r10 | 1340 | +209 =44 −1087 | 17.2% | −273 | −272 | 88 | 5.7 | 12 |
| beginner vs sf1320r20 | 40 | +14 =2 −24 | 37.5% | −89 | −92 | 108 | 6.7 | 1 |
| beginner vs sf1320r35 | 1340 | +1035 =36 −269 | 78.6% | +226 | +225 | 100 | 5.9 | 13 |
| beginner vs sf1320r50 | 40 | +37 =1 −2 | 93.8% | +470 | +510 | 102 | 5.5 | 0 |
| beginner vs sf1320r70 | 40 | +39 =0 −1 | 97.5% | +636 | +647 | 79 | 4.8 | 0 |
| novice vs sf1320r10 | 40 | +0 =1 −39 | 1.3% | −759 | −711 | 65 | 4.1 | 0 |
| novice vs sf1320r20 | 40 | +0 =0 −40 | 0.0% | −∞ | −530 | 71 | 3.7 | 0 |
| novice vs sf1320r35 | 1340 | +213 =177 −950 | 22.5% | −215 | −214 | 121 | 6.5 | 63 |
| novice vs sf1320r50 | 40 | +21 =9 −10 | 63.8% | +98 | +72 | 156 | 7.7 | 1 |
| novice vs sf1320r70 | 40 | +29 =6 −5 | 80.0% | +241 | +209 | 138 | 7.3 | 3 |

### The random-move levels

| Stockfish at 1320 with | Rating | 95% interval |
|---|---:|---|
| 10% random moves | 1094 | 1066 to 1123 |
| 20% | 914 | 824 to 996 |
| 35% | 597 | 555 to 635 |
| 50% | 311 | 218 to 409 |
| 70% | 175 | 50 to 279 |

Random moves cost the most at first: the first 10% takes about 230 Elo off
sf1320, the next 25 points take about 500 more.

### Planned against achieved precision

| Level | Planned | Achieved |
|---|---:|---:|
| Advanced | ±52 | ±54 |
| Intermediate | ±37 | ±35 |
| Casual | ±19 | ±19 |
| Beginner | ±40 | ±37 |
| Novice | ±50 | ±45 |

## Checks

- **Main run alone.** Fitting only the main run gives Advanced 1973, Intermediate
  1626, Casual 1323, Beginner 823 and Novice 376. Every level is within 7 Elo
  of the joint fit, so the pilot's lopsided pairings don't move the result.
- **Games stopped at 300 plies.** 104 games reached the limit and counted as
  draws, 63 of them Novice vs r35. Refitting without them gives Novice 364
  (−19) and moves no other level more than 4. Every label stays the same.
- **Stockfish's own spacing.** Each upper level played two pinned Stockfish
  levels. Advanced's two scores imply sf1800 and sf2100 are about 223 apart,
  not 300. Intermediate's imply sf1400 and sf1700 are about 352 apart. Those
  are good to about ±105 and ±80, so neither contradicts the labels. The fit
  splits the difference, which is why its gaps differ from the score-only gaps
  in those four rows.
- **The chain.** Below Casual, every link is the only path to the next player,
  so there the fit gaps equal the score gaps (+229, −272, +225, −214).

## Limitations

- **Engine scale, not human.** The ratings say how the levels do against
  Stockfish's `UCI_Elo` levels. They are not Lichess or FIDE ratings, and
  people may fare differently against a bot that blunders by temperature.
- **Stockfish's labels are taken as given.** `UCI_Elo` was calibrated on the
  full Stockfish at longer time controls. The lite build at 100 ms a move
  probably plays below its label, which would make every rating here read
  high, by an unknown amount that may differ between levels. The intervals
  leave this out.
- **The low end is a chain.** Beginner and Novice are linked to sf1320 only
  through Stockfish with random moves, so their errors add up link by link,
  as the intervals show. Elo assumes a rating carries over between opponent
  types. That may hold less well between a uniform random blunderer and
  LorFish's evaluation-weighted one.
- **Odd openings.** The openings are level by Stockfish's judgement but come
  from a sloppy bot, so many look unnatural. Users' games start from the
  initial position.
- **Draws at 300 plies.** These favour whichever side was losing; see Checks.
- **Not exactly repeatable.** LorFish's choices are seeded, but Stockfish's
  limited-strength randomness is not, so a rerun gives statistically similar
  results, not the same games.

## Not done

- **Thinking-time check.** Replay Casual vs sf1320 and Intermediate vs sf1700
  with Stockfish at 400 ms a move, to see whether 100 ms biases the scale
  (about 20 minutes).
- **Bot-vs-bot games.** Play neighbouring LorFish levels against each other
  and fit them separately, to measure how much self-play stretches the gaps
  (about 15 minutes without Advanced).
- **Human scale.** Compute rated players' performance against each level from
  production games.

## Reproducing

From the repository root, into a new experiment folder: `tournament` skips
games already in its output file, so rerunning in place does nothing.

```
node tools/lorfish/levels.js openings --count 700 --within 50 --seed 1   # rewrites tools/lorfish/openings.txt
node tools/lorfish/levels.js tournament <folder>/pilot.txt               # seed 1
node tools/lorfish/levels.js tournament <folder>/main.txt --seed 2
node tools/lorfish/levels.js fit <folder>/pilot.jsonl <folder>/main.jsonl
```

Re-fitting this run's games needs no games played (about 10 seconds):

```
node tools/lorfish/levels.js fit experiments/2026-10-ai-ratings/pilot.jsonl experiments/2026-10-ai-ratings/main.jsonl
```

## Files

| File | What it is |
|---|---|
| `pilot.txt`, `main.txt` | The plans: one `a b games [movetime]` pairing a line |
| `pilot.jsonl`, `main.jsonl` | Every game, one JSON object a line. `a` and `b` are the levels; `score` is a's points; `aWhite`, `index` and `opening` locate the game; `plies` and `ms` are its length; `capped` marks a game stopped at 300 plies |
| `../../tools/lorfish/levels.js` | The harness: `openings`, `match`, `tournament`, `fit`, `profile` |
| `../../tools/lorfish/eloFit.js` | The fit and bootstrap, tested by `test/unit/eloFit.test.js` |
| `../../tools/lorfish/openings.txt` | The 700 openings, as UCI moves |
