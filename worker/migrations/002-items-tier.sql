-- M3: Add tier-based refresh scheduling columns to items + refresh_log table.
-- See docs/plans/2026-04-23-enricher-daemon.md
--
-- tier:          current tier label (0-5), determines refresh interval
-- next_refresh_at: unix ts when this item is eligible for refresh (L5 = NULL)
-- last_velocity: likes/min on the most recent observed window (M3 回填用累积均值，
--                M4 上线 runRefreshTiered 后换成真 Δlikes/Δt from metrics_snapshots)
-- deleted_at:    unix ts when syndication API returned 404 → frontend feed 过滤

ALTER TABLE items ADD COLUMN tier INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN next_refresh_at INTEGER;
ALTER TABLE items ADD COLUMN last_velocity REAL DEFAULT 0;
ALTER TABLE items ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_items_next_refresh ON items(next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);

-- refresh_log: per-invocation observability for runRefreshTiered.
-- One row per (refresh invocation × tier) so we can aggregate CF quota usage
-- by tier and see whether hot tiers get the share they deserve.
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
