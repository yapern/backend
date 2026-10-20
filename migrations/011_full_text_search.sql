-- Reuse source text instead of storing another copy in each FTS table.
-- The hidden integer rowid joins the index to the existing public text IDs.
CREATE VIRTUAL TABLE boards_fts USING fts5(
  slug, name, description,
  content='boards', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TRIGGER boards_search_insert AFTER INSERT ON boards BEGIN
  INSERT INTO boards_fts(rowid, slug, name, description)
  VALUES (new.rowid, new.slug, new.name, new.description);
END;
CREATE TRIGGER boards_search_delete AFTER DELETE ON boards BEGIN
  INSERT INTO boards_fts(boards_fts, rowid, slug, name, description)
  VALUES ('delete', old.rowid, old.slug, old.name, old.description);
END;
CREATE TRIGGER boards_search_update AFTER UPDATE OF slug, name, description ON boards BEGIN
  INSERT INTO boards_fts(boards_fts, rowid, slug, name, description)
  VALUES ('delete', old.rowid, old.slug, old.name, old.description);
  INSERT INTO boards_fts(rowid, slug, name, description)
  VALUES (new.rowid, new.slug, new.name, new.description);
END;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  title, body,
  content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER messages_search_update AFTER UPDATE OF title, body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO messages_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Include content written before this migration, including the default board.
INSERT INTO boards_fts(boards_fts) VALUES ('rebuild');
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
