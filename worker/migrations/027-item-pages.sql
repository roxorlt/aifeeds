-- 027: item static pages —— 每条内容独立 SSR 静态页（/i/…）的 D1 索引表。
-- sitemap 与增量再生均从此表读取；R2 仅存 item 页 HTML 快照。
-- 设计:docs/plans/2026-07-08-item-ssr-pages-design.md §4.2
-- 编号说明:026 已被 search-fts 占用，本表用 027。

CREATE TABLE IF NOT EXISTS item_pages (
  item_id TEXT PRIMARY KEY, source TEXT NOT NULL, url_path TEXT NOT NULL,
  generated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_item_pages_source ON item_pages(source, status);
