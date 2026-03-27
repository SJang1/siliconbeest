-- Media proxy cache: stores mapping of remote URLs to cached R2 objects
CREATE TABLE IF NOT EXISTS media_proxy_cache (
  id TEXT PRIMARY KEY,
  remote_url TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_media_proxy_url ON media_proxy_cache(remote_url);
