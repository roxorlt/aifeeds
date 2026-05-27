# 抓取任务看板设计（admin/tasks）

> 状态：draft  
> 创建：2026-05-27  
> 目标：admin dashboard 新增「抓取任务看板」，可视化 worker 所有 cron 任务的调度排期 + 实际执行历史。

## 1. 背景与现状

### 现状

worker 单 cron 触发器 `*/5 * * * *`，靠 `scheduled()` 内部 `if (hour===X && minute===Y)` 分发到 ~20 个不同任务。当前缺口：

- **任务排期信息散落在代码注释里**，没有集中视图
- **执行历史几乎没有落库**：只有 `list-poll-ingest` 写 `refresh_log`（tier=99），其他 19 个任务全是 `console.log()` 进 CF Workers 日志，admin dashboard 拿不到
- **运维查问题流程**：要么 `wrangler tail`、要么去 CF Dashboard Logs，跨 session 反复说明

### 目标

在 `/admin/tasks` 提供：

1. **横向时间轴鱼骨图**（甘特图风格）：0-24h 横轴，按信源做 swim lane（X / GitHub / PH / HF / ClawHub / HDX / 通用），任务节点画在对应时刻
2. **明细列表**：点击鱼骨图任意任务节点，下方切换到该任务最近 N 次执行明细
3. **看全部明细**：右上角"查看全部"按钮，下方切换到全局执行历史 + 任务名 / 状态 / 信源筛选

## 2. 数据模型

### 新表 `cron_runs`

`worker/migrations/017-cron-runs.sql`：

```sql
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,             -- 'list-poll-ingest' / 'github-fetch' / ...
  source TEXT,                          -- 'x' | 'github' | 'ph' | 'hf' | 'clawhub' | 'hdx' | 'common' | NULL
  category TEXT NOT NULL,               -- 'fetch' | 'enrich' | 'backfill' | 'refresh' | 'cleanup' | 'system'
  started_at INTEGER NOT NULL,          -- unix ms
  finished_at INTEGER,                  -- unix ms; NULL = crashed mid-run（应当少见）
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'ok' | 'error' | 'skipped'
  duration_ms INTEGER,
  subrequests INTEGER,                  -- credits/subrequests used（result 里能抽就抽，抽不到留 NULL）
  items_count INTEGER,                  -- 处理 item 数（同上）
  result_json TEXT,                     -- JSON.stringify(result).slice(0, 4000) 截断防 D1 row 过大
  error TEXT                            -- error message（status='error' 时填）
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_task ON cron_runs(task_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status, started_at DESC);
```

### 容量估算

- 固定槽位：~20 任务 × 平均 24 次/天 ≈ 480 行/天
- 增长率：~17万/年，单行 < 4KB，年增 ~700MB（D1 可接受）
- 清理：30 天前自动删除（接入现有 `runCleanup`，加一条 SQL）

## 3. 埋点 helper

`worker/src/cron-runs.ts`（新文件）：

```typescript
import type { Env } from './index';

export interface CronTaskMeta {
  name: string;
  source?: string;
  category: 'fetch' | 'enrich' | 'backfill' | 'refresh' | 'cleanup' | 'system';
}

/**
 * 包装一个 cron 任务执行，自动写 cron_runs 表。
 * 不影响原任务执行 — 写表失败只 console.error，不抛错。
 */
export async function recordCronRun<T>(
  env: Env,
  task: CronTaskMeta,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let result: T | null = null;
  let status: 'ok' | 'error' = 'ok';
  let error: string | null = null;
  try {
    result = await fn();
    return result;
  } catch (e) {
    status = 'error';
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw e;
  } finally {
    const finishedAt = Date.now();
    try {
      await env.DB.prepare(
        `INSERT INTO cron_runs
           (task_name, source, category, started_at, finished_at, status,
            duration_ms, subrequests, items_count, result_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        task.name,
        task.source ?? null,
        task.category,
        startedAt,
        finishedAt,
        status,
        finishedAt - startedAt,
        extractSubreq(result),
        extractItemsCount(result),
        result ? JSON.stringify(result).slice(0, 4000) : null,
        error,
      ).run();
    } catch (logErr) {
      console.error('[cron-runs] insert failed:', logErr);
    }
  }
}

/** 从 result 智能抽 subrequests（兼容现有各任务 result shape） */
function extractSubreq(r: unknown): number | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  return (
    (o.credits_used as number) ??
    (o.subrequests_used as number) ??
    (o.subrequests as number) ??
    null
  );
}

/** 从 result 智能抽 items_count */
function extractItemsCount(r: unknown): number | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  return (
    (o.ingested as number) ??
    (o.tweets_seen as number) ??
    (o.refreshed as number) ??
    (o.fetched_details as number) ??
    (o.triggered as number) ??
    (o.found as number) ??
    null
  );
}
```

## 4. 改造 scheduled handler

`worker/src/index.ts` 中每个 cron case 包一层 `recordCronRun()`。示例：

```typescript
// before
if (mode === 'github-fetch') {
  const r = await runGithubFetchTrending(env);
  console.log(`[cron] github-fetch result:`, JSON.stringify(r));
  await notifyCronSummary(env, 'GitHub Trending 抓取', r as ...);
  return;
}

// after
if (mode === 'github-fetch') {
  const r = await recordCronRun(
    env,
    { name: 'github-fetch', source: 'github', category: 'fetch' },
    () => runGithubFetchTrending(env),
  );
  console.log(`[cron] github-fetch result:`, JSON.stringify(r));
  await notifyCronSummary(env, 'GitHub Trending 抓取', r as ...);
  return;
}
```

埋点位置（20 处）：

| Task | Source | Category | Cadence (BJT) |
|---|---|---|---|
| `hf-daily-fetch` | hf | fetch | 每日 08:00 |
| `ph-daily-fetch` | ph | fetch | 每日 18:10 |
| `github-fetch` | github | fetch | 每日 01:00 / 13:00 |
| `clawhub-fetch` | clawhub | fetch | 每日 04:00 / 16:00 |
| `hdx-fetch-start` | hdx | fetch | 每日 04:30 / 16:30 |
| `hdx-fetch-continue` | hdx | fetch | 04:35-05:05 / 16:35-17:05 接力 |
| `hdx-sweep` | hdx | cleanup | 每日 03:00 |
| `hdx-auto-drain` | hdx | enrich | 每小时 :20 / :50 |
| `list-poll-ingest` | x | fetch | 每小时 :25 / :55 |
| `x-backfill-truncated` | x | backfill | 每小时 :15 / :45 |
| `x-backfill-workflow` | x | backfill | 每小时 :10 / :40 |
| `x-reconstruct-threads` | x | backfill | 每日 12:05 |
| `x-article-body-backfill` | x | backfill | 每小时 :05（除 12:05）|
| `x-article-translate-backfill` | x | backfill | 每小时 :35（除 11:35）|
| `hf-backfill-workflow` | hf | backfill | 每小时 :20 / :50 |
| `refresh-metrics` | common | refresh | 每小时 :00 / :30 |
| `cleanup` | common | cleanup | 每日 11:35 |
| `warning-digest` | common | system | 每日 07:00 |
| `ops-baseline` | common | system | 每日 02:10 |
| `ops-detect` | common | system | 每小时 :00 / :30 |

## 5. 静态调度配置

`worker/src/ops/cron-schedule.ts`（新文件）：

```typescript
export interface CronTaskDef {
  name: string;
  source: 'x' | 'github' | 'ph' | 'hf' | 'clawhub' | 'hdx' | 'common';
  category: 'fetch' | 'enrich' | 'backfill' | 'refresh' | 'cleanup' | 'system';
  label: string;              // 中文显示名
  bjt_times: string[];        // 具体时刻 ['08:00'] / ['01:00','13:00'] / ['*:00','*:30']
  frequency: 'daily' | 'daily-2x' | 'hourly-2x' | 'hourly-1x';
  description: string;
}

export const CRON_SCHEDULE: CronTaskDef[] = [
  { name: 'hf-daily-fetch', source: 'hf', category: 'fetch',
    label: 'HF Daily Papers', bjt_times: ['08:00'], frequency: 'daily',
    description: 'Hugging Face Daily Papers 每日榜单抓取' },
  { name: 'ph-daily-fetch', source: 'ph', category: 'fetch',
    label: 'Product Hunt', bjt_times: ['18:10'], frequency: 'daily',
    description: 'PH GraphQL API 每日榜单' },
  { name: 'github-fetch', source: 'github', category: 'fetch',
    label: 'GitHub Trending', bjt_times: ['01:00', '13:00'], frequency: 'daily-2x',
    description: 'GitHub trending repos 一日两次抓取' },
  // ... 共 20 条
];
```

**前端鱼骨图直接拿这个配置渲染**，不依赖 cron_runs。cron_runs 只用于：
- 每个节点 hover 时显示最近 24h 统计 badge（runs/ok/error/avg_ms）
- 点击展开下方明细

## 6. Endpoints

`worker/src/admin-tasks.ts`（新文件）+ 路由挂在 `worker/src/index.ts`：

| Method | Path | 说明 |
|---|---|---|
| GET | `/admin/tasks` | 鱼骨图 + 明细页 HTML（admin 鉴权）|
| GET | `/api/admin/tasks/schedule` | 返回 `CRON_SCHEDULE` 静态配置 + 每个任务最近 24h 统计 |
| GET | `/api/admin/tasks/runs?task=X&limit=50&offset=0` | 某任务的执行明细（按 started_at DESC）|
| GET | `/api/admin/tasks/runs/all?limit=100&offset=0&status=&source=&category=` | 全部明细 + 多维筛选 |
| GET | `/api/admin/tasks/run-detail?id=N` | 单条详情（完整 result_json）|

## 7. 前端布局

`/admin/tasks` 页面（新 `worker/src/admin-tasks.ts`）：

```
┌─────────────────────────────────────────────────────────────┐
│  ai-feeds admin  │  📊仪表盘  📦运营  ⏰抓取任务  🔧运维工具  │
├─────────────────────────────────────────────────────────────┤
│ 🐟 抓取任务看板         24h 总览          [查看全部明细 →]  │
├─────────────────────────────────────────────────────────────┤
│  鱼骨图（SVG，0-24h 横向）                                  │
│        00 ──── 04 ──── 08 ──── 12 ──── 16 ──── 20 ──── 24   │
│  X   ──┼────────────────────────────────────────────────    │
│       ▲▲▲▲▲▲▲▲▲▲▲▲ (每小时 :05/:10/:15/:25 等多个节点)      │
│  GH  ──┼──● 01:00 ────────────────● 13:00 ─────────────     │
│  PH  ──┼─────────────────────────────────● 18:10 ──────     │
│  HF  ──┼──● 08:00 ──────────────────────────────────────    │
│  CH  ──┼──● 04:00 ────────────● 16:00 ──────────────────    │
│  HDX ──┼──●● 04:30 接力 ──────●● 16:30 接力 ────────────    │
│  通用──┼─ :00/:30 refresh+ops-detect ▲ + 每日固定节点 ●     │
├─────────────────────────────────────────────────────────────┤
│  📋 执行明细                                                 │
│  [当前显示: github-fetch | 最近 50 次]                       │
│  ┌──────┬─────────┬────────┬────────┬────────┐              │
│  │ 时间 │ 状态    │ 耗时   │ items  │ subreq │              │
│  ├──────┼─────────┼────────┼────────┼────────┤              │
│  │ ...  │ ok      │ 2.3s   │ 23     │ 19     │              │
│  └──────┴─────────┴────────┴────────┴────────┘              │
│  点击行展开 → 显示 result_json + error                       │
└─────────────────────────────────────────────────────────────┘
```

### 交互细节

- **鱼骨图节点**：
  - `●` = 每日 1-2 次的固定任务
  - `▲` = 高频任务（每小时多次）
  - 颜色按 category：`fetch=蓝` / `enrich=紫` / `backfill=橙` / `refresh=绿` / `cleanup=灰` / `system=黄`
  - hover tooltip：任务名 + BJT 时间 + 描述 + 最近 24h 成功率
  - 节点状态环：最近 1 次执行成功=实心，失败=红边，跳过=虚线

- **明细切换**：
  - 默认显示全部任务最近 50 次
  - 点击鱼骨图节点 → 下方筛到该任务 + 标题更新
  - "查看全部明细"按钮 → 下方展开筛选条 + 全局明细

- **明细行展开**：
  - 鼠标点击行 → 展开显示 `result_json`（JSON pretty）+ `error`（如有）
  - 复制按钮：复制 result_json 到剪贴板（运维场景）

## 8. Admin nav 更新

`worker/src/admin.ts` `adminNavHtml` 签名扩展：

```typescript
export function adminNavHtml(active: 'dashboard' | 'tools' | 'ops' | 'tasks'): string {
  // ...
  return `<nav class="topnav">
    <span class="brand">ai-feeds <span>admin</span></span>
    <a class="${cls('dashboard')}" href="/admin/dashboard">📊 仪表盘</a>
    <a class="${cls('ops')}" href="/admin/ops">📦 运营</a>
    <a class="${cls('tasks')}" href="/admin/tasks">⏰ 抓取任务</a>
    <a class="${cls('tools')}" href="/admin/tools">🔧 运维工具</a>
    <span class="meta" id="metaText"></span>
  </nav>`;
}
```

## 9. Deploy 流程

1. **Migration**: `wrangler d1 execute xlist-staging --env staging --remote --file=worker/migrations/017-cron-runs.sql` → 验证 → prod
2. **Worker deploy**: staging 先 deploy → 等 1 个完整 cron tick（5 min）→ 检查 staging cron_runs 表有数据 → prod
3. **冷启动**：cron_runs 从 deploy 时刻起开始记，之前的执行历史不可恢复（设计文档明确告知）

## 10. YAGNI 不做

- **任务重新触发按钮**：admin/tools 已有部分手动触发 endpoint，不重复
- **失败告警**：已有 `notifyCronSummary` + `warning-digest` 推 PushDeer
- **CF Workflow instance 视图**：每条 item 1 个 instance、量级 1000+/天，单独做 view 价值有限。如需要，未来另开 `/admin/workflows`
- **历史回填**：之前的 console.log 不可恢复
- **多日对比 / 趋势图**：MVP 只看 24h，未来加

## 11. 工程量

- 1 migration（5 行 SQL）
- 1 helper（cron-runs.ts，~100 行）
- 1 schedule config（cron-schedule.ts，~80 行）
- scheduled handler 改造（20 处 × 3-5 行 ≈ 80 行 diff）
- 1 新 admin page（admin-tasks.ts，~400 行 HTML+SVG+JS）
- 5 endpoints（admin-tasks.ts，~200 行）
- admin.ts nav 签名扩展（~5 行）
- index.ts route 注册（~10 行）
- docs/operations.md 同步（新增 endpoint 段）

合计：~900 行新增/修改。预估 1 个 PR、半天 - 1 天完成。

## 12. 风险

- **D1 写入开销**：每个 cron tick 1-2 次额外 INSERT，可忽略
- **scheduled handler diff 大**：20 处 wrap，逐个改容易漏。措施：先改 helper + schedule 配置 → 再分 source（X / GH / PH / ...）批改并 self-review
- **rolling cleanup**：30 天前数据需要清，加 `runCleanup` 一条 SQL（DELETE FROM cron_runs WHERE started_at < (strftime('%s','now')-30*86400)*1000）
