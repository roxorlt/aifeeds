-- migration 021: 邮件回流落地记录(email_landings)
-- 用途:admin 订阅页「邮件回流」section 的精确归因。邮件每条内容链接都走
-- /api/digest/return?u=<token>(见 digest/templates.ts itemLink/enterLink),
-- handleDigestReturn 验 token 后服务端即知 subId+userId+email,在那里 ctx.waitUntil 插一条。
-- 配 digest_send_log(发送)算 发送→回流→回流率;user_id 关联 events.user_id 进一步算
-- 「落地后是否真浏览」(landed 用户落地后有无站内 interact 行为)。

CREATE TABLE IF NOT EXISTS email_landings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER REFERENCES subscriptions(id),  -- 理论上 token 必含 subId,留空仅作容错
  user_id TEXT REFERENCES users(id),                     -- 邮件 token 隐式登录的 user(关联 events.user_id)
  email TEXT NOT NULL,
  to_path TEXT,                                          -- 落地深链 path(/ph/... 或 /)
  landed_at INTEGER NOT NULL,                            -- UTC ms
  day TEXT NOT NULL,                                     -- 'YYYY-MM-DD' BJT,按天聚合用
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_landings_day ON email_landings(day);
CREATE INDEX IF NOT EXISTS idx_email_landings_sub ON email_landings(subscription_id, landed_at);
CREATE INDEX IF NOT EXISTS idx_email_landings_user ON email_landings(user_id, landed_at);
