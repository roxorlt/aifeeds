# X 主链迁 CF Workflows 设计 (阶段 4)

> 2026-05-16。落地：`worker/src/workflows/x-tweet-pipeline.ts`（待实施）。
>
> 闭合 TODO #4 阶段 4（含 task #5-#8 一并 in-PR 做完）。
> 上游：[`2026-05-06-cf-backend-migration-discussion.md`](2026-05-06-cf-backend-migration-discussion.md) § 4.1 / [`2026-05-16-github-pipeline-workflows-design.md`](2026-05-16-github-pipeline-workflows-design.md)（阶段 3 同模式复用）。

## 背景

X 主链目前 **6 个 cron mode** 全部走 preempt：每个 `*/5min` tick 查 D1 NULL 字段决定跑哪个 mode，固定槽位（refresh/longform/list-poll）之外全是抢占。痛点跟阶段 3 GH 链一样，但量级和复杂度都大得多：

- **状态散在 D1**：`is_relevant IS NULL` / `content_translated IS NULL` / `quote_of IS NULL` / `reply_to_id IS NULL` / `extra.is_longform` / `extra.longform_pending` 等十几个字段做隐式状态机
- **抢占饥饿**：DeepSeek 慢时 fill-translations 把 cron 槽吃光，classify-pending 排队半小时（这是「[英文久未翻译](2026-05-14-perf-mobile-diagnosis.md)」根因）
- **selectTranslationCandidates RANDOM SQL miss**：从大池子里随机抽 150 条，命中率 ~1%（task #5 已记账）
- **覆盖度漏洞**：reply / retweet 父推 snapshot 翻译流程根本不扫（task #6）
- **没有端到端 trace**：1 条推文从 ingest 到全 enrich 经过 6 个 mode 异步串联，挂在哪步只能从字段反推
- **量级**：80/天平均（migration doc 老估 261/天高估了；过去 7 天 prod 实测 23-148/天，均值 ~80）

## 决策记录（待 PM approve）

| 决策点 | 选项 | 建议 | 理由 |
|---|---|---|---|
| Worker 位置 | 单 main / 独立 worker | **单 main worker** | 跟阶段 3 GH 一致；list-poll-ingest cron 已在 main worker，inline 触发 workflow 避免跨 worker service binding |
| 切换方式 | 直接 / 双写过渡 | **直接切换** + 强 staging 验证 + 部 prod 后 24h 紧贴看 dashboard | X 量 80/天但复杂度 6 模式，单 PR 回滚极简；双写复杂度比收益高 |
| 任务粒度 | 1 大 step / N 小 step 顺序 / fan-out 并行 | **fan-out 并行**（Promise.all）| 翻译 3 个字段 + 父推回填 3 种类型互相独立，并行省 wall time + retry 粒度细 |
| task #5-#8 合并 | 单独 PR / 跟阶段 4 一起 | **跟阶段 4 一起** | task #5-#8 都是 X 主链改造，分 PR 反而碎片；单 PR review 一次到位 |

## 架构

### 端到端流程（迁后）

```
[list-poll-ingest cron] :25 / :55 → ScrapeBadger 拉 list page → INSERT 新 tweet (is_relevant=NULL)
                                  → 对每条新 tweet create Workflow instance
                                    (id = `x-{tweet_id}`, params = { itemId, hasQuoteRef, hasReplyRef })

[XTweetPipelineWorkflow]  (1 instance per new tweet)
  step 1: classify-with-llm   (DeepSeek 判 is_relevant + lang，retry 3 × 10s)
  ↓
  is_relevant=0 → return (早退，跳过 step 2-5)
  ↓
  step 2 fan-out (Promise.all 并行)：
    2a: backfill-quote          (条件：hasQuoteRef，syndication API)
    2b: backfill-reply          (条件：hasReplyRef，syndication API)
    2c: check-longform          (条件：tweet text length > 280 || 含 note_tweet 标记)
  ↓
  step 3: longform-via-sb       (条件：step 2c 检测到长推，ScrapeBadger 拉全文)
  ↓
  step 4 fan-out (Promise.all 并行)：
    4a: translate-content              (always)
    4b: translate-quote-of-content     (条件：step 2a backfilled)
    4c: translate-link-card-title-desc (条件：tweet 含 link_card)
    4d: translate-reply-of-content     (条件：step 2b backfilled，task #6 新加)
    4e: translate-retweet-of-content   (条件：retweet snapshot，task #6 新加)
  ↓
  done.
```

每 step 完成立即写 D1（保留「dashboard 看部分进度」UX），失败按 retry 配置（3 × 10s exp）。

### 取消的 6 个 preempt cron mode

| 旧 mode | 取消 | 备注 |
|---|---|---|
| `classify-pending` | ✅ → Workflow step 1 |
| `fill-translations` | ✅ → Workflow step 4 fan-out（一并解决 task #5 RANDOM miss）|
| `backfill-quotes` | ✅ → Workflow step 2a |
| `backfill-replies` | ✅ → Workflow step 2b（一并解决 task #6 翻译覆盖）|
| `detect-longform` | ✅ → Workflow step 2c |
| `longform-via-sb` | ✅ → Workflow step 3 |

**保留作 admin endpoint fallback**：上述 6 个 mode 通过 `/api/enrich/run?mode=X` (Bearer INGEST_TOKEN) 仍可手动 trigger，给以下场景兜底：
- 老 pre-migration 数据 backfill（类似阶段 3 的 9 个 stuck GH item）
- Workflow 出问题时手动批量补救
- 加新字段时 batch 回填存量

**取消但不动 admin endpoint**：所有现有 `/api/admin/*` GH/PH/X backfill endpoints 保留不动。

### 不动的 cron mode

- `list-poll-ingest`（:25/:55）—— 保留作 Phase 1 触发器
- `refresh-metrics`（:00/:30）—— ScrapeBadger batch endpoint，不切 Workflow（[migration doc § 2](2026-05-06-cf-backend-migration-discussion.md) 已说明）
- `cleanup`（每日 03:35）—— 简单定时清理
- GH `github-fetch` + Workflow（阶段 3 已迁完）
- PH `ph-daily-fetch`（每日 18:10）+ preempt enrich / r2-migrate
- ClawHub fetch + preempt enrich
- Huodongxing fetch + preempt enrich

### Workflow class 骨架

```typescript
// worker/src/workflows/x-tweet-pipeline.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  classifyXTweetWithLlm,
  backfillQuoteForTweet,
  backfillReplyForTweet,
  checkLongformForTweet,
  fetchLongformViaScrapeBadger,
  translateXTweetField,  // 单字段翻译，参数化 source_lang/target_lang
} from '../enrich';

interface XTweetParams {
  itemId: string;
  // 提示信号（Phase 1 ingest 时已知，省 step 内 D1 re-read）
  hasQuoteRef: boolean;
  hasReplyRef: boolean;
  hasLinkCard: boolean;
  lang: string;  // 暂硬编码 'zh' (task #7 i18n 友好：后续可加 'en' 等)
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class XTweetPipelineWorkflow extends WorkflowEntrypoint<Env, XTweetParams> {
  async run(event: WorkflowEvent<XTweetParams>, step: WorkflowStep) {
    const { itemId, hasQuoteRef, hasReplyRef, hasLinkCard, lang } = event.payload;

    // Step 1: classify
    const cls = await step.do('classify-with-llm', RETRY, async () => {
      return await classifyXTweetWithLlm(this.env, itemId);
    });
    if (cls.is_relevant !== 1) {
      return { itemId, classified: 'irrelevant' as const };
    }

    // Step 2 fan-out (parallel)
    const [quote, reply, longform] = await Promise.all([
      hasQuoteRef
        ? step.do('backfill-quote', RETRY, () => backfillQuoteForTweet(this.env, itemId))
        : Promise.resolve(null),
      hasReplyRef
        ? step.do('backfill-reply', RETRY, () => backfillReplyForTweet(this.env, itemId))
        : Promise.resolve(null),
      step.do('check-longform', RETRY, () => checkLongformForTweet(this.env, itemId)),
    ]);

    // Step 3: longform fetch (conditional)
    if (longform.is_longform) {
      await step.do('longform-via-sb', RETRY, () =>
        fetchLongformViaScrapeBadger(this.env, itemId),
      );
    }

    // Step 4 fan-out (parallel)
    await Promise.all([
      step.do('translate-content', RETRY, () =>
        translateXTweetField(this.env, itemId, 'content', { lang }),
      ),
      quote
        ? step.do('translate-quote-content', RETRY, () =>
            translateXTweetField(this.env, itemId, 'quote_of.content', { lang }),
          )
        : Promise.resolve(),
      hasLinkCard
        ? step.do('translate-link-card', RETRY, () =>
            translateXTweetField(this.env, itemId, 'link_card', { lang }),
          )
        : Promise.resolve(),
      reply
        ? step.do('translate-reply-content', RETRY, () =>
            translateXTweetField(this.env, itemId, 'reply_of.content', { lang }),
          )
        : Promise.resolve(),
    ]);

    return { itemId, classified: 'relevant' as const };
  }
}
```

> ⚠️ 现有 `worker/src/enrich.ts` 里的 `runClassifyPending` / `runFillTranslations` / `runBackfillQuotes` / `runBackfillReplies` / `runDetectLongform` / `runLongformViaSb` 函数需要拆成单 itemId 版本（上面 import 的 6 个函数），保留 batch 版本给 admin endpoint 用。

### Phase 1 触发

`worker/src/scrapebadger.ts` 的 `runListPollIngest` 拉完 list 后，**对每条 INSERT 成功（新行）的 tweet** 触发 workflow：

```typescript
// runListPollIngest() 内部，每个 INSERT 后：
const ingestSignals = {
  hasQuoteRef: !!tweet.quote_of_id,
  hasReplyRef: !!tweet.reply_to_id,
  hasLinkCard: !!tweet.link_card,
  lang: 'zh',
};
const instanceId = `x-${tweet.tweet_id}`;
try {
  await env.X_TWEET_PIPELINE_WORKFLOW.create({
    id: instanceId,
    params: { itemId: tweet.id, ...ingestSignals },
  });
} catch (e) {
  if (!String(e).toLowerCase().includes('already exists')) {
    console.error(`[x-ingest] workflow create failed for ${tweet.id}:`, e);
  }
}
```

### i18n 友好接口（task #7）

为未来多语言扩展铺路，**所有翻译相关函数 + Workflow 参数加 `lang` 字段**（当前硬编码 `'zh'`）：

```typescript
// 翻译函数签名变化：
async function translateXTweetField(
  env: Env,
  itemId: string,
  field: 'content' | 'quote_of.content' | 'link_card' | 'reply_of.content' | 'retweet_of.content',
  opts: { lang: 'zh' | 'en' | 'ja' },  // 暂只用 'zh'，类型预留
): Promise<{ translated: boolean }>

// Workflow instance 参数也带 lang：
params: { itemId, ..., lang: 'zh' }

// DeepSeek prompt 模板参数化：
const PROMPT_BY_LANG: Record<string, string> = {
  zh: '把以下推文翻译成中文...',
  en: 'Translate the following tweet to English...',
  // ...
};
```

**DB schema 不改**（保留 `items.content_translated` 单列）—— 多语言成真业务需求时再加 `translations` 表。**API lang 参数不加** —— 同样等真业务需求。

### C 端展示策略（task #8）

**API 改动**：`/api/items` 返回时按「已翻译优先」排序：

```sql
-- 当前
ORDER BY published_at DESC

-- 改为
ORDER BY (content_translated IS NULL) ASC,  -- 已翻译靠前
         published_at DESC
```

**新字段**：`items` 表加 `translated_at INTEGER`（unix 时间戳），翻译完成时写。API 返回带这个字段，前端复用现有「N 条新内容可加载」横条（translated_at > last_user_fetch_at 的 item 标新）。

**不做**：实时推送 / 服务端严格过滤（未翻译不下发）—— 边际收益低，复杂度高。

## 容量预算

实测 X 主链量（2026-05-09 至 05-16，7 天）：

| 维度 | 实测 |
|---|---|
| 平均入库量 | ~80 条/天 |
| 峰值 | 148 条/天 |
| is_relevant=1 比例 | ~75% |
| 含 quote 比例 | ~10-25% |
| 含 reply 比例 | <5% |
| 含 longform 比例 | <1%（近期）|

平均每条 step 数：
- is_relevant=0 (~25%)：1 step
- is_relevant=1 简单 (~50%)：classify + check-longform + translate-content = 3 step
- is_relevant=1 含 quote (~15%)：3 + backfill-quote + translate-quote = 5 step
- is_relevant=1 含 reply / longform / link_card (~10%)：5-7 step

加权平均 ≈ 3.5 step/instance

**月 step**：80 × 3.5 × 30 ≈ **8,400 step/月**（免费额度 100k，利用率 **8.4%**）
**峰值预算**：148 × 5 × 30 ≈ 22,200 step/月（仍 22%）
**月成本：$0**

## 测试计划

### 1. Staging 部署 + 通路验证

```bash
# 触发 staging Phase 1：拉 list page + 写 tweet + trigger workflows
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://staging-api.ai-feeds.com/api/admin/x-list-poll-now'
# (新增 admin endpoint，跟 gh-fetch-now 同模式)
```

CF Dashboard → Workflows → `x-tweet-pipeline-workflow-staging` 应看到 N 个 instance（N = 当次新 tweet 数）。点单 instance 看：
- 简单 tweet：step 1 (classify) + step 2c (check-longform) + step 4a (translate-content) 全绿
- 含 quote tweet：再加 step 2a (backfill-quote) + step 4b (translate-quote)
- is_relevant=0 tweet：只 step 1 绿，其他 skip

### 2. 异常路径验证

- 模拟 DeepSeek 挂：临时 base URL 改 404 → 部 staging → trigger 一次 → 期望 step 1 / step 4 errored，dashboard 单步重试
- 模拟 ScrapeBadger 挂：临时 SB API key 失效 → 含 longform 的 tweet 卡 step 3，dashboard 单步重试
- 模拟 syndication API 挂：含 quote 的 tweet 卡 step 2a

### 3. Prod cutover 后 24h 监控

- 部完立刻看下一次 `:25` / `:55` list-poll-ingest tick → CF Dashboard Workflows 有新 instance 流入
- 24h 内紧贴看：
  - Workflow instance 成功率（dashboard 看 errored 比例）
  - D1 `items` 新增行的字段填充延迟（content_translated 应在分钟级）
  - AI Gateway 看 DeepSeek 调用速率有无飙高（fan-out 并行可能短时尖峰）

### 4. 老数据 backfill

参照阶段 3 GH 模式，加 admin endpoint：
```
POST /api/admin/x-trigger-pending-workflows-now?limit=100
```
扫 `is_relevant IS NULL` 或 `content_translated IS NULL` 的老 tweet，每条 create workflow 兜底。

## 回滚

单 PR revert + `cd worker && rm -f ../wrangler.jsonc && npx wrangler deploy`：
- Phase 1 (list-poll-ingest) 自动回到「INSERT tweet + 等 preempt」模式
- 6 个 preempt cron 分支恢复
- 正在跑的 Workflow instance 跑完即止（不阻塞回滚）
- 数据：Workflow 写的 D1 跟 preempt 字段格式一致，旧 preempt 不重复处理（is_relevant / content_translated 等字段判断同样）

## 时间估算

- **Day 1**（本 design doc PR review）：1 hour 内出第一版给 PM，1-2 hour 内 merge
- **Day 2-3**（核心 Workflow class + 单 itemId 函数重构）
- **Day 4**（Phase 1 list-poll-ingest 改造 + admin endpoints + 删 6 个 preempt 分支）
- **Day 5**（C 端展示策略：API ORDER BY + translated_at 字段 + items 表 schema 加列）
- **Day 6**（Staging 端到端 + 异常路径验证）
- **Day 7**（Prod cutover + 24h 监控 + operations.md 更新）

总：~1 周 calendar time。

## 后续延伸

完成阶段 4 后剩下的 CF 迁移收尾：
- 把 `worker/src/scrapers/ph.ts` + `worker/src/clawhub.ts` 的 enrich 流程也迁 Workflow（仿 X 模式，但量更小，可低优先级延后）
- 加 Workflow instance retention 策略（CF 默认 90 天后 prune，量大可能要主动删 succeeded 的）

## Operations.md 更新（实施 PR 时一并做）

- 重写「X 流水线」节描述 6-step Workflow 架构 + dashboard 查看路径
- 删 `classify-pending` / `fill-translations` / `backfill-quotes` / `backfill-replies` / `detect-longform` / `longform-via-sb` 6 个 preempt mode 描述
- 加 X workflow admin endpoint 文档
- 顺手修：阶段 3 写的「wrangler 4.x 部署陷阱」节里 `.secrets/worker-prod-secrets.env` 旧路径改成 `.secrets/aifeeds-prod.env`（PR #41 OPS secrets 改造后的新约定）
