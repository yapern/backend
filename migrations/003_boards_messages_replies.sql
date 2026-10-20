-- Boards, board messages, and one-level replies.
-- Users and sessions are created by earlier migrations.

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE CHECK(
    length(slug) BETWEEN 1 AND 80
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT GLOB '-*'
    AND slug NOT GLOB '*-'
  ),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_boards_user_id
  ON boards(user_id);

INSERT OR IGNORE INTO boards(id, slug, name, description)
VALUES('general', 'general', 'General', 'General discussion.');

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  board_id TEXT NOT NULL REFERENCES boards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  title TEXT NOT NULL DEFAULT 'Untitled'
    CHECK(length(trim(title)) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_messages_user_id
  ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_board_id_created_at
  ON messages(board_id, created_at);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_replies_message_id_created_at
  ON replies(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_replies_user_id
  ON replies(user_id);
