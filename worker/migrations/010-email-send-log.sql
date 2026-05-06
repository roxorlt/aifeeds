-- 010: email_send_log（email 验证码风控审计日志）
-- 设计参考：docs/plans/2026-05-06-email-auth-design.md § 3.1
-- 与 sms_send_log 完全对称（identifier 字段名 phone → email），独立维度统计

CREATE TABLE IF NOT EXISTS email_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,
  result TEXT NOT NULL,
    -- 'success'
    -- | 'turnstile_failed'
    -- | 'rate_limited'
    -- | 'disposable_blocked'
    -- | 'mx_failed'
    -- | 'budget_capped'
    -- | 'resend_api_error'
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  code_used_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_email_sent ON email_send_log(email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_ip_sent ON email_send_log(ip, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_device_sent ON email_send_log(device_id, sent_at DESC);
