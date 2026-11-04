CREATE TABLE board_crawl_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES board_crawler_urls(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','blocked','failed')),
  added_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_board_crawl_jobs_active ON board_crawl_jobs(source_id)
  WHERE state IN ('queued','running');
CREATE INDEX idx_board_crawl_jobs_source ON board_crawl_jobs(source_id, created_at DESC);
CREATE INDEX idx_board_crawl_jobs_recovery ON board_crawl_jobs(state, lease_until);
CREATE INDEX idx_board_crawl_jobs_user ON board_crawl_jobs(user_id, created_at);

-- Keep the discovery record after a message is deleted so a later crawl cannot
-- recreate a deliberately removed message. Deduplication also spans source URLs.
CREATE TABLE board_crawled_articles (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source_id TEXT REFERENCES board_crawler_urls(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(board_id, url)
);
