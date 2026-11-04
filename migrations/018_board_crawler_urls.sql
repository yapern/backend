-- Source URLs configured by each board's owner for the crawler.
CREATE TABLE board_crawler_urls (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(board_id, url)
);

CREATE INDEX idx_board_crawler_urls_board_created
  ON board_crawler_urls(board_id, created_at);
