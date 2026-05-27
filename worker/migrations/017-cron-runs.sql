-- 017-cron-runs.sql
-- cron 任务执行历史表。每次 scheduled() 内某 case 执行完(成功/失败)
-- 由 recordCronRun() helper 写一行。供 /admin/tasks 鱼骨图明细 + 全部执行历史使用。
-- 容量估算: 20 任务 × 平均 24 次/天 ≈ 480 行/天, runCleanup 自动删 30 天前数据。

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  source TEXT,
  category TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  duration_ms INTEGER,
  subrequests INTEGER,
  items_count INTEGER,
  result_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_task ON cron_runs(task_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status, started_at DESC);
