-- 021-blog-podcast.sql
-- blog / podcast 两个新源接入。设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §5
--
-- 本 migration 唯一 schema 增量 = 1 条 partial 表达式索引（给 v1 L1 跨源精确去重）。
--   * source_type 是裸 TEXT，新增枚举值 'blog' / 'podcast' 零 DB 变更（不 ALTER）。
--   * blog/podcast 全部特异字段落 items.extra JSON，不加 items 业务列。
--   * 不建 metrics_snapshots_blog / _podcast（RSS 无可追 Δ 的时序指标，见 §5.4）。
--
-- L1 去重算法只查 url_hash（基于 canonical URL 的 sha256 前 16 hex）。
-- D1/SQLite 支持对确定性表达式（json_extract）建索引；用 partial WHERE 只索引
-- 真正写了 url_hash 的行（blog/podcast），不为全表 X/GH/PH/HF 行付存储成本。
CREATE INDEX IF NOT EXISTS idx_items_url_hash
  ON items(json_extract(extra, '$.url_hash'))
  WHERE json_extract(extra, '$.url_hash') IS NOT NULL;

-- ⚠️ 故意不建 idx_items_content_hash：v1 L1 全程不查 content_hash（L2 标题 Jaccard
--    用内存 shingle 比对、推迟到 v2），给谁都不查的列建索引纯属死索引 + 写入开销。
--    等 v2 真上 content-hash 去重时再加（见 §5.2 / §5.6）。
--
-- 部署（照 CLAUDE.md checklist：先 staging 验证再 prod）：
--   wrangler d1 execute xlist-staging --env staging --remote --file=migrations/021-blog-podcast.sql
--   wrangler d1 execute xlist           --remote --file=migrations/021-blog-podcast.sql
-- 退路：若某 D1 版本对 partial 表达式索引报错，退成无 WHERE 的普通表达式索引；
--       再不行改加真列 url_hash（代价小）。
