-- Votes are individual contributions. Keep zero-valued rows so a removed vote
-- cannot create another first-upvote notification for the same target.
CREATE TABLE message_votes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK(value IN (-1, 0, 1)),
  PRIMARY KEY(message_id, user_id)
);
CREATE TABLE reply_votes (
  reply_id TEXT NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK(value IN (-1, 0, 1)),
  PRIMARY KEY(reply_id, user_id)
);

INSERT INTO message_votes(message_id, user_id, value)
  SELECT id, user_id, 1 FROM messages;
INSERT INTO reply_votes(reply_id, user_id, value)
  SELECT id, user_id, 1 FROM replies;

CREATE TRIGGER seed_message_author_vote AFTER INSERT ON messages BEGIN
  INSERT INTO message_votes(message_id, user_id, value) VALUES(NEW.id, NEW.user_id, 1);
END;
CREATE TRIGGER seed_reply_author_vote AFTER INSERT ON replies BEGIN
  INSERT INTO reply_votes(reply_id, user_id, value) VALUES(NEW.id, NEW.user_id, 1);
END;

-- Rebuild to make reply_id nullable. Copy original IDs and timestamps so
-- existing acknowledgements and delivery retries retain their meaning.
DROP TRIGGER notify_message_reply;
CREATE TABLE notifications_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('reply', 'upvote')),
  reply_id TEXT REFERENCES replies(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivered_at TEXT,
  CHECK((kind = 'reply' AND reply_id IS NOT NULL AND message_id IS NULL AND actor_id IS NULL)
     OR (kind = 'upvote' AND actor_id IS NOT NULL AND ((reply_id IS NOT NULL) <> (message_id IS NOT NULL))))
);
INSERT INTO notifications_new(id,user_id,kind,reply_id,created_at,read_at,delivered_at)
  SELECT id,user_id,'reply',reply_id,created_at,read_at,delivered_at FROM notifications;
-- The largest ID may have been deleted. Keep the AUTOINCREMENT watermark so
-- a future notification cannot reuse an ID already acknowledged by a client.
DELETE FROM sqlite_sequence WHERE name='notifications_new';
INSERT INTO sqlite_sequence(name,seq)
  SELECT 'notifications_new',seq FROM sqlite_sequence WHERE name='notifications';
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_pending ON notifications(user_id, id) WHERE delivered_at IS NULL;
CREATE UNIQUE INDEX idx_notifications_reply_event ON notifications(reply_id) WHERE kind='reply';
CREATE UNIQUE INDEX idx_notifications_message_upvote ON notifications(actor_id,message_id) WHERE kind='upvote' AND message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_notifications_reply_upvote ON notifications(actor_id,reply_id) WHERE kind='upvote' AND reply_id IS NOT NULL;

CREATE TRIGGER notify_message_reply AFTER INSERT ON replies BEGIN
  INSERT INTO notifications(user_id,kind,reply_id,created_at)
    SELECT user_id,'reply',NEW.id,NEW.created_at FROM messages
    WHERE id=NEW.message_id AND user_id<>NEW.user_id;
END;
CREATE TRIGGER notify_message_upvote_insert AFTER INSERT ON message_votes WHEN NEW.value=1 BEGIN
  INSERT OR IGNORE INTO notifications(user_id,kind,message_id,actor_id,created_at)
    SELECT user_id,'upvote',NEW.message_id,NEW.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM messages WHERE id=NEW.message_id AND user_id<>NEW.user_id
      AND NOT EXISTS(SELECT 1 FROM notifications
        WHERE kind='upvote' AND actor_id=NEW.user_id AND message_id=NEW.message_id);
END;
CREATE TRIGGER notify_message_upvote_update AFTER UPDATE OF value ON message_votes
  WHEN OLD.value<>1 AND NEW.value=1 BEGIN
  INSERT OR IGNORE INTO notifications(user_id,kind,message_id,actor_id,created_at)
    SELECT user_id,'upvote',NEW.message_id,NEW.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM messages WHERE id=NEW.message_id AND user_id<>NEW.user_id
      AND NOT EXISTS(SELECT 1 FROM notifications
        WHERE kind='upvote' AND actor_id=NEW.user_id AND message_id=NEW.message_id);
END;
CREATE TRIGGER notify_reply_upvote_insert AFTER INSERT ON reply_votes WHEN NEW.value=1 BEGIN
  INSERT OR IGNORE INTO notifications(user_id,kind,reply_id,actor_id,created_at)
    SELECT user_id,'upvote',NEW.reply_id,NEW.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM replies WHERE id=NEW.reply_id AND user_id<>NEW.user_id
      AND NOT EXISTS(SELECT 1 FROM notifications
        WHERE kind='upvote' AND actor_id=NEW.user_id AND reply_id=NEW.reply_id);
END;
CREATE TRIGGER notify_reply_upvote_update AFTER UPDATE OF value ON reply_votes
  WHEN OLD.value<>1 AND NEW.value=1 BEGIN
  INSERT OR IGNORE INTO notifications(user_id,kind,reply_id,actor_id,created_at)
    SELECT user_id,'upvote',NEW.reply_id,NEW.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM replies WHERE id=NEW.reply_id AND user_id<>NEW.user_id
      AND NOT EXISTS(SELECT 1 FROM notifications
        WHERE kind='upvote' AND actor_id=NEW.user_id AND reply_id=NEW.reply_id);
END;
