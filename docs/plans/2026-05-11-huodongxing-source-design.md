# 活动行（huodongxing.com）AI 活动源接入设计

> 日期：2026-05-11
> 状态：Phase 0 设计稿（HTML 可扒性已 reconnaissance 验证；待 sign-off 进 Phase 1）
> 对应 SOP：[docs/source-integration-sop.md](../source-integration-sop.md)
> 关联：官方 API 申请中。HTML 抓取作为先行方案，API 下来后评估是否替换。

---

## 0. TL;DR

- **可扒**：SSR 静态 HTML，无 turnstile/captcha，CF Worker `fetch()` 直接拿 200 + 完整页。robots.txt `Allow: /events`。
- **覆盖**：24 个官方城市（6 个子域名 + 18 个 ?city= 形式）。没有「全国」聚合页。
- **抓取策略**：每城市 × `tag=AI` × `orderby=o` × 翻页到底；不再细分 `d` / `eventType` 维度，前端按事件自带字段筛。
- **频率**：BJT 09:00 + 21:00 各一次。每次走 ~5 个 cron */5 slot 串联，subrequest 预算充足。
- **enrich**：每个新 unique event 触发一次 detail page 抓取，拿精确时间戳 / 完整地址 / 多档票价 / 报名人数 / 正文。
- **过期处理**：抓取时跳过已过期事件；status=historical 后默认不显示，DB 保留历史。
- **LLM**：标签是 AI 二次判别非必需，但保留 `is_relevant` 判别口子防止站点错误打标。

---

## 1. 决策矩阵（已 sign-off 项）

| 维度 | 决策 |
|------|------|
| 抓取范围 | **24 个官方城市**（6 子域名 + 18 ?city=）；其他城市不支持 |
| 时段过滤 (`d` 参数) | **不传**；事件自带精确时间，前端按 `本周 / 本周末 / 1 月内` 筛 |
| 形式过滤 (`eventType` 参数) | **不传**；卡片 addr 已含「线上活动」/ 城市名，前端按线上/线下筛 |
| 排序 (`orderby` 参数) | **仅 `o`（综合排序）**；不跑 `t` 维度 |
| 翻页 | `page=N` 起 1，遇 `<div class="hd-empty-list">` 停 |
| 单页 size | 列表页 12-20 条，平均 ~5 页/城市/抓取 |
| 抓取频率 | **早晚各一次**：**BJT 04:30 + 16:30**（UTC 20:30 + 08:30） |
| URL 形式 | **统一用 `?city={名}`**，不用 6 个子域名（工程一致性优先） |
| LLM judge | **v1 不开**（站点已按 `tag=AI` 锁死预筛，默认 `is_relevant=1`） |
| 翻译 | **不需要**（站点全中文） |
| Detail enrich | 每个 unique event 抓一次 detail page，跳过已过期 |
| 过期处理 | 三合一：抓取阶段跳过 / status=historical / dashboard 默认 filter |
| R2 资源 | **全迁**：logo + og_image + organizer avatar + guest avatar + **detail 正文内嵌图（≤5 张）** |
| metrics_snapshots 表 | **v1 不建**（无时间序列可视化需求，schema 仅增不减，后期可补） |
| 字段命名 | source_type = `huodongxing` |

---

## 2. URL 与抓取流水线

### 2.1 URL 模式

```
列表：https://www.huodongxing.com/events?tag=AI&city={城市}&orderby=o&page={N}
详情：https://www.huodongxing.com/event/{id}
更换城市索引：https://www.huodongxing.com/changecity（参考）
```

> 6 个核心城市另有子域名形式 (`bj/sh/gz/sz/hz/cd.huodongxing.com/events`)，已决定**不用**：18 个次级城市只能 `?city=`，统一一种形式工程更简单。Phase 1 验证 `?city=` 对 6 个核心城市等价后定型。

### 2.2 24 城市清单

| 形式 | 城市 |
|------|------|
| 子域名 (6) | 北京 (bj) · 上海 (sh) · 广州 (gz) · 深圳 (sz) · 杭州 (hz) · 成都 (cd) |
| `?city=` (18) | 长沙 · 南京 · 重庆 · 苏州 · 西安 · 郑州 · 厦门 · 天津 · 宁波 · 青岛 · 东莞 · 佛山 · 济南 · 珠海 · 合肥 · 福州 · 石家庄 · 昆明 |

> 配置写在 worker 一个常量数组，未来加城市改一行。

### 2.3 流水线总览

```
[CF Worker scheduled() at BJT 09:00 + 21:00 → 抢占 ~5 个 */5 cron slot]
  for city in CITIES (24):
    for page in 1..N:
      ↓ fetch /events?tag=AI&city={city}&orderby=o&page={page}
      ↓ if hd-empty-list → break (该城市抓完)
      ↓ parse 12-20 个 card → canonical Item[]
      ↓ upsert items 表 (ON CONFLICT 更新 last_seen_at + metrics)
      ↓ 新 unique event 标 detail_pending=true
  ↓ done

[CF Worker scheduled() preempt rotation (any */5 tick)]
  if detail_pending count > 0 AND start_time > now (未过期):
    pick 1 row → fetch detail page → parse → enrich extra/metrics
    LLM is_relevant judge（可选）
    R2 migrate (logo + main image + organizer avatar)
    update items: detail_pending=false
```

### 2.4 单页内容样本（列表卡片）

| 字段 | CSS / 解析路径 | 例 |
|------|--------------|-----|
| event_id | `<a href="/event/{id}">` | `5859894940100` |
| title | `.item-title span` | `【BP常年征集令】...` |
| thumbnail | `.item-logo[src]` | `cdn.huodongxing.com/logo/.../v2small.jpg` |
| location_raw | `.item-dress-pp` | `北京朝阳` / `线上活动` |
| time_raw | `.item-dress p` | `05/21 周四 14:30` / `后天 10:00` |
| organizer_name | `.user-name` | `三板汇` |
| organizer_url | `<a class="flex" href="...">` | `https://sanbanhui.huodongxing.com` |
| organizer_avatar | `.user-logo[src]` | `cdn.huodongxing.com/logo/org/...jpg` |
| organizer_fans | `.follows` 文本 | `粉丝 17899` |
| organizer_certified | `.attestation-sign` 标签 | 企业认证 / VIP 金牌 |

### 2.5 Detail page 增量字段

| 字段 | 来源 | 例 |
|------|------|------|
| start_time / end_time | meta + 正文区域 ISO 时间戳 | `2026-05-13 09:00` |
| location_full | meta + `.eventContentAreaMain` 内地址块 | `北京市朝阳区北苑东路山水蓝维30号` |
| ticket_tiers[] | 价格块 (¥XXX / 免费) | `[{name: '早鸟', price: 199}, ...]` |
| registered_count | "已报名 N 人" 文本 | `12` |
| body_html | `.eventContentAreaMain` HTML（清洗 inline style） | drawer 主内容 |
| guests[] | 嘉宾区块（meta `活动嘉宾` 提示存在） | `[{name, title, avatar}]` |
| og_image | `<meta property="og:image">` | 主图 1200px |

---

## 3. Schema 增量

### 3.1 `items` 共享字段映射

| 列 | huodongxing 值 |
|----|---------------|
| `id` | `huodongxing:{event_id}` |
| `source_type` | `'huodongxing'` |
| `source_id` | `{event_id}` |
| `title` | event title |
| `content` | tagline（取 og:description 或正文首段 100 字） |
| `author` | organizer_name |
| `handle` | organizer slug（从主页 URL 提取，如 `sanbanhui`） |
| `url` | 详情页 URL |
| `created_at` | event start_time (ISO，由 detail 补） |
| `published_at` | event start_time（同上，前端时间筛用） |
| `scraped_at` | 抓取时刻 ISO |
| `metrics` | JSON：`{registered_count, ticket_price_min, ticket_price_max, organizer_fans}` |
| `media` | JSON：`[{type:'image', url:'/r/hdx/<sha>', role:'thumbnail'}, ...]` |
| `lang` | `'zh'` |
| `is_relevant` | 0/1（可选 LLM judge，默认 1） |
| `extra` | JSON 大杂烩，见 3.2 |

### 3.2 `items.extra` JSON shape

```jsonc
{
  // 抓取阶段写入
  "city": "北京",                       // 24 城市之一
  "district": "朝阳",                   // 从 addr 拆出来（"北京朝阳" → "朝阳"）
  "is_online": false,                   // addr=="线上活动" → true
  "first_seen_at": 1778600000,          // 首次抓到的 unix 时间戳
  "last_seen_at": 1778686400,           // 最后一次出现在列表的时间戳
  "detail_pending": true,               // 待 enrich
  "status": "active",                   // active | historical
  "organizer": {
    "name": "三板汇",
    "slug": "sanbanhui",
    "url": "https://sanbanhui.huodongxing.com",
    "avatar_url": "/r/hdx/<sha>",
    "fans": 17899,
    "is_certified_company": true,
    "is_vip_gold": true
  },

  // Detail enrich 阶段写入
  "start_time": "2026-05-13T09:00:00+08:00",
  "end_time": "2026-05-13T12:00:00+08:00",
  "location_full": "北京市朝阳区北苑东路山水蓝维30号",
  "is_free": false,
  "ticket_tiers": [
    { "name": "早鸟票", "price": 199, "currency": "CNY" },
    { "name": "标准票", "price": 499, "currency": "CNY" }
  ],
  "registered_count": 12,
  "body_html": "<div>...activity content...</div>",
  "guests": [
    { "name": "张三", "title": "三板汇 CEO", "avatar_url": "/r/hdx/<sha>" }
  ],
  "og_image": "/r/hdx/<sha>",
  "enriched_at": "2026-05-11T10:30:00Z",

  // LLM judge（可选）
  "ai_relevant_reason": "AI 应用场景实战会，主题与 AI 强相关",
  "llm_called_at": 1778600000,

  // R2 迁移
  "r2_migrated_at": "2026-05-11T10:35:00Z",
  "r2_assets_count": 4
}
```

### 3.3 `metrics_snapshots_huodongxing` 表

**v1 不建**。报名人数和主办方粉丝数 v1 仅需当前最新值（存 `items.metrics` + `items.extra.organizer.fans`），无时间序列可视化需求。

未来若 v2 需要"报名增长曲线 / 主办方粉丝变化"，按 PH 同款模式补 schema：

```sql
CREATE TABLE IF NOT EXISTS metrics_snapshots_huodongxing (
  item_id          TEXT NOT NULL,
  captured_at      INTEGER NOT NULL,
  registered_count INTEGER,
  organizer_fans   INTEGER,
  PRIMARY KEY (item_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_ms_hdx_item_time
  ON metrics_snapshots_huodongxing(item_id, captured_at);
```

### 3.4 telemetry 事件（无新增）

复用：`item_open_drawer / item_close_drawer / external_link_click / share_click / feed_load_error / api_error / image_load_error / item_impression`。

---

## 4. 抓取实现位置：CF Worker

### 4.1 文件骨架

```
worker/src/
├── huodongxing.ts            # 主流水线 (runHuodongxingFetchList + runHuodongxingEnrich)
├── huodongxing/
│   ├── parser.ts             # listing HTML → canonical Item[]
│   ├── parser-detail.ts      # detail HTML → enrich fields
│   ├── cities.ts             # 24 城市常量 + URL 拼装
│   └── llm-judge.ts          # 可选 is_relevant 判别
├── ph.ts                     # 已存在（R2 迁移）
└── index.ts                  # scheduled() 新增 hdx mode 抢占
```

### 4.2 Cron 抢占轮转设计

参考 `worker/src/index.ts:300-400` 的 X / GH / ClawHub / PH 模式，新增：

- `huodongxing-fetch-list`：BJT 09:00 + 21:00 触发（UTC 01:00 + 13:00）
  - 单 tick 内抓 N 个城市（subrequest 预算 50/invocation，~5 页/城市 → 一 tick 抓 ~8 城市）
  - 用 KV 或 D1 临时表跟踪本轮 cron 已抓到第几个城市，多 tick 串联完成 24 城市
- `huodongxing-detail-enrich`：任何 tick 上检测 `detail_pending=true AND 未过期`，preempt 一行 enrich

伪代码（scheduled() 内）：

```ts
if (isHdxFetchSlot(hour, minute)) {
  const r = await runHuodongxingFetchList(env, /*cities batch=*/ 8);
  // 跑完 24 城市后下个 slot 自动停（用 KV 标记）
}
else if (mode !== 'github-fetch' && mode !== 'clawhub-fetch') {
  // GH preempt 之后加 hdx 链
  const hdxDetailPending = await countHdxDetailPending(env);
  if (hdxDetailPending > 0) {
    await runHuodongxingDetailEnrich(env, 2);
    return;
  }
  const hdxR2Pending = await countHdxR2Pending(env);
  if (hdxR2Pending > 0) { ... }
}
```

### 4.3 抓取计划伪代码

```ts
// list fetch — 单次跑指定城市
async function fetchCityListing(city: string): Promise<EventCard[]> {
  const cards: EventCard[] = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://www.huodongxing.com/events?tag=AI&city=${encodeURIComponent(city)}&orderby=o&page=${page}`;
    const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
    if (html.includes('hd-empty-list')) break;
    const pageCards = parseListing(html, city);
    if (pageCards.length === 0) break;
    cards.push(...pageCards);
  }
  return cards;
}

// detail enrich — 单条 enrich
async function enrichOne(env: Env, item: ItemRow) {
  // 跳过已过期
  if (item.extra.start_time && new Date(item.extra.start_time) < new Date()) {
    await markHistorical(env, item.id);
    return;
  }
  const url = `https://www.huodongxing.com/event/${item.source_id}`;
  const html = await (await fetch(url)).text();
  const detail = parseDetail(html);
  await updateItem(env, item.id, detail);
}
```

### 4.4 停止条件（FAQ-defensive）

- 翻页：遇 `hd-empty-list` 立刻停（已验证空态 marker）
- 单页 0 card：保险起见也停
- 单城市最大翻 20 页（活动行 AI 单城市日常远不到 240 个）
- 抓到的 event 已在 DB → ON CONFLICT 路径只 bump `last_seen_at`

---

## 5. LLM Prompt 设计

### 5.1 is_relevant 判别（可选）

站点已经按 `tag=AI` 预筛，但难免混入沾边（创业 / 投融资 / web3 等冠名 AI 的）。需要时 DeepSeek V4 Flash 二次判别：

```
[输入]
- title
- tagline / og:description
- body_html 前 500 字（去 HTML 标签）
- organizer_name

[任务]
判断这是不是"AI 强相关"活动。AI 强相关：核心议题是 LLM / Agent / 模型 /
AI 工具 / AI 行业讨论 / 学术 / 应用落地。
排除：仅冠名 AI 但议程是创业 / 投融资 / web3 / Web2 SaaS / 销售课程。

[输出]
{
  "is_ai": 0 | 1,
  "reason": "<50 字以内中文，解释判断"
}
```

成本：每天新事件 ~50-150 个 × ~400 tokens input × $0.10/M ≈ **$0.01/天**。

> Phase 1 决定要不要开。默认先全过（is_relevant=1）。

### 5.2 翻译

**不需要**（站点全中文）。

---

## 6. R2 资源迁移

复用 GH/PH 的 `xlist-readme-assets` bucket，key prefix `hdx/`：

```
xlist-readme-assets/
├── gh/<sha>.<ext>   (existing)
├── ph/<sha>.<ext>   (existing)
└── hdx/<sha>.<ext>  (new)
```

每 item 资产 cap（v1 全迁）：

- thumbnail (item-logo)：1 × ≤ 1MB
- og_image / 主图：1 × ≤ 5MB
- organizer avatar：1 × ≤ 1MB
- guest avatars：≤ 10 × 1MB
- **detail body 内嵌图：≤ 5 × 5MB**（v1 启用，防活动行 CDN 失效）

总 cap：~18 资产/event / ~30MB/event 上限。

迁移幂等：sha256(URL) → 已存在跳过；已是 `/r/hdx/` 跳过。

### 6.1 内嵌图重写规则

detail enrich 写入 `extra.body_html` 时，扫描 `<img src="https://...">` 标签，逐个：
1. fetch 原图（content-type 验证）
2. 上传 R2，key = `hdx/<sha>.<ext>`
3. 原 HTML 中替换 `src` 为 `/r/hdx/<sha>.<ext>`

最终入库的 `body_html` 内所有图都已指向 R2 自家路径，与 GH README 同款模式（参考 `worker/src/github.ts` 的 `runGithubR2Migrate`）。

---

## 7. Dashboard UI（v1）

### 7.1 Card 组件（HuodongxingCard.tsx）

设计稿：待出 mockup `_mockups/2026-05-11-hdx-card-mockup.html`。

**初版构想**（参考 GithubCard / PhCard 现有风格）：

```
┌─────────────────────────────────────────┐
│ ┌──┐ 【BP常年征集令】项目够硬，你就来 ↗   │
│ │图│ 三板汇提供免费路演、政府直投...         │
│ └──┘                                      │
│ 📅 05/21 周四 14:30  📍 北京朝阳            │
│ ┌──┐ 三板汇  粉丝 17.9k ✓                  │
│ │头│ 金牌主办方                            │
│ └──┘                                      │
└─────────────────────────────────────────┘
```

字段：
- 左上：80×80 thumbnail
- 右上：title（粗） + tagline（1 行）
- 中：时间 + 地点 chip 行
- 底：organizer header + 认证标
- 右上角：外链跳出箭头

### 7.2 Drawer (HuodongxingDrawerBody.tsx)

参考 GithubDrawerBody / PhDrawerBody 9 段结构：

1. **活动头部**：og_image + title + 时间 + 地点 + 主办方 chip
2. **KPI 行**：报名数 / 票价区间 / 主办方粉丝数
3. **关键信息**（chip 组）：日期 + 城市 + 在线/线下 + 是否免费 + 票价档位
4. **AI 解读**（可选）：DeepSeek 一段中文解读「这场活动适合谁参加」
5. **嘉宾**：guests[] 头像 + 名字 + title
6. **正文**：body_html 渲染（清洗后）
7. **主办方**：organizer 卡片（头像 + 名字 + 粉丝 + 认证 + 主页跳出）
8. **报名渠道**：跳活动行原页面（自带 UTM）
9. （可选）**相似活动**：同主办方的其它 AI 活动 list

### 7.3 SourceIcon

加 `IconHuodongxing`（活动行 logo 简化 SVG）。

### 7.4 App.tsx 注册

```ts
const SOURCE_COLUMNS: SourceConfig[] = [
  // ...
  { source_type: "huodongxing", title: "活动行" },
];

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  // ...
  { key: "huodongxing", label: "活动" },
];
```

### 7.5 前端筛选 UI

dashboard feed 顶上加三个 chip（多选）：

- **时段**：本周 (t1) / 本周末 (t4) / 1 月内 (t5)（按 start_time 客户端筛）
- **城市**：6 主城（北上广深杭蓉）默认显示 + "更多 (18)" 展开
- **形式**：全部 / 线下 / 线上（按 is_online 字段筛）

> 抓取阶段不分维度，全部丢前端 client-side filter（feed 数据量小，单城日量 ~10-50 条，3 万条/年顶天）。

### 7.6 默认排序

```
ORDER BY
  CASE
    WHEN start_time <= now() AND end_time > now()       THEN 0  -- 进行中（含 end_time 为 NULL 但 start 已过 24h 内的兜底）
    WHEN start_time > now()                              THEN 1  -- 未开始
    ELSE                                                 2       -- 已结束（不应出现在 feed，feed query 会先 filter 掉）
  END ASC,
  start_time ASC      -- 同状态下按开始时间升序（最近发生的在前）
```

> 实施时按 `extra.start_time` / `extra.end_time` JSON 抽出做派生排序。Feed query 默认 WHERE filter：`status != 'historical' AND (end_time > now() OR end_time IS NULL)`。
>
> 已结束的活动**不会**主动进 feed；但已展示给用户的活动如果在 feed 停留期间过期了，前端可以选择保留在视图里（不刷新）或在下一次 fetch 时被过滤掉（按业务体验决定，建议下次 fetch 过滤）。

---

## 8. CF 资源成本估算

| 项 | 估算 | 备注 |
|----|------|------|
| List fetch | 24 城 × ~5 页 × 2 次/天 = **240 fetch/天** | 单次 ~150KB |
| Detail enrich | ~150 个新 event/天 = **150 fetch/天** | 单次 ~200KB |
| Bandwidth 下载 | (240×150 + 150×200) KB ≈ **66MB/天 ≈ 2GB/月** | CF 无限 |
| D1 写入 | ~150 新行 + ~150 enrich update + 240 last_seen bump = ~540 写/天 | 月 16k 远低于 100M |
| Subrequest | 240 + 150 = ~390/天 ÷ 288 ticks ≈ **<2 subreq/tick 平均** | 单 tick 上限 50 |
| DeepSeek (可选 judge) | ~150 调用/天 × 400 token ≈ **$0.01/天** | 接近忽略 |
| R2 PUT | 4 资源/event × 150 = ~600 PUT/天 = 18k/月 | 1M/月 free 内 |
| R2 存储 | ~150 × 4 × 200KB ≈ 120MB/月 累积 | 10GB free |

**结论**：**几乎不耗成本**。比 X 的 list-poll + refresh 还省。

---

## 9. Phase 拆分（实施计划）

### Phase 0：设计 + Mockup（本文档 + 可选）— **0.5 天**

- [x] 设计文档（本文档）
- [ ] HTML mockup（feed card + drawer，参考 GH/PH mockup 样式）
- [ ] Sign-off

### Phase 1：Schema + Parser POC — **0.5 天**

- [ ] 决定是否加 `metrics_snapshots_huodongxing` 表
- [ ] 写 `worker/src/huodongxing/parser.ts` 单测：拿现成 listing HTML samples 喂入，比对解析结果
- [ ] 写 `worker/src/huodongxing/parser-detail.ts` 单测：拿现成 detail HTML 喂入
- [ ] **POC endpoint** `/poc/hdx?city=北京`：现场 fetch + parse + 返 JSON，验证流水线

### Phase 2：Scraper 主体 — **1 天**

- [ ] `huodongxing.ts` 串联：`runHuodongxingFetchList(env, batch)` + `runHuodongxingDetailEnrich(env, limit)` + 计数函数
- [ ] cities 常量 + URL 拼装
- [ ] LLM judge 模块（可选开关）
- [ ] 本地 `wrangler dev` 单城市端到端测

### Phase 3：Cron + Enrich 抢占 — **0.5 天**

- [ ] `index.ts` scheduled() 新增 fetch-list slot + detail-enrich preempt
- [ ] 多 tick 城市轮转状态机（用 KV 标记进度）
- [ ] Subrequest budget 边界测试

### Phase 4：Dashboard UI — **2 天**

- [ ] `HuodongxingCard.tsx`
- [ ] `HuodongxingDrawerBody.tsx`
- [ ] `IconHuodongxing` SVG
- [ ] 前端筛选 UI（时段 + 城市 + 形式）
- [ ] App.tsx + Feed.tsx 路由注册
- [ ] 移动 + PC smoke test

### Phase 5：R2 资源迁移 — **0.5 天**

- [ ] `huodongxing-r2-migrate` 模式（参考 PH r2-migrate）
- [ ] 内嵌图选项决策（v1 不开）

### Phase 6：真机验收 — **0.5 天**

- [ ] iOS Safari + 微信 WebView
- [ ] 安卓 Chrome + 微信（走 ai-feeds.com）
- [ ] golden path：feed 显示 → 卡片点开 drawer → 时段/城市/形式筛 → 跳活动行原页

### Phase 7：operations.md 更新 — **0.5 天**

- [ ] 加 cron 配置 + 频率
- [ ] 加 D1 新表（如有）
- [ ] 加 R2 key 前缀 `hdx/`
- [ ] 加 LLM 成本
- [ ] secrets 无变更（DeepSeek 已有）

**总工时**：**5-6 天**（不含官方 API 替换的迭代）

---

## 10. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 活动行 HTML 结构改版导致 parser 挂 | 中 | 高 | parser 加 fail-safe（缺字段不 throw，记日志）；解析失败率 > 20% 告警 |
| 反爬升级（突然加 turnstile / 风控） | 低 | 高 | 监控解析成功率；切换 CF Browser Rendering 或本地 fallback |
| 24 城市以外用户需求 | 中 | 中 | v2 加用户输入 fallback（worker 实时抓单次，会话级，不入库） |
| 时间字符串解析不准（"后天" / 月日无年份） | 中 | 中 | 抓取上下文推年份（跨年看 detail page 精确时间）；detail enrich 是真值来源 |
| 24 城市单 tick 抓不完 | 低 | 低 | 多 tick 串联，KV 标记进度，4-5 个 tick 跑完 24 城 |
| 官方 API 下来后字段不一致 | 中 | 中 | parser 抽象到独立模块；API 来后写 adapter，items.extra 内 schema 不变 |
| 报名数 / 时间 metric 在不同时间点变化（drift） | 低 | 低 | `metrics_snapshots_huodongxing` 表追踪历史，主表存最新值 |
| LLM judge 误杀（把真 AI 活动 is_relevant=0） | 低 | 中 | v1 不开 judge 默认全过；判别开关用 env var 控制，能随时关掉 |

---

## 11. 与官方 API 的关系（待 API 下来后修订）

| 维度 | HTML 抓取（本方案） | 官方 API |
|------|----|----|
| 实施周期 | 5-6 天，本周可上 | API 申请未知，几天到几周 |
| 字段丰富度 | 列表 + detail 已能覆盖 90% drawer 需求 | 通常更全（票务 / 报名 / 主办方所有事件） |
| 稳定性 | 站点改版会挂 | 官方 contract 通常更稳 |
| Rate limit | 仅受 CF subrequest 限制 | 取决于 API 配额 |
| 迁移成本 | 抽象 fetcher / parser 到独立模块，便于换接口 | 拿到 token 后写 API adapter，1-2 天 |

**策略**：先上 HTML 方案。API 下来后做 A/B 字段对比 + 写 adapter。`items.extra` schema 不变，仅 fetch 路径切换。

---

## 12. 附：用户已 sign-off 决策记录

> 2026-05-11 brainstorming + 二轮 sign-off：

**轮 1**：
- ✅ 范围：24 个官方城市，不做 fallback
- ✅ 排序：只 `orderby=o`
- ✅ 过期处理：DB 保留全部 / dashboard 默认只显未过期 / 抓取阶段跳过过期 / status=historical
- ✅ 时段筛 (d) / 形式筛 (eventType)：均不在抓取维度展开，前端 client-side 筛

**轮 2**：
- ✅ **Cron 时间**：BJT 04:30 + 16:30（UTC 20:30 + 08:30）
- ✅ **URL 形式**：统一 `?city=`，不用子域名
- ✅ **metrics_snapshots 表**：v1 不建
- ✅ **LLM judge**：v1 不开（`tag=AI` 已锁，默认 `is_relevant=1`）
- ✅ **R2 内嵌图**：v1 迁
- ✅ **默认排序**：状态优先（进行中 > 未开始 > 已结束），同状态 start_time ASC

---

## 13. Frontend 接口对齐（与并行前端 session 协议）

| 项 | 协议 |
|----|------|
| `source_type` 字符串 | `huodongxing`（D1 列、`/api/items`、`/api/sources`、`/api/stats.by_source` 一致） |
| 过期过滤 | **worker 层默认过滤**：`status != 'historical' AND (end_time > now() OR (end_time IS NULL AND start_time > now() - 1 day))`（end_time 为 NULL 时按 start_time 兜底） |
| 历史活动开关 | query param `?include_historical=1` 透传 |
| 命名一致 | `is_online` / `ticket_tiers[]` / `is_free` 按 §3.2 |
| Detail enrich 状态 | `extra.detail_enriched_at`（时间戳，非 null 即 enrich 完成）；列表 listing 抓到但未 enrich 的 event 仅有 `time_raw` / `location_raw`，前端 fallback 显示原始字符串 |
| `media[]` role 枚举 | `thumbnail` / `og_image` / `organizer_avatar` / `guest_avatar` / `body_image` |
| Deep-link 路由 | `/e/:event_id` v1 加（event_id 直接用站点原始数字 ID 如 `5859894940100`） |
| 数据上线节奏 | source 进 staging /api/sources 即可，前端 placeholder 自动消失，不必等 PR 合并 |
