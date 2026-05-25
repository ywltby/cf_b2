CREATE TABLE IF NOT EXISTS links (
  id        TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL,
  p         TEXT NOT NULL,
  exp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_exp ON links(exp);
