-- 人审优先（2026-08-19 事故修复）：人工审核提交的选题顺序高于自动排序，
-- 多次人审以最后一次为准。此前批次表没有「这条选择序列出自人审」的标记，
-- 08:35 的 daily-digest-rescore 自动重算冻结出的新批次把 applied_selected_ids
-- 置空，下游回落到 digest_pool 自动排序，直接覆盖了 07:5x 的人审结果。
--
-- human_reviewed = 1 表示该批次的 applied_selected_ids 源自人工提交（或由人审序列
-- 继承而来）。冻结 / 净化 / 手工线索确认三条建新版本的路径都必须继承这个标记，
-- 自动路径只允许剔除失效条目，不允许重排人审顺序。
ALTER TABLE daily_news_review_batches ADD COLUMN human_reviewed INTEGER NOT NULL DEFAULT 0;

-- 回填当天在途批次：applied_selected_ids 非空 + 有人工编辑轮次 + 不是自动修复/净化派生，
-- 只可能来自 submitNewsReviewSelection。批次按天过期（expires_at = 当日 24:00 BJT），
-- 回填只影响迁移当天尚未过期的数据。
UPDATE daily_news_review_batches SET human_reviewed = 1
 WHERE applied_selected_ids IS NOT NULL
   AND edit_revision > 0
   AND auto_repaired_from_batch IS NULL;
