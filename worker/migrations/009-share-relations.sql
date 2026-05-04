-- PR5 share feature: share_relations
-- 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 2.1
--
-- 一条 row = 一次分享行为（分享人 + 内容 + 短码）。落地用户首次扫码补 to_did + landed_at；
-- 落地用户后续注册补 to_uid + registered_at。多次扫码累计 scan_count / last_scanned_at。

CREATE TABLE IF NOT EXISTS share_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,            -- nanoid(8) 短码
  from_uid TEXT NOT NULL,                -- 分享人 user.id
  item_id TEXT NOT NULL,                 -- 被分享内容 composite id
  shared_at INTEGER NOT NULL,            -- 创建时间 ms

  -- 落地后填
  to_did TEXT,                           -- 落地浏览器 device_id（首次扫码）
  to_uid TEXT,                           -- 落地用户后续注册的 user.id
  landed_at INTEGER,                     -- 首次扫码落地时间
  registered_at INTEGER,                 -- 落地后该 did 注册时间

  -- 多次扫码统计
  scan_count INTEGER NOT NULL DEFAULT 0, -- 累计扫码次数（每次 GET /s/:token +1）
  last_scanned_at INTEGER                -- 最近一次扫码时间
);

-- 短码查询（高频，每次 /s/:token 命中）
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_token ON share_relations(token);

-- 分享人时间线（admin / 未来推荐场景）
CREATE INDEX IF NOT EXISTS idx_share_from_uid_time ON share_relations(from_uid, shared_at DESC);

-- 内容维度（看一条 item 被分享了多少次）
CREATE INDEX IF NOT EXISTS idx_share_item_time ON share_relations(item_id, shared_at DESC);

-- 落地 device_id 反查（注册时回填 to_uid）
CREATE INDEX IF NOT EXISTS idx_share_to_did ON share_relations(to_did) WHERE to_did IS NOT NULL;
