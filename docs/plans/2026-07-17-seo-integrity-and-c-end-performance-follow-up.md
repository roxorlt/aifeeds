# SEO 完整性与 C 端性能后续实施计划

> 状态：`IMPLEMENTATION IN PROGRESS — BATCH A/C LOCAL VERIFICATION COMPLETE`
>
> 本文只固化诊断、方案、实施顺序和验收门槛，不包含生产变更。执行时必须从最新
> `origin/main` 为每个可独立回滚的批次建立分支，不把所有改动塞进一个大 PR。

## 1. 目标

同时关闭以下两类问题，并避免为了修 SEO 反而放大首页性能风险：

1. 修复 `/i/` 页面 JSON-LD 的 Unicode 截断错误、sitemap 中的 5xx、孤岛页和无出站链接；
2. 完成此前已识别但尚未落地的 Product Hunt GIF、移动端请求调度、waterfall SSR
   缓存与 classic/waterfall 对照验证；
3. 把发布前 synthetic、发布后 RUM、GSC/Ahrefs 复验拆开，避免等待真实流量阻塞代码交付；
4. 每一批都能单独测试、灰度、回滚，不再形成需要连续多轮生产授权的大型发布包。

## 2. 当前证据与结论

### 2.1 GSC “Unicode 字符被截断”已经定位到确定性代码缺陷

受影响页面：

```text
https://ai-feeds.com/i/x/2061451225762046411
```

线上 JSON-LD 的 `Article.description` 末尾为：

```text
... world models \ud83d…
```

同一条内容的 `articleBody` 中则保留了完整的 `🔥`。原始数据没有损坏，损坏发生在静态页渲染阶段：

- `worker/src/seo/item-page.ts` 以 `ITEM_DESC_MAX = 150` 调用 `clampSentences()`；
- `worker/src/digest/render.ts` 使用 `clean.slice(0, maxLen)`；
- JavaScript 的 `String.length` 和 `slice()` 按 UTF-16 code unit 计数；
- `🔥` 由高、低两个 surrogate 组成，边界正好切在两者之间；
- `JSON.stringify()` 会把孤立的高 surrogate 输出为 `\ud83d`，Google 因此判定结构化数据无效。

同类风险还存在于 `worker/src/seo/item-body.ts`：

```ts
return bits.join(' ').slice(0, INDEXABLE_MAX);
```

现有 `worker/src/seo/item-page.test.ts` 只断言 JSON 能被 `JSON.parse()`；但 JSON 语法允许孤立
surrogate，所以该测试不能代表 Google 接受的 Unicode scalar 有效性。

结论：这是 P0，可直接修。部署代码后还必须重新生成已有 R2 HTML 快照，否则旧页面不会自动改变。

### 2.2 Ahrefs 孤岛页是链接图问题，不是 sitemap 发现问题

2026-07-17 只读抽样结果：

| 项目 | 数量 |
|---|---:|
| sitemap 中唯一 `/i/` URL | 34,111 |
| 47 个日报页中出现过的唯一 `/i/` 链接 | 2,444 |
| 没有任何日报入链的 sitemap item URL | 31,671 |
| 日报入链覆盖率 | 7.16% |

按源拆分：

| 源 | sitemap 唯一 URL | 被日报链接 |
|---|---:|---:|
| X | 29,920 | 940 |
| GitHub | 253 | 124 |
| Product Hunt | 891 | 492 |
| HF Paper | 1,602 | 591 |
| News | 1,445 | 293 |

Ahrefs 报 5,072 个孤岛页小于 31,671，不表示其余页面已有内链；更可能是 Ahrefs 只对已发现/已抓样本
给出报告。sitemap 能帮助发现 URL，但不构成普通 HTML 内链。

`worker/src/seo/item-page-run.ts` 的 `fetchRelated()` 还有一个结构性缺陷：所有历史页都按全库
`published_at DESC LIMIT 6` 指向同源最新 5 条，而不是当前页面附近的内容。它不能把历史页面织成
稳定、可遍历的图。

结论：不能靠“再提交一次 sitemap”解决。需要 SSR 源归档、时间分桶分页和稳定的前后项/相关文章内链。

### 2.3 “1 个页面没有出站链接”很可能是 classic 首页空 SPA 壳

生产首页原始 HTML：

- 正文只有空的 `<div id="root"></div>`；
- 原始 HTML 中没有 `<a>`；
- 所有可见导航和 footer 链接都要等 React 执行后才出现。

因此，不执行 JavaScript 的 crawler 会把首页视为“无出站链接”。但当前没有 Ahrefs 导出的精确 URL，
所以这里只能标为高概率解释，不能当成最终归因。

### 2.4 两个 5xx 仍缺少精确 URL，不能猜修

当前 sitemap index 和 7 个 sitemap 子文件均返回 200。Ahrefs 的：

- 2 个 500 页面；
- 2 个 5xx 页面；
- 2 个“网站地图中的 5xx 页面”；

很可能是同两条 sitemap URL 在 Ahrefs 抓取时返回 5xx，但必须取得精确 URL、抓取时间和响应信息后
才能确认。

代码中有一个合理嫌疑但尚未被证实：

- `worker/src/seo/item-routes.ts` 在 R2 miss 时同步调用 `generateItemPage()`；
- 该调用没有局部 `try/catch`；
- D1、相关内容查询、R2 put 或后续读取任一异常都可能冒泡成 500；
- sitemap 则只看 `item_pages.status='live'`，不验证 R2 对象当前仍存在。

结论：第一步必须导入 Ahrefs 两条精确 URL；在此之前不应通过广泛吞异常或假 200 掩盖问题。

### 2.5 Product Hunt 4.276 MB GIF 的根因已经定位

外部 synthetic 反复记录到：

```text
https://api.ai-feeds.com/r/ph/35ac32f912e690496debcd7303a9ebb2fec98caeccbaf9f797d08fce3e44e326.gif
```

单资源传输 4,276,378 B，约占代表性 desktop 完整页面传输的 55%–61%。

当前链路：

- `PhCard` 优先选择第一张非 logo 图片；
- 有 `card_variants` 时用静态 WebP 变体；
- 没有变体时，R2 URL 无法被 `/img` 自递归转换，只能直接加载原图；
- `worker/src/card-image-variant.ts` 的可转换类型明确排除了 `image/gif`，URL 后缀也拒绝 GIF；
- 所以这张动画没有 400/800 WebP，卡片直接下载完整 GIF。

Cloudflare Images 官方支持 `anim:false` 把动画输入转换为静态首帧，因此这里不需要在浏览器端下载 GIF
再截图，也不需要引入新的图片处理服务。

### 2.6 移动端请求策略是“部分完成”，不是“全部未做”

最新 main 已经做到：

- 首屏每频道由 30 条降到 12 条；
- 移动端只挂载当前频道；
- 弱网、Save-Data 禁止后台预取；
- 后台预取串行并在页面隐藏时暂停队列；
- 列表请求有 single-flight 去重。

仍未完成：

- `LOAD_MORE_LIMIT` 仍为 30；
- readiness 之后仍会遍历并预取所有 live 分类；
- X 的 30 秒 `setInterval` 在页面隐藏后仍继续触发；
- 移动端 tab 滑动/按下意图没有被用作相邻频道预取信号。

因此后续任务应是收紧剩余行为，而不是重做已经上线的首屏调度。

### 2.7 waterfall SSR 已实现但尚未进入 main

`codex/waterfall-ssr-rum-parallel` 当前：

- 比 `origin/main` 多 15 个独立提交；
- 比 `origin/main` 少 6 个新提交；
- 已包含新旧版切换、混合源 home feed、Pages Function SSR、view-mode RUM、
  sitespeed.io workflow 和本地/合成测试；
- 尚未包含最新 cursor 修复；
- 当前缓存只是在 Cache API 中存 30 秒，没有 stale-while-revalidate 或定时预热。

Cloudflare 官方明确说明：`cache.match()` / `cache.put()` 不支持
`stale-while-revalidate`。因此不能只往现有 `Cache-Control` 后面追加该指令；需要在 Pages Function
中自主管理 fresh/stale 时间和后台刷新。

## 3. 方案选择

### 3.1 Unicode：代码点安全截断 + JSON-LD 边界兜底

采用两层防护：

1. 所有面向用户/SEO 的长度截断按 Unicode code point 操作，不再按 UTF-16 code unit；
2. JSON-LD 序列化前将任何上游遗留的孤立 surrogate 替换为 `U+FFFD`，并用测试递归检查所有字符串。

不采用只针对当前 emoji 的正则补丁，因为下一条恰好卡在其它补充平面字符时仍会复发。

### 3.2 孤岛页：分层归档，而不是 34,111 链接巨页

采用以下 crawlable SSR 信息架构：

```text
/
└── /archive/
    ├── /archive/x/
    │   ├── /archive/x/2026-07/
    │   └── /archive/x/2026-06/2
    ├── /archive/gh/
    ├── /archive/ph/
    ├── /archive/paper/
    └── /archive/news/
```

规则：

- `/archive/` 链接五个源；
- 每个源页列出所有有内容的月份、条数和月份入口；
- 月份页每页 100 条，输出正常 HTML `<a>`；
- 月份页输出全部分页号或分段分页索引，避免只能逐页 next 导致深度线性增长；
- 每个 item 页链接回所属源/月，并链接同源时间相邻的前后项；
- 首页、日报归档和 item 页 footer 均能进入 `/archive/`；
- 所有路径都 SSR、self-canonical、无 JavaScript 依赖。

不采用：

- 单页输出 34,111 条链接：HTML 过大、不可维护、抓取价值低；
- 只把 URL 留在 sitemap：不能解决 Ahrefs 孤岛定义，也不能传递正常内部链接关系；
- 把所有 X 页面都直接 noindex：缺少 GSC 按源的索引/流量证据，风险过大。

### 3.3 X 大盘索引范围：先建链接图，再做质量门决策

归档落地后，用 GSC 按 `/i/x/`、`/i/gh/`、`/i/ph/`、`/i/paper/`、`/i/news/` 拆分：

- 已编入索引数量；
- 有展现/点击的页面数；
- 抓取频率；
- “已发现但未编入索引”比例；
- 近 90 天零展现且正文过短的比例。

然后再决定：

1. 全量索引；
2. 仅质量合格集合进 sitemap/index；
3. 页面保留可访问，但低质量集合 `noindex` 且移出 sitemap。

这项是独立决策，不阻塞 Unicode、5xx 和归档修复。

### 3.4 GIF：列表静态首帧，详情按意图加载原动画

- 列表卡片只使用 400/800 WebP 静态首帧；
- 抽屉 gallery 初始也先显示静态预览；
- 用户点击“播放动图”或进入 Lightbox 后才请求原 GIF；
- 无法生成首帧时，列表宁可用 logo/占位，也不自动回退 4.28 MB 动画；
- 原始 GIF 继续保留在 R2，不做破坏性迁移。

### 3.5 移动请求：基于意图，不做全量后台扫

- 删除“readiness 后预取所有 live source”的全局循环；
- 点击 tab 的 `pointerdown/focus` 与横滑明确锁定相邻目标时，仅预取那个目标；
- single-flight 继续保证预取和实际 mount 共用同一请求；
- load-more：移动端 12，桌面端 16；
- X polling 仅当 X Feed 当前可见、文档可见且在线时调度；
- 页面隐藏时取消 timer，恢复可见后重新从完整间隔开始，不立即突发请求。

### 3.6 SSR 缓存：手动 SWR，预热只做辅助

在现有 Pages Function Cache API 上实现手动 SWR：

- cache object 保留 24 小时；
- HTML 自带 `X-AIFeeds-Generated-At`；
- `age <= 60s`：fresh hit；
- `60s < age <= 10min`：立即返回 stale，并用 `waitUntil()` 后台刷新；
- 刷新失败：继续保留旧快照并记录诊断；
- 超过 10 分钟且刷新失败：fail-open 到 classic；
- 同一 isolate/PoP 用 single-flight 防止刷新风暴。

Cloudflare Cache API 是 PoP 本地缓存，外部定时 GET 只能预热请求落点的 PoP，不能假装全局预热。因此：

- 首选手动 SWR；
- 上游 `/api/home-feed` 可增加短 TTL 数据缓存，降低每个 PoP 首次 render 的 D1 成本；
- synthetic runner 可在台湾/香港定时访问作为观测和局部预热，但不作为正确性依赖。

## 4. 交付拆分与执行顺序

| 批次 | 优先级 | 内容 | 可独立发布 |
|---|---|---|---|
| A | P0 | Unicode/JSON-LD 修复、单页重生、全量快照重灌 | 是 |
| B | P0 | Ahrefs 两条 5xx 精确复现与 sitemap/R2 完整性修复 | 是 |
| C | P1 | SSR 归档、稳定相关文章、首页 crawlable 导航 | 是 |
| D | P1 | Product Hunt GIF 静态首帧与按意图加载 | 是 |
| E | P1 | 移动端预取、load-more、X polling 收紧 | 是 |
| F | P1 | waterfall 分支同步 main、手动 SWR、perf-staging A/B | 是 |
| G | P2 | 按源索引质量评估与可选 noindex/retention 策略 | 是 |

依赖关系：

```text
A ───────────────┐
B ───────────────┼── 生产 SEO 复验
C ───────────────┘

D ──┐
E ──┼── F 同条件 classic/waterfall 对照 ── waterfall canary
A/B/C 不阻塞 D/E 的本地开发，但 F 上 staging 前必须包含最新 main。
```

## 5. 批次 A：Unicode/JSON-LD P0

### Task A1：先写失败测试

**Files**

- Modify: `worker/src/seo/item-page.test.ts`
- Modify: `worker/src/digest/render.test.ts`
- Modify: `worker/src/seo/item-body.test.ts`

新增 fixture：

```text
"a".repeat(149) + "🔥" + "tail"
```

断言：

- `clampSentences(value, 150)` 不包含孤立 surrogate；
- 截断结果仍可包含完整 `🔥` 或在它之前结束，不能只有 `\ud83d`；
- `articleBody` 在 4,000 code point 边界同样有效；
- 递归遍历 JSON-LD 的每个字符串，任意位置都不匹配孤立高/低 surrogate；
- 保持 `<`、U+2028、U+2029 的既有安全转义。

**Verify RED**

```bash
cd worker
npx vitest run src/digest/render.test.ts src/seo/item-body.test.ts src/seo/item-page.test.ts
```

Expected：新增 emoji 边界用例失败。

### Task A2：实现共享 Unicode helper

**Files**

- Modify: `worker/src/digest/render.ts`
- Modify: `worker/src/seo/item-body.ts`
- Modify: JSON-LD 安全序列化 helper 所在文件

实现：

- `truncateCodePoints(value, max)`：`Array.from(value).slice(0, max).join('')`；
- `wellFormedText(value)`：只替换孤立 surrogate，不改变合法 surrogate pair；
- `clampSentences()` 先按 code point 截断，再做标点回退；
- `itemIndexableText()` 使用共享 helper；
- JSON-LD 序列化边界递归 well-form，作为上游脏字符串的最后兜底。

**Verify GREEN**

运行 Task A1 的 focused tests 和完整 Worker suite。

### Task A3：增加精确单页重生运维入口

**Files**

- Modify: `worker/src/index.ts`
- Modify/Create: 对应 admin mode 测试
- Modify: `docs/operations.md`

增加严格鉴权的：

```text
POST /api/enrich/run?mode=item-page-regenerate&id=x_list:2061451225762046411
```

要求：

- 复用既有 `INGEST_TOKEN` / staging dev token 边界；
- id 最大长度和 source 前缀有限；
- 只调用 `generateItemPage()`，不接受任意 URL/R2 key；
- 返回 `item_id`、`skipped`、`reason`、`generated_at`；
- 不 ping 3.4 万旧 URL，不绕过 relevant/dedup gate。

### Task A4：staging 与生产修复流程

1. 在 staging 部署 Worker；
2. 对 emoji 边界 fixture 调单页重生；
3. 拉取 HTML，递归验证 JSON-LD 全部字符串 well-formed；
4. Rich Results Test 验证；
5. 生产发布 Worker；
6. 只重生 GSC 指向的精确页面；
7. 再以一个固定 `cutoff` 分源 force 重灌全部 live item 页；
8. 每批检查 `remaining` 单调下降、错误数为 0；
9. 运行 sitemap/HTML Unicode 抽样；
10. 在 GSC 对该问题点击“验证修复”。

**停止线**

- 单页重生后仍出现 `\uD800-\uDFFF` 孤立值；
- force campaign 未复用同一 cutoff；
- 任一批 `scanned>0` 且 `generated=0` 连续两次；
- live page 数、sitemap URL 数或 410 数出现非预期变化。

**回滚**

- Worker 回滚上一版本；
- R2 HTML 不能自动回滚，必要时用上一版本 Worker 以新的固定 cutoff 再重灌；
- 不删除 `item_pages` 行，不批量移出 sitemap。

## 6. 批次 B：Ahrefs 5xx 与 sitemap 完整性

### Task B0：取得不可替代的输入

从 Ahrefs 导出两条精确记录，至少包含：

- URL；
- issue 类型；
- crawl timestamp；
- HTTP status；
- response time；
- redirect chain；
- AhrefsBot user-agent/渲染模式（若报告提供）。

这不是要求用户等待开发的阻塞项：A、C、D、E 可并行实施；只是 B 的根因修复不能越过该证据门。

### Task B1：逐条重放并分层定位

对每个 URL 做：

1. public host GET；
2. public host HEAD；
3. AhrefsBot UA GET；
4. direct origin-gated Worker GET；
5. 查 `item_pages.status/generated_at/url_path`；
6. 查对应 `items` relevant/dedup 状态；
7. 对 `itemPageR2Key()` 做 R2 head；
8. 对照抓取时 Worker version、香港 nginx access/error log 和 Worker log。

分类：

- R2 miss；
- D1 row/id 解析异常；
- 同步 regenerate 超时/异常；
- nginx/upstream 暂态；
- 已修复的历史 5xx；
- sitemap 中已不该存在的 gone/失格 URL。

### Task B2：先测试后修精确根因

**Likely files**

- Modify: `worker/src/seo/item-routes.ts`
- Modify: `worker/src/seo/item-routes.test.ts`
- Modify: `worker/src/seo/item-page-run.ts`
- Modify: `worker/src/seo/item-page-run.test.ts`

必须覆盖：

- R2 miss + regenerate 成功；
- R2 miss + R2 put 失败；
- related query 失败；
- D1 upsert 失败；
- HEAD 不触发写；
- sitemap live 行与 R2 对象不一致；
- 不把真实 gone/not-found 伪装成 200。

首选恢复策略：

- 已有完整 item row、仅持久化失败时：返回内存渲染 HTML，`Cache-Control: no-store`，
  `X-AIFeeds-SEO-Fallback: render`，并后台重试持久化；
- 内容无法安全渲染时：返回显式 `503 Retry-After`，不返回未完成的 200；
- 写 `item_pages=live` 必须发生在 R2 put 成功之后；
- 增加分批只读完整性审计：`item_pages live` 与 R2 key head 对账，发现 miss 后排队重生。

最终选择必须由 B1 的两条真实 URL 决定，不能只按上述嫌疑路径实现。

### Task B3：持续完整性门禁

新增低负载审计，不对公网 34,111 URL 做暴力 crawl：

- 每 5 分钟审计少量新生成/近期更新页面；
- 每天按 cursor 扫一批历史 `item_pages` 并 R2 head；
- 记录 `checked/missing/regenerated/errors/next_cursor`；
- 只有 missing 才 regenerate；
- 超阈值 PushDeer 告警；
- sitemap 计数与 `item_pages status=live` 计数必须一致。

验收：

- 两条 Ahrefs URL 连续 20 次 GET 无 5xx；
- sitemap 中随机分层样本 200；
- 审计完整跑一轮 `missing=0`；
- Ahrefs re-crawl 后 5xx 和 sitemap 5xx 均清零。

## 7. 批次 C：孤岛页与 crawlable 链接图

### Task C1：归档路由纯函数与查询测试

**Files**

- Create: `worker/src/seo/item-archive.ts`
- Create: `worker/src/seo/item-archive.test.ts`

先写失败测试：

- source 只接受 `x|gh|ph|paper|news`；
- month 只接受真实 `YYYY-MM`；
- page 为正整数且有上限；
- 每页固定 100；
- 查询复用 relevant、deleted、dedup、cn_sensitive 和 `item_pages.status=live` gate；
- 排序稳定为 `published_at DESC, id DESC`；
- canonical 对 page 1 不产生重复 `/1`；
- 所有 item link 使用 `item_pages.url_path`；
- 空月/越界页返回 noindex 404；
- 页码、prev/next、source/month link 均为普通 `<a>`。

### Task C2：实现 archive index/source/month 页面

**Files**

- Modify: `worker/src/seo-routes.ts`
- Modify: `worker/src/seo-routes.test.ts`
- Modify: `deploy/nginx/aifeeds-seo-location.conf`
- Modify: `dashboard/public/sw.js`
- Modify: `docs/operations.md`
- Modify: `TODO.md`

新增路由：

```text
/archive/
/archive/:source/
/archive/:source/:yyyy-mm/
/archive/:source/:yyyy-mm/:page
```

页面要求：

- SSR HTML、唯一 h1、self-canonical；
- breadcrumb、源/月/页导航；
- 100 条轻量列表，不加载卡片大图；
- page title/description 含源和月份；
- 归档页不进 item sitemap；单独加入 `sitemap-archive.xml`；
- nginx、Worker bot gate、Service Worker 三层路径同步。

### Task C3：把 item 页相关内容改成稳定时间邻居

**Files**

- Modify: `worker/src/seo/item-page-run.ts`
- Modify: `worker/src/seo/item-page-run.test.ts`
- Modify: `worker/src/seo/item-page.ts`
- Modify: `worker/src/seo/item-page.test.ts`

查询规则：

- 仅同源、live、relevant、非 dedup；
- 当前项之前 3 条 + 之后 3 条；
- 使用 `published_at + id` 稳定排序；
- 不再让所有历史页指向全站最新 5 条；
- item 页增加所属源/月归档链接；
- BreadcrumbList 第二级由 `/?source=...` 改为 SSR source archive。

### Task C4：首页和日报入口

**Files**

- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/index.html`
- Modify: `worker/src/digest/daily-page.ts`
- Modify: 对应 contract/unit tests

要求：

- React footer 增加可见的“内容归档”链接；
- classic 原始 HTML 至少提供 `<noscript>` crawlable 导航；
- waterfall SSR HTML 直接包含归档链接；
- 日报归档和日报页 footer 链接 `/archive/`；
- 不用隐藏文本/隐藏巨型链接列表，不制造 cloaking。

“无出站链接”具体 URL 到手后再决定 `<noscript>` 是否足够；若 Ahrefs 指向的不是首页，按精确页面补链接。

### Task C5：链接图验收工具

新增只读脚本/测试：

- 从 sitemap 取全部 live item URL；
- 从 archive、daily、item adjacency 建边；
- 每个 sitemap item 至少一个普通 HTML 入链；
- 从 `/archive/` 到每个 item 的最大预期深度不超过 4–5；
- 无链接指向 gone/404；
- PH canonical slug 去重后计数一致；
- 不对 production 重复抓全部正文，只抓归档页并用 D1/R2 测试数据验证 item adjacency。

验收目标：

- Ahrefs orphan pages 降到 0 或仅剩明确豁免页面；
- 31,671 个当前无日报入链 URL 均能从 archive 路径到达；
- archive 页自身无孤岛、无 pagination trap。

## 8. 批次 D：Product Hunt GIF 静态首帧

**执行状态（2026-07-17）**：D1–D3 已按 RED→GREEN 完成本地实现；Worker 全量 49 files /
793 tests、Dashboard 258 tests、TypeScript 与 production build 通过。D4 等待该批次在最新
`main` 上完成 staging 小批回填、网络验收和生产发布后关闭。

### Task D1：变体生成 RED tests

**Files**

- Modify: `worker/src/card-image-variant.test.ts`
- Modify: `worker/src/card-image-variant-backfill.test.ts`
- Modify: `worker/src/ph-r2.test.ts`

新增断言：

- `image/gif` 可作为静态卡片变体输入；
- 请求必须带 `anim:false`；
- 输出必须为单帧 WebP；
- 400/800 每档不超过 512 KiB，典型 400 档目标不超过 40 KiB；
- SVG、视频、私网、自域仍拒绝；
- transform 失败时不把 4.28 MB 原 GIF重新作为列表 fallback；
- existing R2 GIF 可从 `src-url` metadata 恢复外部源后回填。

### Task D2：实现静态预览字段

**Files**

- Modify: `worker/src/card-image-variant.ts`
- Modify: `worker/src/card-image-variant-backfill.ts`
- Modify: `worker/src/ph-r2.ts`
- Modify: `worker/src/list-item.ts`

实现：

- GIF 仅允许 `anim:false` 转换；
- 列表 DTO 保留 `card_variants`；
- 对失败的巨大动画写显式 `card_preview_status`，前端据此使用 logo/占位；
- 不删除原 GIF；
- backfill 仍默认 dry-run、CAS 更新、每批最多 25。

### Task D3：前端按意图加载原动画

**Files**

- Modify: `dashboard/src/components/PhCard.tsx`
- Modify: `dashboard/src/components/PhDrawerBody.tsx`
- Modify: `dashboard/src/components/Lightbox.tsx`
- Modify/Create: 对应 unit/contract/Playwright tests

行为：

- Feed：只渲染静态首帧；
- Drawer gallery：初始静态首帧 + “播放动图”；
- 点击后才创建原 GIF `<img>`；
- reduced-motion 下不自动播放；
- error 时回到静态首帧；
- PC/移动端均不在首屏请求原 GIF。

### Task D4：staging/production 数据回填与性能验收

1. staging dry-run inventory；
2. staging 小批写 1–5 条；
3. 验证 WebP 真实尺寸、字节和 R2 metadata；
4. 对已知 GIF 做 classic desktop 5 次 sitespeed.io；
5. 要求原 GIF在未交互前 0 请求，完整页面传输至少减少约 4 MB；
6. production 小批回填已知项；
7. 确认后分批补 PH 主视觉；
8. 原图保留，回滚前端即可恢复。

## 9. 批次 E：移动端请求预算

### Task E1：调度纯函数 RED tests

**Files**

- Modify: `dashboard/src/lib/feedScheduling.ts`
- Modify: `dashboard/src/lib/feedScheduling.test.mjs`
- Modify: `dashboard/src/lib/feedScheduling.integration.contract.test.mjs`

新增纯函数：

- `loadMoreLimitForViewport(width)`：mobile 12、desktop 16；
- `shouldPollFeed({sourceType, feedVisible, documentVisible, online})`；
- `adjacentSourceForIntent(current, direction, liveSources)`；
- intent prefetch 去重和取消。

先让现有“遍历所有 source”的契约失败，再改实现。

### Task E2：删除全量预取，接入 tab 意图

**Files**

- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Feed.tsx`

实现：

- 删除 `prefetchCandidates` 全量 for-loop；
- chip `pointerdown/focus` 只预取目标；
- 横滑 intent 锁定相邻 tab 时预取相邻目标；
- 切换完成后由 mount 复用 single-flight；
- 无交互不请求非当前移动频道；
- PC DeferredFeed 继续按 viewport 挂载，不增加新的全量预取。

### Task E3：收紧 load-more 与 X polling

**Files**

- Modify: `dashboard/src/components/Feed.tsx`
- Modify: `dashboard/e2e/home-performance.spec.ts`
- Modify: `dashboard/e2e/perf-staging-remote.spec.ts`

实现：

- mobile load-more 12；
- desktop load-more 16；
- polling 从永久 `setInterval` 改为可取消的递归 timer；
- `document.hidden`、Feed 不可见、offline 时不调度；
- visibility 恢复后等待完整 30 秒；
- 切走 X tab 立即 cancel；
- 切回时用最新 `lastScrapedAt`。

### Task E4：PC/移动端网络验收

Playwright 至少覆盖：

- mobile 首开只有当前 source 一个 list request；
- 10 秒无交互仍无其它分类请求；
- pointerdown/swipe 只增加相邻 source 一个请求；
- 预取与 mount 只有一个 network flight；
- load-more limit 精确为 12；
- hidden 60 秒 X poll 为 0；
- visible 30 秒后最多 1 次；
- desktop load-more limit 精确为 16；
- Save-Data/3g 不做 intent 预取；
- 返回/Drawer/搜索无回归。

## 10. 批次 F：waterfall 同步、SWR 与 A/B

### Task F1：从最新 main 建新的集成分支

不要直接在已落后 6 个提交的旧 worktree 上部署。

```bash
git fetch origin main
git switch -c codex/waterfall-ssr-main-sync origin/main
git merge --no-ff origin/codex/waterfall-ssr-rum-parallel
```

解决冲突后必须保留：

- 最新 cursor compatibility 修复；
- 批次 D/E 的 GIF 和请求策略；
- 既有 view switch、home-feed 和 telemetry；
- classic 默认行为不变；
- feature flag 默认关闭。

### Task F2：手动 SWR RED tests

**Files**

- Modify: `dashboard/functions/home-runtime.test.mjs`
- Modify: `dashboard/functions/home-runtime.ts`

先写测试：

- fresh cache 直接返回，不请求 HOME_API；
- stale cache 立即返回，并恰好安排一次后台 refresh；
- 并发 stale hit single-flight；
- refresh 成功替换 cache；
- refresh 失败保留 stale；
- stale 超过最大窗口且 refresh 失败时 classic fail-open；
- HEAD 无 body；
- 任意 cookie 不改变公共 cache body；
- response 有 `X-AIFeeds-Home-SSR`、age/freshness 诊断；
- 不依赖原生 `stale-while-revalidate` Cache API 语义。

### Task F3：实现手动 SWR

缓存对象使用长 retention + 自有生成时间：

```text
fresh_ttl = 60s
max_stale = 10min
retention = 24h
```

实现：

- cached response 记录生成时间；
- stale hit 先返回，再 `waitUntil(refresh)`；
- isolate 内刷新 single-flight；
- HOME_API/renderer/template 失败不覆盖好快照；
- stale/fallback 进入 telemetry；
- 仅匿名 public waterfall 使用公共 cache；
- classic、登录态、query override 均不写入公共 body。

### Task F4：可选预热

只有 synthetic 显示各 PoP 首次 miss 仍明显拖慢时才增加：

- GitHub Actions 定时访问台湾/香港可达的 production/perf-staging URL；
- 或在 Worker home-feed 层缓存无个性化数据；
- 明确记录 Cache API PoP-local 限制；
- 预热失败不能影响请求正确性或触发部署。

### Task F5：perf-staging 同条件 classic/waterfall

前置：

- 分支包含最新 main 和 A–E 已合入批次；
- feature flag 默认 off；
- 已知 cursor 400 为 0；
- 已知 4.28 MB GIF 未交互请求为 0；
- SSR cache 单测/构建全绿。

矩阵：

- DebugBear 台湾/香港；
- mobile/desktop；
- classic/waterfall；
- 每格先 5 次，波动 >20% 增到 10 次；
- cold/warm 分开；
- 同一时间窗、同一内容、同一设备配置。

硬门：

- waterfall mobile p75 LCP 相对 classic 不劣化 >10%，目标至少改善 15%；
- CLS ≤0.1；
- 0 个 5xx；
- 0 个 hydration/fallback error；
- 首屏媒体字节不高于 classic；
- classic/waterfall 都能切换，cookie 有界；
- SSR HTML 中有首屏内容、item anchors 和唯一 LCP 候选；
- SEO archive 和 `/i/` 路由不被 Pages Function 截获。

通过后只进入小流量 canary；RUM 仍是上线后观察，不阻塞 staging 代码交付。

## 11. 批次 G：索引质量与保留策略

这批不得与 A–F 同时上线。

输入：

- GSC 按源 90 天索引/展现/点击；
- archive 上线后 2–4 周 crawl 变化；
- Ahrefs orphan、depth、internal backlinks；
- 页面正文字数、重复度、发布时间、源质量。

输出一个明确决策：

- 哪些页面继续 index + sitemap；
- 哪些页面可访问但 noindex；
- 哪些页面应 410；
- X 是否只保留最近 N 月或满足最小正文/互动/质量分；
- sitemap 与 archive 是否跟随同一 eligibility predicate。

任何批量 noindex/410 都要先 staging 抽样、生成影响清单并单独审批。

## 12. 总体验证矩阵

### Worker

```bash
cd worker
npx vitest run src/digest/render.test.ts \
  src/seo/item-body.test.ts \
  src/seo/item-page.test.ts \
  src/seo/item-page-run.test.ts \
  src/seo/item-routes.test.ts \
  src/seo/item-archive.test.ts \
  src/seo-routes.test.ts \
  src/card-image-variant.test.ts \
  src/card-image-variant-backfill.test.ts
npm test
```

### Dashboard

```bash
cd dashboard
node --test src/lib/feedScheduling.test.mjs \
  src/lib/feedScheduling.integration.contract.test.mjs \
  functions/home-runtime.test.mjs
npm run build
npx playwright test e2e/home-performance.spec.ts
```

### SEO 静态验收

- JSON-LD 全字符串 well-formed；
- Rich Results Test 无严重结构化数据错误；
- sitemap index/子片/归档片全部 200；
- sitemap live URL 与 D1/R2 integrity 一致；
- 每个 item 至少一个内部 HTML 入链；
- archive 最大 crawl depth 有界；
- 404/410/noindex 语义正确；
- Googlebot/AhrefsBot UA 与普通 UA 结果一致；
- nginx、Worker、Service Worker 三层路径一致。

### 性能验收

- classic/waterfall 双端 5–10 次 external synthetic；
- 首屏和完整页面 bytes；
- LCP/FCP/TBT/CLS/feed-ready；
- LCP 前媒体请求数；
- GIF 原图在无交互时为 0；
- hidden X poll 为 0；
- 非当前移动频道请求为 0；
- SSR cache fresh/stale/miss/fallback 分布可观测。

## 13. 发布顺序与授权边界

建议生产顺序：

1. A：Unicode Worker + 精确单页重生；
2. A：固定 cutoff 全量快照重灌；
3. B：两条 5xx 精确修复；
4. C：archive/link graph；
5. D：GIF 代码 + 单项 PH 回填；
6. E：移动请求策略；
7. F：waterfall perf-staging；
8. F：小流量 canary；
9. G：若数据支持，再做索引裁剪。

授权应按“发布批次”而不是每一条内部命令拆分：

- 每批先提交一个版本化 change packet，内含精确部署、验证、停止线和回滚；
- 用户一次确认该批后，批内正常测试/发布/验证连续执行；
- 只有触发停止线、扩大数据写范围、修改 DNS/VPS/secret 或进入下一批时才再次确认；
- synthetic 和 RUM 观察不应制造重复生产授权。

## 14. 完成定义

本计划只有在以下条件全部满足时才算完成：

- GSC Unicode 严重问题验证通过；
- 已有 34,111+ item 快照均为 well-formed JSON-LD；
- Ahrefs 两条 5xx 根因已用精确 URL 关闭，sitemap 5xx 为 0；
- sitemap item 全部存在至少一个普通 HTML 入链；
- 无出站链接问题按精确 URL 关闭；
- 4.28 MB GIF 不再进入无交互列表请求；
- 移动端只按当前/相邻意图请求，隐藏页面不轮询；
- waterfall 已包含最新 main、手动 SWR，并完成 perf-staging 同条件对照；
- 代码交付和 staging 验收不等待 RUM；
- 生产 canary 后按 `view_mode × device × region` 继续观察 RUM，达到样本门槛后再确认长期收益。

## 15. 参考资料

- Google Structured Data General Guidelines:
  <https://developers.google.com/search/docs/appearance/structured-data/sd-policies>
- Google Structured Data Introduction:
  <https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data>
- Ahrefs orphan page definition:
  <https://help.ahrefs.com/en/articles/2694175-orphan-page-error-in-site-audit>
- Ahrefs orphan page discovery explanation:
  <https://help.ahrefs.com/en/articles/4756073-why-are-my-pages-being-reported-as-orphan-pages-when-they-are-not>
- Ahrefs 5xx definition:
  <https://help.ahrefs.com/en/articles/2453036-what-does-5xx-page-error-mean-in-site-audit>
- Cloudflare Cache API limitations:
  <https://developers.cloudflare.com/workers/runtime-apis/cache/>
- Cloudflare Cache API PoP-local behavior:
  <https://developers.cloudflare.com/workers/reference/how-the-cache-works/>
- Cloudflare Images `anim:false`:
  <https://developers.cloudflare.com/images/optimization/features/>
