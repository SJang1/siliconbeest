CREATE TABLE preview_cards (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'link',
  author_name TEXT DEFAULT '',
  author_url TEXT DEFAULT '',
  provider_name TEXT DEFAULT '',
  provider_url TEXT DEFAULT '',
  image_url TEXT,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  html TEXT DEFAULT '',
  embed_url TEXT DEFAULT '',
  blurhash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_preview_cards_url ON preview_cards(url);

CREATE TABLE status_preview_cards (
  status_id TEXT NOT NULL REFERENCES statuses(id),
  preview_card_id TEXT NOT NULL REFERENCES preview_cards(id),
  PRIMARY KEY (status_id, preview_card_id)
);
