ALTER TABLE users ADD COLUMN email_notify_replies INTEGER NOT NULL DEFAULT 1
  CHECK (email_notify_replies IN (0, 1));
ALTER TABLE users ADD COLUMN email_notify_votes INTEGER NOT NULL DEFAULT 1
  CHECK (email_notify_votes IN (0, 1));
ALTER TABLE users ADD COLUMN email_notify_sub_yap_messages INTEGER NOT NULL DEFAULT 1
  CHECK (email_notify_sub_yap_messages IN (0, 1));

-- Remember participation even if a user's message or reply is later deleted.
CREATE TABLE board_participants (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, user_id)
);
INSERT INTO board_participants(board_id,user_id)
  SELECT board_id,user_id FROM messages
  UNION
  SELECT m.board_id,r.user_id FROM replies r JOIN messages m ON m.id=r.message_id;
CREATE TRIGGER record_message_participant AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO board_participants(board_id,user_id) VALUES(NEW.board_id,NEW.user_id);
END;
CREATE TRIGGER record_reply_participant AFTER INSERT ON replies BEGIN
  INSERT OR IGNORE INTO board_participants(board_id,user_id)
    SELECT board_id,NEW.user_id FROM messages WHERE id=NEW.message_id;
END;

-- Commit email jobs with their event, including image/video posts. Do not
-- backfill jobs for historical activity when this migration is applied.
CREATE TABLE email_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'upvote', 'downvote', 'new_message')),
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reply_id TEXT REFERENCES replies(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  completed_at INTEGER
);
CREATE INDEX idx_email_notifications_pending ON email_notifications(available_at, id)
  WHERE completed_at IS NULL;
CREATE INDEX idx_email_notifications_completed ON email_notifications(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE TRIGGER email_message_reply AFTER INSERT ON replies BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id,reply_id)
    SELECT u.id,NEW.user_id,'reply',NEW.message_id,NEW.id
    FROM messages m LEFT JOIN replies p ON p.id=NEW.parent_reply_id
    JOIN users u ON u.id=COALESCE(p.user_id,m.user_id)
    WHERE m.id=NEW.message_id AND u.id<>NEW.user_id
      AND u.email_notify_replies=1 AND length(trim(u.email))>0;
END;

CREATE TRIGGER email_new_message AFTER INSERT ON messages BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id)
    SELECT u.id,NEW.user_id,'new_message',NEW.id FROM users u
    WHERE u.id<>NEW.user_id AND u.email_notify_sub_yap_messages=1
      AND length(trim(u.email))>0 AND u.id IN (
        SELECT user_id FROM board_participants WHERE board_id=NEW.board_id
      );
END;

CREATE TRIGGER email_message_vote_insert AFTER INSERT ON message_votes
  WHEN NEW.value<>0 BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id)
    SELECT u.id,NEW.user_id,CASE NEW.value WHEN 1 THEN 'upvote' ELSE 'downvote' END,m.id
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.id=NEW.message_id AND u.id<>NEW.user_id
      AND u.email_notify_votes=1 AND length(trim(u.email))>0;
END;
CREATE TRIGGER email_message_vote_update AFTER UPDATE OF value ON message_votes
  WHEN NEW.value<>0 AND NEW.value<>OLD.value BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id)
    SELECT u.id,NEW.user_id,CASE NEW.value WHEN 1 THEN 'upvote' ELSE 'downvote' END,m.id
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.id=NEW.message_id AND u.id<>NEW.user_id
      AND u.email_notify_votes=1 AND length(trim(u.email))>0;
END;
CREATE TRIGGER email_reply_vote_insert AFTER INSERT ON reply_votes
  WHEN NEW.value<>0 BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id,reply_id)
    SELECT u.id,NEW.user_id,CASE NEW.value WHEN 1 THEN 'upvote' ELSE 'downvote' END,r.message_id,r.id
    FROM replies r JOIN users u ON u.id=r.user_id
    WHERE r.id=NEW.reply_id AND u.id<>NEW.user_id
      AND u.email_notify_votes=1 AND length(trim(u.email))>0;
END;
CREATE TRIGGER email_reply_vote_update AFTER UPDATE OF value ON reply_votes
  WHEN NEW.value<>0 AND NEW.value<>OLD.value BEGIN
  INSERT INTO email_notifications(user_id,actor_id,kind,message_id,reply_id)
    SELECT u.id,NEW.user_id,CASE NEW.value WHEN 1 THEN 'upvote' ELSE 'downvote' END,r.message_id,r.id
    FROM replies r JOIN users u ON u.id=r.user_id
    WHERE r.id=NEW.reply_id AND u.id<>NEW.user_id
      AND u.email_notify_votes=1 AND length(trim(u.email))>0;
END;
