CREATE TABLE IF NOT EXISTS shortlinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'category', 'brand', 'shortcode')),
  entity_id TEXT,
  app_path TEXT NOT NULL,
  web_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON shortlinks(code);
CREATE INDEX IF NOT EXISTS idx_shortlinks_entity_type_id ON shortlinks(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_shortlinks_active ON shortlinks(is_active);
