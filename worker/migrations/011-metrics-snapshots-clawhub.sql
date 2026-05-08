-- ClawHub metrics_snapshots
-- Append-only time series of ClawHub skill metrics. Written on every cron
-- phase 1 run (BJT 04:00 + 16:00 = UTC 20:00 + 08:00) — 2 rows per skill per day.
--
-- Field shape diverges from gh / ph tables: ClawHub exposes 4 numeric metrics
-- worth tracking over time (stars / downloads / installs_current / installs_all_time).
-- comments / versions are static-ish counters and live in items.metrics single value.
--
-- Storage estimate: ~1200 skills × 2 snapshots/day × 30 days retention ≈ 72k rows
-- after warm-up. Cleanup cron (runCleanup, 03:35 UTC daily) sweeps rows older
-- than 30 days, same pattern as metrics_snapshots / refresh_log.

CREATE TABLE IF NOT EXISTS metrics_snapshots_clawhub (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,                 -- 'clawhub:<slug>' (matches items.id)
  captured_at INTEGER NOT NULL,          -- unix seconds
  stars INTEGER,
  downloads INTEGER,
  installs_current INTEGER,
  installs_all_time INTEGER
);

CREATE INDEX IF NOT EXISTS idx_msch_item_time ON metrics_snapshots_clawhub(item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_msch_captured ON metrics_snapshots_clawhub(captured_at);
