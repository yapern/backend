-- Preserve metadata and screenshot failure reasons across queued work and cache hits.
ALTER TABLE link_previews ADD COLUMN diagnostics TEXT;
