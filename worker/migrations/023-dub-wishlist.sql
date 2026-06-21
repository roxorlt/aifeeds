-- 023: dub_wishlist —— 「翻译成中文音频」假门按钮(painted door)的需求信号。
-- 点击只记录「有人想要」,不真做配音。一台设备(X-Device-Id)对一集只计一次(UNIQUE)。
-- 计数只在 admin 看板读,不暴露给 C 端。
-- 设计:docs/plans/2026-06-20-podcast-dubbing-cost-and-painted-door.md

CREATE TABLE IF NOT EXISTS dub_wishlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,          -- 匿名设备 id(始终有),复用前端 getDeviceId()
  user_id     TEXT,                   -- 登录则带(可空),做更精归因
  created_at  INTEGER NOT NULL,       -- ms
  day         TEXT NOT NULL,          -- 北京时区 YYYY-MM-DD,做 cohort/趋势
  ip          TEXT,
  ua          TEXT,
  UNIQUE(item_id, device_id)          -- 去重:一台设备对一集只计一次
);

CREATE INDEX IF NOT EXISTS idx_dub_wishlist_item ON dub_wishlist(item_id);
CREATE INDEX IF NOT EXISTS idx_dub_wishlist_day ON dub_wishlist(day);
