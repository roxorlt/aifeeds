# 补录取材范围修正 · 规格（2026-09-04 晚）

> **owner 纠正原始需求**：「有 url 的走抓取+搜索，没有 url 的走搜索，搜索依据是描述啊，为什么有一句话描述直接进池？那写口播词如何写？」
>
> 上一版把取材做窄了：有链接时**只抓那个链接、不搜索**；且取材是提交时后台跑一次，失败即放弃，写口播词之前没有补救。结果是素材缺失时口播只有 owner 的一句话可用。

## 1. 现状（要改的三处）

- `createPlainTextResolver`（面板 `manual-news-plain-text.mjs:238`）：`if (input.url) return fetch(url)` / `else if (input.query) return search(query)` —— **二选一**。
- 云端 `runManualLeadEnrichment` 只在提交/担保成功后经 `ctx.waitUntil` 跑一次，失败只留一行日志。
- 口播输入（面板 `daily-media.mjs`）：`title` = owner 陈述，`evidence_text` = 陈述 + 陈述 + `evidence_note`。素材缺失时模型手上只有那一句话。

## 2. 目标

| 输入 | 取材 |
|---|---|
| 有链接 | **抓该链接正文 + 以描述为依据搜索**，两份都要，合并后作为素材 |
| 无链接 | 以描述为依据搜索（现状已实现，保留） |

且**素材必须在写口播词之前备齐**：提交时取一次；到生成口播那一步仍缺失的，当场补取。入池本身仍然不等取材（这是 9/4 上午修复的核心，不得回退）。

## 3. 改动

### 3.1 面板：`/v1/plain-text` 支持「抓取 + 搜索」合并

- `createPlainTextResolver` 改为：有 `url` 时**并发**发起「抓该 url」与「按 `query` 搜索」，两者都成功就合并（链接正文在前、搜索素材在后，去重相同 url），只成功一个就用那一个，都失败回 `null`。
- 请求体允许 `{url, query, date}` 三者共存（`validatePlainTextRequest` 当前是 `url` 与 `query` 二选一，改为：至少有其一，可同时有）。
- 返回结构增加 `sources: [{url, publisher, kind}]`，`kind` 取值 `document` / `tweet` / `search+document`；`text` 为合并后的正文，仍受既有长度上限。
- X 链接维持走推文接口，同时也做搜索。
- 预算：抓取 12s、搜索 15s，两者并发，总预算 20s。

### 3.2 云端：请求体带上描述；补取兜底

- `runManualLeadEnrichment` 调 `/v1/plain-text` 时**同时传 `url`（若有）与 `query`（= owner 的陈述/描述）**，不再二选一。
- 新增补取入口 `backfillManualLeadEnrichment(env, date)`：找出当天已确认、`extra.manual_evidence_text` 为空的手工候选，逐条补取（并发 ≤ 3，单条 20s，整体 60s 预算）。
- 在**生成口播之前**调用它。落点选 `codex-push.ts` 的 finalize/staged build 路径（`authorizeFormalNewsSet(..., 'codex_staged_build')` 与 `'codex_finalize_locked'` 附近，取真正组装 payload 之前的那一处），要求：
  - 补取失败不阻塞出片，只记日志；
  - 补取成功后写入的仍只是 `extra.manual_evidence_text` / `manual_evidence_source` 两个键，不碰任何被正式新闻门绑定的列；
  - 幂等，已有素材的跳过。

### 3.3 素材缺失时的可见性

`manual-news-leads-api.ts` 的详情 DTO 增加 `evidence_material: { chars, sources } | null`，面板卡片在素材为空时显示「尚未取到背景素材，口播只能依据你写的这句话」。让 owner 在审核时就能看见，而不是等视频出来才发现口播单薄。

## 4. 测试

- 有链接时抓取与搜索都被发起（计数桩），两份都成功时合并、去重同一 url；只成功一个时用那一个；都失败回空且候选完好。
- 请求体三者共存的校验用例；只有 `query`、只有 `url` 的既有行为不变。
- 补取：当天有空素材的候选被补上；已有素材的跳过；补取抛异常时出片流程不受影响。
- 写入后仍：正式新闻门 `ALLOW_VERIFIED_MANUAL`、连续两次 sanitize `changed:false`、被绑定的列逐字未变。

## 5. 不改的

入池不等取材；owner 的陈述始终是标题与卡片显示文字，取材只进 `evidence_note` 供口播当背景；`/v1/document` 的证据取证与本路径无关。

---

## 6. 回滚记录（2026-09-04 23:00）

PR #249 上线后 prod 出现两处回归，已 `git revert -m 1 61560ea` 回滚：

1. **`POST /api/digest/daily-news-leads`（owner_asserted）连续 500**，三次三中。worker 日志只有 `[manual-news-leads-api] internal request failure {"error":"Error"}`（该路径只记错误名，无堆栈），线索行已建但 `confirmed_at` 为空 —— 说明四语句原子写入之后、确认那一步抛了未归类异常。
2. **取材不再写入 `extra.manual_evidence_text`**。#249 之前的 18:47 那条（`ml-20260904-e0cb46e9a893`）成功写入 159 字，#249 之后的 22:51 那条（`a29c223017bc`）确认成功但素材为 0。

回滚后恢复到 #248 的状态：取材可用（有链接抓该链接、无链接搜索），提交可用。**面板 v22 不回滚**——它接受 `url` 与 `query` 同时出现、也接受只给其一，与 #248 的云端兼容。

### 重做时必须先补的东西

- **可诊断性**：`manual-news-leads-api.ts` 的 `internal_error` 分支现在只记 `error.name`，prod 上无法定位。重做前先让它记 `error.message` 的前 200 字（不含 URL 与 token，沿用 `safeError` 的脱敏），否则下次同样瞎。
- **端到端回归**：#249 的 3274 个用例全绿却在 prod 一提交就 500，说明测试没覆盖真实提交路径的这段。重做时补一条走完整 `handleManualNewsLeadsApi` 的 owner_asserted 提交用例（真实 D1 夹具，不是桩），断言 200 且 `confirmed_at` 非空。
- 定位方向：#249 对提交路径的改动只有详情 DTO 新增 `evidence_material`（自带 try/catch，已排除）与 `scheduleLeadEnrichment` 的入参，重点看后者与 `createOwnerAssertedLead` 的交互。
