# X list 抓取游标驱动改造 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 X list-poll 从「固定 maxPages=3 + 早停」改为「游标驱动 + seen_set 10 个 id 命中即停」，确保零漏 list 内 AI 推文。

**Architecture:** 复用 `sources.cursor` 字段存上轮顶端 10 个 `tweet_id`（JSON 数组）；每页扫到 `∩ seen_set 非空`就停；硬上限 10 页；`newly_inserted > 70` 时分流走 `pending_workflow` 队列由后续 cron tick 消化。`LIST_POLL_MODE` 开关控制新旧切换。

**Tech Stack:** Cloudflare Workers (TypeScript) + D1 + ScrapeBadger REST API + wrangler CLI。Worker 项目无单测框架，**核心纯函数用 `tsx` 跑 ad-hoc 断言脚本验证**，集成层用 `wrangler deploy --env staging` + curl smoke 验证。

**设计文档参考:** [`docs/plans/2026-05-22-x-list-cursor-driven-design.md`](2026-05-22-x-list-cursor-driven-design.md)

---

## Phase 0：准备工作

### Task 0.1: 确认 branch + 干净 working tree

**Files:** 无

**Step 1: 确认在 feat/x-list-cursor-driven 分支**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `feat/x-list-cursor-driven`

**Step 2: 确认无未 commit 的相关改动**

Run: `git status --short | grep -v "^??" || echo "clean"`
Expected: `clean`（untracked 文件忽略）

---

## Phase 1：D1 migration

### Task 1.1: 写 migration SQL

**Files:**
- Create: `worker/migrations/016-x-list-cursor.sql`

**Step 1: 写 SQL 文件**

完整内容：

```sql
-- M16: X list 抓取游标驱动改造
--
-- 设计文档: docs/plans/2026-05-22-x-list-cursor-driven-design.md
-- 触发: 2026-05-21 实测确认 ScrapeBadger /lists/{id}/tweets 是严格时间倒序，
--       从「固定 maxPages=3 + 早停」改为「游标驱动 + seen_set 10 个 id 命中即停」。
--
-- 1. sources.cursor 字段语义改造（无 schema 变更，仅约定）
--    旧: 全 null（未启用）
--    新: JSON 数组，存上轮抓完后 page 1 的顶端 10 个 tweet_id
--        例: '["2057121410556842160","2057119975521825208","2057119166394466461",...]'
--    旧值 null = 冷启动，新逻辑首次跑按硬上限 10 页走，结束时填入。
--
-- 2. items 表加 pending_workflow 标志
--    0 = 正常（已 trigger workflow 或不需要）
--    1 = catch-up 分流时被 defer 的，由后续 cron tick 收尾消化

ALTER TABLE items ADD COLUMN pending_workflow INTEGER DEFAULT 0;

-- 部分索引：只索引待加工的，按发布时间升序便于「最老先消化」
CREATE INDEX IF NOT EXISTS idx_items_pending_workflow
  ON items(pending_workflow, published_at)
  WHERE pending_workflow=1;
```

**Step 2: 检查 SQL 语法是否合法（本地 sqlite dry-run，不连远端）**

Run:
```bash
sqlite3 ":memory:" <<'EOF'
CREATE TABLE items (id TEXT PRIMARY KEY, source_type TEXT, published_at TEXT);
.read worker/migrations/016-x-list-cursor.sql
.schema items
EOF
```
Expected: 输出包含 `pending_workflow INTEGER DEFAULT 0`

**Step 3: Commit**

```bash
git add worker/migrations/016-x-list-cursor.sql
git commit -m "feat(x-list): M16 migration - items.pending_workflow + sources.cursor 语义改造"
```

### Task 1.2: staging D1 跑 migration

**Files:** 无（执行外部命令）

**Step 1: source staging secrets**

Run:
```bash
set -a && . .secrets/aifeeds-staging.env && set +a
```

**Step 2: 跑 migration 到 staging D1**

Run:
```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist-staging --env staging --remote --file=migrations/016-x-list-cursor.sql
```
Expected: `Executed 2 commands` 或类似，无 error

**Step 3: 验证 staging schema 更新**

Run:
```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist-staging --env staging --remote \
  --command="SELECT sql FROM sqlite_master WHERE name='items'" --json | grep pending_workflow
```
Expected: 输出包含 `"pending_workflow INTEGER DEFAULT 0"`

**Step 4: 无需 commit**（migration 文件已 commit，这一步是执行）

---

## Phase 2：抽核心算法纯函数 + ad-hoc 测试

把所有不依赖 D1 / SB / workflow runtime 的逻辑抽到 `worker/src/x-list-cursor.ts`，配 `worker/scripts/test-x-list-cursor.ts` 用 `tsx` 跑断言。

### Task 2.1: 写 ad-hoc 测试脚本骨架（先全部 fail）

**Files:**
- Create: `worker/scripts/test-x-list-cursor.ts`

**Step 1: 写测试脚本（包含所有要写的函数的断言，但还没实现 → 全 fail）**

完整内容：

```typescript
// 纯函数 ad-hoc 测试。运行：npx tsx worker/scripts/test-x-list-cursor.ts
// 不依赖 D1/SB/workflow runtime，纯逻辑断言。
//
// 设计参考: docs/plans/2026-05-22-x-list-cursor-driven-design.md

import {
  parseSeenSet,
  serializeSeenSet,
  findStopIndex,
  partitionForCatchup,
} from '../src/x-list-cursor';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

// ─── parseSeenSet ───────────────────────────────────────────────
console.log('\nparseSeenSet:');
eq(parseSeenSet(null), new Set<string>(), 'null → 空 Set（冷启动）');
eq(parseSeenSet(''), new Set<string>(), '空串 → 空 Set');
eq(
  parseSeenSet('["A","B","C"]'),
  new Set(['A', 'B', 'C']),
  '合法 JSON → Set',
);
eq(parseSeenSet('not json'), new Set<string>(), '非法 JSON → 空 Set（容错）');
eq(parseSeenSet('{}'), new Set<string>(), '非数组 → 空 Set（容错）');

// ─── serializeSeenSet ───────────────────────────────────────────
console.log('\nserializeSeenSet:');
eq(serializeSeenSet([]), '[]', '空数组 → "[]"');
eq(
  serializeSeenSet(['N1', 'N2', 'N3']),
  '["N1","N2","N3"]',
  '3 个 id → JSON 数组',
);
eq(
  serializeSeenSet(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12']),
  '["N1","N2","N3","N4","N5","N6","N7","N8","N9","N10"]',
  '> 10 个 id 自动截断为前 10 个',
);

// ─── findStopIndex ──────────────────────────────────────────────
// 返回 page 内第一个命中 seen_set 的 index；没命中返回 -1
// 命中后 index 之前（含 index 前一条）的全是新的要 upsert；
// index 及之后的是 seen，丢弃
console.log('\nfindStopIndex:');
eq(
  findStopIndex(['N1', 'N2', 'N3'], new Set(['A', 'B'])),
  -1,
  '无任何命中 → -1',
);
eq(
  findStopIndex(['N1', 'N2', 'A', 'N4'], new Set(['A', 'B'])),
  2,
  '第一条命中位于 index 2',
);
eq(
  findStopIndex(['A', 'N2', 'N3'], new Set(['A', 'B'])),
  0,
  'page 第一条就命中 → 0',
);
eq(
  findStopIndex(['N1', 'C', 'B', 'A'], new Set(['A', 'B', 'C'])),
  1,
  '取最早出现的命中 index（即使有多个命中）',
);
eq(
  findStopIndex([], new Set(['A'])),
  -1,
  '空页 → -1',
);
eq(
  findStopIndex(['N1', 'N2'], new Set()),
  -1,
  '空 seen_set（冷启动）→ -1（全部要）',
);

// ─── partitionForCatchup ────────────────────────────────────────
// 入参 newItems 按 published_at desc 排序（最新在前）
// 阈值默认 70：≤ 70 全部 immediate；> 70 时前 70 immediate，剩余 pending
console.log('\npartitionForCatchup:');
{
  const items = Array.from({ length: 50 }, (_, i) => `id${i}`);
  const r = partitionForCatchup(items, 70);
  eq(r.immediate, items, '50 条（≤70）→ 全部 immediate');
  eq(r.pending, [], '50 条 → pending 空');
}
{
  const items = Array.from({ length: 350 }, (_, i) => `id${i}`);
  const r = partitionForCatchup(items, 70);
  eq(r.immediate.length, 70, '350 条 → immediate 70 条');
  eq(r.pending.length, 280, '350 条 → pending 280 条');
  eq(r.immediate[0], 'id0', 'immediate 是最新的（index 0 in）');
  eq(r.pending[0], 'id70', 'pending 从 index 70 起');
}
{
  const r = partitionForCatchup([], 70);
  eq(r.immediate, [], '空数组 → immediate 空');
  eq(r.pending, [], '空数组 → pending 空');
}

// ─── 收尾 ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

**Step 2: 跑测试，预期全 fail（模块还没创建）**

Run:
```bash
cd /Users/roxor/brain/30-projects/aifeeds && npx tsx worker/scripts/test-x-list-cursor.ts
```
Expected: 报错 `Cannot find module '../src/x-list-cursor'`

**Step 3: Commit 测试脚本骨架**

```bash
git add worker/scripts/test-x-list-cursor.ts
git commit -m "test(x-list): 游标驱动核心算法 ad-hoc 测试骨架"
```

### Task 2.2: 实现 4 个纯函数让测试通过

**Files:**
- Create: `worker/src/x-list-cursor.ts`

**Step 1: 写实现**

完整内容：

```typescript
// X list 抓取游标驱动 - 核心算法纯函数
//
// 设计文档: docs/plans/2026-05-22-x-list-cursor-driven-design.md
//
// 所有函数纯逻辑，不依赖 env / D1 / fetch，便于 ad-hoc 测试。
// 测试: worker/scripts/test-x-list-cursor.ts

/** seen_set 大小上限（设计文档 §3 决策 1）*/
export const SEEN_SET_MAX_SIZE = 10;

/** catch-up 分流默认阈值（设计文档 §3 决策 4）*/
export const CATCHUP_THRESHOLD_DEFAULT = 70;

/** 解析 sources.cursor 文本到 Set。容错：非法 / 空 → 空 Set（冷启动）*/
export function parseSeenSet(cursorRaw: string | null | undefined): Set<string> {
  if (!cursorRaw) return new Set();
  try {
    const parsed = JSON.parse(cursorRaw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/** 把 topIds 序列化回 cursor 字段；只取前 SEEN_SET_MAX_SIZE 个 */
export function serializeSeenSet(topIds: string[]): string {
  return JSON.stringify(topIds.slice(0, SEEN_SET_MAX_SIZE));
}

/**
 * 找 page 内第一个命中 seen_set 的位置。
 * 返回 -1 = 没命中（这一页全是新的，要全部 upsert + 翻下一页）
 * 返回 >= 0 = 命中位置。pageIds[0..index-1] 是新的；index 及之后丢弃；停翻页。
 */
export function findStopIndex(pageIds: string[], seenSet: Set<string>): number {
  if (seenSet.size === 0) return -1;
  for (let i = 0; i < pageIds.length; i++) {
    if (seenSet.has(pageIds[i])) return i;
  }
  return -1;
}

/** catch-up 分流结果 */
export interface CatchupPartition<T> {
  immediate: T[];
  pending: T[];
}

/**
 * 按阈值把 newItems 分两组。
 * 入参假设按 published_at desc 排（最新在前）。
 * ≤ threshold → 全部 immediate；> threshold → 前 threshold immediate，剩余 pending。
 */
export function partitionForCatchup<T>(
  newItems: T[],
  threshold: number = CATCHUP_THRESHOLD_DEFAULT,
): CatchupPartition<T> {
  if (newItems.length <= threshold) {
    return { immediate: newItems, pending: [] };
  }
  return {
    immediate: newItems.slice(0, threshold),
    pending: newItems.slice(threshold),
  };
}
```

**Step 2: 跑测试，预期全 pass**

Run:
```bash
cd /Users/roxor/brain/30-projects/aifeeds && npx tsx worker/scripts/test-x-list-cursor.ts
```
Expected: 输出 `N passed, 0 failed`（约 20+ pass）

**Step 3: Commit**

```bash
git add worker/src/x-list-cursor.ts
git commit -m "feat(x-list): 游标驱动核心算法纯函数（parseSeenSet/serializeSeenSet/findStopIndex/partitionForCatchup）"
```

---

## Phase 3：改 runListPollIngest 接入游标驱动

### Task 3.1: 加 LIST_POLL_MODE env 类型 + 默认值常量

**Files:**
- Modify: `worker/src/enrich.ts`（找到 `EnrichEnv` interface 或相关 env 定义；加 `LIST_POLL_MODE?: string`）

**Step 1: 查 EnrichEnv 定义位置**

Run:
```bash
grep -n "EnrichEnv\|interface.*Env" worker/src/enrich.ts | head -5
```
Expected: 输出 EnrichEnv 接口的行号

**Step 2: 在 EnrichEnv 接口加字段**

在 `EnrichEnv` 接口里加：

```typescript
/**
 * X list-poll 模式开关（M16 灰度）：
 * 'cursor-driven'（默认）= 游标驱动（设计文档 docs/plans/2026-05-22-x-list-cursor-driven-design.md）
 * 'fixed-pages'         = 旧逻辑（固定 maxPages=3 + 整页全 known 早停）
 */
LIST_POLL_MODE?: string;
```

**Step 3: 检查 TypeScript 不挂**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 无 error（worker 项目原有 `tsc --noEmit` 通过的话，加字段不会引入错误）

**Step 4: Commit**

```bash
git add worker/src/enrich.ts
git commit -m "feat(x-list): EnrichEnv 加 LIST_POLL_MODE 灰度开关字段"
```

### Task 3.2: 把现有 runListPollIngest 重命名为 runListPollIngestFixedPages（旧逻辑保留）

**Files:**
- Modify: `worker/src/enrich.ts:2153`

**Step 1: 把 `export async function runListPollIngest` 改名**

在 `worker/src/enrich.ts` 里找 `export async function runListPollIngest(` 这一行（约 2153），改名为：

```typescript
async function runListPollIngestFixedPages(
```

注意：**去掉 `export`**（保留为模块内函数），新的导出入口由 Task 3.4 的 dispatcher 提供。

**Step 2: 检查调用方都是通过 export 入口调用的**

Run:
```bash
grep -rn "runListPollIngest" worker/src/
```
Expected: 出现的调用都在 `worker/src/index.ts`，且都是导入后调用（不会因为内部改名而挂；新 export 会保留同名）

**Step 3: 检查 tsc**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 报错 `Module has no exported member 'runListPollIngest'`（暂时正常，下一 task 修复）

**Step 4: 不 commit（独立 task 不可工作，跟下一 task 合）**

### Task 3.3: 新增 runListPollIngestCursorDriven 实现游标驱动逻辑

**Files:**
- Modify: `worker/src/enrich.ts`

**Step 1: 在 `runListPollIngestFixedPages` 后面加新函数**

在 `runListPollIngestFixedPages` 函数闭合 `}` 后面加：

```typescript
/**
 * 游标驱动版 list-poll ingest（M16，2026-05-22）。
 *
 * 设计文档: docs/plans/2026-05-22-x-list-cursor-driven-design.md
 *
 * 与旧的 runListPollIngestFixedPages 的核心差异：
 * 1. 从 sources.cursor 读上轮顶端 10 个 tweet_id（seen_set）
 * 2. 翻页时本页 ids ∩ seen_set 非空就停（替代「整页全 known」早停）
 * 3. 硬上限 10 页（兜底，防 seen_set 全被删导致无限翻）
 * 4. 整轮成功才更新 sources.cursor（中途失败保留旧值，下轮重头）
 * 5. newly_inserted > 70 时分流走 partitionForCatchup，剩余 pending_workflow=1
 *    由 scheduled() 收尾步骤消化
 */
async function runListPollIngestCursorDriven(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  listId: string,
): Promise<ListPollIngestResult> {
  const HARD_MAX_PAGES = 10;

  const t0 = Date.now();
  let totalCredits = 0;
  let totalSeen = 0;
  let newCount = 0;
  let updatedCount = 0;
  let pages = 0;
  let lastRateRemaining: number | undefined;
  let firstError: string | undefined;
  let stopReason: 'hit_seen' | 'hard_max' | 'no_cursor' | 'error' = 'error';

  // 1. 读 sources.cursor → seen_set
  const sourceId = `x_list:${listId}`;
  const sourceRow = await env.DB.prepare(
    `SELECT cursor FROM sources WHERE id = ?`,
  ).bind(sourceId).first<{ cursor: string | null }>();
  const seenSet = parseSeenSet(sourceRow?.cursor ?? null);
  const isColdStart = seenSet.size === 0;

  // 2. 累积所有新 items（跨多页），整轮成功后再统一 trigger workflow
  const allNewItems: Array<{
    itemId: string;
    publishedAt: string | null;
    hasQuoteRef: boolean;
    hasReplyRef: boolean;
    hasLinkCard: boolean;
    hasRetweetRef: boolean;
  }> = [];

  // 第一页的顶端 ids（用于结束时更新 cursor）
  let firstPageTopIds: string[] = [];

  let cursor: string | null = null;
  let stopped = false;

  for (let p = 0; p < HARD_MAX_PAGES && !stopped; p++) {
    const r = await fetchListTweetsPage(env, listId, cursor);
    pages++;
    totalCredits += r.creditsUsed || 0;
    totalSeen += r.tweets.length;
    lastRateRemaining = r.rateLimitRemaining;

    if (r.error) {
      firstError = r.error;
      stopReason = 'error';
      break;
    }
    if (r.tweets.length === 0) {
      stopReason = 'no_cursor';
      stopped = true;
      break;
    }

    const pageIds = r.tweets.map((t) => t.id).filter((x): x is string => !!x);
    if (p === 0) {
      firstPageTopIds = pageIds.slice(0, SEEN_SET_MAX_SIZE);
    }

    // 命中判定
    const stopIndex = findStopIndex(pageIds, seenSet);
    const tweetsToProcess = stopIndex === -1 ? r.tweets : r.tweets.slice(0, stopIndex);

    // upsert + 累积 new items（具体 D1 batch 逻辑同旧函数 runListPollIngestFixedPages，
    // 这里抽公共 helper：upsertTweetsAndCollectNew，见 Task 3.4 之后细化）
    const result = await upsertTweetsAndCollectNew(env, tweetsToProcess);
    newCount += result.newCount;
    updatedCount += result.updatedCount;
    allNewItems.push(...result.newItems);

    if (stopIndex !== -1) {
      stopReason = 'hit_seen';
      stopped = true;
      break;
    }
    if (!r.nextCursor) {
      stopReason = 'no_cursor';
      stopped = true;
      break;
    }
    cursor = r.nextCursor;
  }

  if (!stopped && pages >= HARD_MAX_PAGES) {
    stopReason = 'hard_max';
  }

  // 3. 整轮成功才推进 cursor + trigger workflow
  const allSuccess = !firstError;
  if (allSuccess) {
    // catch-up 分流：按 published_at desc 排序（已经是了，SB 返回就是时序）
    allNewItems.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    const partition = partitionForCatchup(allNewItems, CATCHUP_THRESHOLD_DEFAULT);

    // 立即 trigger immediate 部分
    if (env.X_TWEET_PIPELINE_WORKFLOW) {
      for (const n of partition.immediate) {
        await triggerXWorkflowForItem(env, n.itemId, {
          hasQuoteRef: n.hasQuoteRef,
          hasReplyRef: n.hasReplyRef,
          hasLinkCard: n.hasLinkCard,
          hasRetweetRef: n.hasRetweetRef,
        });
      }
    }

    // pending 部分标记 pending_workflow=1
    if (partition.pending.length > 0) {
      const stmts = partition.pending.map((n) =>
        env.DB.prepare(`UPDATE items SET pending_workflow=1 WHERE id=?`).bind(n.itemId),
      );
      await env.DB.batch(stmts);
    }

    // 更新 sources.cursor
    if (firstPageTopIds.length > 0) {
      await env.DB.prepare(
        `INSERT INTO sources (id, source_type, source_ref, cursor, last_success_at)
         VALUES (?, 'x_list', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cursor = excluded.cursor,
           last_success_at = excluded.last_success_at`,
      ).bind(
        sourceId,
        listId,
        serializeSeenSet(firstPageTopIds),
        new Date().toISOString(),
      ).run();
    }
  }

  return {
    mode: 'list-poll-ingest',
    list_id: listId,
    pages,
    tweets_seen: totalSeen,
    inserted_or_updated: newCount + updatedCount,
    newly_inserted: newCount,
    credits_used: totalCredits,
    rate_limit_remaining: lastRateRemaining,
    duration_ms: Date.now() - t0,
    early_stop: stopReason === 'hit_seen',
    error: firstError,
    // M16 扩展字段（可选，不破坏旧 caller）
    stop_reason: stopReason,
    cold_start: isColdStart,
    pending_count: allSuccess ? Math.max(0, newCount - CATCHUP_THRESHOLD_DEFAULT) : 0,
  };
}
```

**Step 2: 在 enrich.ts 顶部加 import**

在文件顶部其他 import 后面加：

```typescript
import {
  parseSeenSet,
  serializeSeenSet,
  findStopIndex,
  partitionForCatchup,
  SEEN_SET_MAX_SIZE,
  CATCHUP_THRESHOLD_DEFAULT,
} from './x-list-cursor';
```

**Step 3: 在 `ListPollIngestResult` interface 加可选字段**

找到 `ListPollIngestResult` 定义（通过 grep `interface ListPollIngestResult`），加：

```typescript
stop_reason?: 'hit_seen' | 'hard_max' | 'no_cursor' | 'error';
cold_start?: boolean;
pending_count?: number;
```

**Step 4: 不 commit（这一 task 不可独立工作，需要 Task 3.4 完成 dispatcher 才能 build pass）**

### Task 3.4: 实现 dispatcher（runListPollIngest）+ 抽 upsertTweetsAndCollectNew helper

**Files:**
- Modify: `worker/src/enrich.ts`

**Step 1: 抽 upsertTweetsAndCollectNew helper（从旧 runListPollIngestFixedPages 里复制核心 upsert 逻辑）**

在 `runListPollIngestFixedPages` 上方插入：

```typescript
/** 把一组 tweet upsert 到 items 表，返回 new vs updated 分类 + 新 items 元信息 */
async function upsertTweetsAndCollectNew(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  tweets: ScrapeBadgerTweet[],
): Promise<{
  newCount: number;
  updatedCount: number;
  newItems: Array<{
    itemId: string;
    publishedAt: string | null;
    hasQuoteRef: boolean;
    hasReplyRef: boolean;
    hasLinkCard: boolean;
    hasRetweetRef: boolean;
  }>;
}> {
  // 视频补全（同旧函数 L2200-L2228）
  const videoMp4Map = new Map<string, string>();
  const videoTweets = tweets.filter((t) =>
    (t.media || []).some((m) => m.type === 'video' || m.type === 'animated_gif'),
  );
  for (const vt of videoTweets) {
    if (!vt.id) continue;
    try {
      const fr = await fetchTweet(vt.id);
      if (!fr?.data) continue;
      const mediaDetails = (fr.data as Record<string, unknown>).mediaDetails as
        | Array<Record<string, unknown>>
        | undefined;
      if (!mediaDetails) continue;
      for (const md of mediaDetails) {
        if (md.type !== 'video' && md.type !== 'animated_gif') continue;
        const variants =
          ((md.video_info as Record<string, unknown>)?.variants as Array<{
            content_type?: string;
            bitrate?: number;
            url?: string;
          }>) || [];
        const mp4s = variants.filter((v) => v.content_type === 'video/mp4' && v.url);
        mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const best = mp4s[0]?.url;
        if (best && !videoMp4Map.has(vt.id)) videoMp4Map.set(vt.id, best);
      }
    } catch { /* 单条失败不影响其它 */ }
  }

  const composedIds = tweets.map((t) => `x_list:${t.id}`).filter(Boolean);
  if (composedIds.length === 0) {
    return { newCount: 0, updatedCount: 0, newItems: [] };
  }

  const placeholders = composedIds.map(() => '?').join(',');
  const existingRows = await env.DB.prepare(
    `SELECT id FROM items WHERE id IN (${placeholders})`,
  )
    .bind(...composedIds)
    .all<{ id: string }>();
  const existingSet = new Set(existingRows.results.map((row) => row.id));

  const stmts: D1PreparedStatement[] = [];
  let newCount = 0;
  let updatedCount = 0;
  const newItems: Array<{
    itemId: string;
    publishedAt: string | null;
    hasQuoteRef: boolean;
    hasReplyRef: boolean;
    hasLinkCard: boolean;
    hasRetweetRef: boolean;
  }> = [];

  for (const t of tweets) {
    const item = sbTweetToIngestItem(t, videoMp4Map);
    if (!item) continue;
    const id = `x_list:${item.source_id}`;
    stmts.push(
      env.DB.prepare(`
        INSERT INTO items (id, source_type, source_id, title, content,
          content_translated, author, handle, url, media, metrics, published_at,
          scraped_at, is_relevant, matched_by, lang, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = CASE
            WHEN items.content IS NULL OR length(coalesce(excluded.content, '')) >= length(items.content)
              THEN excluded.content
            ELSE items.content
          END,
          media = excluded.media,
          metrics = excluded.metrics,
          extra = CASE
            WHEN items.extra IS NULL THEN excluded.extra
            WHEN excluded.extra IS NULL THEN items.extra
            ELSE json_patch(items.extra, excluded.extra)
          END
      `).bind(
        id, item.source_type, item.source_id, item.title, item.content,
        item.content_translated, item.author, item.handle, item.url,
        item.media, item.metrics, item.published_at, item.scraped_at,
        item.is_relevant, item.matched_by, item.lang, item.extra,
      ),
    );
    if (!existingSet.has(id)) {
      newCount++;
      let extraObj: Record<string, unknown> = {};
      try {
        extraObj = JSON.parse(item.extra || '{}') as Record<string, unknown>;
      } catch { /* ignore */ }
      newItems.push({
        itemId: id,
        publishedAt: item.published_at ?? null,
        hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
        hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
        hasLinkCard: !!extraObj.link_card,
        hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
      });
    } else {
      updatedCount++;
    }
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  return { newCount, updatedCount, newItems };
}
```

**Step 2: 在文件末尾加 dispatcher（取代原 export）**

```typescript
/**
 * X list-poll ingest 统一入口（M16 dispatcher）。
 *
 * env.LIST_POLL_MODE:
 *   'fixed-pages'    = 旧逻辑（备份用，灰度回滚开关）
 *   'cursor-driven'  = 新逻辑（默认，M16+）
 *   缺省            = 'cursor-driven'（默认走新）
 *
 * 第 3 个参数 maxPages 仅 fixed-pages 模式有效；cursor-driven 用硬编码 10。
 */
export async function runListPollIngest(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string; LIST_POLL_MODE?: string },
  listId: string,
  maxPages = 3,
): Promise<ListPollIngestResult> {
  const mode = (env.LIST_POLL_MODE || 'cursor-driven').toLowerCase();
  if (mode === 'fixed-pages') {
    return runListPollIngestFixedPages(env, listId, maxPages);
  }
  return runListPollIngestCursorDriven(env, listId);
}
```

**Step 3: 检查 tsc**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 无 error

**Step 4: Commit Phase 3 全部改动**

```bash
git add worker/src/enrich.ts
git commit -m "feat(x-list): 游标驱动版 runListPollIngest（M16 主体）+ LIST_POLL_MODE dispatcher

- runListPollIngestCursorDriven: 游标驱动 + seen_set 命中即停 + 10 页硬上限 + >70 catch-up 分流
- runListPollIngestFixedPages: 旧逻辑保留（开关回滚用）
- upsertTweetsAndCollectNew: helper 复用两种模式的 D1 batch upsert 逻辑
- ListPollIngestResult 加 stop_reason / cold_start / pending_count 可选字段（不破坏旧 caller）

设计: docs/plans/2026-05-22-x-list-cursor-driven-design.md"
```

---

## Phase 4：cron tick 加 pending_workflow 收尾消化

### Task 4.1: 在 enrich.ts 加 drainPendingWorkflowQueue 函数

**Files:**
- Modify: `worker/src/enrich.ts`

**Step 1: 在文件末尾加 export 函数**

```typescript
/**
 * 收尾消化「待加工」队列（M16 catch-up 平摊机制）。
 * 每个 cron tick 主流程做完后调用一次，按 published_at asc（最老先）取 N 条
 * pending_workflow=1 的 item，逐条 trigger workflow，触发成功的清 0。
 *
 * @returns { drained, remaining } 本次消化数 + 剩余 pending 数（用于通知 / 监控）
 */
export async function drainPendingWorkflowQueue(
  env: EnrichEnv,
  batchSize: number = CATCHUP_THRESHOLD_DEFAULT,
): Promise<{ drained: number; remaining: number; error?: string }> {
  if (!env.X_TWEET_PIPELINE_WORKFLOW) {
    return { drained: 0, remaining: 0, error: 'no_workflow_binding' };
  }

  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT id, extra FROM items
       WHERE pending_workflow = 1 AND source_type = 'x_list'
       ORDER BY published_at ASC
       LIMIT ?`,
    ).bind(batchSize).all<{ id: string; extra: string | null }>();
  } catch (e) {
    return { drained: 0, remaining: -1, error: e instanceof Error ? e.message : 'select_failed' };
  }

  let drained = 0;
  for (const r of rows.results) {
    let extraObj: Record<string, unknown> = {};
    try {
      extraObj = JSON.parse(r.extra || '{}') as Record<string, unknown>;
    } catch { /* ignore */ }
    try {
      await triggerXWorkflowForItem(env, r.id, {
        hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
        hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
        hasLinkCard: !!extraObj.link_card,
        hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
      });
      // 触发成功后清 pending 标志
      await env.DB.prepare(`UPDATE items SET pending_workflow=0 WHERE id=?`).bind(r.id).run();
      drained++;
    } catch (e) {
      // 单条失败不影响其它；下次 cron tick 还能再试
      console.error(`[drain-pending] item=${r.id} err:`, e);
    }
  }

  // 查剩余总量（监控用）
  let remaining = -1;
  try {
    const rest = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE pending_workflow = 1 AND source_type = 'x_list'`,
    ).first<{ n: number }>();
    remaining = rest?.n ?? -1;
  } catch { /* ignore */ }

  return { drained, remaining };
}
```

**Step 2: 检查 tsc**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 无 error

**Step 3: Commit**

```bash
git add worker/src/enrich.ts
git commit -m "feat(x-list): drainPendingWorkflowQueue - cron tick 收尾消化 pending 队列"
```

### Task 4.2: 在 scheduled() 接入 drain 收尾

**Files:**
- Modify: `worker/src/index.ts:1264`（list-poll-ingest 分支末尾）

**Step 1: 找到 list-poll-ingest 分支**

Run:
```bash
grep -n "list-poll-ingest\|drainPending" worker/src/index.ts | head -10
```

**Step 2: 在 import 加 drainPendingWorkflowQueue**

找到 `worker/src/index.ts` 顶部从 `enrich` 导入的那行（约第 17 行），加：

```typescript
import {
  runListPollIngest,
  drainPendingWorkflowQueue,
  // ... 其他已有 imports
} from './enrich';
```

**Step 3: 在 list-poll-ingest 分支末尾（约 `:1284` `return;` 前）插入收尾**

找到约 1264-1284 行的 `if (mode === 'list-poll-ingest')` 分支，在 `await notifyCronSummary(env, 'X List 抓取', ...)` 之前插入：

```typescript
// M16 收尾：消化 pending_workflow 队列（不阻塞主结果通知）
try {
  const drainRes = await drainPendingWorkflowQueue(env);
  if (drainRes.drained > 0 || drainRes.remaining > 0) {
    console.log(`[cron] list-poll-ingest drain-pending: drained=${drainRes.drained} remaining=${drainRes.remaining}`);
    // 把 drain 信息合并到通知 payload
    (r as Record<string, unknown>).pending_drained = drainRes.drained;
    (r as Record<string, unknown>).pending_remaining = drainRes.remaining;
  }
} catch (e) {
  console.error('[cron] drain-pending failed:', e);
}
```

**Step 4: 检查 tsc**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 无 error

**Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(x-list): cron list-poll-ingest 收尾消化 pending 队列"
```

---

## Phase 5：扩展 notifyCronSummary 加 3 个告警信号

### Task 5.1: 加 3 个通知触发

**Files:**
- Modify: `worker/src/index.ts`（list-poll-ingest 分支）+ `worker/src/notifier.ts`（如果需要新函数）

**Step 1: 查 notifyCronSummary 实现位置**

Run:
```bash
grep -n "notifyCronSummary\|export.*notify" worker/src/notifier.ts | head -5
```

**Step 2: 在 list-poll-ingest 分支加 3 个特殊信号**（接在 Task 4.2 的 drain 之后）

```typescript
// M16 告警信号（除常规 summary 外的额外推送）
const stopReason = (r as Record<string, unknown>).stop_reason as string | undefined;
const newlyInserted = (r as Record<string, unknown>).newly_inserted as number | undefined;
const pendingDrained = (r as Record<string, unknown>).pending_drained as number | undefined;

// 信号 1：catch-up 触发
if (typeof newlyInserted === 'number' && newlyInserted > 70) {
  console.log(`[cron] CATCH-UP: newly_inserted=${newlyInserted}, pending=${newlyInserted - 70}`);
  // 单独 push（不打扰常规 summary，但运维要看到）
  try {
    await notifyCronSummary(env, 'X List 补漏触发', {
      message: `本轮新增 ${newlyInserted} 条（>70），已分流，${newlyInserted - 70} 条进入待加工队列`,
      newly_inserted: newlyInserted,
      pending_added: newlyInserted - 70,
    });
  } catch (e) {
    console.error('[notify] catch-up push failed:', e);
  }
}

// 信号 2：硬上限触发（10 页都没撞 seen_set）
if (stopReason === 'hard_max') {
  try {
    await notifyCronSummary(env, 'X List 警告: 翻满硬上限', {
      message: '翻满 10 页未撞 seen_set。可能 seen_set 全被作者删 / list 突增 / SB 异常。需要人看一眼',
      list_id: env.LIST_POLL_LIST_ID || '1643236611378008066',
    });
  } catch (e) {
    console.error('[notify] hard-max push failed:', e);
  }
}

// 信号 3：连续失败（依赖 KV state，跨 tick 累计）
// 简化版：每次失败 KV +1，连续 3 次告警，成功清 0
const FAIL_STREAK_KEY = 'x-list-poll-fail-streak';
if ((r as Record<string, unknown>).error) {
  try {
    const cur = parseInt((await env.KV.get(FAIL_STREAK_KEY)) || '0', 10);
    const next = cur + 1;
    await env.KV.put(FAIL_STREAK_KEY, String(next), { expirationTtl: 86400 });
    if (next >= 3) {
      await notifyCronSummary(env, 'X List 告警: 连续失败', {
        message: `连续 ${next} 轮抓取失败，cursor 已停止推进`,
        last_error: (r as Record<string, unknown>).error,
        fail_streak: next,
      });
    }
  } catch (e) {
    console.error('[notify] fail-streak track failed:', e);
  }
} else {
  // 成功清 streak
  try { await env.KV.delete(FAIL_STREAK_KEY); } catch { /* ignore */ }
}
```

**Step 3: 确认 env.KV binding 存在**

Run:
```bash
grep -n "KV\|KVNamespace" worker/wrangler.toml | head -5
```
Expected: 存在 KV namespace binding（如果没有要先加，但 worker 大概率已有，用于 cron sentinel keys）

**Step 4: 检查 tsc**

Run:
```bash
cd worker && npx tsc --noEmit
```
Expected: 无 error

**Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(x-list): 3 个 M16 告警信号 - catch-up / hard-max / 连续失败"
```

---

## Phase 6：CLAUDE.md 同步更新

### Task 6.1: 删旧节 + 加新事实 + 加新章节

**Files:**
- Modify: `/Users/roxor/brain/30-projects/aifeeds/CLAUDE.md`

**Step 1: 找到旧节位置**

Run:
```bash
grep -n "禁用 ID 游标\|抓取停止条件\|核心事实.*X list" CLAUDE.md
```

**Step 2: 把整节「⚠️ 抓取停止条件：禁用 ID 游标（反复踩过的坑）」**删除**

删除从「### ⚠️ 抓取停止条件」开始，到该节结束（下一个 `##` 或 `###` 之前）的全部内容。

**Step 3: 在同位置插入新节**

```markdown
### X list 抓取：游标驱动停止条件（M16，2026-05-22 上线）

**关键事实更正**（2026-05-21 实测确认）：
- X web 端访问 list 默认是热度排序（For You / Top）
- 但 aifeeds 走的 **ScrapeBadger `/v1/twitter/lists/{id}/tweets` endpoint 是严格时间倒序**（行为等价于 X 官方 `ListLatestTweetsTimeline`）
- 历史上 CLAUDE.md 里「禁止基于 tweet_id 做游标」的禁令是基于「热度排序」前提写的，前提作废，禁令也作废

**当前抓取停止策略**（runListPollIngest，cursor-driven 模式）：

- `sources.cursor` 字段存上次抓完后 page 1 的顶端 10 个 `tweet_id`（JSON 数组），称 seen_set
- 每次抓取从最新一页开始翻；本页任意 `id ∈ seen_set` 即停（时序保证：命中之后的全是上轮处理过的）
- 硬上限 10 页（兜底，防 seen_set 全部被作者删导致无限翻爆 API 费用）
- 整轮成功才更新 seen_set；中途失败保留旧值，下轮重头（D1 upsert 无副作用）
- `newly_inserted > 70` 时进入 catch-up 分流：最新 70 条立即触发 workflow，其余 `items.pending_workflow=1`，由后续 cron tick 在 `drainPendingWorkflowQueue` 里平摊消化

**灰度开关**：`LIST_POLL_MODE`（worker secret）
- `cursor-driven`（默认）= 新逻辑
- `fixed-pages`        = 旧逻辑（回滚开关，跑 1 周稳定后可删）

**完整设计**：见 `docs/plans/2026-05-22-x-list-cursor-driven-design.md`
```

**Step 4: 检查 CLAUDE.md 改完没遗留旧引用**

Run:
```bash
grep -n "禁用 ID 游标\|tweet_id ≤ last_max" CLAUDE.md
```
Expected: 无输出（旧禁令文本已全部删除）

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): 同步 M16 X list 游标驱动 - 删旧禁令 + 加新事实 + 加新节"
```

---

## Phase 7：staging 部署 + 端到端验证

### Task 7.1: 部署到 staging

**Files:** 无（执行外部命令）

**Step 1: source staging secrets**

```bash
set -a && . .secrets/aifeeds-staging.env && set +a
```

**Step 2: deploy**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker deploy --env staging
```
Expected: `Deployment complete!`

**Step 3: 验证 secret LIST_POLL_MODE 未设置（默认走新逻辑）**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker secret list --env staging | grep LIST_POLL_MODE || echo "未设置（默认 cursor-driven）"
```
Expected: 输出 `未设置（默认 cursor-driven）`

### Task 7.2: 手动触发 staging 一次 list-poll 看日志

**Files:** 无（curl + tail log）

**Step 1: 触发一次抓取**（用 admin endpoint）

```bash
curl -sS -X POST "https://staging-api.ai-feeds.com/api/admin/x-list-poll-trigger?listId=1643236611378008066&pages=10" \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "x-dev-token: $DEV_TOKEN" | jq
```
Expected: 返回 JSON 含 `mode`, `pages`, `tweets_seen`, `newly_inserted`, `stop_reason`, `cold_start`

（如果不存在这个 admin endpoint，跳到 Task 7.3 等 cron 自然跑）

**Step 2: 看日志**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker tail --env staging --format pretty | grep -i "list-poll\|cursor\|seen_set" &
sleep 60
kill %1
```
Expected: 看到 `list-poll-ingest result: {... "stop_reason": "...", "cold_start": true, ...}`

**Step 3: 验证 staging D1 已更新 cursor**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist-staging --env staging --remote \
  --command="SELECT cursor FROM sources WHERE id='x_list:1643236611378008066'" --json | jq
```
Expected: cursor 字段非空，是 JSON 数组含 10 个 tweet_id

### Task 7.3: 静观 3-7 天 + 横纵比对

**Files:** 无（观察）

**Step 1: 每天 1 次查 staging 抓取统计**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist-staging --env staging --remote \
  --command="SELECT refreshed_at, items_count, errors FROM refresh_log WHERE tier=99 ORDER BY refreshed_at DESC LIMIT 20" --json
```
Expected: 持续有新的 tick 记录；items_count 分布合理（多数 1-2 页 = 55-110）

**Step 2: 横向比对 staging vs prod 同期 newly_inserted 数**

跑一个对比脚本（创建 `worker/scripts/compare-staging-prod-xlist.ts`，从 2 个环境的 items 表查最近 24h `source_type='x_list' AND scraped_at > now-24h` 的数量；staging 应该 ≥ prod 95%）

**Step 3: 纵向比对 KOL 覆盖**

跑 `worker/scripts/verify-kol-coverage.ts`：用 SB user-timeline endpoint 抓 list 内 5-10 个 KOL 最近 100 条，对比 staging items 表里这些人的覆盖率（应该 ≥ 95%）

**Step 4: 看 PushDeer 是否有异常告警**

期间 staging 不应该频繁收到「硬上限触发」「连续失败」推送。常态推送（catch-up 触发）可能有，正常。

---

## Phase 8：合 main + prod 灰度

### Task 8.1: PR + merge

**Files:** 无（git + GitHub）

**Step 1: push feature branch**

```bash
git push -u origin feat/x-list-cursor-driven
```

**Step 2: 开 PR**

```bash
gh pr create --title "feat(x-list): M16 游标驱动 - 零漏 list AI 推文" --body "$(cat <<'EOF'
## Summary
- 把 X list-poll 从固定 3 页早停改为游标驱动（seen_set 10 个 id 命中即停）
- 硬上限 10 页兜底；> 70 条 catch-up 分流走 pending_workflow 队列
- LIST_POLL_MODE 灰度开关支持秒级回滚

## Test plan
- [ ] staging 跑 3-7 天，refresh_log 显示常态在 1-2 页就停
- [ ] staging vs prod 同期 newly_inserted 比对，staging ≥ prod 95%
- [ ] SB user-timeline KOL 覆盖率 ≥ 95%
- [ ] PushDeer 无频繁告警

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: 等 review 通过后 merge（用户操作）**

**Step 4: 切回 main + pull**

```bash
git checkout main
git pull origin main
```

### Task 8.2: prod deploy

**Files:** 无（执行 deploy）

**Step 1: source prod secrets**

```bash
set -a && . .secrets/aifeeds-prod.env && set +a
```

**Step 2: 跑 prod migration**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist --remote --file=migrations/016-x-list-cursor.sql
```
Expected: `Executed 2 commands`

**Step 3: prod deploy**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker deploy
```
Expected: `Deployment complete!`

**Step 4: 等下一个 :25 / :55 cron tick，看日志**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker tail --format pretty | grep "list-poll" &
# 等 5-30 分钟到下个 tick
```
Expected: prod cron 触发后输出 `list-poll-ingest result: {... "stop_reason": "...", ...}`

**Step 5: 验证 prod sources.cursor 已填**

```bash
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx --prefix worker wrangler --cwd worker d1 execute xlist --remote \
  --command="SELECT cursor FROM sources WHERE id='x_list:1643236611378008066'" --json | jq
```
Expected: cursor 非空，含 10 个 tweet_id

### Task 8.3: prod 1 周观察

**Files:** 无（观察）

**Step 1: 每天 1 次 prod 状态查询**

跟 Task 7.3 类似，prod 版。

**Step 2: 如有异常**

立即回滚：
```bash
echo 'fixed-pages' | (cd worker && \
  CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx wrangler secret put LIST_POLL_MODE)
```

---

## Phase 9：稳定后清理（合 prod 1 周后）

### Task 9.1: 删旧 fixed-pages 代码 + 开关

**Files:**
- Modify: `worker/src/enrich.ts`（删 `runListPollIngestFixedPages` + dispatcher 简化）

**Step 1: 删除 `runListPollIngestFixedPages` 函数**

**Step 2: 把 `runListPollIngest` 直接等同于原 `runListPollIngestCursorDriven`**（去掉 dispatcher）

**Step 3: 删除 `EnrichEnv.LIST_POLL_MODE` 字段**

**Step 4: tsc 检查**

```bash
cd worker && npx tsc --noEmit
```

**Step 5: PR + merge + deploy（同 Phase 8 流程）**

**Step 6: 删 prod LIST_POLL_MODE secret**

```bash
echo "" | (cd worker && \
  CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" \
  npx wrangler secret delete LIST_POLL_MODE)
```

### Task 9.2: 同步更新 docs/operations.md（如有提及 list-poll 旧行为）

略，按需调整。

---

## 任务总览

| Phase | Task | 大致耗时 |
|---|---|---|
| 0 | 准备 | 2 分钟 |
| 1 | D1 migration（写 + staging 跑） | 10 分钟 |
| 2 | 核心算法纯函数 + 测试 | 20 分钟 |
| 3 | runListPollIngest 重写 + dispatcher | 30 分钟 |
| 4 | drainPendingWorkflowQueue + cron 接入 | 15 分钟 |
| 5 | 3 个告警信号 | 15 分钟 |
| 6 | CLAUDE.md 同步 | 10 分钟 |
| 7 | staging deploy + 验证（实际跨 3-7 天） | 15 分钟操作 + 静观 |
| 8 | prod 合 + deploy + 1 周观察 | 20 分钟操作 + 静观 |
| 9 | 1 周后清理 | 15 分钟 |

**纯编码 + deploy 操作时间约 2.5 小时；含 staging 观察 + prod 观察总跨度约 10-14 天。**
