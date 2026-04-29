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
  -- M3: tiered refresh scheduling (see docs/plans/2026-04-23-enricher-daemon.md)
  tier INTEGER DEFAULT 0,
  next_refresh_at INTEGER,
  last_velocity REAL DEFAULT 0,
  deleted_at INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_items_next_refresh ON items(next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);

-- Enrich state: per-mode progress for CF Worker cron-based enrichment
-- (replaces data/enrich_state/*.json from the Python script)
-- state JSON shape: {processed_ids:[], failed_ids:[], not_found_ids:[], started_at, last_update, counts:{...}}
CREATE TABLE IF NOT EXISTS enrich_state (
  mode TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- M1.5: Append-only metrics snapshots. One row per refresh-metrics write
-- so we can compute real Δlikes/Δtime over time (feeds tier recalibration in M5).
-- See migrations/001-metrics-snapshots.sql for rationale.
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  likes INTEGER,
  retweets INTEGER,
  replies INTEGER,
  bookmarks INTEGER,
  views INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_time ON metrics_snapshots(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON metrics_snapshots(captured_at);

-- M3: Per-invocation refresh observability (tier-indexed).
CREATE TABLE IF NOT EXISTS refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refreshed_at INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  items_count INTEGER NOT NULL,
  subrequests_used INTEGER NOT NULL,
  duration_ms INTEGER,
  errors INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_refresh_log_time ON refresh_log(refreshed_at);
