-- 运营看板基线 + 阈值 EDA 查询存档
-- 设计文档：docs/plans/2026-05-21-ops-pool-design.md
-- 用途：调阈值 / 看分布漂移 / 验证 cron 计算结果时重跑
--
-- 跑法：source .secrets/aifeeds-prod.env 后
--   cd worker && npx wrangler d1 execute xlist --remote --file=queries/baseline-eda.sql
-- 或者单条复制到 npx wrangler d1 execute --command
--
-- 注意：所有 SQL 都加 `is_relevant=1` filter（非 AI 长尾把头部基线撑高 30%）
-- captured_at 在 metrics_snapshots 是 **秒**，scraped_at 在 items 是 **毫秒**，别搞混

-- ==============================================================
-- §1 各源 is_relevant 分布（确认 100% AI 三源）
-- ==============================================================
SELECT
  source_type,
  COUNT(*) AS total,
  SUM(CASE WHEN is_relevant = 1 THEN 1 ELSE 0 END) AS rel_1,
  SUM(CASE WHEN is_relevant = 0 THEN 1 ELSE 0 END) AS rel_0,
  ROUND(100.0 * SUM(CASE WHEN is_relevant = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_relevant
FROM items
WHERE scraped_at > (strftime('%s','now')-7*86400)*1000
GROUP BY source_type
ORDER BY total DESC;

-- ==============================================================
-- §2 X raw score 分位数（AI only，7d）→ hot/爆推阈值依据
-- ==============================================================
WITH scored AS (
  SELECT
      COALESCE(json_extract(metrics,'$.likes'), 0) * 1
    + COALESCE(json_extract(metrics,'$.bookmarks'), 0) * 10
    + COALESCE(json_extract(metrics,'$.replies'), 0) * 13.5
    + COALESCE(json_extract(metrics,'$.retweets'), 0) * 20 AS score
  FROM items
  WHERE source_type='x_list'
    AND is_relevant = 1
    AND scraped_at > (strftime('%s','now')-7*86400)*1000
    AND metrics IS NOT NULL
),
ranked AS (
  SELECT score, NTILE(100) OVER (ORDER BY score) AS pct FROM scored WHERE score > 0
)
SELECT
  MIN(CASE WHEN pct=50 THEN score END) AS p50,
  MIN(CASE WHEN pct=75 THEN score END) AS p75,
  MIN(CASE WHEN pct=90 THEN score END) AS p90,
  MIN(CASE WHEN pct=95 THEN score END) AS p95,
  MIN(CASE WHEN pct=99 THEN score END) AS p99,
  MAX(score) AS max_score,
  COUNT(*) AS n
FROM ranked;

-- ==============================================================
-- §3 X likes/h 增速分位数（AI only，3d）→ 趋势推阈值依据
-- captured_at 是秒（不是毫秒）
-- ==============================================================
WITH snaps AS (
  SELECT
    s.item_id,
    s.captured_at,
    s.likes,
    LAG(s.likes) OVER (PARTITION BY s.item_id ORDER BY s.captured_at) AS prev_likes,
    LAG(s.captured_at) OVER (PARTITION BY s.item_id ORDER BY s.captured_at) AS prev_at
  FROM metrics_snapshots s
  JOIN items i ON i.id = s.item_id
  WHERE i.is_relevant = 1
    AND s.captured_at > (strftime('%s','now') - 3 * 86400)
),
rates AS (
  SELECT
    CAST((likes - prev_likes) AS REAL) * 3600 / NULLIF(captured_at - prev_at, 0) AS likes_per_hour
  FROM snaps
  WHERE prev_at IS NOT NULL
    AND captured_at - prev_at > 60
    AND likes >= prev_likes
),
ranked AS (
  SELECT likes_per_hour, NTILE(100) OVER (ORDER BY likes_per_hour) AS pct
  FROM rates
  WHERE likes_per_hour > 0
)
SELECT
  MIN(CASE WHEN pct=50 THEN likes_per_hour END) AS p50,
  MIN(CASE WHEN pct=75 THEN likes_per_hour END) AS p75,
  MIN(CASE WHEN pct=90 THEN likes_per_hour END) AS p90,
  MIN(CASE WHEN pct=95 THEN likes_per_hour END) AS p95,
  MIN(CASE WHEN pct=99 THEN likes_per_hour END) AS p99,
  MAX(likes_per_hour) AS max_rate,
  COUNT(*) AS n
FROM ranked;

-- ==============================================================
-- §4 外部作者频次（AI tweet 引用/回复，14d 窗口）→ 发现博主阈值依据
-- distinct_tweets 才是触发阈值的指标，total_mentions 仅用于展示 dilution
-- ==============================================================
WITH known AS (
  SELECT DISTINCT handle FROM items WHERE source_type='x_list' AND handle IS NOT NULL
),
mentions AS (
  SELECT
    json_extract(extra,'$.quote_of.handle') AS h,
    json_extract(extra,'$.quote_of.id') AS src_tid
  FROM items
  WHERE source_type='x_list' AND is_relevant=1
    AND json_extract(extra,'$.quote_of.handle') IS NOT NULL
    AND scraped_at > (strftime('%s','now') - 14*86400) * 1000
  UNION ALL
  SELECT
    json_extract(extra,'$.reply_of.handle'),
    json_extract(extra,'$.reply_of.id')
  FROM items
  WHERE source_type='x_list' AND is_relevant=1
    AND json_extract(extra,'$.reply_of.handle') IS NOT NULL
    AND scraped_at > (strftime('%s','now') - 14*86400) * 1000
)
SELECT
  h,
  COUNT(*) AS total_mentions,
  COUNT(DISTINCT src_tid) AS distinct_tweets,
  ROUND(CAST(COUNT(*) AS REAL) / COUNT(DISTINCT src_tid), 1) AS dilution_ratio
FROM mentions
WHERE h NOT IN (SELECT handle FROM known)
GROUP BY h
ORDER BY distinct_tweets DESC, total_mentions DESC
LIMIT 30;

-- ==============================================================
-- §5 验证：metrics_snapshots 表覆盖率
-- ==============================================================
SELECT i.is_relevant, COUNT(DISTINCT s.item_id) AS items_with_snap
FROM metrics_snapshots s
JOIN items i ON i.id = s.item_id
GROUP BY i.is_relevant;

-- ==============================================================
-- §6 SB API 调用量（refresh_log 7d 直方）→ 容量监控
-- ==============================================================
SELECT
  date(refreshed_at, 'unixepoch', '+8 hours') AS day,
  COUNT(*) AS cron_runs,
  SUM(items_count) AS total_items_refreshed,
  SUM(subrequests_used) AS total_subreqs
FROM refresh_log
WHERE refreshed_at > strftime('%s','now') - 7 * 86400
GROUP BY day
ORDER BY day DESC;
