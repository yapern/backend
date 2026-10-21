-- Existing replies remain direct children of their original message. Keep the
-- root message on every row so thread reads, votes and deep links stay simple.
-- A single reply cannot be deleted while others depend on it. Deleting the
-- message still removes every reply through the existing root-message FK.
ALTER TABLE replies ADD COLUMN parent_reply_id TEXT REFERENCES replies(id) ON DELETE NO ACTION;
ALTER TABLE replies ADD COLUMN direct_reply_count INTEGER NOT NULL DEFAULT 0
  CHECK(direct_reply_count >= 0);
ALTER TABLE replies ADD COLUMN idempotency_key TEXT;
ALTER TABLE replies ADD COLUMN vote_score INTEGER NOT NULL DEFAULT 0;
UPDATE replies SET vote_score=COALESCE((SELECT SUM(value) FROM reply_votes WHERE reply_id=replies.id),0);
CREATE INDEX idx_replies_parent_reply_id ON replies(parent_reply_id);
CREATE INDEX idx_replies_thread_parent_created ON replies(message_id,parent_reply_id,created_at,id);
CREATE INDEX idx_replies_thread_parent_score ON replies(message_id,parent_reply_id,vote_score,id);
CREATE UNIQUE INDEX idx_replies_idempotency ON replies(user_id,idempotency_key);

-- A parent must already exist in the same thread. Together with immutable
-- thread pointers, this prevents self-links, cycles and cross-message trees.
CREATE TRIGGER validate_reply_parent BEFORE INSERT ON replies
  WHEN NEW.parent_reply_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'invalid_reply_parent') WHERE NOT EXISTS (
    SELECT 1 FROM replies WHERE id=NEW.parent_reply_id
      AND message_id=NEW.message_id AND id<>NEW.id
  );
END;
-- REPLACE deletes/reinserts instead of running UPDATE triggers. Reject an
-- existing identity so it cannot bypass the immutable thread pointers below.
CREATE TRIGGER preserve_reply_identity BEFORE INSERT ON replies
  WHEN EXISTS(SELECT 1 FROM replies WHERE id=NEW.id) BEGIN
  SELECT RAISE(ABORT, 'reply_thread_is_immutable');
END;
CREATE TRIGGER preserve_reply_thread BEFORE UPDATE OF id,message_id,parent_reply_id,idempotency_key ON replies
  WHEN OLD.id<>NEW.id OR OLD.message_id<>NEW.message_id
    OR OLD.parent_reply_id IS NOT NEW.parent_reply_id
    OR OLD.idempotency_key IS NOT NEW.idempotency_key BEGIN
  SELECT RAISE(ABORT, 'reply_thread_is_immutable');
END;

-- Message counters from migration 013 already include every reply in a thread.
-- Reply counters count immediate children only. Updating one parent is O(1)
-- regardless of depth, and commits atomically with the insert/delete.
CREATE TRIGGER increment_direct_reply_count AFTER INSERT ON replies
  WHEN NEW.parent_reply_id IS NOT NULL BEGIN
  UPDATE replies SET direct_reply_count=direct_reply_count+1 WHERE id=NEW.parent_reply_id;
END;
CREATE TRIGGER decrement_direct_reply_count AFTER DELETE ON replies
  WHEN OLD.parent_reply_id IS NOT NULL BEGIN
  UPDATE replies SET direct_reply_count=direct_reply_count-1 WHERE id=OLD.parent_reply_id;
END;

-- Top pages read an indexed stored score instead of summing every sibling's
-- votes. Author seed votes use these same triggers; neutral votes contribute 0.
CREATE TRIGGER increment_reply_vote_score AFTER INSERT ON reply_votes BEGIN
  UPDATE replies SET vote_score=vote_score+NEW.value WHERE id=NEW.reply_id;
END;
CREATE TRIGGER update_reply_vote_score AFTER UPDATE OF value,reply_id ON reply_votes BEGIN
  UPDATE replies SET vote_score=vote_score-OLD.value WHERE id=OLD.reply_id;
  UPDATE replies SET vote_score=vote_score+NEW.value WHERE id=NEW.reply_id;
END;
CREATE TRIGGER decrement_reply_vote_score AFTER DELETE ON reply_votes BEGIN
  UPDATE replies SET vote_score=vote_score-OLD.value WHERE id=OLD.reply_id;
END;

-- Notify the author being answered, suppressing self-replies. Root-message
-- authors are not notified for every exchange elsewhere in their thread.
DROP TRIGGER notify_message_reply;
CREATE TRIGGER notify_message_reply AFTER INSERT ON replies BEGIN
  INSERT INTO notifications(user_id,kind,reply_id,created_at)
    SELECT user_id,'reply',NEW.id,NEW.created_at FROM messages
      WHERE NEW.parent_reply_id IS NULL AND id=NEW.message_id AND user_id<>NEW.user_id
    UNION ALL
    SELECT user_id,'reply',NEW.id,NEW.created_at FROM replies
      WHERE id=NEW.parent_reply_id AND user_id<>NEW.user_id;
END;
