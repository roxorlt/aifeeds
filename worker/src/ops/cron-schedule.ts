// 静态 cron 任务调度配置。
// 用途:
//   1. 驱动 /admin/tasks 鱼骨图渲染 (不查 DB, 零成本)
//   2. 给 task_name → label 等映射, 供明细列表展示
// 真实执行时刻仍由 worker/src/index.ts scheduled() 里 if (hour===X) case 决定;
// 这里的 bjt_times 只是 *显示* 用的索引,改这里不会改实际触发。
// 任何 cron 改动 → 同步改这里 + scheduled handler + docs/operations.md。

import type { CronCategory } from '../cron-runs';

export type CronSource =
  | 'x'
  | 'github'
  | 'ph'
  | 'hf'
  | 'clawhub'
  | 'hdx'
  | 'blog'
  | 'podcast'
  | 'common';

export interface CronTaskDef {
  name: string;
  source: CronSource;
  category: CronCategory;
  label: string;
  bjt_times: string[];
  frequency: 'daily' | 'daily-2x' | 'daily-4x' | 'hourly-2x' | 'hourly-1x' | 'multi-tick';
  description: string;
}

export const CRON_SCHEDULE: CronTaskDef[] = [
  // ─── X (Twitter) ──────────────────────────────────────────────
  {
    name: 'list-poll-ingest',
    source: 'x',
    category: 'fetch',
    label: 'X List 抓取',
    bjt_times: ['*:25', '*:55'],
    frequency: 'hourly-2x',
    description: 'ScrapeBadger API 拉 X List 最新推文 → ingest 进 items 表',
  },
  {
    name: 'x-backfill-truncated',
    source: 'x',
    category: 'backfill',
    label: 'X 截断推文修补',
    bjt_times: ['*:15', '*:45'],
    frequency: 'hourly-2x',
    description: '修旧 ingest 漏掉的截断推文 (workflow step 0 兜底)',
  },
  {
    name: 'x-backfill-workflow',
    source: 'x',
    category: 'backfill',
    label: 'X workflow 兜底',
    bjt_times: ['*:10', '*:40'],
    frequency: 'hourly-2x',
    description: '扫 workflow_completed_at NULL 老数据,re-trigger workflow',
  },
  {
    name: 'x-reconstruct-threads',
    source: 'x',
    category: 'backfill',
    label: 'X thread 重建',
    bjt_times: ['12:05'],
    frequency: 'daily',
    description: '从 self-reply chain 反向填 thread_root_id',
  },
  {
    name: 'x-article-body-backfill',
    source: 'x',
    category: 'backfill',
    label: 'X Article 正文抓取',
    bjt_times: ['*:05'],
    frequency: 'hourly-1x',
    description: 'X long-form article 正文抓取兜底 (除 12:05 给 reconstruct)',
  },
  {
    name: 'x-article-translate-backfill',
    source: 'x',
    category: 'backfill',
    label: 'X Article 翻译',
    bjt_times: ['*:35'],
    frequency: 'hourly-1x',
    description: 'X long-form article 翻译兜底 (除 11:35 给 cleanup)',
  },
  // ─── GitHub ───────────────────────────────────────────────────
  {
    name: 'github-fetch',
    source: 'github',
    category: 'fetch',
    label: 'GitHub Trending 抓取',
    bjt_times: ['01:00', '13:00'],
    frequency: 'daily-2x',
    description: 'GitHub trending repos 一日两次抓取 + workflow enrich',
  },
  // ─── Product Hunt ─────────────────────────────────────────────
  {
    name: 'ph-daily-fetch',
    source: 'ph',
    category: 'fetch',
    label: 'Product Hunt 每日',
    bjt_times: ['18:10'],
    frequency: 'daily',
    description: 'PT 切日后 ~3h, daily_rank 已 settle, GraphQL 拉全榜',
  },
  // ─── Hugging Face Papers ──────────────────────────────────────
  {
    name: 'hf-daily-fetch',
    source: 'hf',
    category: 'fetch',
    label: 'HF Daily Papers',
    bjt_times: ['08:00'],
    frequency: 'daily',
    description: 'UTC 0 出榜,北京早 8 点抓 + workflow enrich + deep_analysis',
  },
  {
    name: 'hf-backfill-workflow',
    source: 'hf',
    category: 'backfill',
    label: 'HF Paper workflow 兜底',
    bjt_times: ['*:20', '*:50'],
    frequency: 'hourly-2x',
    description: '扫 stuck items 重 trigger workflow (input-hash idempotent)',
  },
  // ─── ClawHub ──────────────────────────────────────────────────
  {
    name: 'clawhub-fetch',
    source: 'clawhub',
    category: 'fetch',
    label: 'ClawHub 列表抓取',
    bjt_times: ['04:00', '16:00'],
    frequency: 'daily-2x',
    description: 'Convex API 拉 ClawHub 文章列表 + workflow enrich',
  },
  // ─── Huodongxing (活动行) ────────────────────────────────────
  {
    name: 'hdx-fetch-start',
    source: 'hdx',
    category: 'fetch',
    label: '活动行起跑',
    bjt_times: ['04:30', '16:30'],
    frequency: 'daily-2x',
    description: 'Reset KV 状态机,开始抓 24 城',
  },
  {
    name: 'hdx-fetch-continue',
    source: 'hdx',
    category: 'fetch',
    label: '活动行接力',
    bjt_times: ['*:35-05', '*:35-17'],
    frequency: 'multi-tick',
    description: '接力抓 cities_pending,直到清完',
  },
  {
    name: 'hdx-auto-drain',
    source: 'hdx',
    category: 'enrich',
    label: '活动行 detail enrich',
    bjt_times: ['*:20', '*:50'],
    frequency: 'hourly-2x',
    description: 'Drain HDX detail workflow pending (cutover 后兜底)',
  },
  {
    name: 'hdx-sweep',
    source: 'hdx',
    category: 'cleanup',
    label: '活动行历史清扫',
    bjt_times: ['03:00'],
    frequency: 'daily',
    description: '标 stale events historical, 每日清扫一次',
  },
  // ─── 官方新闻：厂商博客 + AI 播客 (feeds, Phase 1 2026-06-09) ──
  {
    name: 'blog-fetch',
    source: 'blog',
    category: 'fetch',
    label: '厂商博客抓取',
    bjt_times: ['00:20', '02:20', '04:20', '06:20', '08:20', '10:20', '12:20', '14:20', '16:20', '18:20', '20:20', '22:20'],
    frequency: 'multi-tick',
    description: '厂商博客 RSS 抓取 (每 2h, UTC 偶数时 :20) → blog-pipeline workflow enrich',
  },
  {
    name: 'podcast-fetch',
    source: 'podcast',
    category: 'fetch',
    label: 'AI 播客抓取',
    bjt_times: ['03:50', '09:50', '15:50', '21:50'],
    frequency: 'daily-4x',
    description: 'AI 播客 RSS 抓取 (4x/天, UTC {1,7,13,19}:50) → podcast-pipeline workflow enrich',
  },
  // ─── 通用 (common) ───────────────────────────────────────────
  {
    name: 'refresh-metrics',
    source: 'common',
    category: 'refresh',
    label: 'Metrics 刷新',
    bjt_times: ['*:00', '*:30'],
    frequency: 'hourly-2x',
    description: 'tiered/legacy 刷 metrics snapshot (X/PH/HF/CH/GH)',
  },
  {
    name: 'cleanup',
    source: 'common',
    category: 'cleanup',
    label: '通用清理',
    bjt_times: ['11:35'],
    frequency: 'daily',
    description: '清理过期数据 (refresh_log / events / cron_runs 30d+)',
  },
  {
    name: 'warning-digest',
    source: 'common',
    category: 'system',
    label: '告警日报',
    bjt_times: ['07:00'],
    frequency: 'daily',
    description: 'Flush KV 攒批 warning,推合并日报到 PushDeer (早 7 点)',
  },
  {
    name: 'daily-health-checks',
    source: 'common',
    category: 'system',
    label: '每日健康检查',
    bjt_times: ['07:00'],
    frequency: 'daily',
    description: '翻译失败率 + X metrics 覆盖率检查 (UTC 23:00,与 warning-digest 同 tick)',
  },
  {
    name: 'ops-baseline',
    source: 'common',
    category: 'system',
    label: '运营基线计算',
    bjt_times: ['02:10'],
    frequency: 'daily',
    description: '每日 1 次, 计算 score P90/P99 + likes/h P95 → ops_pool_baseline',
  },
  {
    name: 'ops-detect',
    source: 'common',
    category: 'system',
    label: '运营池检测',
    bjt_times: ['*:00', '*:30'],
    frequency: 'hourly-2x',
    description: 'is_hot / 爆推 / 趋势推 / 发现博主 4 池 detection',
  },
];

export function getTaskDef(name: string): CronTaskDef | undefined {
  return CRON_SCHEDULE.find((t) => t.name === name);
}
