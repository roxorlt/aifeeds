-- M17: X list 抓取游标驱动改造
--
-- 设计文档: docs/plans/2026-05-22-x-list-cursor-driven-design.md
-- 触发: 2026-05-21 实测确认 ScrapeBadger /lists/{id}/tweets 是严格时间倒序，
--       从「固定 maxPages=3 + 早停」改为「游标驱动 + seen_set 10 个 id 命中即停」。
--
-- 1. sources.cursor 字段语义改造（无 schema 变更，仅约定）
--    旧: 全 null（未启用）
--    新: JSON 数组，存上轮抓完后 page 1 的顶端 10 个 tweet_id
--        例: '["2057121410556842160","2057119975521825208","2057119166394466461",...]'
--    旧值 null = 冷启动，新逻辑首次跑按硬上限 10 页走，结束时填入。
--
-- 2. items 表加 pending_workflow 标志
--    0 = 正常（已 trigger workflow 或不需要）
--    1 = catch-up 分流时被 defer 的，由后续 cron tick 收尾消化

ALTER TABLE items ADD COLUMN pending_workflow INTEGER DEFAULT 0;

-- 部分索引：只索引待加工的，按发布时间升序便于「最老先消化」
CREATE INDEX IF NOT EXISTS idx_items_pending_workflow
  ON items(pending_workflow, published_at)
  WHERE pending_workflow=1;
