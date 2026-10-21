-- Backfill once; message reads use this stored total without scanning replies.
ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0
  CHECK(reply_count >= 0);

UPDATE messages SET reply_count = (
  SELECT COUNT(*) FROM replies WHERE message_id = messages.id
);

-- Keep totals in the same transaction as the reply, including direct SQL writes.
CREATE TRIGGER increment_message_reply_count AFTER INSERT ON replies BEGIN
  UPDATE messages SET reply_count = reply_count + 1 WHERE id = NEW.message_id;
END;

CREATE TRIGGER decrement_message_reply_count AFTER DELETE ON replies BEGIN
  UPDATE messages SET reply_count = reply_count - 1 WHERE id = OLD.message_id;
END;

CREATE TRIGGER move_message_reply_count AFTER UPDATE OF message_id ON replies
  WHEN OLD.message_id <> NEW.message_id BEGIN
  UPDATE messages SET reply_count = reply_count - 1 WHERE id = OLD.message_id;
  UPDATE messages SET reply_count = reply_count + 1 WHERE id = NEW.message_id;
END;
