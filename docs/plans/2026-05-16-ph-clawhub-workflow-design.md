# 阶段 6：PH + ClawHub 抓取链迁 CF Workflow 设计

> 2026-05-16。落地：`worker/src/workflows/ph-pipeline.ts` + `worker/src/workflows/clawhub-pipeline.ts`（待实施）。
>
> CF 迁移收官 — 把剩下 2 个抓取链 (PH + ClawHub) 也迁 workflow，跟前面 GH (#39/#40)、X (#42/#43)、hdx (#44/#45) 架构对齐。
> 复用阶段 5 治本 (marker / drain SQL 扩展 / drawer 触发) 模式，无新增机制。

## 背景

prod 实测（2026-05-16）：

| 源 | 总 | 待处理 | 占比 |
|---|---|---|---|
| **PH** | 391 | **197 r2_pending** (logo/截图/视频没迁 R2)| 50% |
| **ClawHub** | 3408 | **196 enrich_pending** (summary 没译 / readme 没拉)| 5.7% |

跟前面 3 个数据源同根因：抢占式 preempt cron 跟其他源抢 slot，无 dashboard 看挂哪步，无 per-item retry 粒度。

两者紧迫性都比 hdx 低（无视觉感知的「加载中」体验），属架构对齐 + 治理收尾。

## 决策（同前 4 阶段模式）

| 决策 | 选 | 理由 |
|---|---|---|
| Worker 位置 | 单 main worker | 跟 GH/X/hdx 一致 |
| 切换方式 | 直接切换 | 量小回滚极简 |
| 任务粒度 | per-item workflow | per-item retry + dashboard 可视化 |
| 设计先行 | 先 design doc | 同前 |

## PH Workflow 架构

```
[runPhDailyFetch cron] 每天 BJT 18:10 (UTC 10:10-14) 拉 PH yesterday → INSERT items
  ↓ 对每条新 post：
      env.PH_PIPELINE_WORKFLOW.create({ id: 'ph-<post_id>', params: { itemId } })

[PhPipelineWorkflow]  3 step
  step 1: ph-enrich (DeepSeek classify is_relevant + ai_category + ai_summary)
  ↓ is_relevant=0 早退（跳过 step 2-3）
  step 2: r2-migrate (logo + gallery + maker_avatar + video → R2，rewrite URLs)
  step 3: translate-fields (DeepSeek 翻译 tagline + maker_post + top_comments[])
```

替换：
- `runPhEnrich` preempt cron（已删 cron 调度，函数保留作 admin fallback）
- `runPhR2Migrate` preempt cron（同上）
- `runFillTranslations` 里 PH 字段分支（保留作 admin fallback）

## CH Workflow 架构

```
[runClawhubFetchList cron] 每天 BJT 16:00 + 04:00 拉 list → INSERT items
  ↓ 对每条新 skill (ch_pending=true)：
      env.CH_PIPELINE_WORKFLOW.create({ id: 'ch-<slug>', params: { itemId } })

[ClawhubPipelineWorkflow]  2 step
  step 1: enrich-and-translate (DeepSeek: summary translate + LLM finding translate
                                + fetch readme via Convex action + translate readme markdown)
  step 2: persist (UPDATE items extra + content_translated)
```

替换：
- `runClawhubEnrichPending` preempt cron（cron 删，函数保留作 admin fallback）

> CH 的 step 1 内部已是 Promise.all 并行 3 件事，workflow 内层逻辑不变 — workflow 只换调度模型（per-item + dashboard）+ 治本 marker。

## 治本模式自动扩到 PH / CH

阶段 5 已统一治本基础设施，本阶段只需复制扩展：

- **marker 字段**：`extra.workflow_triggered_at` 同字段（无 schema 改动）
- **drain SQL** 加 PH/CH 版本：
  - `/api/admin/ph-trigger-pending-workflows-now` — 扫 is_relevant NULL / r2_migrated_at NULL / (maker_post_text 但无 maker_post_translated) / top_comments[] 有内容无 translated
  - `/api/admin/ch-trigger-pending-workflows-now` — 扫 ch_pending=true / content_translated NULL (readme 没拉/译)
- **drawer 触发** `refreshSingleItem`：PH/CH 分支检测 stuck → trigger workflow（仿 X/GH/hdx）

## 容量预算

- PH：30 items/天 × 3 step × 30 = ~2,700 step/月
- CH：5-10 items/天 × 2 step × 30 = ~600 step/月
- **2 个 workflow 加起来 < 3,500 step/月**（免费额度 100k 利用率 < 4%）
- 加现有 GH (~615) + X (~8,400) + hdx (~9,000) = 总 ~21,500 step/月（21% 利用率）
- **月成本：$0**

## Backlog drain（cutover 后立刻做）

```bash
# PH 197 r2_pending + 翻译没补 → 分 1 批 limit=200 一次清完
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://api.ai-feeds.com/api/admin/ph-trigger-pending-workflows-now?limit=200'

# CH 196 enrich_pending → 同样 1 批清完
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://api.ai-feeds.com/api/admin/ch-trigger-pending-workflows-now?limit=200'
```

按阶段 5 治本的 400 上限，PH/CH 各自 < 200 item，单批就够。

## 测试计划

### 1. Staging E2E

```bash
# PH workflow trigger 1 个 item
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://staging-api.ai-feeds.com/api/admin/ph-workflow-trigger-now?itemId=product_hunt:<slug>'

# CH workflow trigger 1 个 item
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  'https://staging-api.ai-feeds.com/api/admin/ch-workflow-trigger-now?itemId=clawhub:<slug>'
```

观察 CF Dashboard → Workflows → ph-pipeline-workflow-staging / ch-pipeline-workflow-staging instance 状态。

### 2. Prod cutover + 24h 监控

部完后 drain 2 个 backlog + 等下次 cron tick (PH 18:10 / CH 04:00 / 16:00) 自然触发。
24h dashboard 看 instance 错误率 < 5%。

## 回滚

单 PR revert + redeploy。两个 workflow class 独立，互不影响其他 5 个抓取链。

## 时间估算

- **Day 1**（本 PR）：design doc review + merge
- **Day 2-3**（实施 PR）：
  - PH workflow class + 3 个单 itemId 函数（fetch + classify + r2-migrate + translate）
  - CH workflow class + 1-2 个单 itemId 函数（enrich-and-translate combined）
  - runPhDailyFetch / runClawhubFetchList Phase 1 改造触发 workflow + 写 marker
  - 删 ph-enrich / ph-r2-migrate / clawhub-enrich preempt cron 调度
  - 加 2 个 admin drain endpoints (限 400 / 批)
  - refreshSingleItem 加 PH / CH stuck trigger 分支
  - Staging E2E + Prod cutover + drain + 24h
  - operations.md 加 PH/CH workflow 节

**总：~2-3 天 calendar time**

## CF 迁移全收官状态（阶段 6 完成后）

| 抓取链 | 状态 |
|---|---|
| GH (阶段 3) | ✅ workflow |
| X 主链 (阶段 4) | ✅ workflow |
| hdx (阶段 5) | ✅ workflow + 治本基础设施 |
| **PH (阶段 6)** | 🟡 待实施 |
| **CH (阶段 6)** | 🟡 待实施 |

阶段 6 收官后，所有 5 个抓取链架构统一 + 治本 marker / drain SQL / drawer 触发 全覆盖。

## Operations.md 更新（实施 PR 时一并做）

- PH 节 Phase 2/3/4 改写：原 ph-enrich + ph-r2-migrate + fill-translations preempt 删
- CH 节 Phase 2 改写：原 clawhub-enrich preempt 删
- 加 PH / CH workflow 描述 + admin endpoints + 治本扩展到 PH/CH
