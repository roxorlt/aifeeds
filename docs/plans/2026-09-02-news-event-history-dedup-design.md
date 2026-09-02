# 行业要闻事件级历史去重（2026-09-02）

## 1. 缺陷与根因

9/2 候选头部混进两条一个月前的旧事件：**Gemini 3.7 Flash**（库内首见 8/14，9/1 一篇合集稿又提了一遍）
与 **Qwen3.8-Max**（首发 8/3，9/2 一篇「更新…登顶 CodeArena」的后续稿）。

排查结论与最初的假设不同 —— **不是「只跟上一次推送比对」**：
`fetchPreviousPushedNewsCandidates`（`selection.ts`）的账本窗口本来就是
`EVENT_DEDUP_LOOKBACK_DAYS = 30` 天，且覆盖窗口内**全部**推送；
07:50 的池重建（`pool-rebuild.ts` → `selectNewsByScoreWithAudit`）也确实传了
`strictCrossDayEventDedup: true`。

真正的漏洞有三个，叠加起来让旧事件畅通无阻：

1. **官方源天窗没有时间上限**（主因，owner 举的两个例子都是这一条）。
   `suppressCrossDayRepeatedNewsEvents` 里：

   ```ts
   // 官方源是更权威的后续代表:昨天媒体报过、今天官方源入库时仍允许替换成官方口径。
   if (officialSourceWeight(item) > 0) return true;
   ```

   本意是「昨天媒体报过、今天官方发声时允许换成官方口径」，但**没限定事件年龄**。
   `blog:google` 与 `blog:qwen` 都在 `officialSourceNames` 里，于是官方源一个月后的
   后续稿 / 合集稿拿到了永久免死金牌。

2. **推送账本只记机器选出的那份**。`digest_pool`（`source='news'`）只写
   `rebuildDigestPoolSource` 算出的 top5 / top3；人审换上来的条目从不回写。
   真正发布的集合在 `daily_news_review_batches.applied_selected_ids`。

3. **账本比对会把历史条目再过一遍「今天的」授权谓词**。
   `fetchNewsCandidatesByIds` 带 registry/sources JOIN + `formalNewsScheduledSqlPredicate`，
   信源改名 / 停用 / `sources.config` 漂移 / 条目软删，都会让一个月前推过的条目
   **静默**从账本比对里消失，从而把「推过」误判成「没推过」。

## 2. 指纹机制的实际形态与复用决策

**结论：复用现成的 `eventTokens` + `sameNewsEvent`，不新造 key、不加列、不加 migration。**

- `items.extra.event_fingerprint` 对 feed 条目是 **9 键 snake_case 对象**
  （`event_type / primary_actor / primary_object / object_family / object_variant /
  object_version / action / canonical_event / confidence`，见 `feeds/classify-translate.ts`）；
  对人工补录条目是 **字符串** `mnev1:<hash>`。两种形态共用同一 JSON 路径。
- `selection.ts` 的判同是**成对模糊判定**：结构化指纹快路径（`sameStructuredEventFingerprint` /
  `sameStructuredReleaseLifecycle`）+ token 兜底，且**不满足传递性**
  （preview↔released 会连，但两者都不与第三个 stage=unknown 的条目连）。
  因此**不存在「每条候选唯一确定的事件 key」**可以入库做等值匹配。
- 仓里唯一的标量事件 key `deriveAutomaticManualEventIdentityV1`
  （`manual-news-leads.ts`，已有索引 `idx_items_event_fingerprint`）是给人工补录冲突检测用的
  **fail-closed** 派生：要求 9 键齐全、`confidence >= 0.8`、产品命中 `PRODUCT_ENTITY_REGISTRY`
  白名单、action 属于枚举……绝大多数 feed 指纹拿不到 key。拿它做历史去重会在多数候选上**静默失效**。

所以历史去重改成：把**有上限的历史行**拉进内存，与候选做成对比对，判同标准与
`foldNewsEventsForDigest` / `suppressCrossDayRepeatedNewsEvents` 完全一致。

## 3. 规则落点

新增纯判定函数 `applyNewsEventHistoryPolicy(scored, history, pushedIds, options)`（无 I/O），
挂在 `selectNewsByScoreWithAudit` 里 `suppressCrossDayRepeatedNewsEvents` 之后、
editorial review 之前，与跨天去重共用 `strictCrossDayEventDedup` 开关
（daily-api 实时路径刻意不付这次 30 天历史查询的代价）。

| 情形 | 处理 |
|---|---|
| 历史里没有更老的同事件条目（首见 ≤ `NEWS_EVENT_STALE_AFTER_DAYS` = 3 天） | 原样不动 |
| 首见 > 3 天 **且** 已推送过 **且** 结构化指纹判同 | **剔除**（不进榜单，审计仍留记录） |
| 首见 > 3 天，其余情形（没推过 / 只有 token 兜底判同） | **降权**，并强制排在所有未降权候选之后 |

### 为什么剔除要「结构化指纹判同」这一道额外门槛

`sameNewsEvent` 的 token 兜底相当粗：没有结构化指纹时，「Gemini 4.0 Ultra 发布」与
「Gemini 3.7 Flash 发布」共享 `google / gemini / model` 等 token 就会被判成同事件
（这一点有测试实证）。在折叠里这只是合并展示；但在历史去重里**剔除是破坏性动作** ——
误杀一条真正的新模型发布，比放过一条旧事件回流更糟。

所以新增 `newsEventMatchStrength()`（完全复用既有判定函数，不另写一套标准）：
`structured` 才允许剔除，`fuzzy` 只降权。生产里 feed 条目普遍有 LLM 指纹，
所以正常路径仍是硬剔除；指纹缺失时安全降级为降权。

### 「不得进前列」是硬保证

`compareScoredNewsCandidate` 把「是否被降权」作为**第一排序键**，降权候选恒排在未降权候选之后。
不依赖 `NEWS_EVENT_STALE_UNPUSHED_PENALTY`（= 40）这个数字够不够大；该常量只用于审计可读性。

### 常量（都在 `selection.ts` 顶部，便于调整）

`NEWS_EVENT_HISTORY_LOOKBACK_DAYS = 30` / `NEWS_EVENT_STALE_AFTER_DAYS = 3` /
`NEWS_EVENT_STALE_UNPUSHED_PENALTY = 40` / `NEWS_EVENT_HISTORY_CAP = 4000`。

### 审计输出

`buildNewsSelectionAudit` 每条新增 `event_first_seen_at` / `event_previously_pushed` /
`event_history_decision`（`dropped` | `demoted`）/ `event_history_reason`（含首见日期与判定理由）。
被剔除的候选**仍留在审计里**，便于复盘。

## 4. 性能（遵守 PR #237 的守则）

历史查询 `/* news_selection:event_history */`：单表、纯索引、**不 JOIN**、
**不带 `deleted_at`**（那是 `idx_items_deleted` 的诱饵）、裸列比较让
`idx_items_source_scraped(source_type, scraped_at DESC)` 可用、带 `LIMIT 4000` 安全阀。
**无需新建索引，无需 migration。**

窗口刻意只取 `[now-30d, 候选窗起点)` —— 候选窗是 3 天、判旧阈值也是 3 天，
窗内的行不可能把任何事件变「旧」，排除掉既不影响结论又省一大块 I/O。

账本 id 集合 `/* news_selection:pushed_ledger_ids */` 取
`digest_pool`（机器账本）∪ `daily_news_review_batches.applied_selected_ids`（人审发布集合）
的并集，**只查 id、不重跑授权谓词** —— 判「有没有推过」不需要它今天还授权通过，
这样就绕开了根因 3 的静默丢失。

生产规模夹具（10 万行 items）实测：历史 1200 行，整条流水线
**32ms（改动前）→ 40ms（改动后）**，预算 2000ms。160k 次成对比对只占约 8ms，
因此没有引入任何预筛索引 —— 朴素全量比对既简单又可证正确。

## 5. 序列化与透传

`candidates_json` 每条新增 `event_first_seen_at`（ISO）与 `event_previously_pushed`（bool）。
取值直接来自选品审计（`digest_pool.items_meta.candidates[]`），**冻结时不重复查库**。

沿 PR #239 的四处序列化点同法处理：

| 位置 | 处理 |
|---|---|
| `freezeNewsReviewBatchFromPool` 定时候选字面量 | **补齐**，无值省略字段 |
| `verifiedManualCandidateSnapshot` legacy 分支 | 不补：人工补录候选不跑事件历史判定 |
| `manual-news-leads-store` manual_lead confirm | 同上 |
| source-support 分支（`{...payload.item_projection}`） | **不动**：签名快照，`canonical_digest` / `hmac_sha256` 覆盖 item_projection，形状不能改 |

**消费端确认原样透传**：`news-review-api.ts` 的 `candidates` 三处出现（`:200` / `:232` / `:265`）
全部只按 `item_id` 做 `.filter(...)`，没有白名单式字段重组，最终
`return response({ ..., candidates: batch.candidates, ... })`。UI 展示另行交接。

## 6. 残余风险

- **判同仍是模糊匹配**。指纹缺失时只降权不剔除是安全降级，但也意味着
  「旧事件 + 无指纹」仍可能出现在榜单靠后位置（不会进前列）。
- **`event_fingerprint` 覆盖率未实测**。`normalizeFeedEventFingerprint` 在 LLM 没给
  `confidence` 时默认填 `0.5`，低于结构化阈值 `0.75` → 退化成 token 兜底 → 只降权。
  上线后值得统计一下生产里高置信指纹的实际占比。
- **官方源天窗本身没动**。本次是在它**之后**加一道历史判定来兜住，
  没有直接给 `suppressCrossDayRepeatedNewsEvents` 的天窗加年龄上限（blast radius 更小）。
  若日后想收紧，那里是第二个落点。
- **历史窗口安全阀命中时只打 `console.warn`**，会静默丢弃最旧的历史行
  （当前 4000 对 ~1300 有 3x 冗余）。
- **人审发布集合按 `review_date` 字符串比较**取 30 天窗口，与 `digest_pool` 的
  epoch ms 窗口不是同一套时间基准，边界日可能差一天；对 30 天窗口影响可忽略。
