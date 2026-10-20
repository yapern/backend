-- Email credentials are separate so legacy user records cannot be claimed by
-- supplying an arbitrary password to the combined login/signup endpoint.
CREATE TABLE email_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Keys are SHA-256 digests of normalized email addresses or client IPs.
-- One row per key is updated atomically for each fixed one-minute window.
CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE INDEX idx_auth_rate_limits_window_start ON auth_rate_limits(window_start);
