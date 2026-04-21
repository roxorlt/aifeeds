-- xList D1 Schema
-- 统一内容模型，支持多数据源

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_ref TEXT,
  title TEXT,
  content TEXT,
  content_translated TEXT,
  author TEXT,
  handle TEXT,
  url TEXT,
  media TEXT,
  metrics TEXT,
  published_at TEXT,
  scraped_at TEXT NOT NULL,
  is_relevant INTEGER DEFAULT 1,
  matched_by TEXT,
  lang TEXT,
  extra TEXT,
  translation_quality TEXT,
  translation_attempts INTEGER DEFAULT 0,
  UNIQUE(source_type, source_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  name TEXT,
  topic TEXT,
  cursor TEXT,
  last_success_at TEXT,
  config TEXT,
  UNIQUE(source_type, source_ref)
);

CREATE TABLE IF NOT EXISTS run_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  new_count INTEGER,
  relevant_count INTEGER,
  stop_reason TEXT,
  duration_s INTEGER
);

CREATE INDEX IF NOT EXISTS idx_items_scraped ON items(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source_scraped ON items(source_type, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_relevant ON items(is_relevant, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);

-- Enrich state: per-mode progress for CF Worker cron-based enrichment
-- (replaces data/enrich_state/*.json from the Python script)
-- state JSON shape: {processed_ids:[], failed_ids:[], not_found_ids:[], started_at, last_update, counts:{...}}
CREATE TABLE IF NOT EXISTS enrich_state (
  mode TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
