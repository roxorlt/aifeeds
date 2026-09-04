# 审核区「打开所选日期」卡顿 · 根因与修复规格（2026-09-04）

> **owner 反馈**：「展开对应日期的内容为什么会在点击按钮之后等这么久」。对应页面元素是审核卡片里的「打开所选日期」/「打开今日候选审核」，点击后状态行显示「正在载入对应日期的候选批次…」。

## 1. 实测数据（prod，`GET /api/digest/daily-news-review?date=…`，仅返回 250 字节）

| 日期 | 手工补录候选数 | 耗时 |
|---|---|---|
| 2026-09-04 | 2 | 6.7–7.5s |
| 2026-09-03 | 1 | 4.9s |
| 2026-09-02 | 0 | 3.2s |
| 2026-09-01 | 0 | 2.9s |
| 2026-08-30 | 0 | 3.8s |

**基线约 3s，每多一条手工补录候选加约 1.8s。** 页面点击一次会**串行发两次**该接口（先 date-only 拿 batch+token，再带 batch+token 拿正文），所以 9/4 实际等待约 13s，且随手工补录条数线性增长。

## 2. 根因（三条叠加）

1. **`sanitizeCurrentNewsReviewBatchAttempt` 里逐条串行 await**：`worker/src/digest/news-review.ts:1125` 的 `for (const candidate of current.candidates)` 内，第 `:1138` 行 `await confirmedManualCandidateById(env, leadId)` 每条手工候选一次往返（proof 加载 + HMAC + 证据摘要校验，实测约 1.8s），完全串行。经典 N+1 且不并发。
2. **完整性修复例程跑在读路径上**：`news-review-api.ts:142` 起的 GET 分支，date-only（`:160`）与带 batch+token（`:179`）两条路径都调用 `sanitizeCurrentNewsReviewBatch`。
3. **页面一次点击两次往返**：`run.mjs` 的 `resolveReviewDate` 先 `GET …daily-news-review-resolve?date=`（面板转发为 date-only），拿到 batch+token 后再 `loadNewsReview` 发第二次；两次各跑一遍 sanitize。

## 3. 修复（按此顺序，互不依赖）

### 3.1 并发化手工候选校验（云端，必做）

把 `:1125` 循环中的 `confirmedManualCandidateById` 改为先收集所有需要校验的 `leadId`、`Promise.all` 并发拿回结果，再按**原顺序**走原有的保留/剔除判定。硬要求：
- 候选的最终顺序、`droppedIds` 的内容与顺序、以及所有既有判定分支逐字不变（顺序影响 `candidates_json`，进而影响 sanitize 是否 bump revision）。
- 并发度上限 8，避免同时打爆 D1。
- 既有测试（`news-review-revision-race.test.ts`、`manual-news-leads-d1.test.ts` 里的 sanitize 稳定性用例）必须一行不改地全过；补一条「多条手工候选时校验并发发起」的测试（可用带时序记录的桩证明重叠）。

预期：2 条手工候选从 3.6s 降到约 1.8s，且不再随条数线性增长。

### 3.2 一次点击只发一次请求（云端 + 页面，必做）

- 云端：date-only 的 GET 分支（`news-review-api.ts:160`）在现有 `{ok,date,batch_id,review_url}` 之外，**追加带 batch+token 分支返回的同一份正文**（候选、默认选择、已发布选择、编辑态、finalize 态等，字段名与形状逐字一致，复用同一段构造代码，不要复制粘贴两份）。响应里同时给出 `token`。此举不改变既有字段，旧客户端不受影响。
- 页面：`resolveReviewDate` 拿到 resolve 响应后，若其中已含正文则**直接渲染，不再发第二次请求**；缺失时回退到现有的 `loadNewsReview`（兼容旧云端）。
- 结果：sanitize 每次点击只跑一遍。

### 3.3 基线 3s 的排查（云端，选做，本次不阻塞）

0 条手工候选时仍要 3s。候选来源：外层 `getActiveNewsReviewBatch` 与 sanitize 内重复读、`readScheduledNewsItemPolicy`、`getPublishedNewsReviewSelection`、`authorizeFormalNewsSet`。要求：在 worker 里对这几步各打一条耗时日志（`console.log` 带毫秒），prod 跑一次取真实分布写进本文件，再决定是否合并查询。**不要凭猜测改 SQL。**

## 4. 验收

- prod 实测 9/4（2 条手工候选）date-only 接口耗时，以及页面一次点击的总等待时间，前后对比写进本文件。
- 连续两次 sanitize 仍 `changed:false`（不因并发化而误判 drift 空转 bump revision）。
- 全量 `cd worker && npm test` 与面板 `node --test workflows/aifeeds-daily/*.test.mjs` 全过。
