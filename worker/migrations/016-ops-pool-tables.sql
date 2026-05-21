-- 运营看板内容池 v1 (Phase 1)
-- 设计：docs/plans/2026-05-21-ops-pool-design.md
-- 一处坑全坑：所有 cron / SQL 必须 `WHERE is_relevant = 1`

-- 1) 滑动基线快照（每日重算覆盖）
CREATE TABLE IF NOT EXISTS ops_pool_baseline (
  source_type TEXT NOT NULL,
  metric_key TEXT NOT NULL,     -- 'score_p90' / 'score_p99' / 'rate_p95' / 'rate_p99'
  value REAL NOT NULL,
  computed_at INTEGER NOT NULL, -- unix sec
  sample_size INTEGER,
  PRIMARY KEY (source_type, metric_key)
);

-- 2) 池子条目（爆推 / 趋势推 / 发现博主）
-- hot 不进此表（量大、状态而非事件），通过 items.is_hot 直接查
-- 发现博主 item_id 用 'handle:<handle>' 形式（hack 重用主键）
CREATE TABLE IF NOT EXISTS ops_pool_items (
  pool_type TEXT NOT NULL,      -- 'baopui' | 'trend' | 'discover'
  item_id TEXT NOT NULL,
  payload TEXT,                 -- JSON 含 score / rate / dilution / etc
  added_at INTEGER NOT NULL,    -- unix sec 首次进池
  pushed_at INTEGER,            -- pushdeer 推送时间，NULL = 未推
  PRIMARY KEY (pool_type, item_id)
);

CREATE INDEX IF NOT EXISTS ops_pool_added ON ops_pool_items(pool_type, added_at DESC);

-- 3) items 加 is_hot 列（feed UI 直读不用 join）
-- 部分 D1 实例不支持 ADD COLUMN IF NOT EXISTS，先 try 再忽略错误（手动跑时如已存在跳过即可）
ALTER TABLE items ADD COLUMN is_hot INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS items_is_hot ON items(is_hot) WHERE is_hot = 1;
