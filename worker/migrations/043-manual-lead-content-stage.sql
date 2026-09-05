-- 2026-09-05：补录线索的内容加工进度。
--
-- 一步录入改成「提交即返回、加工在后台跑」之后，owner 在页面上要看得见现在到哪一步了
-- （规格 docs/plans/2026-09-05-manual-lead-real-content-spec.md 第 4 节）。进度不能塞进
-- 既有的 status 列：那一列的取值被状态机、门禁 SQL 与候选池查询同时约束着，多一个取值
-- 要改的地方遍布全仓；进度是另一件事，单独放。
--
-- 四列全部可空，只有一步录入的线索会写。老行读出来是 NULL，行为与这次改动之前一致。
ALTER TABLE manual_news_leads ADD COLUMN content_stage TEXT;
ALTER TABLE manual_news_leads ADD COLUMN content_stage_detail TEXT;
ALTER TABLE manual_news_leads ADD COLUMN content_material_tier TEXT;
-- 总预算到点的时刻。后台那一轮如果整个 isolate 被回收了，没人再去入池 —— 面板轮询时
-- 按这一列把过期的捡回来补入池，入池永不失败这条约束才真的兜得住。
ALTER TABLE manual_news_leads ADD COLUMN content_deadline_at INTEGER;

-- 捡回过期未入池的一步录入线索：按 (review_date, content_deadline_at) 选行，
-- 不会退化成全表扫。
CREATE INDEX IF NOT EXISTS idx_manual_news_leads_content_deadline
  ON manual_news_leads(review_date, content_deadline_at);
