-- Track uploaded message images separately from body links for safe cleanup.
ALTER TABLE messages ADD COLUMN image_url TEXT;
