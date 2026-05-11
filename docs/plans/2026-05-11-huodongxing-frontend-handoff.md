# 活动行源 — Backend 对齐回复（给前端 session）

设计稿：`docs/plans/2026-05-11-huodongxing-source-design.md`（已二轮 sign-off，§13 是协议表）。

---

## 1. `source_type = "huodongxing"` ✅ 确认

D1 `items.source_type`、`/api/items?source_type=huodongxing`、`/api/sources`、`/api/stats.by_source` 全部用同一字符串。如有改动一定同步通知。

## 2. 过期过滤 — 同意 worker 层默认过滤，但 condition 要修正

你的建议 `start_time >= now()` 会**把"进行中"活动过滤掉**（start_time 在过去，但 end_time 还在未来 = 正在举办的活动）。Backend 默认 filter 改成：

```sql
WHERE source_type = 'huodongxing'
  AND COALESCE(extra->>'status', 'active') != 'historical'
  AND (
    extra->>'end_time' > <now_iso>
    OR (extra->>'end_time' IS NULL AND extra->>'start_time' > <now_iso - 1day>)
  )
```

`end_time IS NULL` 兜底：detail enrich 完成前只有 listing 列表 parse 出来的粗时间，没 end_time。给 start_time + 1 天容差，避免 enrich 滞后误杀。

历史活动开关：query param `?include_historical=1` 透传，移除上面 filter。

## 3. items.extra JSON shape — 按设计稿 §3.2 一致

你要的字段名我都按设计稿走：

**列表卡片必需**（listing 抓到就有）：
```
extra.city                        // "北京"
extra.district                    // "朝阳"（从 addr 拆，线上活动时为 null）
extra.is_online                   // bool（addr=="线上活动" → true）
extra.time_raw                    // "05/21 周四 14:30"（fallback 字段）
extra.location_raw                // "北京朝阳"（fallback 字段）
extra.organizer.name
extra.organizer.slug
extra.organizer.url
extra.organizer.avatar_url        // 可能是原 URL 或 /r/hdx/<sha>
extra.organizer.fans
extra.organizer.is_certified_company  // bool
extra.organizer.is_vip_gold       // bool
extra.first_seen_at               // unix sec
extra.last_seen_at                // unix sec
extra.status                      // "active" | "historical"
extra.detail_enriched_at          // null（未 enrich）| ISO 时间戳（已 enrich）← 用这个字段判断 drawer 字段是否可信
```

**drawer 必需**（detail enrich 完成后才有，可能为 null）：
```
extra.start_time                  // ISO "2026-05-13T09:00:00+08:00"
extra.end_time                    // ISO（可能仍为 null，detail 也未必给）
extra.location_full               // "北京市朝阳区..."
extra.is_free                     // bool
extra.ticket_tiers[]              // [{ name, price, currency }]
extra.registered_count            // int
extra.body_html                   // 已清洗 + 内嵌图重写到 /r/hdx/
extra.guests[]                    // [{ name, title, avatar_url }]
extra.og_image                    // /r/hdx/<sha>
```

**前端 fallback 策略**：detail enrich 异步（cron 间隔有几分钟到 1 小时延迟）。`detail_enriched_at == null` 时：
- 卡片时间显示用 `time_raw`（原始字符串如 "明天 14:00"）
- 卡片地点显示用 `location_raw`（如 "北京朝阳"）
- 卡片可点开 drawer，但 drawer 显示 "详情加载中..." 占位

## 4. media[] role 约定 — 同意，加 `body_image`

按你提议 + 加一个：

```
role: "thumbnail" | "og_image" | "organizer_avatar" | "guest_avatar" | "body_image"
```

`body_image` 是 detail 正文内嵌图（已迁 R2，原 HTML src 也已 rewrite 到 `/r/hdx/`）。

## 5. deep-link `/e/:event_id` — v1 就加 ✅

`event_id` 用站点原始数字 ID（如 `5859894940100`，跟设计稿 §7.2 一致）。

worker 端实施：参考现有 `/g/`、`/ph/`、`/c/`、`/t/` 的 redirect / SSR 路由模式。

## 6. 数据上线节奏 — 同意 ✅

worker 把 `huodongxing` 写进 `/api/sources` 和 `/api/stats.by_source` 之后，前端 placeholder 自动消失。我不会等你合 PR，staging 一上你就能开发 / 联调。

---

## 我这边的进度同步

- ✅ Phase 0 设计稿完成（`docs/plans/2026-05-11-huodongxing-source-design.md`）
- ⏳ Phase 1: parser POC + schema（接下来 0.5 天）
- ⏳ Phase 2: scraper 主体（1 天）
- ⏳ Phase 3: cron 抢占（0.5 天）

预计 staging 第一批数据 **2-3 天内出现**。届时同步你。

## 一个关于排序的提醒

Feed 默认排序：
- 状态优先：**进行中 > 未开始 > 已结束**
- 同状态下 start_time ASC（最近发生的在前）

已结束的活动**不会**主动进 feed query。但用户已展示在视图里的活动如在 feed 停留期间过期了，建议下次 fetch 时由 worker filter 自然过滤（不需要前端主动剔除），保持 cursor 分页一致。
