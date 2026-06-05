# 运营看板 X 卡片渲染（自动 + 手动）— 设计文档

> 2026-06-05。基于已上线的 P0（X 媒体→R2）+ P2/P3（`x-card-render.ts` 渲染管线，
> `renderXCardViaCodex` 调 Codex HTTPS 端点 → 转存 R2）。本设计在 `/admin/ops`
> 运营看板上加两个能力，分支 `feat/x-card-ops-render`，走 staging→prod。

## 1. 目标

1. **自动渲染**：爆推（baopui）/ 趋势推（trend）在**检测入池的那一刻**（`detect.ts`），
   除现有 PushDeer 告警外，新增动作把它**送进渲染队列** → 调 Codex 渲成社媒卡片图。
   渲染时间 + 结果在 ops 面板可见；失败可重推。
2. **手动添加**：ops 面板填 X 推文地址（`x.com/.../status/<id>`）或 aifeeds 抽屉地址
   （`/t/<id>`）→ 同样调 Codex 渲染。不在库的推文先抓取入库再渲。

> 注意：这里的「push」是**调 Codex 渲染**，与 `ops_pool_items.pushed_at`（现有的
> PushDeer 通知时间，`detect.ts:373` 写）是**两回事**，不复用那个字段。

## 2. 数据模型：新表 `x_card_renders`

统一管「自动池」+「手动」两类渲染，按 `item_id` 一条：

```sql
CREATE TABLE x_card_renders (
  item_id     TEXT PRIMARY KEY,        -- x_list:<tweet_id>
  render_key  TEXT,                    -- tweet_id + 内容哈希(P3 生成)
  status      TEXT NOT NULL,           -- pending | rendering | ok | failed
  image_url   TEXT,                    -- 成功:https://api.ai-feeds.com/r/x-card/<key>.png
  error       TEXT,                    -- 失败原因
  source      TEXT NOT NULL,           -- pool-auto | manual
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,        -- 入队时间(unix)
  rendered_at INTEGER                  -- 出图时间(unix),给面板显示"推送时间"
);
CREATE INDEX idx_x_card_renders_status ON x_card_renders(status, created_at);
```

## 3. 自动渲染流程

1. `detect.ts` 检测到一条入 baopui/trend 池（已有写 `ops_pool_items` + PushDeer 的地方）
   → 新增 `INSERT OR IGNORE INTO x_card_renders(item_id, status='pending', source='pool-auto', created_at)`。
   不 inline 渲染（避免拖慢检测 + 符合 Codex 限流）。
2. **新 cron tick `drain-x-card-renders`**：每 tick 取 N=2-3 条 `status='pending'`，串行带间隔（3-5s）渲染：
   - 渲染前**检查 enrich 完成**：该 item 有 `content_translated`（非中文推文）+ `x_media_r2_at`。
     没完成 → 跳过本 tick（留 pending，等下轮），保证卡片有中文 + R2 媒体，不渲半成品。
   - `status='rendering'` → `renderXCardViaCodex(env, itemId)`（P3，已有，幂等）
   - 成功 → `status='ok', image_url, rendered_at`；失败 → `status='failed', error, attempts++`
   - 自动重试封顶 `attempts < 3`；超过留 failed，面板仍可手动重推
3. 限流：Codex 并发 1 / 3-5s/张。检测一次入多条 → 摊到几个 tick 慢慢渲。

## 4. 手动添加流程

`POST /api/admin/x-card-manual { url }`（CF Access 鉴权，同其他 `/api/admin/*`）：

1. **解析 tweet id**：支持 `x.com|twitter.com/.../status/<id>`、`ai-feeds.com|staging.ai-feeds.com/t/<id>`、裸数字 id。解析不出 → 400。
2. 查 `items` 有没有 `x_list:<id>`。
3. **不在库** → SB by-id 抓全（`/v1/twitter/tweets/?tweets=<id>`）→ 复用 `sbTweetToIngestItem` 写入 `items` → `X_TWEET_PIPELINE_WORKFLOW.create`（翻译 + 媒体 R2 + 回填）。
4. `INSERT OR REPLACE INTO x_card_renders(item_id, status='pending', source='manual', created_at)` → 进同一队列。
   - 队列渲染前的「enrich 完成」检查天然处理「刚抓的新推文还在翻译」：等就绪了再渲。
5. 返回 `{ ok, item_id, status }`，面板里这条出现在状态列表,pending→ok 实时刷。

## 5. 面板 UI（`admin-ops.ts` 的 `OPS_HTML` + metric endpoint）

- **新 metric** `/api/admin/ops?metric=renders`：返回 `x_card_renders` 行（pool-auto + manual + 最近列表）。
- **爆推/趋势区**：`metricBaopui`/`metricTrend` 的 SQL `LEFT JOIN x_card_renders ON item_id`，每条尾部加**渲染状态徽章**：
  - pending/rendering → 「渲染中…」（灰）
  - ok → 小缩略图（`image_url`）+ 「看大图」链接 + 渲染时间
  - failed → 红字 `error` + 「重推」按钮
- **新增「手动渲染」卡片**：输入框（粘贴 URL）+「渲染」按钮 → POST `/api/admin/x-card-manual` → 这条进状态列表。
- **「重推」按钮** → `POST /api/admin/x-card-render-repush { item_id }` → `UPDATE x_card_renders SET status='pending', attempts=0` → 下个 tick 重渲（P3 幂等：内容没变命中 R2 缓存秒回，变了才真重渲）。

## 6. 边界 / 决策

- **幂等**：P3 自带 R2 缓存（`x-card/<render_key>.png` 命中直接返）+ `status` 防重复入队。
- **enrich 未就绪**：队列跳过等待，不渲半成品。
- **失败重试**：`attempts < 3` 自动重试；面板手动重推无视上限。
- **限流**：cron 每 tick N=2-3 + 间隔，符合 Codex 单机渲染机保守用法。
- **鉴权**：手动/重推走 CF Access（同 admin）；自动走 cron（内部）。

## 7. 实施阶段（每阶段 staging 验证再 prod）

| 阶段 | 内容 |
|------|------|
| A | DB migration 建 `x_card_renders` 表（staging 先跑） |
| B | 渲染队列：`drain-x-card-renders` 函数 + cron tick 接入 + enrich 就绪检查 |
| C | `detect.ts` 入池时 `INSERT x_card_renders(pool-auto)` |
| D | 手动添加 endpoint（URL 解析 + 不在库则抓取入库 + 入队）+ 重推 endpoint |
| E | 面板 UI：renders metric + 爆推/趋势状态徽章 + 手动渲染区 + 重推按钮 |
