-- 2026-06-09 feed 排序索引:消除 /api/items 的 temp b-tree 全表排序
-- 排查:perf_nav 显示 feed 内容慢卡在 /api/items（~1s TTFB）。EXPLAIN QUERY PLAN 显示
-- "USE TEMP B-TREE FOR ORDER BY" —— ORDER BY 第一键 (content_translated IS NULL) 是表达式,
-- 普通索引盖不住,55k 行被全量排序。用表达式索引覆盖 (source_type / is_relevant 前缀 + 完整
-- ORDER BY 列) → 计划变 "SEARCH items USING INDEX",temp b-tree 消失。
-- 实测 X feed TTFB 0.46s→0.31s、PH 1.3s→0.85s。已在 prod + staging apply（additive,无行为变更）。
CREATE INDEX IF NOT EXISTS idx_items_feed_src ON items(source_type, is_relevant, (content_translated IS NULL), scraped_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_feed_all ON items(is_relevant, (content_translated IS NULL), scraped_at DESC, id DESC);
