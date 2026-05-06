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

-- M8: PH 单独维度（votes / comments / reviews / followers / daily_rank）
CREATE TABLE IF NOT EXISTS metrics_snapshots_ph (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  launch_date_pt TEXT,
  votes INTEGER,
  comments_count INTEGER,
  reviews_count INTEGER,
  reviews_avg REAL,
  followers INTEGER,
  daily_rank INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msph_item_time ON metrics_snapshots_ph(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_msph_launch_date ON metrics_snapshots_ph(launch_date_pt);

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

-- PR1: events 表 — 完整产品行为 telemetry 落地点
-- 详见 migrations/004-events-table.sql
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

-- PR2: 用户身份三张核心表
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.1-3.3

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  banned_reason TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);

CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  unbound_at INTEGER,
  metadata TEXT,
  UNIQUE(provider, identity_value, unbound_at)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE INDEX IF NOT EXISTS idx_identities_provider_value ON identities(provider, identity_value);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  ip TEXT,
  ua TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- PR2: sms_send_log 表 — 短信发送日志 + 防刷计数 + 验证码 hash
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.4

CREATE TABLE IF NOT EXISTS sms_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_used_at INTEGER,
  code_attempts INTEGER DEFAULT 0,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_phone_time ON sms_send_log(phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_ip_time ON sms_send_log(ip, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_device_time ON sms_send_log(device_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_sent_at ON sms_send_log(sent_at DESC);

-- 010: email_send_log 表 — email 验证码风控审计日志
-- 与 sms_send_log 完全对称（identifier 字段名 phone → email），独立维度统计

CREATE TABLE IF NOT EXISTS email_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  code_used_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_email_sent ON email_send_log(email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_ip_sent ON email_send_log(ip, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_device_sent ON email_send_log(device_id, sent_at DESC);
