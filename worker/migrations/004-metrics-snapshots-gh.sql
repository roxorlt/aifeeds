-- M4: metrics_snapshots_gh table
-- Append-only time series of GitHub repo metrics. Written on every cron run
-- (BJT 01:00 + 13:00) into the github source ingest endpoint.
--
-- Why a separate table from metrics_snapshots:
--   - X metrics: likes/retweets/replies/views (chrome scrape, rate-limited)
--   - GitHub metrics: stars/forks/watchers/issues/PRs (API, 5000/hr)
--   - Field shapes diverge; merging would force NULL columns and complicate queries
--
-- Future PH/arXiv/podcast each get their own metrics_snapshots_<source> table.
--
-- Retention: TBD (mirror metrics_snapshots' 30 days when cleanup job lands).
-- Storage estimate: ~10 AI repos/day × 2 cron × 7 day window × 30 days ≈ 4.2k rows ≈ small.

CREATE TABLE IF NOT EXISTS metrics_snapshots_gh (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,                 -- 'gh:owner/repo' (matches items.id)
  captured_at INTEGER NOT NULL,          -- unix seconds
  trending_date_str TEXT,                -- 'YYYY-MM-DD' BJT (handy for daily group-by)
  total_stars INTEGER,
  today_stars INTEGER,
  forks INTEGER,
  watchers INTEGER,
  open_issues INTEGER,
  open_prs INTEGER
);

CREATE INDEX IF NOT EXISTS idx_msgh_item_time ON metrics_snapshots_gh(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_msgh_trending_date ON metrics_snapshots_gh(trending_date_str);
