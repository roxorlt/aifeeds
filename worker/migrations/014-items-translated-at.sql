-- task #8 C 端展示策略：items 加 translated_at INTEGER 字段（unix 秒时间戳）。
-- Workflow step 4 translateXTweetField 翻译完成时写入，API 用来给 dashboard
-- 「N 条新译文可加载」横条提供 timestamp 信号。
--
-- 老数据 (translated_at IS NULL) 不回填 —— 新翻译写新值即可，前端按
-- (translated_at > last_user_fetch_at) 判断「是否标新」，NULL 等同于「不标新」
-- (相当于跟老 content_translated 一起展示，不打扰)。
--
-- 设计：docs/plans/2026-05-16-x-main-pipeline-workflows-design.md § C 端展示策略

ALTER TABLE items ADD COLUMN translated_at INTEGER;
