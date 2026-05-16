# GH 抓取链迁 CF Workflows 设计

> 2026-05-16。落地：`worker/src/workflows/github-pipeline.ts`（待实施）。
>
> 闭合 TODO #4 阶段 3 「GH 链试点 Workflow」。
> 上游讨论：[`2026-05-06-cf-backend-migration-discussion.md`](2026-05-06-cf-backend-migration-discussion.md) § 4.1 Workflows。
> 模式参照：[`2026-05-14-d1-backup-workflows-design.md`](2026-05-14-d1-backup-workflows-design.md)（首个 Workflow 落地，独立 worker `aifeeds-d1-backup`）。

## 背景

当前 GH 链 1 个定时 fetch + 3 个抢占式 preempt mode（`github-enrich` / `github-r2-migrate` / `github-readme-translate`）。状态通过 D1 字段（`is_relevant IS NULL` / `r2_pending` / `translated IS NULL`）做隐式状态机。痛点：

- **无端到端 trace**：一条 repo 走到哪步、为什么挂、卡在哪只能从字段反推
- **无独立 retry 粒度**：preempt 失败整 batch 失败
- **跟 X 主链抢 slot**：DeepSeek 慢时 GH preempt 把 X mode 饿死，反之亦然
- **状态字段散落**：4 步骤 ≈ 4 个状态字段散在 D1，维护负担重

GH 链业务量小（~1 条/天，启动期），是阶段 4 X 主链大迁移之前最合适的试点。

## 决策记录（已 PM approve）

| 决策点 | 选项 | 决定 | 理由 |
|---|---|---|---|
| Worker 位置 | 单 main `xlist-api` / 独立 worker | **单 main worker** | GH `Phase 1` cron 已在 main worker，inline `env.GITHUB_PIPELINE_WORKFLOW.create(...)` 触发，避免跨 worker service binding；阶段 4 X 主链也会塞 main worker，一致 |
| 切换方式 | 直接切换 / 双写过渡 | **直接切换** | GH 量 ~1/天，单日挂了影响小；单 PR 回滚极简 |
| 设计先行 | 先 design doc / 直接 PR | **先 design doc** | Workflow 是项目里 main worker 第一次用，对齐架构再实施 |

## 架构

### 迁后端到端流程

```
[github-fetch cron] BJT 01:00 / 13:00   ← 保留（main worker scheduled handler）
        │
        │ 解析 trending HTML → 写 stub 行到 D1
        │     items 表：is_relevant=NULL, extra.gh_pending=true
        ▼
        │ 对每条新 repo 立刻：
        │     env.GITHUB_PIPELINE_WORKFLOW.create({ id: `gh-${itemId}`, params: { itemId } })
        ▼
[GithubPipelineWorkflow]  ← 新增（worker/src/workflows/github-pipeline.ts）
        step 1: enrich-metadata    (GH API: license/watchers/contributors/commits, retry 3×10s exp)
        step 2: classify-with-llm  (DeepSeek 分类 + ai_summary, retry 3×10s exp)
        │   ↓ 仅 is_relevant=1 继续，0 早退
        step 3: r2-migrate-assets  (README 内 inline 图/视频迁 R2, retry 3×10s)
        step 4: translate-readme   (DeepSeek 翻译 README, retry 3×10s)
```

每步完成后**立即增量写 D1**（保留 dashboard 看部分进度的现有 UX），不是「全 step 跑完一次性写」。

### Workflow class 骨架

```typescript
// worker/src/workflows/github-pipeline.ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  fetchAndPersistMetadata,
  runLlmClassification,
  migrateReadmeAssetsToR2,
  translateReadme,
} from '../github';

interface GithubPipelineParams {
  itemId: string;
}

export class GithubPipelineWorkflow extends WorkflowEntrypoint<Env, GithubPipelineParams> {
  async run(event: WorkflowEvent<GithubPipelineParams>, step: WorkflowStep) {
    const { itemId } = event.payload;
    const RETRY = {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' as const },
    };

    const meta = await step.do('enrich-metadata', RETRY, async () => {
      return await fetchAndPersistMetadata(this.env, itemId);
    });

    const llm = await step.do('classify-with-llm', RETRY, async () => {
      return await runLlmClassification(this.env, itemId, meta);
    });

    if (llm.is_relevant !== 1) {
      return; // is_ai=0 早退，省 step 3+4
    }

    await step.do('r2-migrate-assets', RETRY, async () => {
      return await migrateReadmeAssetsToR2(this.env, itemId);
    });

    await step.do('translate-readme', RETRY, async () => {
      return await translateReadme(this.env, itemId);
    });
  }
}
```

> ⚠️ 现有 `worker/src/github.ts` 里的 `runGithubEnrichPending` / `runGithubR2Migrate` / `runGithubReadmeTranslate` 函数需要拆成单 itemId 粒度的可复用单元（上面 import 的 4 个函数），便于 step 独立调用 + 测试。

### Phase 1 改造

```typescript
// worker/src/github.ts runGithubFetchTrending() 内：
// 写完 stub 行后，对每个新 repo 触发 Workflow instance：
for (const itemId of newItemIds) {
  try {
    await env.GITHUB_PIPELINE_WORKFLOW.create({
      id: `gh-${itemId}`,  // 用 itemId 做 instanceId，便于追溯 / 防重复
      params: { itemId },
    });
  } catch (e) {
    // 同名 instance 已存在 → 上次 cron 触发过，跳过即可
    if (!String(e).includes('already exists')) {
      console.error(`[gh-fetch] workflow create failed for ${itemId}:`, e);
    }
  }
}
```

### 删除的 preempt 分支（同 PR 内）

- `worker/src/index.ts` `scheduled()` handler 内：
  - 删 `github-enrich` preempt 段（~10 行，调用 `runGithubEnrichPending`）
  - 删 `github-r2-migrate` preempt 段
  - 删 `github-readme-translate` preempt 段
- 删未使用的 helper：`countGithubPending` / `countGithubR2Pending` / `countGithubReadmeTranslatePending`
- **保留**：`runGithubFetchTrending` 本身（改造成「触发 Workflow」，不再写 pending row）
- **保留**：`/api/admin/gh-fetch-now` admin endpoint（手动触发 Phase 1，便于测试）
- **保留**：`/api/admin/gh-enrich-now` 等 admin endpoints（兜底手动 trigger 用）

### wrangler.toml 改动

```toml
# prod
[[workflows]]
name = "github-pipeline-workflow"
binding = "GITHUB_PIPELINE_WORKFLOW"
class_name = "GithubPipelineWorkflow"

# staging
[[env.staging.workflows]]
name = "github-pipeline-workflow-staging"
binding = "GITHUB_PIPELINE_WORKFLOW"
class_name = "GithubPipelineWorkflow"
```

### Workflow instance ID 防重

用 `gh-${itemId}` 做 instance ID。同 ID 重复 create 会 throw → catch + 跳过。这样 Phase 1 cron 万一重复触发（极少见），也不会为同一 repo 起两个 Workflow。

## 容量预算

- GH 入库量：~1 条/天（启动期，未来扩展再算）
- 平均 step/instance：
  - `is_relevant=1` 时 4 step
  - `is_relevant=0` 时 2 step（早退）
  - 平均按 67% relevant ≈ 3.3 step/instance
- 月 step = 30 × 3.3 ≈ 100 step/月
- CF 免费额度：100,000 step/月
- 利用率：< 0.1%
- **月成本：$0**（Workers Paid `$5/月`含量已覆盖）

## 测试计划

### 1. Staging 部署 + 通路验证

部署到 staging 后，手动触发 Phase 1：

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://staging-api.ai-feeds.com/api/admin/gh-fetch-now'
```

验证项：
- CF Dashboard → Workflows → `github-pipeline-workflow-staging` 有 N 个 instance 创建（N = 当次 trending HTML 解析出的新 repo 数）
- 单 instance 详情：4 步全跑过，每步状态 = `success`
- D1 staging `items` 表：对应行 `is_relevant` / `ai_category` / `ai_summary` / `content_translated` 都正常落库
- R2 staging bucket：README 资源迁过去

### 2. 异常路径验证

人为制造失败，验证 retry + dashboard 单步 retry：

- **DeepSeek 挂**：临时改 `worker/src/github.ts` 的 DeepSeek base URL 到一个 404 URL → 部 staging → trigger Phase 1
  - 期望：step 2 `classify-with-llm` retry 3 次 backoff 10s/20s/40s，最终 `errored`
  - CF Dashboard 上能看到该 instance 卡在 step 2，可以「Retry from step」单步重试
- **R2 binding 失效**：临时 unbind R2 → 同上 → 期望 step 3 `r2-migrate-assets` errored

### 3. Prod cutover 后验证

- 部署 prod 后，等下一次 GH fetch slot（BJT 01:00 / 13:00）自动触发
- CF Dashboard → Workflows → `github-pipeline-workflow` 看新 instance 列表
- 24h 后对比 D1 prod 当天 GH 入库行：所有字段是否跟旧 preempt 模式一致

## 回滚

单 PR 切换 → 回滚 = revert PR：

- Phase 1 自动回到「写 pending row + 等 preempt」模式
- 3 个 preempt cron 分支恢复
- 正在跑的 Workflow instance 跑完即止（不阻塞回滚）
- **数据安全**：Workflow 写的 D1 行跟 preempt 写的字段格式一致，旧 preempt 不会重复处理（`gh_pending` 字段 + `is_relevant` 字段都用一样的判断）

如果想保留 Workflow 但暂停触发：把 Phase 1 里 `env.GITHUB_PIPELINE_WORKFLOW.create(...)` 那段注释掉 + 恢复「写 pending row + 等 preempt」，单文件 hotfix 即可。

## 时间估算

- **Day 1**（design doc PR）：本 PR review + merge
- **Day 2-3**（实施 PR）：
  - 写 `GithubPipelineWorkflow` 类
  - 改 `worker/src/github.ts` 拆分单 itemId 函数
  - 改 `worker/src/index.ts` 删 3 个 preempt 分支
  - 改 `wrangler.toml` 加 workflows binding（prod + staging）
  - Staging deploy + 三项测试
  - Prod cutover + 24h 观察
- **总**：3 天 calendar time（含 design review 等待时间）

## 后续阶段同模式复用

阶段 4 X 主链迁 Workflow 时直接复用本设计的：
- 同 worker / 同模式（main worker 内多个 `[[workflows]]` binding）
- 同 step 粒度（每步 1 个外部依赖调用 + 1 个 D1 写）
- 同 retry 模式（3×10s exp）
- 同 instance ID 防重模式（用业务 ID 做 instance ID）

阶段 4 增量复杂度：
- X 主链 step 更多（6+ step，含 longform 条件分支）
- 量更大（261 条/天 vs GH 1 条/天），需要更精细的 step 内 batch / 限流
- 翻译类 step 跟 task 队列对接（task #5 的工作）

## Operations 文档更新（实施 PR 时一并做）

`docs/operations.md` 新增「Workflows」节：

- `github-pipeline-workflow` 简介 + trigger 方式 + dashboard 路径
- 单步 retry 操作步骤（dashboard UI）
- 失败排查 checklist（看 step 状态 / 看 instance 详情 logs / 看 D1 行状态）
- 删除 `github-enrich` / `github-r2-migrate` / `github-readme-translate` 三个旧 mode 的描述
