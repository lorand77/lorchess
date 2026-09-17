-- LorChess database schema. Idempotent (IF NOT EXISTS) — safe to run on every
-- boot. Written to port cleanly to Postgres later (no SQLite-only types).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT,                       -- NULL for the reserved AI account
  rating        INTEGER NOT NULL DEFAULT 1200,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- games / moves are defined now (M2) so the schema is complete and stable, but
-- they aren't written to until AI-game persistence lands in M3.
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
