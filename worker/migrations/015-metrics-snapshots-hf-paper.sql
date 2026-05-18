-- M15: metrics_snapshots_hf_paper table
-- Append-only time series of HuggingFace Daily Papers metrics. Written on
-- every cron run (daily, BJT 08:00 = UTC 00:00) by runHfDailyFetch.
--
-- Field shape diverges from other sources (X likes/retweets / GH stars/forks /
-- PH votes/comments) so use a dedicated table per source-integration SOP.
--
-- Tracked metrics:
--   - upvotes:      HF Daily upvotes (paper.upvotes)
--   - num_comments: discussion comment count (top-level numComments)
--   - github_stars: paper-linked GitHub stars (HF API githubStars, 已抓好不用 GH API)
--
-- Retention: 30 days (mirror metrics_snapshots' window when cleanup job lands).
-- Storage estimate: 50 papers/day × 30 days × 12 months ≈ 18k rows/year. Tiny.

CREATE TABLE IF NOT EXISTS metrics_snapshots_hf_paper (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,                 -- 'hf_paper:<arxiv_id>' (matches items.id)
  captured_at INTEGER NOT NULL,          -- unix seconds
  upvotes INTEGER,
  num_comments INTEGER,
  github_stars INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mshf_item_time ON metrics_snapshots_hf_paper(item_id, captured_at);
