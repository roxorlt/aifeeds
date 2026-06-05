# 日报内容推送 Codex 渲染机（daily/ingest）— 设计文档

> 2026-06-05。早 8 点订阅邮件生成后，并行把当天日报的完整内容（含附件图片 + 原始链接 +
> 全字段）推给 Codex 的 `daily/ingest` 接口，Codex 做下游加工（生成日报图、ZIP、微信/小红书文案）。
> 分支 `feat/daily-codex-push`，走 staging→prod。

## 1. 背景与目标

- Codex 已开放每日推送入口 `POST https://ai-feeds.cc/aifeeds/api/daily/ingest`。
  改为**由 aifeeds 主动推**（不再由渲染机拉 digest API）。
- aifeeds 早 8 点 `DigestNodeRunWorkflow` 算完当天榜单（`digest_pool` 快照）+ 发订阅邮件。
  **在发邮件的同时**，并行把这份日报内容 POST 给 Codex。
- 用户要求「全面信息」：不只标题 + 简介，还要**附件图片（cover + media[]）+ 原始链接 + 站内深链 + 全字段**。

**关键复用**：`digest/render.ts` 的 `renderItem()` 产出的 `RenderedItem` 已经是 Codex item 的**超集**
（`rank/item_id/source/title/summary/summary_full/url/deep_link/author/cover/logo/media[]`，
cover/media 已拼成绝对 URL，ph/x 已是 R2 链接）。所以本功能 = **读快照 + 复用 renderItem + 包壳 + POST**，
不需要新数据管线。

## 2. 决策（已和用户确认）

| 项 | 决定 |
|----|------|
| 推送时机 | **仅早 8 点**（slotHourBjt === 8），一天一份日报 |
| 内容档位 | **normal 标准档**（每源 ~5 条，跟默认订阅邮件一致；Codex 示例也用 normal）|
| 数据范围 | **只 ph / gh / hf-paper 三源**（Codex 当前只渲这 3 源，X/clawhub 暂不打包）|
| 内容来源 | **`digest_pool` 快照**（= 当天邮件实际用的同一份内容，不实时重拉，避免漂移）|
| 鉴权 | 复用 `X_CARD_SHARED_TOKEN`（Codex 说先复用 X card 那个）|
| 失败处理 | **非阻塞**：try/catch 包住，Codex 挂了不影响邮件投递；失败 PushDeer 告警 |

## 3. 触发点

`DigestNodeRunWorkflow.run()`（`digest/node-run.ts`）现有顺序：
Phase 1（建 normal+curated 池）→ Phase 1.5（节点标题）→ Phase 2（spawn 各订阅 deliver）。

**新增 Phase 3**（放在 Phase 2 spawn 之后，邮件已在投递路上，不拖慢邮件）：
```
if (slotHourBjt === 8) {
  await step.do('push-codex-daily', RETRY, async () => {
    try { return await pushDailyToCodex(env, slotHourBjt); }
    catch (e) { /* PushDeer 告警 + 返回 skipped,不抛错 */ }
  });
}
```

## 4. payload 构造（`digest/codex-push.ts` 新文件）

`buildDailyCodexPayload(env, slotHourBjt)`：
1. `sk = slotKey(8)`，`date = bjtDateStr()`。
2. 对 `['ph','gh','hf-paper']`：读 `digest_pool(slot_key=sk, source, density='normal')` → `item_ids`。
3. `fetchRows(env, ids)` 拉渲染所需全字段 → `renderItem(source, row, rank, apiBase)`。
4. 映射成 Codex item（cover 顶层 + media/logo 进 raw，满足 Codex 多图收集规则）：
   ```json
   {
     "rank": 1, "source": "gh", "title": "...", "summary": "...", "summary_full": "...",
     "url": "https://...", "deep_link": "/g/owner/repo", "author": "owner",
     "cover": "https://api.ai-feeds.com/r/...png", "item_id": "github:owner/repo",
     "raw": { "media": [ {"type":"image","url":"https://..."} ], "logo": null }
   }
   ```
5. 外层包壳：
   ```json
   {
     "render_key": "daily-2026-06-05-normal-<hash8>",
     "date": "2026-06-05", "density": "normal",
     "title": "AI Feeds 2026-06-05 日报",
     "source": "cloudflare-daily",
     "digest": {
       "meta": { "generated_at": "...(BJT)", "density": "normal",
                 "source_order": ["ph","gh","hf-paper"], "source_labels": {...} },
       "sections": { "normal": [ { "source":"ph","source_label":"热门产品","count":5,"items":[...] }, ... ] }
     }
   }
   ```

**render_key 幂等**：`daily-<date>-normal-<sha256(item_ids + 各条 title)前8位>`。
内容没变 → 同 key → Codex 命中同一条不重复生成；内容变了（重跑/补榜）→ 新 key。

## 5. POST 调用（`pushDailyToCodex`）

- `POST https://ai-feeds.cc/aifeeds/api/daily/ingest`（可被 `DAILY_PUSH_ENDPOINT` env 覆盖）
- Header：`Authorization: Bearer <X_CARD_SHARED_TOKEN>` + `Content-Type: application/json`
- Body：§4 payload
- Codex 快速返回 202 `{ id, status:'queued', ... }`（异步生成）
- 记 console.log（含返回 id）；非 2xx → 抛错触发 step RETRY；最终失败 PushDeer 告警
- **token 绝不进 payload / log / 前端**（沿用 X card 约定）

## 6. 手动触发（测试用）

加 enrich mode `daily-codex-push`（同 x-card 那批），`POST /api/enrich/run?mode=daily-codex-push[&dry=1]`，
不等 8 点 cron 就能在 staging 验证 payload + 调用。`dry=1` 只返 payload 不真 POST。

## 7. 边界 / 暂不做（phase 2）

- **copies{wechat,xhs}**：Codex 支持我们传文案优先用。v1 先让 Codex 自己生成；后续可把邮件级文案传过去。
- **gh/hf 图片全量 R2**：ph/x 已 R2；gh README 图是 githubusercontent（GitHub CDN 稳定），
  hf 图多为 R2 或 arxiv（Codex 说 arxiv URL 它能处理）。v1 先用 renderItem 现成的，全量自托管留 phase 2。
- **状态回查 / 面板**：Codex 侧 AF 工作台已有「每日日报」模块看结果；aifeeds 侧 v1 只 fire-and-forget + 日志。

## 8. 实施 + 验证

1. `digest/codex-push.ts`：`buildDailyCodexPayload` + `pushDailyToCodex`。
2. `node-run.ts`：8 点 Phase 3 接入（非阻塞）。
3. `index.ts`：enrich mode `daily-codex-push`（手动触发 + dry）。
4. staging：`dry=1` 看 payload 结构 → 真 POST 一次，确认 Codex 返 202 + 工作台出现记录。
5. 合 main → prod 部署 → 次日早 8 点观察（或手动触发一次）。
