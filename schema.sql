CREATE TABLE IF NOT EXISTS links (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  project TEXT DEFAULT 'default',
  created_at INTEGER DEFAULT (unixepoch())
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_links_project ON links(project);