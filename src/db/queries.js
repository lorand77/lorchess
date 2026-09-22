"use strict";

// Thin prepared-statement layer (no ORM). Statements are prepared once at load
// and reused — better-sqlite3 is synchronous, so callers use .get()/.run()/.all()
// directly. Keep all SQL here so the rest of the app stays SQL-free.

const db = require("./index");

module.exports = {
  // --- users ---
  createUser: db.prepare(
    "INSERT INTO users (username, password_hash, puzzle_rating) VALUES (?, ?, ?)"
  ),
  // Full row incl. password_hash — for login verification only.
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  // Safe public view (no hash) — for /api/me and general lookups.
  getUserById: db.prepare(
    "SELECT id, username, rating, created_at FROM users WHERE id = ?"
  ),
  updateRating: db.prepare("UPDATE users SET rating = ? WHERE id = ?"),
  // Ops-only (src/db/setPassword.js); there is no self-service change flow.
  updatePassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),

  // Leaderboard: every human account ranked by rating, with a W/L/D record
  // over finished rated PvP games (the only games that move Elo). Param is
  // the reserved AI username to exclude.
  leaderboard: db.prepare(`
    SELECT u.id, u.username, u.rating, u.puzzle_rating,
           COUNT(g.id) AS games,
           COALESCE(SUM(CASE WHEN (g.result = '1-0' AND g.white_id = u.id)
                               OR (g.result = '0-1' AND g.black_id = u.id) THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN (g.result = '0-1' AND g.white_id = u.id)
                               OR (g.result = '1-0' AND g.black_id = u.id) THEN 1 ELSE 0 END), 0) AS losses,
           COALESCE(SUM(CASE WHEN g.result = '1/2-1/2' THEN 1 ELSE 0 END), 0) AS draws
    FROM users u
    LEFT JOIN games g
      ON (g.white_id = u.id OR g.black_id = u.id)
     AND g.mode = 'pvp' AND g.status = 'finished' AND g.rated = 1
    WHERE u.username <> ?
    GROUP BY u.id
    ORDER BY u.rating DESC, games DESC, u.username COLLATE NOCASE ASC
    LIMIT 100
  `),

  // --- games ---
  createGame: db.prepare(`
    INSERT INTO games (white_id, black_id, mode, ai_color, ai_depth,
                       start_fen, current_fen, turn,
                       initial_ms, increment_ms, rated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  // A user's games, newest first (they may be on either side), with both
  // players' usernames resolved for display.
  listGamesForUser: db.prepare(`
    SELECT g.*,
           wu.username AS white_username,
           bu.username AS black_username,
           (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS move_count
    FROM games g
    LEFT JOIN users wu ON wu.id = g.white_id
    LEFT JOIN users bu ON bu.id = g.black_id
    WHERE g.white_id = ? OR g.black_id = ?
    ORDER BY g.id DESC
  `),
  updateGamePosition: db.prepare(
    "UPDATE games SET current_fen = ?, turn = ? WHERE id = ?"
  ),
  finishGame: db.prepare(`
    UPDATE games
    SET status = 'finished', result = ?, termination = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `),
  // Aborted = ended without a result (early disconnect, etc.).
  abortGame: db.prepare(`
    UPDATE games
    SET status = 'aborted', termination = ?, finished_at = datetime('now')
    WHERE id = ?
  `),
  // Clocks are written on every move so a restart can restore them. Kept
  // separate from updateGamePosition because AI games are untimed.
  updateGameClocks: db.prepare(
    "UPDATE games SET clock_w_ms = ?, clock_b_ms = ? WHERE id = ?"
  ),
  // PvP games still 'active' — after a restart these are the ones waiting to
  // be resumed. AI games are deliberately excluded: they hold no server-side
  // state, so a restart never interrupts them.
  listActivePvpGames: db.prepare(
    "SELECT id FROM games WHERE status = 'active' AND mode = 'pvp'"
  ),

  // Both sides of every live PvP game; the lobby marks these users as busy.
  playersInLiveGames: db.prepare(
    "SELECT id, white_id, black_id FROM games WHERE status = 'active' AND mode = 'pvp'"
  ),

  // --- friendships ---
  // The one row (if any) linking two users, in either direction.
  findFriendship: db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = @a AND addressee_id = @b)
       OR (requester_id = @b AND addressee_id = @a)
  `),
  getFriendshipById: db.prepare("SELECT * FROM friendships WHERE id = ?"),
  createFriendRequest: db.prepare(
    "INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)"
  ),
  acceptFriendRequest: db.prepare(`
    UPDATE friendships
    SET status = 'accepted', responded_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `),
  deleteFriendship: db.prepare("DELETE FROM friendships WHERE id = ?"),
  // Everything involving a user, with the OTHER party resolved for display.
  listFriendshipsForUser: db.prepare(`
    SELECT f.id, f.status, f.created_at, f.responded_at,
           f.requester_id, f.addressee_id,
           u.id AS other_id, u.username AS other_username, u.rating AS other_rating
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id
                                ELSE f.requester_id END
    WHERE f.requester_id = @me OR f.addressee_id = @me
    ORDER BY f.status DESC, u.rating DESC, u.username COLLATE NOCASE
  `),

  // --- puzzles (see src/puzzles/service.js) ---
  getPuzzle: db.prepare("SELECT * FROM puzzles WHERE id = ?"),
  countPuzzles: db.prepare("SELECT COUNT(*) AS n FROM puzzles"),
  countPuzzlesInRange: db.prepare(
    "SELECT COUNT(*) AS n FROM puzzles WHERE rating BETWEEN ? AND ?"
  ),
  // Random pick = count the range (index only), then jump to a random offset.
  puzzleInRangeAt: db.prepare(
    "SELECT * FROM puzzles WHERE rating BETWEEN ? AND ? ORDER BY rating, id LIMIT 1 OFFSET ?"
  ),
  countDailyCandidates: db.prepare(`
    SELECT COUNT(*) AS n FROM puzzles
    WHERE rating BETWEEN ? AND ? AND popularity >= ? AND rating_deviation <= ?
  `),
  dailyCandidateAt: db.prepare(`
    SELECT id FROM puzzles
    WHERE rating BETWEEN ? AND ? AND popularity >= ? AND rating_deviation <= ?
    ORDER BY rating, id LIMIT 1 OFFSET ?
  `),
  insertPuzzle: db.prepare(`
    INSERT OR REPLACE INTO puzzles
      (id, fen, moves, rating, rating_deviation, popularity, nb_plays, themes, game_url, opening_tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  wipePuzzles: db.prepare("DELETE FROM puzzles"),

  getPuzzleUser: db.prepare(
    "SELECT id, username, puzzle_rating, daily_streak, daily_last_date FROM users WHERE id = ?"
  ),
  setPuzzleRating: db.prepare("UPDATE users SET puzzle_rating = ? WHERE id = ?"),
  setDailyStreak: db.prepare(
    "UPDATE users SET daily_streak = ?, daily_last_date = ? WHERE id = ?"
  ),
  getAttempt: db.prepare(
    "SELECT * FROM puzzle_attempts WHERE user_id = ? AND puzzle_id = ?"
  ),
  insertAttempt: db.prepare(`
    INSERT INTO puzzle_attempts (user_id, puzzle_id, solved, rating_before, rating_after)
    VALUES (?, ?, ?, ?, ?)
  `),
  attemptStats: db.prepare(`
    SELECT COUNT(*) AS attempts, COALESCE(SUM(solved), 0) AS solved
    FROM puzzle_attempts WHERE user_id = ?
  `),
  getDaily: db.prepare("SELECT puzzle_id FROM daily_puzzles WHERE date = ?"),
  insertDaily: db.prepare("INSERT OR IGNORE INTO daily_puzzles (date, puzzle_id) VALUES (?, ?)"),

  // --- customization (see src/settings/routes.js) ---
  getUserPrefs: db.prepare("SELECT prefs FROM users WHERE id = ?"),
  setUserPrefs: db.prepare("UPDATE users SET prefs = ? WHERE id = ?"),
  upsertUserAsset: db.prepare(`
    INSERT INTO user_assets (user_id, kind, mime, data, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (user_id, kind) DO UPDATE
      SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at
  `),
  getUserAsset: db.prepare(
    "SELECT mime, data, updated_at FROM user_assets WHERE user_id = ? AND kind = ?"
  ),
  listUserAssets: db.prepare(
    "SELECT kind, updated_at FROM user_assets WHERE user_id = ?"
  ),
  deleteUserAsset: db.prepare("DELETE FROM user_assets WHERE user_id = ? AND kind = ?"),
  deleteAllUserAssets: db.prepare("DELETE FROM user_assets WHERE user_id = ?"),

  // --- chat ---
  insertChat: db.prepare(
    "INSERT INTO chat_messages (game_id, user_id, role, body) VALUES (?, ?, ?, ?)"
  ),
  getChatById: db.prepare(`
    SELECT c.id, c.user_id AS userId, u.username, c.role, c.body AS text, c.created_at AS at
    FROM chat_messages c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `),
  // Player chat and spectator chat are two separate conversations: a spectator
  // must never be able to feed a move to a player (see socket.js handleChat).
  // Both are "most recent N, oldest first". There is deliberately NO query that
  // returns both, so no caller can leak one audience into the other by accident.
  listPlayerChat: db.prepare(`
    SELECT * FROM (
      SELECT c.id, c.user_id AS userId, u.username, c.role, c.body AS text, c.created_at AS at
      FROM chat_messages c JOIN users u ON u.id = c.user_id
      WHERE c.game_id = ? AND c.role IN ('w', 'b')
      ORDER BY c.id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `),
  listSpectatorChat: db.prepare(`
    SELECT * FROM (
      SELECT c.id, c.user_id AS userId, u.username, c.role, c.body AS text, c.created_at AS at
      FROM chat_messages c JOIN users u ON u.id = c.user_id
      WHERE c.game_id = ? AND c.role = 's'
      ORDER BY c.id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `),

  // --- moves ---
  insertMove: db.prepare(`
    INSERT INTO moves (game_id, ply, san, uci, fen_after, by_user, premove)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  // PvP variant: also records how long the mover thought (server-measured).
  insertMoveTimed: db.prepare(`
    INSERT INTO moves (game_id, ply, san, uci, fen_after, by_user, think_ms, premove)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getMovesForGame: db.prepare(
    "SELECT ply, san, uci, fen_after, by_user, think_ms, premove, created_at FROM moves WHERE game_id = ? ORDER BY ply"
  ),
  // Used by undo: drop everything after the new last ply.
  deleteMovesAfter: db.prepare(
    "DELETE FROM moves WHERE game_id = ? AND ply > ?"
  ),

  // --- rating history ---
  insertRatingHistory: db.prepare(`
    INSERT INTO rating_history (user_id, game_id, rating_before, rating_after)
    VALUES (?, ?, ?, ?)
  `),
  ratingHistoryForGame: db.prepare(
    "SELECT user_id, rating_before, rating_after FROM rating_history WHERE game_id = ?"
  ),
  // Today's rating changes (UTC), oldest first.
  ratingHistorySince: db.prepare(`
    SELECT rating_before, rating_after FROM rating_history
    WHERE user_id = ? AND created_at >= ? ORDER BY id
  `),

  // --- achievements (see src/achievements/service.js) ---
  // Insert or raise the tier. The WHERE on the upsert makes a lower or equal
  // tier a no-op, so `changes` tells the caller whether anything was earned.
  awardAchievement: db.prepare(`
    INSERT INTO user_achievements (user_id, key, tier, earned_at, game_id, puzzle_id)
    VALUES (@userId, @key, @tier, COALESCE(@at, datetime('now')), @gameId, @puzzleId)
    ON CONFLICT (user_id, key) DO UPDATE SET
      tier = excluded.tier, earned_at = excluded.earned_at,
      game_id = excluded.game_id, puzzle_id = excluded.puzzle_id
    WHERE excluded.tier > user_achievements.tier
  `),
  listAchievements: db.prepare(
    "SELECT key, tier, earned_at, game_id, puzzle_id FROM user_achievements WHERE user_id = ? ORDER BY earned_at DESC, key"
  ),
  countAchievements: db.prepare(
    "SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ?"
  ),
  // Aggregate record over finished games, from one user's point of view.
  achievementGameStats: db.prepare(`
    SELECT COUNT(*) AS finished,
           COALESCE(SUM(win), 0) AS wins,
           COALESCE(SUM(win AND termination = 'checkmate'), 0) AS checkmates,
           COALESCE(SUM(win AND white), 0) AS wins_white,
           COALESCE(SUM(win AND NOT white), 0) AS wins_black
    FROM (
      SELECT g.termination,
             (g.white_id = @me) AS white,
             ((g.result = '1-0' AND g.white_id = @me) OR (g.result = '0-1' AND g.black_id = @me)) AS win
      FROM games g
      WHERE (g.white_id = @me OR g.black_id = @me) AND g.status = 'finished'
    )
  `),
  // PvP wins per time control (initial_ms), for the format badges.
  achievementWinsByClock: db.prepare(`
    SELECT initial_ms, COUNT(*) AS n FROM games
    WHERE mode = 'pvp' AND status = 'finished'
      AND ((result = '1-0' AND white_id = @me) OR (result = '0-1' AND black_id = @me))
    GROUP BY initial_ms
  `),
  achievementMoveStats: db.prepare(`
    SELECT COUNT(*) AS moves,
           COALESCE(SUM(san LIKE 'O-O-O%'), 0) AS long_castles,
           COALESCE(SUM(san LIKE 'O-O%' AND san NOT LIKE 'O-O-O%'), 0) AS short_castles
    FROM moves WHERE by_user = ?
  `),
  achievementRecentResults: db.prepare(`
    SELECT result FROM games
    WHERE (white_id = ? OR black_id = ?) AND status = 'finished'
    ORDER BY id DESC LIMIT 10
  `),
  achievementRecentAttempts: db.prepare(
    "SELECT solved FROM puzzle_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 60"
  ),
  achievementChatCount: db.prepare(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?"
  ),
  achievementUser: db.prepare(
    "SELECT id, username, rating, puzzle_rating, daily_streak, daily_last_date, created_at FROM users WHERE id = ?"
  ),
  listFinishedGameIds: db.prepare(
    "SELECT id FROM games WHERE status = 'finished' ORDER BY id"
  ),
  listHumanUserIds: db.prepare(
    "SELECT id FROM users WHERE password_hash IS NOT NULL ORDER BY id"
  ),
};
