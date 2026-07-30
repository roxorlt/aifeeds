CREATE TABLE IF NOT EXISTS daily_news_review_batches (
  review_date TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  candidate_ids TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  default_selected_ids TEXT NOT NULL,
  applied_selected_ids TEXT,
  selection_hash TEXT,
  edit_revision INTEGER NOT NULL DEFAULT 0,
  publish_status TEXT NOT NULL DEFAULT 'not_requested',
  publish_error TEXT,
  published_at INTEGER,
  notified_at INTEGER,
  notification_hash TEXT,
  auto_repaired_from_batch TEXT,
  auto_repaired_invalid_ids TEXT,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (review_date, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_news_review_active
  ON daily_news_review_batches(review_date, superseded_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_news_review_applied
  ON daily_news_review_batches(review_date, applied_selected_ids, published_at DESC, created_at DESC);
