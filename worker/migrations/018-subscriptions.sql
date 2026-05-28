-- migration 018: 订阅推送子系统(邮件 digest MVP)
-- 设计文档:roxor-main-design-20260528-090625.md
-- 三表:subscriptions(订阅关系)/ digest_pool(每节点每源榜单缓存)/ digest_send_log(投递记录)

-- 订阅关系。匿名订阅 user_id 为 NULL,邮件回流首次到访时回填(users.id 是 TEXT)。
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK(channel IN ('email','wechat')),
  sources TEXT NOT NULL,                              -- JSON: ["ph","gh"] 勾选的源,顺序=邮件内源排序
  send_slot INTEGER NOT NULL,                         -- 推送节点小时(BJT),∈ PUSH_SLOTS_BJT
  density TEXT NOT NULL CHECK(density IN ('normal','curated')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','unsubscribed','kicked','paused')),
    -- paused: runtime-only,worker_send_failures 兜底,运维介入,对外 API 归一成 active
  next_send_at INTEGER NOT NULL,                      -- UTC ms,创建/发送后重算
  last_sent_at INTEGER,
  bounce_count INTEGER NOT NULL DEFAULT 0,            -- 永久,Resend webhook 驱动,>=2 → kicked
  worker_send_failures INTEGER NOT NULL DEFAULT 0,    -- 瞬态,Step3 失败++,成功重置,>=5 → paused
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(email, channel)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_slot_active
  ON subscriptions(send_slot) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email);

-- 每节点每源榜单缓存。node-run workflow 算好后写入,deliver workflow 按 (slot_key, source, density) 读。
-- density 列同时承载 'meta' 行(slot_key, '_subject', 'meta')存节点级标题摘要。
CREATE TABLE IF NOT EXISTS digest_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL,                             -- 'YYYY-MM-DD-HH' BJT 日期+节点小时
  source TEXT NOT NULL,                               -- 源 key 或 '_subject'
  density TEXT NOT NULL,                              -- 'normal' | 'curated' | 'meta'
  item_ids TEXT NOT NULL,                             -- JSON array,已是该源该档全部条目(N 或 M 条)
  items_meta TEXT,                                    -- curated: {item_id: hook}+skipped;meta: {subject}
  generated_at INTEGER NOT NULL,
  UNIQUE(slot_key, source, density)                   -- 重跑用 ON CONFLICT DO UPDATE 覆盖
);
CREATE INDEX IF NOT EXISTS idx_digest_pool_slot ON digest_pool(slot_key, source);

-- 投递记录。Step0 幂等查询用 (subscription_id, slot_key, status='sent')。
CREATE TABLE IF NOT EXISTS digest_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  slot_key TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  items_count INTEGER NOT NULL,
  status TEXT NOT NULL,                               -- 'sent'|'no_items'|'failed_resend'|'welcome'
  content_hash TEXT,                                  -- observability only,非幂等键
  resend_message_id TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_digest_send_log_sub
  ON digest_send_log(subscription_id, slot_key, status);
