-- 029: .cc 内容镜像审核、人工覆盖、页面状态与增量变更事件。

CREATE TABLE IF NOT EXISTS cc_item_reviews (
  item_id TEXT PRIMARY KEY,
  policy_version INTEGER NOT NULL,
  source_policy TEXT NOT NULL,
  review_status TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  review_text_hash TEXT NOT NULL,
  model TEXT,
  reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_reviews_status
  ON cc_item_reviews(review_status, reviewed_at);

CREATE TABLE IF NOT EXISTS cc_item_overrides (
  item_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  decision_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cc_item_pages (
  item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url_path TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  content_hash TEXT,
  title TEXT NOT NULL,
  published_at TEXT,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_pages_status_source
  ON cc_item_pages(status, source, generated_at);

CREATE TABLE IF NOT EXISTS cc_page_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  op TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_page_events_item
  ON cc_page_events(item_id, seq);
