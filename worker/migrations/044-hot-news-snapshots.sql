-- 行业要闻滚动热榜快照（hot.ai-feeds.com 只读 API 的持久副本）。
-- 设计:docs/plans 之外的 /office-hours 设计稿 2026-09-06「行业要闻滚动热榜」B1。
--
-- 只保留每个窗口的最新一份:window_hours 就是主键,每次 cron 覆盖写同一行。
-- 不留历史、不做清理任务(要看进榜/掉榜时再另开历史表)。
-- 热路径读 KV `hot:news:72h`;这张表是 KV 缺失/被驱逐后的回源副本。
CREATE TABLE hot_news_snapshots (
  window_hours INTEGER PRIMARY KEY CHECK (window_hours > 0),
  computed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
  item_count INTEGER NOT NULL CHECK (item_count >= 0)
);
