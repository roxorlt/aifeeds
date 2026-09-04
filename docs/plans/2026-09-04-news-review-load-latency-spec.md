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

### 3.1 ~~并发化手工候选校验~~ → 读路径不再逐条重算手工候选（owner 2026-09-04 改判，已实现）

> owner 原话：「补录数据，在确认过后，不应该每次查列表时候再重复做补录数据的串行验证了啊」。
> 并发化只是把 3.6s 压成 1.8s，方向不对：验签属于「确认」那一步的写入门禁，
> `sanitizeCurrentNewsReviewBatch` 把它搬到了每次 GET 上。原 3.1 作废。

**每条手工候选原本的 9 次串行 D1 往返**（`loadVerifiedManualCandidateProof` 全展开）：

| # | 查询 | 位置 |
|---|---|---|
| 1 | `news_review:confirmed_manual_candidate_by_id` 读线索行 | `news-review.ts:990` |
| 2 | `manual_verification:policy_dispatch` 读 active proof 行 | `manual-news-leads-verification.ts:468` |
| 3–4 | `manual_verification:key_lineage` + `manual_evidence:key_lineage` | 同文件 `:312` |
| 5–6 | `loadManualNewsEvidence` 内又跑一遍上面两条 key lineage | 同文件 `:332` |
| 7 | `manual_evidence:preflight` | 同文件 `:332` |
| 8 | `manual_evidence:list` | 同文件 `:332` |
| 9 | `manual_verification:*_authorization` 读授权审计行 | 同文件 `:488/:557/:603` |

prod 实测约 1.8s/条，与「每多一条候选加约 1.8s」完全对上。

**改法**（`loadSignedManualCandidateSnapshots`，`manual-news-leads-verification.ts:740`）：

- 一条 SQL（`news_review:manual_candidate_proof_bulk`）把整批候选的 `lead_id` 一次性
  对上 `manual_news_leads`（`confirmed_at IS NOT NULL` 且 `status IN ('recommended','needs_review')`）
  与 `manual_news_assessment_verifications`（`status='active'`）；一条线索出现多行 active
  就不猜，直接交给完整重算。
- 拿到行之后**纯计算**地重算 `canonical_digest` 并验 HMAC（`isCurrentManualNews*Proof`），
  再把签名里的候选投影取出来，全程零次额外 D1 往返。
- 投影与 `candidates_json` 里的快照逐字一致（`stableJson`）→ 直接放行。
- 缺行、签名过不去、投影对不上 → 落回 `loadVerifiedManualCandidateProof` 完整重算
  （含证据摘要比对与失效隔离），这一步仍按原下标并发发起（上限 8）。

**安全边界（写进代码注释）**：读路径信任的是确认时已验签并落盘的摘要，它回答「这份签名
还是确认时那一份吗」，不回答「证据行事后有没有被单独改动」。`authorizeFormalNewsSet`
（`news-source-policy.ts:874`，含发布授权）那条线仍逐条走完整校验。

**顺序不变性**：候选顺序、`droppedIds` 内容与顺序、各判定分支逐字不变；错误也按原下标
回放，抛出的仍是候选顺序上第一个失败的那条。

### 3.2 一次点击只发一次请求（云端 + 页面，必做）

- 云端：date-only 的 GET 分支（`news-review-api.ts:160`）在现有 `{ok,date,batch_id,review_url}` 之外，**追加带 batch+token 分支返回的同一份正文**（候选、默认选择、已发布选择、编辑态、finalize 态等，字段名与形状逐字一致，复用同一段构造代码，不要复制粘贴两份）。响应里同时给出 `token`。此举不改变既有字段，旧客户端不受影响。
- 页面：`resolveReviewDate` 拿到 resolve 响应后，若其中已含正文则**直接渲染，不再发第二次请求**；缺失时回退到现有的 `loadNewsReview`（兼容旧云端）。
- 结果：sanitize 每次点击只跑一遍。

**落地补充（2026-09-04）**：

- 云端把两条 GET 路径的正文构造抽成 `projectNewsReviewBatch`（`news-review-api.ts:148`），
  date-only 分支在 `{ok,date,batch_id,review_url}` 之外追加 `token` 与同一份正文，
  既有字段名与形状一个不动。
- 面板代理原本做字段白名单（只放行 `date/batch/token`），现在在 `daily-news-review-http.mjs`
  里加 `reviewBody()`：只有当正文的 `ok/date/batch_id` 与刚校验过的那份凭据对得上、
  且 `candidates` 是数组时才透传为 `review` 字段；凭据（`review_url`/`token`）不在正文里
  重复一份。
- 页面 `reviewBodyFromResolve()` 校形状，`loadNewsReview(request, preloaded)` 拿到就直接
  渲染；云端没带（旧云端）就回退到原来的第二次请求。

### 3.3 基线 3s 的排查（owner 2026-09-04 升为必做，静态盘点已完成）

#### A. date-only GET 路径的全部 D1 查询（改造前，0 条手工候选）

| # | 步骤 | 位置 | 循环内？ | 查询数 |
|---|---|---|---|---|
| 1 | `getActiveNewsReviewBatch` | `news-review.ts:328` | 否 | 1 |
| 2 | `sanitize` → `getActiveNewsReviewBatch`（与 #1 重复读同一行） | `news-review.ts:328` | 否 | 1 |
| 3 | `sanitize` → `readScheduledNewsItemPolicy` → `authorizeFormalNewsSet('review_sanitizer')` | `news-review.ts:890` / `news-source-policy.ts:874` | 否 | 3 |
| 3a | └ `formal_news:early_authorization` | `news-source-policy.ts:724` | 否 | 1 |
| 3b | └ `formal_news:early_scheduled_join` | `news-source-policy.ts:741` | 否 | 1 |
| 3c | └ `formal_news:final_guard_single_snapshot` | `news-source-policy.ts:707` | 否 | 1 |
| 4 | `sanitize` → 逐条手工候选完整重算 | `news-review.ts:990` | **是** | 9 × 手工候选数 |
| 5 | `sanitize` → `getPublishedNewsReviewSelection` | `news-review.ts:428` | 否 | 5 |
| 5a | └ `readRawPublishedNewsReviewSelection`（`applied_selected_ids` 是数组时跳过） | `news-review.ts:408` | 否 | 0–1 |
| 5b | └ `authorizeNewsReviewBatchSnapshot('published_selection')` = 3 + 1 | `news-review.ts:444` | 否 | 4 |
| 6 | 漂移时才走：授权 3 + `DB.batch` 1 + 重读 1 | `news-review.ts:1240+` | 否 | 0（常态） |
| 7 | 投影 → `getPublishedNewsReviewSelection`（与 #5 对同一批次重复） | `news-review-api.ts:148` | 否 | 5 |
| 8 | 投影 → `getDailyStageState` ×2（`edit_revision>0` 且有已应用选择时才跑，已并发） | `news-review-api.ts:195` | 否 | 0–2 |
| 9 | 投影 → `authorizeNewsReviewBatchSnapshot('review_api_final_projection')` = 3 + 1 | `news-review-api.ts:148` | 否 | 4 |

改造前合计（0 条手工候选、无漂移、无阶段状态）：**19 次，几乎全串行**。按 D1 单次约
150ms 估算 ≈ 2.9s，与实测基线 2.9–3.2s 吻合。注意 #7/#8/#9 原本只在带 batch+token 的
第二次请求里跑，所以 owner 一次点击实际是 10 次（date-only）+ 19 次（正文）。

#### B. 本次直接合并的项

| 合并 | 省下 | 做法 |
|---|---|---|
| #1 与 #2 重复读当前批次行 | 1 次 | date-only 分支不再单独读，改为接住 sanitize 的 `news_review_batch_not_found` 回 404 |
| #5 与 #7 对同一批次重复算已发布选择 | 5 次 | sanitize 没漂移时把 `published_selected_ids` 一并交出，投影直接用；漂移时给 null 让调用方重查 |
| #4 逐条完整重算 | 9 × n → 1 | 见 3.1 |
| #3 与 #4 串行 | 一轮往返 | 定时候选授权与手工签名批量复核并发发起 |
| #7/#8 与 #9 串行 | 一轮往返 | 对外授权与「已发布选择 / 阶段状态」并发发起 |
| 一次点击两次请求 | 一整轮 | 见 3.2 |

改造后一次点击（0 条手工候选、无漂移）：**1 + 3 + 4 + 4 = 12 次**，且 #3 与手工批量复核、
#7/#8 与 #9 各自并发，串行深度从 19 降到约 8。2 条手工候选时不再额外加 18 次，只加 1 次。

#### C. 没有合并、留给实测判断的项

- `authorizeFormalNewsSet` 在一次 date-only 请求里被完整跑了 3 遍（sanitize 一次、已发布
  选择一次、对外投影一次），每遍 3 次查询。三者的 `candidateIds` 不同（定时候选 / 已发布
  选择 / 全部候选），合并需要重构 `authorizeFormalNewsSet` 的入参口径，风险高于收益。
- **`authorizeFormalNewsSet` 里对手工候选仍是 N+1 完整重算**（`news-source-policy.ts:899`
  的 `for` 循环里 `await loadVerifiedManualCandidateProof`，以及 `authorizeManualItem`
  `:368` 里的两次读）。这条是发布授权的安全底线，owner 明确要求保留完整校验，故未动；
  但它同样跑在读路径上，是手工候选日期仍会偏慢的主要剩余来源。要不要给它一条同样的
  批量廉价通道，**等 prod 实测分布出来后由 owner 拍板**。
- `readRawPublishedNewsReviewSelection` 的「找前一版批次」查询（`news-review.ts:415`）
  只在 `applied_selected_ids` 为 null 时才跑，不是常态热点。

#### D. 实测埋点

`timedNewsReviewStep`（`news-review.ts:1108`）在下列步骤各打一条
`[news-review-timing] <步骤名> <毫秒>ms`，只记步骤名与耗时，不记数据内容：

| 步骤名 | 覆盖 |
|---|---|
| `api.resolve.sanitize` | date-only 分支的整个 sanitize |
| `api.detail.sanitize` | 带 batch+token 分支的整个 sanitize |
| `api.projection.reads` | 投影里的已发布选择 / 阶段状态 / 对外授权（并发） |
| `sanitize.active_batch_read` | 读当前批次行 |
| `sanitize.candidate_policy` | 定时候选授权 + 手工签名批量复核（并发） |
| `sanitize.manual_full_recheck` | 落回完整重算的那几条（正常为 0 条，不打点） |
| `sanitize.published_selection` | sanitize 内的已发布选择 |

部署后 `wrangler tail` 按 `[news-review-timing]` 过滤即可取真实分布，**回填到本节**再决定
是否继续合并 C 节里的项。

## 4. 验收

- prod 实测 9/4（2 条手工候选）date-only 接口耗时，以及页面一次点击的总等待时间，前后对比写进本文件。
- 连续两次 sanitize 仍 `changed:false`（不因并发化而误判 drift 空转 bump revision）。
- 全量 `cd worker && npm test` 与面板 `node --test workflows/aifeeds-daily/*.test.mjs` 全过。
