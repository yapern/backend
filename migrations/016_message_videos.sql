-- Keep uploads after their message is deleted until Stream confirms deletion.
CREATE TABLE message_videos (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  stream_uid TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('uploading','processing','ready','failed','deleting')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 104857600),
  stream_origin TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  error TEXT,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_message_videos_owner ON message_videos(user_id,state);
CREATE INDEX idx_message_videos_maintenance ON message_videos(state,checked_at);

CREATE TABLE video_daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  uploads INTEGER NOT NULL,
  PRIMARY KEY(user_id,day)
);

CREATE TRIGGER delete_message_video BEFORE DELETE ON messages BEGIN
  UPDATE message_videos SET state='deleting',checked_at=0 WHERE message_id=OLD.id;
END;
