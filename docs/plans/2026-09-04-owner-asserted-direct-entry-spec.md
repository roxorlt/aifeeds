# 补录线索「owner 直接录入」· 设计规格（2026-09-04）

> **触发事实**：9/4 早 07:55–08:00 owner 提交 3 条文字线索（OpenAI 发布 Astra 等），全部 `failed / processing_retry_exhausted` 且 **evidence=0**。网关日志：ScrapeBadger 搜索在 4s 单家预算内大半超时（成功那次耗时 3195ms，返回 0 条）；少数搜到的网址走 `/v1/document` 全部 502（大陆服务器取不回境外页面，且取证审计要求逐跳 `validated_ip === connected_ip`，架构上不能走代理绕开）。
>
> 9/3 修好的评估门禁（PR #242/#243/#244）今天根本没走到；9/3 做的 owner 担保按钮要求 `evidence.length >= 1`，零证据线索同样用不了。
>
> **owner 原话（2026-09-04）**：「这个功能压根不可用啊！到底是在限制什么东西啊，我这个工具就是给我自己用的，但现在一直处于不可用的状态」。
>
> **产品决定**：这是 owner 自用工具。owner 亲自断言的事实，不需要公开来源背书即可进入候选池。取证链路继续保留并修好，但**不再是入池的必要条件**。

---

## 1. 语义

新增放行方式 `owner_asserted_v1`：owner 写一句话陈述，该陈述即候选标题与口播依据，**不要求任何证据**。与既有三条通道并列：

| 放行方式 | 事实依据 | 证据要求 |
|---|---|---|
| `llm_verified`（v10） | 两轮大模型核验 | 签名证据 ≥1 |
| `source_support_v1` | 官方第一人称原文 | 签名证据 ≥1，且 `reliable` |
| `owner_vouched_v1`（9/3） | owner 担保 + 已有证据链 | 签名证据 ≥1 |
| **`owner_asserted_v1`（本规格）** | **owner 断言** | **0 条也可** |

有证据时仍照常做密码学校验并把证据挂在候选上（来源、链接、发布时间取首条证据）；没有证据时候选只有 owner 的陈述。

---

## 2. 云端（aifeeds 仓，分支 `cc/20260904-owner-asserted-entry`，从 origin/main 开）

### 2.1 一步入池：`POST /api/digest/daily-news-leads` 增加 `owner_asserted`

- 请求体新增可选字段 `owner_asserted: true` 与 `statement`（陈述，规则同 9/3 担保：trim 后 6–160 code points、单行、无控制/bidi/零宽字符、至少 4 个汉字或 3 个英文单词）。`statement` 缺省时取 `text` 的规范化结果（不合规则 400 `invalid_vouch_statement`）。
- 命中 `owner_asserted` 时：**不派发 Workflow、不做任何取证**。直接在一个 `DB.batch` 内：建线索（`status='needs_review'`，`error_code=NULL`）→ 写 `owner_asserted_v1` proof → 写 `submit` 与 `assert_candidate` 审计 → 复用既有确认流程入池。
- 响应形状与 `vouch-candidate` 一致（`ok/changed/rerender_enqueued:false/batch/pending_initial_freeze/lead`），HTTP 200；不再返回 202（没有异步阶段）。
- 幂等：同 `Idempotency-Key` 重放返回同结果。
- 仍受既有约束：`review_expired`、`manual_candidate_event_conflict`、`candidate_batch_revision_conflict`、每日手工候选上限。请求体需带 `expected_batch_revision`；缺省时服务端取当前 active 批次 revision（一步录入没有先读后写的机会，允许缺省）。

### 2.2 救回已卡住的线索：`vouch-candidate` 放开证据数量要求

- `vouchManualNewsLeadCandidate` 去掉 `lead.evidence.length < 1` 这一条（store.ts 约 :2624）。状态仍限 `needs_review` / `failed`，未确认，版本匹配。
- 有证据时走 `owner_vouched_v1`（行为不变）；**零证据时走 `owner_asserted_v1`**，由同一个入口按证据数量分派。

### 2.3 `owner_asserted_v1` 的 payload / proof（新文件或并入 `manual-news-owner-vouch.ts`）

```
payload = {
  policy_version: 'owner_asserted_v1',
  lead_id, review_date,
  statement,
  evidence: canonicalEvidence(lead.evidence),          // 可为空数组
  event_identity: { event_key: 'mnoa1:' + sha256Hex('mnoa1\0' + lead_id) },
  item_projection: {
    item_id: 'blog:manual:<lead>', source_id: 'manual:<lead>',
    title: statement, summary: statement, score: null,
    source: <首条证据 publisher> || '手工补录',
    url: <首条证据 url> || <lead.input_url 且为 https> || '',   // 注意：空串不是 null
    published_at: <首条证据 published_at> || null,
  },
  asserted_at,
}
```
- **`url` 必须用空串而不是 null**：入 items 时走的是 `candidate.url || ''`（store.ts :1448 同形），正式新闻门绑定 `i.url IS json_extract(...,'$.item_projection.url')`，null 与 `''` 对不上会被判 stale。`published_at` 保持 null（`i.published_at IS NULL` 可匹配）。
- HMAC 域 `manual-news-owner-asserted-hmac-v1\0`；`assessment_version = expected_version * 1_000_000 + 800_000`；key 取 `manualNewsVerificationKeyring(env).currentKeyId`；proof 行写 `manual_news_assessment_verifications`（`policy_version='owner_asserted_v1'`，`status='active'`）。
- 快照校验函数重建 payload 并逐字比较 + HMAC 常量时间比较；有证据时仍跑 `assertManualNewsEvidenceBodyDigests`，零证据时该调用对空数组天然通过。

### 2.4 分发点（逐个落地 + 逐个测试）

1. `loadVerifiedManualCandidateProof`（verification.ts :537-590）新增 `owner_asserted_v1` 分支，未登记会被当未知策略返回 null。
2. `confirmManualNewsLeadCandidate`：签名快照路径已按 `verified.candidate` 透传，确认对零证据、空 url 候选成立。
3. `orderedVerifiedManualCandidates`（store.ts :157-203）`authorization_order` 增 `owner_asserted_v1` 分支（按其 `assert_candidate` / `vouch_candidate` 审计 id 定序）。
4. `news-review.ts` `verifiedManualCandidateSnapshot` 签名快照透传分支扩到 `owner_asserted_v1`；`durableConfirmedManualCandidates`、`sanitizeCurrentNewsReviewBatchAttempt`、`freezeNewsReviewBatchFromPool` 合并均须稳定（连续两次 sanitize 不 bump revision）。
5. `news-source-policy.ts` 最终守卫 SQL 增 `owner_asserted_v1` 分支，字段绑定与 `owner_vouched_v1` 同形（含 `event_fingerprint` 与「不存在评估行」）。
6. 摘要与详情 DTO：`candidate_authorization` 增枚举值 `owner_asserted_v1`；`vouch` 字段沿用（`{statement, vouched_at}`，直接录入时 `vouched_at` 为 `asserted_at`）。
7. 迁移：`policy_version` / `last_mutation_kind` / `audit.action` 三列均无 CHECK 约束（9/3 已实测），不需要 D1 迁移。
8. 去重：直接录入的候选不参与跨天事件去重（同 `owner_vouched_v1`），在代码注释与 TODO 写明。

### 2.5 必须有的测试

- 端到端：`owner_asserted` 一步提交 → 线索 `recommended`/`confirmed_at` 非空 → 进当前批次 `candidates_json` 末位（标题即陈述、url 为空串、source 为「手工补录」）→ 正式新闻门 `ALLOW_VERIFIED_MANUAL` → 连续两次 sanitize 均 `changed:false`。
- 零证据 `vouch-candidate` 成功（救回 9/4 那三条形态：`failed` + `processing_retry_exhausted` + evidence 0）。
- 有证据线索走 `owner_asserted` 时证据仍挂在候选上、body digest 仍校验。
- 陈述不合规 400；幂等重放同结果；批次 revision 冲突 409 且 proof 保留；已确认线索 409。
- 冻结前直接录入能合入当天首批候选。

---

## 3. 面板（dailyVideo worktree `.worktrees/review-ux-baton-race`，分支 `cc/20260902-review-ux-and-baton-race`）

### 3.1 代理 `manual-news-leads-proxy.mjs`

- 提交路径 body 允许 `owner_asserted`（布尔）与 `statement`（同 3.3 校验），并透传 `expected_batch_revision`（可选整数）。
- 现有 `vouch-candidate` 不变。
- 更新既有精确断言测试并补新用例。

### 3.2 latest 页面（`run.mjs` `writeShareIndex`）

- 补录表单增加一个提交按钮：**「我确认，直接加入」**（与既有「提交并授权核验追加」并列，后者保持原语义）。点击时：用文字线索内容做陈述校验，不合规就地提示；通过则 `POST /aifeeds/api/workbench/daily-news-leads`，body 带 `owner_asserted: true`、`statement`、`date`、可选 `url`/`note`、`expected_batch_revision`。
- 成功文案：`pending_initial_freeze` 为真 →「已直接加入冻结前候选池；07:50 生成首批候选时会自动合入。」否则 →「已直接加入并生成新的候选批次；当前 Top 5 和视频均未改变，请打开新批次后手动选择、排序并确认重新生成。」并复用既有 `batch.review_url` 链接展示。
- 卡片：`candidate_authorization === 'owner_asserted_v1'` 时标注「owner 直接录入」并显示陈述；零证据卡片的证据区显示「无证据（owner 直接录入）」而不是「尚未取得可核验来源」。
- 「担保加入候选池」按钮的显示条件去掉 `evidenceCount >= 1`（零证据线索也要能担保）。
- 表单旁一句说明：「直接加入不做搜索与核验，标题即你写的这句话。」
- 测试沿用「真实文件切片 + vm」方式，新增协作函数要补桩。

### 3.3 搜索预算（顺带修，不阻塞上面）

`manual-news-research-gateway-assembly.mjs` 的单家提供方预算 4s 对 ScrapeBadger 太紧（今早成功那次 3195ms）。改为：**可用提供方只有一家时，单家预算取总预算**（12s）；多家时维持 4s。附单元测试。

---

## 4. 上线与验收

1. 云端 PR → CI 绿 → staging 部署 → 合并（CI 部署 prod，由 owner 执行 `gh pr merge`）。
2. 面板：代理补丁脚本 v19；页面随 render release 部署，次日 finalize 渲染生效。
3. prod 验收：对 9/4 卡住的三条线索（`d1eb1d` / `48a005` / `3aab72`）调用 `vouch-candidate` 使其入池；再用「直接录入」新提交一条走完全程。
4. 文档：`docs/operations.md` 补录节、TODO.md、规格落地记录。

## 5. 不在本规格内（另行处理）

- 大陆服务器取不回境外网页（`/v1/document` 502）：正解是把研究网关迁到香港 VPS，取证审计的 IP 钉定才能成立。列入 TODO。
- 搜索提供方密钥（百度 / Exa / Brave）仍缺，ScrapeBadger 单点且不稳。
