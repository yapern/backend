-- A reply and its recipient's unread notification commit together, even when
-- nobody is connected or realtime delivery is temporarily unavailable.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_id TEXT NOT NULL UNIQUE REFERENCES replies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivered_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_pending ON notifications(user_id, id) WHERE delivered_at IS NULL;

CREATE TRIGGER notify_message_reply AFTER INSERT ON replies
BEGIN
  INSERT INTO notifications(user_id, reply_id, created_at)
    SELECT user_id, NEW.id, NEW.created_at FROM messages
    WHERE id = NEW.message_id AND user_id <> NEW.user_id;
END;
