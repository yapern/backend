-- Keep the object key after account deletion so scheduled cleanup can remove R2
-- objects. Public image reads always join the live user.
CREATE TABLE link_previews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  favicon TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'ready', 'failed')),
  object_key TEXT,
  error TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, url_hash)
);
CREATE INDEX idx_link_previews_expiry ON link_previews(expires_at);

CREATE TABLE preview_daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  jobs INTEGER NOT NULL DEFAULT 0 CHECK(jobs >= 0),
  PRIMARY KEY(user_id, day)
);
