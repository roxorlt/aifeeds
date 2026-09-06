# 审核确认写路径改批量核对：去掉对补录候选的逐条完整验签

日期：2026-09-06　状态：实施中　前置：`2026-09-04-news-review-load-latency-spec.md`（读路径已改批量，§3.3 C3 留了写路径「等 prod 实测再定」）

## 0. 事故事实（本规格的实测依据）

2026-09-06 10:46:13 owner 在审核区点「确认并重新生成」：

| 层 | 证据 |
|---|---|
| nginx（82.156.0.68）| `POST /aifeeds/api/workbench/daily-news-review?date=2026-09-06&batch=nr-20260906-c3566a13d4d6` → **502**，body 79 字节 = `{"error":"news_review_upstream_timeout","message":"This operation was aborted"}` |
| 面板代理 | `news-review-proxy.mjs` `REVIEW_PROXY_TIMEOUT_MS = 20_000` 到点 abort（nginx 该 location 其实允许 90s）|
| Cloudflare Workers Logs | 同一请求 outcome=**canceled**，wallTime **19577ms**；`[news-review-timing]` 显示还没走到写库那条 UPDATE |
| D1 | 批次 `nr-20260906-c3566a13d4d6` 仍 `edit_revision=0 / human_reviewed=0 / applied_selected_ids=NULL` —— 选择完全没保存 |
| 17:03:28 owner 重试 | 同样 502 / 79 字节 |

同一请求内的耗时分布（候选池 14 条，其中 4 条补录）：

| 轮次 | purpose | 集合 | 耗时 | 其中补录逐条验签 |
|---|---|---|---|---|
| sanitize | `review_sanitizer` / `published_selection`（只读，批量预载）| 全池 / 默认选择 | 1.9s | — |
| #1 | `review_submit_final_guard`（完整验签）| 选中 5 条（含约 2 条补录）| 6.2s | preflight 内 2.8s + preflight 后逐条重载 2.6s |
| #2 | `published_selection` | 默认 5 条 | 0.9s | — |
| #3 | `review_submit_write_guard`（完整验签）| 全池 14 条（4 条补录）| ≥10.5s（被取消）| preflight 内 5.8s + 重载 ≥4.2s |

对照：9/5 08:21 那次确认池里 0 条补录，同步段约 6s，成功。每条补录在完整验签侧每轮约 2.7s（`authorizeManualItem` 里 1 次 lead 查询 + `loadVerifiedManualCandidateProof` 约 8 条语句，preflight 后再 `loadVerifiedManualCandidateProof` 一遍），D1 单次往返 230–620ms。

## 1. 结论与裁决

- 这不是「补录条目有问题」，是 `authorizeFormalNewsSet` 对**非只读 purpose** 一律走逐条完整验签的设计，在补录候选 ≥4 条时必然超过面板 20s。
- 9/4 已证明批量预载（`loadSignedManualCandidateSnapshots` + `signedManualCandidateFromRow` 用 keyring 逐行验 HMAC）与逐条完整验签对「proof 行是否真实有效」给出同一判定；写路径真正的失效闭合校验是写库 UPDATE 里的 `MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL` 与 `formalNewsFinalGuardSqlPredicate()`，这两道**一个字不动**。
- 裁决：**所有 purpose 统一走批量预载**；预载缺行 / 签名对不上 / 多行 active 的那几条，仍按 9/4 规则对这几条回退完整验签（语义不变，只是不再对每一条都跑）。

## 2. 改动清单（worker，`src/digest/news-source-policy.ts`）

1. `authorizeFormalNewsSet`：删除 `READ_ONLY_FORMAL_NEWS_PURPOSES.has(_purpose)` 分流，`preloaded` 对任何 purpose 都由 `preloadManualCandidateAuthorizations` 产生（空集合时 `preloadManualCandidateAuthorizations` 已经短路，不多打一次 D1）。
2. preflight 之后对 manual snapshot 的「重载」保持现有表达式 `preloaded?.get(id)?.record ?? (await loadVerifiedManualCandidateProof(...))`——预载命中就不重载，只有预载缺的那条才逐条。
3. `READ_ONLY_FORMAL_NEWS_PURPOSES` 常量删除（连同注释「只读用途才分流…」），引用处一并清理。
4. `[news-review-timing]` 埋点保留；`authorize.manual_preload` 现在对写 purpose 也会打印，作为验收证据。
5. 不改：`authorizeManualItem`、`executeFormalNewsFinalGuard`、`submitNewsReviewSelection` 的 UPDATE 守卫、面板协议、任何 D1 schema。

## 3. 测试

- 更新 `src/digest/manual-news-leads-d1.test.ts` 里对「写 purpose 走完整验签 / 只读 purpose 走预载」的断言：现在两者行为一致。
- 新增回归测试（同文件或 `news-source-policy` 的测试）：候选集含 4 条 `blog:manual:*` 且 purpose 为 `review_submit_write_guard` 时，按 SQL 注释标签统计 D1 语句：`manual_candidate_proof_bulk` 恰 1 次，`activeManualCandidateProofRow` 那类逐条查询 0 次；决策结果与只读 purpose 逐条一致（allowed_ids 相同）。
- 预载缺行回退：4 条里 1 条在预载里缺失（多行 active 或签名不符）→ 只有这 1 条触发逐条完整验签。
- `npx tsc --noEmit` 与 worker 全量测试绿。

## 4. 验收（由主 agent 在 prod 做）

1. staging 部署后 `wrangler tail` 看一次确认请求的 `[news-review-timing]`，`authorize.preflight` 回到 0.5s 量级。
2. prod：候选池里保留今天那 4 条补录，owner（或主 agent 用 owner 的审核链接）点确认，nginx 返回 202，D1 `edit_revision=1 / human_reviewed=1`，staged 目录出现 `editorial/r2-*.json`，渲染机派发 v2。
3. Workers Logs 复查该请求 outcome=ok、同步段 < 10s。

## 5. 非目标（记入 TODO）

- 一次确认仍要跑 7 次授权（sanitize 2 + 选中 + 默认 + 全池 + prePublish sanitize 2 + staged build 1）。改批量后每次约 1s，总计 8–9s 可接受；合并轮次是后续优化。
- 面板 `REVIEW_PROXY_TIMEOUT_MS` 20s → 85s 与 nginx 90s 对齐，只是缓冲，另一分支处理。
