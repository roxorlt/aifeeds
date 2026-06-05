-- 2026-06-05 运营看板 X 卡片渲染状态表(自动池 + 手动)
-- 设计:docs/plans/2026-06-05-x-card-ops-render-design.md §2
CREATE TABLE IF NOT EXISTS x_card_renders (
  item_id     TEXT PRIMARY KEY,        -- x_list:<tweet_id>
  render_key  TEXT,                    -- tweet_id + 内容哈希(P3 生成)
  status      TEXT NOT NULL,           -- pending | rendering | ok | failed
  image_url   TEXT,                    -- 成功:https://api.ai-feeds.com/r/x-card/<key>.png
  error       TEXT,                    -- 失败原因
  source      TEXT NOT NULL,           -- pool-auto | manual
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,        -- 入队时间(unix)
  rendered_at INTEGER                  -- 出图时间(unix),面板显示"推送时间"
);
CREATE INDEX IF NOT EXISTS idx_x_card_renders_status ON x_card_renders(status, created_at);
