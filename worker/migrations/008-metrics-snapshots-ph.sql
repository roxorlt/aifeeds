-- M8: metrics_snapshots_ph table
-- Append-only time series of Product Hunt launch metrics. Written on every
-- cron run by the PH ingest module — once per day for 14 days after each
-- launch's launch_date_pt, then frozen (no further append, history kept).
--
-- Field shape diverges from gh table: votes / comments / reviews / followers
-- + daily_rank — so use a dedicated table per source-integration SOP.
--
-- Storage estimate: 30 launches/day × 14 days history per launch × 365 days ≈
-- 153k rows after first year. Very small.

CREATE TABLE IF NOT EXISTS metrics_snapshots_ph (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,                 -- 'product_hunt:<slug>:<launch_date>' (matches items.id)
  captured_at INTEGER NOT NULL,          -- unix seconds
  launch_date_pt TEXT,                   -- 'YYYY-MM-DD' PT (denormalised for daily group-by)
  votes INTEGER,
  comments_count INTEGER,
  reviews_count INTEGER,
  reviews_avg REAL,
  followers INTEGER,
  daily_rank INTEGER
);

CREATE INDEX IF NOT EXISTS idx_msph_item_time ON metrics_snapshots_ph(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_msph_launch_date ON metrics_snapshots_ph(launch_date_pt);
