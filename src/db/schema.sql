-- LorChess database schema. Idempotent (IF NOT EXISTS) — safe to run on every
-- boot. Written to port cleanly to Postgres later (no SQLite-only types).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT,                       -- NULL for the reserved AI account
  rating        INTEGER NOT NULL DEFAULT 1200,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Every game, AI or PvP, with its full move record in `moves`.
CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  white_id    INTEGER REFERENCES users(id),
  black_id    INTEGER REFERENCES users(id),
  mode        TEXT    NOT NULL CHECK (mode IN ('ai', 'pvp')),
  ai_color    TEXT    CHECK (ai_color IN ('w', 'b')),
  ai_depth    INTEGER,
  status      TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'finished', 'aborted')),
  result      TEXT,                         -- '1-0' | '0-1' | '1/2-1/2' | NULL
  termination TEXT,                         -- 'checkmate' | 'resign' | ...
  start_fen   TEXT,
  current_fen TEXT,
  turn        TEXT    NOT NULL DEFAULT 'w' CHECK (turn IN ('w', 'b')),
  -- Per-game time control, resolved from shared/timeControls.js at creation.
  -- NULL on 'ai' games, which are untimed.
  initial_ms   INTEGER,
  increment_ms INTEGER,
  -- Whether the result moves Elo. AI games are always unrated.
  rated        INTEGER NOT NULL DEFAULT 1,
  -- 'standard' or a variant key (see src/shared/variants.js). Chess960 only
  -- changes the start position, which is in start_fen; Atomic and Pawn Wars
  -- change the rules the engine plays by (Chess.setVariant).
  variant      TEXT NOT NULL DEFAULT 'standard',
  -- Remaining time per side, written on every move. This is what lets a game
  -- survive a server restart: the position comes from `moves`, the clocks from
  -- here. NULL means "never recorded", i.e. fall back to initial_ms.
  clock_w_ms   INTEGER,
  clock_b_ms   INTEGER,
  -- 1 once both players have joined and the clock has run (see socket.js).
  clock_started INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  ply        INTEGER NOT NULL,
  san        TEXT    NOT NULL,
  uci        TEXT    NOT NULL,
  fen_after  TEXT    NOT NULL,
  by_user    INTEGER REFERENCES users(id),  -- NULL = AI move
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_moves_game_ply ON moves (game_id, ply);

-- Friendships. One row per pair: requester -> addressee, 'pending' until the
-- addressee accepts. Application code checks both directions before inserting
-- so a pair never has two rows.
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  addressee_id INTEGER NOT NULL REFERENCES users(id),
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships (addressee_id);

-- In-game chat. Persisted so a reload (or a rematch lobby after the room is
-- gone) still shows the conversation. role is the sender's seat at send time.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT    NOT NULL CHECK (role IN ('w', 'b', 's')),  -- white | black | spectator
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_game ON chat_messages (game_id, id);

-- Per-user uploaded images for the customization panel: 'bg' (page
-- background) or a piece slot like 'wK' / 'bP'. One row per slot; re-uploading
-- replaces it. Colour preferences live in users.prefs (JSON, see db/index.js).
CREATE TABLE IF NOT EXISTS user_assets (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  data       BLOB    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- Tactics puzzles imported from the Lichess puzzle database (CC0) by
-- src/db/importPuzzles.js. `moves` is the Lichess convention: UCI, space
-- separated, the FIRST move is the opponent's move that sets up the puzzle and
-- the rest alternate player / opponent.
CREATE TABLE IF NOT EXISTS puzzles (
  id               TEXT    PRIMARY KEY,   -- Lichess PuzzleId
  fen              TEXT    NOT NULL,      -- position BEFORE the setup move
  moves            TEXT    NOT NULL,
  rating           INTEGER NOT NULL,
  rating_deviation INTEGER,
  popularity       INTEGER,
  nb_plays         INTEGER,
  themes           TEXT,                  -- space separated
  game_url         TEXT,
  opening_tags     TEXT
);
CREATE INDEX IF NOT EXISTS idx_puzzles_rating ON puzzles (rating);

-- One row per user per puzzle: the first, rating-affecting attempt. Retries
-- are allowed but never recorded again.
CREATE TABLE IF NOT EXISTS puzzle_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  puzzle_id     TEXT    NOT NULL REFERENCES puzzles(id),
  solved        INTEGER NOT NULL,         -- 1 solved, 0 failed / gave up
  rating_before INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, puzzle_id)
);

-- Puzzles a member skipped: let go of without an attempt, so no rating change.
-- Only here to count skips per UTC day against the daily allowance.
CREATE TABLE IF NOT EXISTS puzzle_skips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  puzzle_id  TEXT    NOT NULL REFERENCES puzzles(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_puzzle_skips_user ON puzzle_skips (user_id, created_at);

-- The puzzle of the day, one row per UTC date, chosen on first request.
CREATE TABLE IF NOT EXISTS daily_puzzles (
  date      TEXT PRIMARY KEY,             -- 'YYYY-MM-DD' (UTC)
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id)
);

-- Achievements. One row per user per achievement; tiered achievements keep
-- only the highest tier reached (earned_at is when that tier was reached).
-- game_id / puzzle_id point at whatever earned it, so a stats page can link to it.
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  key        TEXT    NOT NULL,
  tier       INTEGER NOT NULL DEFAULT 1,
  earned_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  game_id    INTEGER REFERENCES games(id),
  puzzle_id  TEXT    REFERENCES puzzles(id),
  PRIMARY KEY (user_id, key)
);

-- Every rated-game rating change, so "what was my rating before this game" and
-- "how did my rating move today" have an answer. Written alongside the Elo
-- update; achievements read it.
CREATE TABLE IF NOT EXISTS rating_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  game_id       INTEGER REFERENCES games(id),
  rating_before INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rating_history_user ON rating_history (user_id, id);

-- Membership promo codes. A code is available while redeemed_by IS NULL, and
-- claiming it is a single conditional UPDATE — so two people submitting the same
-- code at the same instant can never both win it. Generated by
-- `npm run promo:new` (src/db/promoCodes.js); none are seeded automatically.
CREATE TABLE IF NOT EXISTS promo_codes (
  code        TEXT PRIMARY KEY,
  redeemed_by INTEGER REFERENCES users(id),
  redeemed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
