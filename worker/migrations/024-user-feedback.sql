-- 024: user feedback —— C 端用户反馈 + 后台图文回复。
-- 限频:每账号每 BJT 自然日最多 3 条(服务端 COUNT day 列)。
-- 设计:docs/plans/2026-07-05-user-feedback-design.md

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,          -- users.id
  content       TEXT NOT NULL,          -- 反馈文字(trim 后 ≤2000)
  image_key     TEXT,                   -- R2 key: feedback/<sha256>.<ext>,无图 NULL
  device_info   TEXT,                   -- JSON {client:{...前端上报}, server:{ip,ua,country,colo,asn}}
  account_info  TEXT,                   -- JSON 提交时账号快照 {display_name, identities:[{provider,identity_value}]}
  ip            TEXT,
  ua            TEXT,
  day           TEXT NOT NULL,          -- 北京时区 YYYY-MM-DD(限频)
  created_at    INTEGER NOT NULL,       -- ms
  last_reply_at INTEGER                 -- 最近官方回复时间,NULL=未回复
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_day ON feedback(user_id, day);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

CREATE TABLE IF NOT EXISTS feedback_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id  INTEGER NOT NULL,        -- feedback.id
  content      TEXT NOT NULL,           -- 回复文字(≤5000)
  image_key    TEXT,                    -- 可选回复配图,同 R2 规则
  admin_email  TEXT,                    -- 回复人(CF Access JWT email;Basic 兜底时 NULL)
  created_at   INTEGER NOT NULL,        -- ms
  read_at      INTEGER                  -- 用户已读时间,NULL=未读
);
CREATE INDEX IF NOT EXISTS idx_feedback_replies_fb ON feedback_replies(feedback_id);
