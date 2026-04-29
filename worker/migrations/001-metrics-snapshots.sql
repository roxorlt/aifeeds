-- M1.5: metrics_snapshots table
-- Append-only time series of (item_id, likes, retweets, replies, bookmarks, views).
-- Written on every items.metrics overwrite in runRefreshMetrics so we can
-- compute real Δlikes/Δtime once 1-2 weeks of data accumulate (feeds into M5
-- tier threshold recalibration).
--
-- Retention: 30 days (enforced by a scheduled cleanup job, TBD in M5).
-- Storage estimate: 1369 items × 7 refreshes/day × 30 days ≈ 290k rows ≈ 20MB.

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
