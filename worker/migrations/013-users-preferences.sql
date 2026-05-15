-- 2026-05-15: users 表加 preferences JSON 列
-- 用于跨设备同步前端设置（首批：video coordinator 的 autoplay / muted toggle）
-- schema 形如 {"video": {"autoplay": true, "muted": true}}；未来其它 prefs 同 JSON merge
-- 未登录用户走 localStorage；登录后从 user.preferences 拉云端覆盖本地 + 改设置同步上传
ALTER TABLE users ADD COLUMN preferences TEXT;
