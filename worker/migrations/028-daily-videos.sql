-- 每日日报视频元数据。媒体本体使用内容 SHA-256 寻址存于 READMES R2。
CREATE TABLE IF NOT EXISTS daily_videos (
  date             TEXT PRIMARY KEY, -- YYYY-MM-DD（BJT 日报日期）
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  mp4_key          TEXT NOT NULL,
  mp4_sha256       TEXT NOT NULL,
  mp4_size         INTEGER NOT NULL,
  poster_key       TEXT NOT NULL,
  poster_sha256    TEXT NOT NULL,
  poster_size      INTEGER NOT NULL,
  vtt_key          TEXT NOT NULL,
  vtt_sha256       TEXT NOT NULL,
  vtt_size         INTEGER NOT NULL,
  uploaded_at      TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 被替换的内容寻址媒体延迟清理，给并发请求和回滚保留至少 48 小时缓冲。
CREATE TABLE IF NOT EXISTS daily_video_gc (
  r2_key       TEXT PRIMARY KEY,
  delete_after TEXT NOT NULL,
  enqueued_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_video_gc_delete_after
  ON daily_video_gc(delete_after);

-- 视频发布会改变已生成日报页，lastmod 单独供 sitemap/抓取器读取。
ALTER TABLE daily_pages ADD COLUMN lastmod TEXT;
