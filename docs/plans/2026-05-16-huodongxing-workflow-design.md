# 活动行（Huodongxing）抓取链迁 CF Workflow 设计（阶段 5）

> 2026-05-16。落地：`worker/src/workflows/huodongxing-detail.ts`（待实施）。
>
> 闭合阶段 5（CF 迁移收尾的最后一个抓取链）。
> 上游：[`2026-05-16-x-main-pipeline-workflows-design.md`](2026-05-16-x-main-pipeline-workflows-design.md) / [`2026-05-16-github-pipeline-workflows-design.md`](2026-05-16-github-pipeline-workflows-design.md) 同模式。

## 背景

prod 当前数据（2026-05-16 实测）：

| 项 | 数 |
|---|---|
| 总活动数 | 1285 |
| **详情待拉（detail_pending）** | **860 (66%)** |
| 详情已拉 | 425 (33%) |
| 已过期（historical） | 324 |

**enrich 日吞吐 100-180/天**（cron `:20`/`:50` batch=3 × 5s throttle = 理论 144/天上限），**list 抓取 ~150 新事件/天 → 队列稳步积压**。当前 860 backlog 按现速率要 6-9 天才能 drain（且不断进新货）。

根因跟 X / GH 阶段一样：抢占式 cron 模型 + batch 太小 + 跟 PH/ClawHub 抢 cron slot。

## 跟 X / GH 的关键差异（影响架构）

| 维度 | GH / X 主链 | 活动行 |
|---|---|---|
| LLM 调用 | 有（分类 + 翻译）| **无**（中文源 + 不分类，全部 is_relevant=1）|
| 单 item step 数 | 4-5（含 LLM）| **2**（fetch + parse） |
| 外部 API | DeepSeek + 多端点 | 单端点 huodongxing.com |
| **site 反爬** | 无 | **强**：cookie warm-up + 5s/detail 节流 |
| Per-event 并行可能性 | 是 | **否**（rate limit）|

cookie warm-up 是关键约束：**当前每批 1 次 warm-up + N detail 共用**，无 warm-up 时 detail 成功率从 95% 掉到 40%。

## 决策记录（待 PM approve）

| 决策点 | 选项 | 建议 | 理由 |
|---|---|---|---|
| Worker 位置 | 单 main / 独立 | **单 main worker** | 跟阶段 3/4 一致；list-fetch state machine 已在 main worker，inline 触发 |
| 切换方式 | 直接切换 / 双写过渡 | **直接切换** | hdx 量小、独立流水（不卡 X/GH 业务路径），单 PR 回滚极简 |
| 任务粒度 | 每事件 1 instance（throttle 分散） / 每 batch 1 instance（顺序处理） | **每事件 1 instance + KV cookie 缓存 + throttleSec 参数分散** | per-event retry 粒度细，Dashboard 看哪条详情爆错；但用 throttleSec 参数 + KV cookie 共享 控制 rate limit |
| 设计先行 | 先 design / 直接 PR | **先 design doc** | hdx 反爬细节多，对齐架构再实施 |

## 架构

### 整体流程（迁后）

```
[list-fetch state machine cron]  保留不变
  - 起跑：BJT 04:30 / 16:30（UTC 20:30 / 08:30）reset KV 进度
  - 接力：之后 7 个 tick 接抓未完成城市（24 城 × ~5 页）
  - 每个 tick batch_budget=40 subreq，2s/page 节流
  ↓ each tick batch upserts N new events to D1
  ↓ for each new event_id (not in existingSet):
      env.HUODONGXING_DETAIL_WORKFLOW.create({
        id: `hdx-${event_id}`,
        params: { itemId, throttleSec: N * 5 },   // 同 batch 内按顺序分散 5s
      })

[HuodongxingDetailWorkflow]  新增（worker/src/workflows/huodongxing-detail.ts）
  step 0: step.sleep(`${throttleSec} seconds`)  // 跨 instance 节流
  step 1: ensure-cookies                          // 读 KV，过期/缺失则 fetch warm-up，存回 KV
  step 2: fetch-and-parse-detail                  // GET detail page + parseDetail
  step 3: persist                                 // UPDATE D1 (detail 字段 + status active/historical)
```

### Workflow class 骨架

```typescript
// worker/src/workflows/huodongxing-detail.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  ensureHdxSessionCookies,
  fetchAndParseHdxDetail,
  persistHdxDetail,
} from '../scrapers/huodongxing';

interface HdxDetailParams {
  itemId: string;
  throttleSec: number;  // 0..N*5，同 batch 内按顺序错开
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

export class HuodongxingDetailWorkflow extends WorkflowEntrypoint<Env, HdxDetailParams> {
  async run(event: WorkflowEvent<HdxDetailParams>, step: WorkflowStep) {
    const { itemId, throttleSec } = event.payload;

    // Step 0: 节流（跨 instance 错开请求）
    if (throttleSec > 0) {
      await step.sleep('throttle', `${throttleSec} seconds`);
    }

    // Step 1: 拿 cookies（KV cache，10 min TTL）
    const cookies = await step.do('ensure-cookies', RETRY, () =>
      ensureHdxSessionCookies(this.env),
    );

    // Step 2: fetch detail page + parse
    const parsed = await step.do('fetch-and-parse-detail', RETRY, () =>
      fetchAndParseHdxDetail(this.env, itemId, cookies),
    );
    if (!parsed) {
      return { itemId, status: 'parse-failed' as const };
    }

    // Step 3: write D1（含 historical 判断）
    await step.do('persist', RETRY, () =>
      persistHdxDetail(this.env, itemId, parsed),
    );

    return { itemId, status: 'enriched' as const };
  }
}
```

### 单 itemId 函数（待实施 PR 加到 worker/src/scrapers/huodongxing.ts）

```typescript
// Step 1: KV 缓存 cookie 复用，10 min TTL
export async function ensureHdxSessionCookies(env: Env): Promise<string> {
  const cached = await env.AUTH_KV.get('hdx:session_cookies');
  if (cached) return cached;
  const warmupUrl = `https://www.huodongxing.com/events?tag=AI&city=北京&orderby=o`;
  const r = await fetchText(warmupUrl, { retries: 0 });
  const cookies = r.cookies || '';
  if (cookies) {
    await env.AUTH_KV.put('hdx:session_cookies', cookies, { expirationTtl: 600 });
  }
  return cookies;
}

// Step 2: 拉 detail page + parse
export async function fetchAndParseHdxDetail(
  env: Env, itemId: string, cookies: string,
): Promise<DetailEnrich | null> { ... }

// Step 3: 写 D1
export async function persistHdxDetail(
  env: Env, itemId: string, parsed: DetailEnrich,
): Promise<void> { ... }
```

### Phase 1 改造（runHuodongxingFetchList）

当前 runHuodongxingFetchList 在每个 tick 把当前城市的若干 page 写入 D1。改造：

```typescript
// 在 upsert 完一页 events 后，对每条新 event 触发 workflow
// 同 batch 内事件按顺序设 throttleSec（0, 5, 10, 15, ...）防 site 风控
let throttleIndex = 0;
for (const newEvent of newEventsInThisBatch) {
  const instanceId = `hdx-${newEvent.eventId}`;
  try {
    await env.HUODONGXING_DETAIL_WORKFLOW.create({
      id: instanceId,
      params: { itemId: newEvent.itemId, throttleSec: throttleIndex * 5 },
    });
    throttleIndex++;
  } catch (e) {
    if (!String(e).toLowerCase().includes('already exists')) {
      console.error(`[hdx-fetch] workflow create failed for ${newEvent.eventId}:`, e);
    }
  }
}
```

### 取消的 cron mode

- `runHuodongxingDetailEnrich` 的 cron 调度（`:20` / `:50` 槽位）— ✅ 删
- list-fetch 状态机（`isHdxFetchStartSlot` / `isHdxFetchContinueSlot`）— ⚠️ **保留**（pagination 状态机不适合 per-event workflow）
- sweep historical（`isHdxSweepSlot` BJT 03:00）— ⚠️ **保留**（日批量任务，跟 detail enrich 解耦）

**保留作 admin fallback**：
- `POST /api/admin/hdx-enrich-now?limit=N` 兜底批量 enrich（Basic Auth）
- `POST /api/enrich/run?mode=hdx-detail-enrich` 通过 INGEST_TOKEN 触发

### wrangler.toml 改动

```toml
[[workflows]]
name = "huodongxing-detail-workflow"
binding = "HUODONGXING_DETAIL_WORKFLOW"
class_name = "HuodongxingDetailWorkflow"

[[env.staging.workflows]]
name = "huodongxing-detail-workflow-staging"
binding = "HUODONGXING_DETAIL_WORKFLOW"
class_name = "HuodongxingDetailWorkflow"
```

## 容量预算

- 150 新事件/天 × 平均 2 step/instance × 30 = ~9,000 step/月（利用率 9%，免费额度 100k）
- 每 instance 包含 step.sleep（throttleSec），实测占 instance 时间但不消 CPU
- KV 操作 (cookie cache) 极低，可忽略
- **月成本：$0**

## Backfill 860 个 pending（cutover 后立刻做）

新增 admin endpoint：
```bash
POST /api/admin/hdx-trigger-pending-workflows-now?limit=N
```

扫 `json_extract(extra,'$.detail_enriched_at') IS NULL` 的 hdx item，按 last_seen_at DESC 排序，按 throttleSec spacing 5s 分批触发。

**Drain 时长估算**：
- 860 backlog × 5s throttle = ~71 min wall time（多个 instance 并行 + 错开）
- 默认 limit=100 一批，跑 9 批清完
- Site rate limit 仍 12/min，并发不超 site 上限

## 测试计划

### 1. Staging 部署 + 通路验证

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://staging-api.ai-feeds.com/api/admin/hdx-trigger-pending-workflows-now?limit=5'
```

期望：staging Workflow dashboard 看 5 个 instance：step.sleep + ensure-cookies + fetch-and-parse-detail + persist 全绿。

### 2. 异常路径

- 模拟 cookie warm-up 失败：临时改 KV key 名 → ensure-cookies step errored，dashboard 单步重试
- 模拟 detail 404：选已被删的 event → step 2 错误，retry 3 次后 errored

### 3. Prod cutover 后 24h 监控

- 部完触发 backlog drain（admin endpoint，limit=200）
- 观察 dashboard：~12 min 内消耗 200 instance
- 24h 后查 D1：detail_pending 数应降到 < 50

## 回滚

单 PR revert + `cd worker && rm -f ../wrangler.jsonc && npx wrangler deploy`：
- list-fetch 自动恢复「写 D1 + 等 preempt cron」模式
- 已跑完 instance 不重复；未跑完 errored（数据不损失）
- Cookie KV cache 留着不影响

## 时间估算

- **Day 1**（design doc PR review，本 PR）：1-2h
- **Day 2-3**（实施 PR）：
  - 拆分单 itemId 函数（ensureHdxSessionCookies / fetchAndParseHdxDetail / persistHdxDetail）
  - 写 HuodongxingDetailWorkflow class
  - 改 runHuodongxingFetchList 触发 workflow
  - 删 cron 调度 isHdxEnrichSlot
  - 加 admin endpoints
  - Staging E2E + drain backlog 测试
  - Prod cutover + 24h 观察 + operations.md 更新

**总：~2 天 calendar time**

## 兼容备选（备忘）

如果实施期间发现 throttleSec 跨 instance 节流不够（site 仍 rate-limit），降级方案：

**Plan B：1 instance per batch（参考阶段 4 X workflow fan-out 反向）**
- 每次 list-fetch tick 后，把 batch 内 N 个新 events 当 params 传给 1 个 workflow instance
- 该 instance 顺序处理（5s/detail），共享 1 次 cookie warm-up
- 牺牲 per-event retry granularity，换 100% 复刻当前 throttle 模型

**Plan C：纯配置调优（不迁 workflow）**
- 现有 runHuodongxingDetailEnrich 改 batch 3→10 + 频率 :10/:30/:50（3x）
- 1 小时实施，drain 859 backlog ~10 小时
- 不解决根本问题但短期足够

建议优先 Plan A（design 主体），如压测发现 throttleSec 不够再 fallback Plan B。
