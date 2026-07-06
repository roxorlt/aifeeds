-- 025: daily static pages —— 每日静态日报页（SEO P0）的 D1 索引表。
-- sitemap 与 /daily/ 归档索引均从此表读取，不做 R2 list（R2 仅存 daily/YYYY-MM-DD.html 快照）。
-- 设计:docs/plans/2026-07-06-daily-static-page-seo-design.md §4.2

CREATE TABLE IF NOT EXISTS daily_pages (
  date         TEXT PRIMARY KEY,      -- YYYY-MM-DD（BJT）
  title        TEXT NOT NULL,         -- 页面 title（含当日主题）
  item_count   INTEGER NOT NULL,
  generated_at TEXT NOT NULL          -- ISO8601
);
