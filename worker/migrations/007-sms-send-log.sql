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
