-- PR1: events 表 — 完整产品行为 telemetry 落地点
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.5

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  user_id TEXT,
  session_token_hash TEXT,
  event_type TEXT NOT NULL,
  event_payload TEXT,
  ip TEXT,
  ua TEXT,
  referer TEXT,
  page_path TEXT,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_did_time ON events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_path_time ON events(page_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_ingested ON events(ingested_at DESC);
