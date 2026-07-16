# C 端访问性能深入采证与根因分析（2026-07-10）

## 执行摘要

“用户访问非常慢”是真问题，但不是一个单点故障，而是两段关键路径串联：

```text
冷页面壳
用户 → 香港 VPS（首次 TLS/RTT）→ 已缓存的 HTML
                         │
                         └─ 主因：冷连接，下载本身几乎不耗时

首屏内容
HTML → 第二个 API origin（再次 TLS）→ sources/stats 元数据 gate
     → 7 个频道并发查询/大 JSON → 多 origin 图片与错误的 high priority
                         │
                         └─ 主因：人为串行 gate + 请求/数据/媒体扇出
```

根因按置信度和影响排序：

1. **冷访问的一方关键路径必付两次独立的慢 TLS，且主站/API 等受控域先经过香港再回源
   Cloudflare。** 首页
   `ai-feeds.com` 与首屏数据 `api.ai-feeds.com` 证书和 HTTP/2 连接不能复用。本机冷连接
   实测首页 TLS 中位约 0.94 秒，API TLS 中位约 0.94 秒；API 经香港比同客户端直连
   Worker 多约 0.7 秒（仅代表本客户端同机对照，不外推为所有用户常数）。首页 HTML 已在
   nginx 命中缓存；本轮 VPS 采样窗口未见资源饱和，暂不列为优先根因。
2. **Feed 被 `/api/sources`/`/api/stats` 人为挡住。** React 首次把所有 Feed 视为
   placeholder，必须等任一元数据结果回来才开始取数/消费 HTML 中已发出的 X 流预取。
   生产现场这两个接口 TTFB 约 2.4–3.1 秒。这是目前最靠前、因果最直接的应用层阻塞。
3. **元数据 gate 打开后，PC 立刻扇出所有频道。** 7 个 live 列即使在首屏下方也会各取
   30 条；后台 2.5 秒预取与初次请求之间没有 in-flight 去重，特定时序下可再重复一轮。
4. **列表查询和载荷本身确实慢且过宽。** 不同频道现场自报 D1 查询约 0.22–1.41 秒，
   压缩传输合计约 774 KiB；GitHub 单列约 395 KiB gzip。列表携带 README、HF 全量
   `deep_analysis`、新闻正文元数据等详情抽屉专用字段。第一轮报告关于“没有 D1 证据”
   的判断必须撤回：D1 不是冷导航第一根因，却是内容阶段的已证实瓶颈之一。
5. **媒体调度继续放大 LCP。** 代码按“每列前三张”分配 eager/high，PC 当前真实样本
   约 13 张 high，其中多数位于首屏下方；理论上可到 21–24 张。`/r/` R2 图片传入
   `w=400` 实际仍返回原图，HF/活动还存在直连第三方 high 图片，字体也可能在 LCP 前
   开始下载。
6. **性能面板混入了 owner/测速/批量深链流量，放大了极端值。** 但清洗后大陆 4G
   LCP P75 仍约 4.46 秒，冷导航 P75 仍约 1.90 秒首字节口径，所以不能把慢全归因于
   “脏数据”。

本轮只做了 `SELECT`/`EXPLAIN`、HTTP HEAD/GET、VPS 只读检查和代码追踪，没有修改生产
配置、服务或数据，也没有实施性能优化。

## 1. 采证口径与边界

### 1.1 RUM 清洗

分析窗口为近 14 天，并额外执行以下清洗：

- 排除 owner 账号关联 device 与已知 owner device；
- 排除本轮 `codex_perf_probe` 路径；
- Nav/LCP/图片按 `device_id + session_token_hash + page_path` 配对，时间差限制 120 秒；
- 相关性做了 `≤30 秒` 与剔除 `>15 秒` 极端值的敏感性验证；
- 分位数使用 nearest-rank，而不是平均数替代尾部。

清洗后的 14 天样本：Nav 197、FCP 189、LCP 127、图片 413。原始图片样本为 1,857，
清洗后只剩 413，说明此前图片表被 owner 访问严重污染。

现有 dashboard 的 `metricLoadPerf/pctl` 只使用 `NOT_OWNER_SQL`，未使用更严格的流量质量
口径；已有 `IS_REAL_USER_SQL` 又把“总跨度 >5 秒”也当真人，仍可能误收慢测速与自动深链。
因此本文同时报告全量清洗样本、冷/暖切片和样本边界，不把一个大盘数字当唯一事实。

### 1.2 现场网络采样

- 同一客户端对首页/API 做 10 次冷连接和连接复用对照；
- 在香港 VPS 内分别请求 Pages、Worker 和本机 nginx，拆开“用户→香港”与“香港→源”；
- 检查 nginx 响应头、证书 SAN、运行负载、内存、进程、错误日志和近 5,000 条访问状态；
- 生产 API 响应已有 `query_time_ms`，用于区分 D1 查询与客户端端到端耗时。

本机网络对 `workers.dev` 存在异常解析，所以“本机直连 Worker”只作同机相对对照；香港
VPS 侧解析正常，其回源分段数据可信度更高。

### 1.3 双端覆盖边界

本轮代码路径同时审查了 PC 和移动端，但线上 RUM 不足以做双端量化比较：

| 端 | Nav | FCP | LCP |
|---|---:|---:|---:|
| desktop | 191 | 184 | 126 |
| mobile | 6 | 5 | 1 |

因此本文的线上分位主要代表 PC。移动端只能确认代码风险：首频道同样受 metadata gate，
且 2.5 秒后会并发预取其余频道；不能声称移动端比 PC 快或慢。方案必须包含移动真机/定向
合成样本，不能把 desktop 结论直接外推。

## 2. 证据链

### 2.1 冷页面壳：慢在连接与首字节，不在 HTML 下载

14 天冷导航（`sw=0`、`nav_type=navigate`，n=106）：

| 阶段 | P50 | P75 | P95 |
|---|---:|---:|---:|
| DNS | 0 ms | 0 ms | 508 ms |
| TCP（该字段含 TLS 总段） | 291 ms | 1,056 ms | 5,181 ms |
| TLS | 88 ms | 395 ms | 1,779 ms |
| requestStart → responseStart | 99 ms | 226 ms | 625 ms |
| `responseStart - startTime` | 1,041 ms | 1,896 ms | 7,343 ms |
| response 下载 | 1 ms | 2 ms | 9 ms |
| load | 1,804 ms | 3,214 ms | 9,396 ms |

首页现场 10 次冷连接中位约 TLS 0.944 秒、TTFB 1.312 秒、total 1.32 秒，且根路径连续
命中 `X-Cache-Status: HIT/STALE`。从香港 VPS 到 Pages 的 fresh TTFB 中位仅约 90 ms。
所以继续压缩数 KB 的 HTML 不是解法；当前主要成本是客户端到香港的第一次连接。

SW 控制的回访（n=70）TTFB P75 39 ms、load P75 511 ms，证明壳缓存能绕过绝大部分冷
路径。但 SW 在 `load` 后才注册，不能帮助首次访问。

### 2.2 两个 origin 让首屏再付一次 TLS

首屏壳和数据分别来自：

```text
https://ai-feeds.com/          证书：ai-feeds.com + www
https://api.ai-feeds.com/...   证书：api.ai-feeds.com
```

二者不能复用同一 HTTP/2 连接。现场复用收益：

| 请求 | 首次连接 TTFB | 同连接后续 TTFB |
|---|---:|---:|
| 首页 | 约 1.40 s | 约 0.356 s |
| API | 约 1.56 s | 约 0.63–0.72 s |

70 KB X API 的 10 次中位：经香港 TTFB 1.632 秒、total 1.911 秒；同一客户端直连
Worker TTFB 0.925 秒、total 1.226 秒。本客户端样本中的差值约 0.7 秒，其中约 0.29 秒
来自前段 TLS 差，约 0.4 秒来自先到香港再回源的串行等待。由于本机 `workers.dev` 解析
异常，这只是同机方向性对照，不能当作全体用户的固定香港惩罚。

从 VPS 内部测同一真实数据：直连 Worker fresh TTFB 中位约 316 ms，经本机 nginx 约
330 ms，nginx 自身在该采样窗口只增加约 13–20 ms。VPS 当时 load average 为 0，约
502 MiB 可用内存，nginx RSS 约 13 MiB，近 24 小时日志未见 error。本轮没有发现资源
饱和证据，但这些单时点/短窗口数据不能排除历史尖峰；结论只是“暂不优先升级 VPS”。

### 2.3 应用关键路径被 metadata gate 人为串行化

`dashboard/src/App.tsx` 首帧并发请求 `/api/sources` 和 `/api/stats`，但 `liveSourceTypes`
初始为空，于是所有 Feed 收到 `placeholder=true`；`dashboard/src/components/Feed.tsx` 在该
状态直接跳过 initial fetch。即使 `dashboard/index.html` 已经发出 X 流预取，Feed 也要等
元数据回来才消费结果。

现场响应：

- `/api/sources` TTFB 约 2.63 秒，返回 41 行、约 47 KB identity/13 KB gzip；服务端
  `s.*` 后又为每条 source 跑 correlated COUNT；
- `/api/stats` 仅约 204 B gzip，却串行执行 5 个 COUNT/GROUP/MAX，TTFB 约
  2.43–3.06 秒；
- C 端实际只用“哪些 source_type 有数据”和 X 列名称。

这解释了为什么“HTML 预取已经发了”仍可能长时间只看见骨架：网络请求早发不等于 UI
可以消费，元数据被错误地放进了首屏控制依赖。

### 2.4 gate 打开后，PC 请求和数据扇出

PC 固定 `filter=all`，8 列全 mount，其中当前约 7 列 live；lg 布局首行只显示 X、新闻、
PH，但第二/三行的 GitHub、HF、活动、ClawHub 仍立即各取 30 条。

冷启动可能同时包含：

1. HTML 内的 X list prefetch；
2. sources、stats、auth/me；
3. metadata 返回后的其余 6 个 Feed GET；
4. 跨域公开 GET 因无条件 `X-Device-Id` 产生的首次 OPTIONS；
5. 2.5 秒后台预取触发的重复 GET。

后台预取只检查“已完成缓存”，没有 in-flight Map。若元数据恰在约 2.5 秒返回，Feed 请求
刚开始、缓存尚未写入，预取会对相同频道再发一次 `limit=12`。这是确定的竞态路径；其线上
发生率需要新 waterfall 埋点量化。

同一轮 PC 首页 waterfall 中，七列请求参数均为 `limit=30`（实际返回数可少于 30，X 还可能
补 thread siblings）：未压缩 JSON 合计约 1.97 MB，浏览器压缩传输合计约 792,275 B
（774 KiB）。该轮保留了总量、D1 时间和三个最大响应的分项：GitHub 约 1.06 MB identity /
394.8 KiB gzip、新闻约 280 KiB / 110 KiB gzip、HF 约 301 KiB / 199 KiB gzip；其余四列
合计构成剩余量。它是一次真实 waterfall 基线，不是“任意时刻固定等于 774 KiB”的契约，
实施前须由自动化再抓一轮保存原始 HAR。

| 频道（同一轮 `limit=30`） | 已保留响应体信息 | 自报 D1 query_time_ms |
|---|---:|---:|
| X | 计入总量，未单独保留 gzip | 0.297 s |
| 新闻&播客 | 约 280 KiB identity / 110 KiB gzip | 0.902 s |
| Product Hunt | 计入总量，未单独保留 gzip | 0.935 s |
| GitHub | 30 条约 1.06 MB identity / 395 KB gzip | 0.934 s |
| HF Paper | 约 301 KiB identity / 199 KiB gzip | 1.204 s |
| 活动 | 计入总量，未单独保留 gzip | 0.536 s |
| ClawHub | 计入总量，未单独保留 gzip | 1.172 s |

另做了一轮**顺序 `limit=12` 字段审计**，用于定位 JSON 内部组成，不与上面的 774 KiB
waterfall 混算。identity 大小分别为 X 27,718 B、新闻 141,278 B、PH 55,403 B、GitHub
504,510 B、HF 214,632 B、活动 30,739 B、ClawHub 28,131 B，合计 1,002,411 B；对应
D1 查询约 0.223/1.017/0.627/0.870/0.620/0.271/1.413 秒。

这些时间并非全部端到端时间，而是 Worker 内 D1 `.all()` 的测量；因此足以证明内容阶段有
查询瓶颈，但不能解释首页第一次 TLS。

### 2.5 七个默认 SQL 全部出现临时排序，但风险不等量

按当前生产变量和首页 `limit=30` 还原七列默认 SQL，生产 D1 的 `EXPLAIN QUERY PLAN` 均
出现 `USE TEMP B-TREE FOR ORDER BY`：

| 频道 | WHERE 后候选行 | 主要计划 | 判断 |
|---|---:|---|---|
| X | 552 | `idx_items_relevant` + temp B-tree | 候选较小，不足以单独解释秒级 |
| HF Paper | 119 | `idx_items_relevant` + temp B-tree | 同上 |
| 新闻&播客 | 955 | `idx_items_feed_src_pub` + temp B-tree | 动态 FEED_RANK 逐行计算，次级风险 |
| GitHub | 178 | `idx_items_feed_src_pub` + temp B-tree | JSON date/rank 无匹配索引，候选较小 |
| ClawHub all | 16,119 | `idx_items_feed_src_pub` + temp B-tree | 最大明确 SQL 风险 |
| Product Hunt | 880 | 两层 coroutine/scan + 两次 temp B-tree | 窗口函数和外层排序双重成本 |
| 活动默认过滤 | 35 | `idx_items_feed_src_pub` + temp B-tree | 当前候选很小 |

ClawHub 各分类仍需排序约 401–8,412 行，而后台 `prefetchChannels()` 不传 category，直接走
all=16,119 行。它与 Product Hunt、动态新闻评分是第一批应针对性优化的 SQL；X/HF/GH/活动
虽同样有 temp sort，不应仅看到同一 plan 文案就给它们加同等优先级。

migration 020/022 曾让旧 ORDER BY 不再临时排序，但当前通用排序首键已经变成：

```sql
content_translated IS NULL
AND json_extract(extra, '$.title_zh') IS NULL
AND json_extract(extra, '$.excerpt_zh') IS NULL
AND json_extract(extra, '$.ai_summary_zh') IS NULL
```

现有索引只保存 `(content_translated IS NULL)`，两者不等价，所以优化器无法用该索引同时
提供新顺序。这个证据确认“查询计划有退化”，但索引仍应在 list projection 和请求调度之后
按实际 `Server-Timing` 排序实施，避免为 35–552 行的小池盲目增加写放大。

### 2.6 列表 DTO 泄漏详情字段

`handleItems` 及各 source handler 使用 `SELECT *`，随后 `parseItemRow()` 才在 Worker 内删
少量 key。这既把大字段从 D1 拉进 Worker，也让遗漏 key 直接出现在网络响应。

12 条样本字段占用：

- GitHub 504,510 B：`extra.readme_excerpt` 合计约 250,096 字符、
  `readme_translated` 145,928、`recent_commits` 18,368。卡片读取完整 README 只为正则找
  第一张图；全文和 commits 实际是详情抽屉数据。
- 新闻&播客 141,279 B：`extra.excerpt` 约 55,220 字符、`extra.body` 约 32,184。
  `LIST_HEAVY_EXTRA_KEYS` 删除的是 `body_markdown`，没有删除实际的大 `body` 对象，也没有
  截断 `extra.excerpt`。
- HF 默认前端排序 214,632 B：`extra.deep_analysis` 约 63,949 字符；卡片只使用其中
  `tldr`，其余维度是抽屉/SEO 数据。剥离表写的是 `llm_analysis`，不是实际字段名
  `deep_analysis`。

仅补删除 key 能立刻降低 JSON 序列化与下载，但不能降低 `SELECT *` 的 D1 行读取成本。
最终需要 list 专用 SQL projection/DTO；详情继续使用 `/api/items/:id` 完整读取。

### 2.7 媒体优先级和尺寸错误

`Feed.tsx` 用局部行号 `idx < 3` 决定 eager/high。组合到 7 列后，生产首三项真实样本约
13 张 high，约 8 张来自首屏下方列；理论最大约 21，X 同时带主媒体和 LinkCard 时可更高。
浏览器的 `fetchPriority=high` 是全页面资源竞争关系，不是“每列各有三张额度”。

此外：

- `proxyImg('/r/...', 400)` 先把路径变成 API 绝对 URL，但 API host 不在代理 allowlist，
  最终返回原 `/r/` 原图；现场一张 2280×1452 图片为 104,577 B，而 UI 约 360–400 px；
- HF 首三项可能直连 `cdn-thumbnails.huggingface.co`，活动图直连
  `wimg.huodongxing.com`，各自增加 origin/TLS；
- 当前 `perf_img` 只观察 `/img?`，漏掉主流 `/r/` 和第三方图片，所以不能用旧样本证明
  主图整体很快；
- 字体虽在 `window.load` 后注入，但 load P75 约 2.19 秒、LCP P75 约 5.08–6.10 秒，
  约 38 个字体分块仍可能在 LCP 前开始竞争。

RUM 中 LCP 与同会话采样图片只有弱相关（剔除极端值后与 max image r≈0.159、与 average
r≈0.226），且只有 64/127 个 LCP 会话有图片样本。结论应是“代码层资源竞争明确、是高
可信放大器”，而不是“已证明某张图就是第一根因”。必须补 LCP 元素/资源类别后再归因。

### 2.8 SW 只解决壳，不能解决内容阶段

Nav/LCP 成功配对 114/127：

| 切片 | LCP P50/P75/P95 | TTFB P50/P75/P95 | LCP - load P50/P75/P95 |
|---|---|---|---|
| sw=0, n=54 | 2.89/5.08/15.45 s | 1.08/1.78/7.34 s | 0.26/1.92/5.89 s |
| sw=1, n=60 | 1.93/4.04/6.15 s | 0.02/0.03/0.42 s | 1.75/3.23/5.61 s |

即使壳由 SW 几十毫秒返回，P75 仍有约 3.23 秒发生在 load 之后。这与 metadata gate、
频道查询/载荷和媒体阶段完全吻合。

### 2.9 地域结论需要降级表达

非大陆时区 + 4G 冷导航 n=27 的 TTFB P75 约 5.45 秒，LCP n=15 的 P75 约 15.45 秒，
明显比大陆差；架构上所有海外流量绕香港也支持这个方向。但非大陆样本几乎全是一击冷访，
7 月 9 日 01:00 BJT 还出现多台相似 Linux viewport 批量打开两条深链，疑似共享链接/自动化。

因此“全球强制香港对海外有副作用”是中等置信，“海外真实用户精确慢多少”尚不能从现有
样本得出。后续必须用 Worker 侧 country/colo 和 traffic-quality cohort，而不是客户端时区。

## 3. 根因树与排除项

### 已证实

1. 冷壳慢主要是客户端到香港的连接/首字节；HTML 下载不是主因，本轮 VPS 采样未见资源饱和。
2. 首页与 API 两个 origin 导致首屏两次独立 TLS。
3. sources/stats 把可显示的 Feed 人为串行阻塞 2 秒以上。
4. PC 在 gate 后加载全部频道，并存在预取 in-flight 竞态。
5. 部分列表 D1 查询为 0.6–1.4 秒，且响应 DTO 夹带大量抽屉专用字段。
6. PC 将首屏下方媒体错误标为 high；`/r/` 宽度参数实际没有生效。
7. SW 只能显著改善壳，暖访问的内容阶段仍慢。
8. 当前性能面板的流量质量口径不够可靠，移动端样本不足。

### 强推断，需新埋点确认收益占比

1. 错误的 high priority、原图过取和字体下载共同抬高 LCP 尾部。
2. 非大陆用户被香港中转显著放大。
3. 2.5 秒预取竞态在部分冷访问重复了相同列表请求。

### 已排除或不应优先

- 不应先升级 VPS：当前采样窗口没有 CPU、内存、连接数或错误日志饱和证据；先补持续观测，
  历史尖峰仍保留为待证伪假设。
- 不应把精力先放在 HTML/JS 压缩：首屏静态 JS+CSS gzip 约 144 KB，下载不是主要等待。
- 不应只靠 SW：它不帮助新用户，也不解决暖态 LCP 后段。
- 不应无证据先做全球路由切换：大陆与海外需要分 cohort/A-B。
- 不应只在 `parseItemRow` 多删几个 key 就宣称 SQL 已优化：`SELECT *` 的 D1 成本仍在。

## 4. 优化策略与优先级

### P0：先修最靠前的应用关键路径，同时补可归因观测

1. Feed 用静态已知 live channel 乐观启动；sources/stats 只在后台校准，不再控制首流是否取数。
2. 新增 API Resource Timing、`feed_ready`、安全化 LCP 元素/资源类别/频道，Worker 返回
   `Server-Timing`；nginx 日志加入 upstream connect/header/response。
3. 管理面板同时展示 `all-clean` 与 `engaged` cohort，显式标记 synthetic probe；服务端记录
   country/colo 粗粒度分组。

### P1：控制首屏扇出和载荷

1. PC 只 mount 首行可见三列，下面列接近 viewport 才 mount；移动端只加载 active channel。
2. 首批从 30 条降到约 12 条；Feed 与预取共享 in-flight Map。
3. 移动端后台预取改为 LCP/交互之后、串行且尊重 saveData/慢网；取消 2.5 秒并发 shotgun。
4. 全页最多 1 张 `fetchPriority=high`，其他真正可见候选最多 eager/auto；下方全部 lazy。
5. list DTO 白名单化：GitHub 预存 `cover_url`、HF 只带 `deep_analysis.tldr`、新闻去掉
   `body` 并截断 fallback excerpt；详情抽屉继续 full fetch。

### P2：消除第二次首屏 TLS，优化查询和图片

1. staging 先做主域 `/api/*` 同源代理实验，生产 dashboard 使用相对 API base；验证登录 cookie、
   分享、SEO、CORS 和回滚后再放量。
2. 对 projection 后仍慢的默认 SQL 做精确 `EXPLAIN QUERY PLAN`，只为确认存在 temp B-tree/
   scan 的查询补表达式索引或物化排序字段。
3. 为 `/r/` 建真正的卡片尺寸变体或等效 resize 路径，统一 HF/活动图片到受控链路；补
   `srcset`、宽高和 TAO。
4. 字体延后到首次交互结束 LCP，或 load 后更长 idle 窗口；saveData/慢网不主动下载。

### P3：证据驱动的边缘拓扑调整

1. nginx upstream HTTP/1.1/keepalive 先在 staging 验证；预期稳定收益约 20–30 ms，不包装成
   秒级修复。
2. 如果 projection/索引后 D1 仍是主要段，为公开 list 做 10–30 秒微缓存实验，严格限制 GET、
   public endpoint 和 cache key，避免 Cookie/Origin 污染。
3. 收集真实 country/colo 后做地域路由 A/B：大陆保留香港候选，海外直达 Cloudflare 候选；
   按地区分别看 P75/P95，而不是用全球平均拍板。

## 5. 成功指标与停止线

发布前先记录 7 天基线；每一阶段单独灰度，至少观察 48 小时且每个主 cohort ≥100 LCP
样本（移动端不足时用真机合成补功能，不用合成数据冒充 RUM）：

| 指标 | 当前基线 | 第一阶段目标 |
|---|---:|---:|
| desktop all-clean LCP P75（14d） | 5.08 s | ≤3.5 s |
| warm SW LCP P75 | 4.04 s | ≤2.5 s |
| cold nav `responseStart-startTime` P75 | 1.90 s | 同源阶段后不恶化；地域阶段目标 ≤1.5 s |
| 首个可用 Feed (`feed_ready`) P75 | 尚无 | ≤2.5 s，warm ≤1.5 s |
| LCP 前列表压缩传输 | 单轮七列 `limit=30` waterfall 约 774 KiB | PC ≤250 KiB；mobile ≤100 KiB |
| GitHub 30 条 gzip | 约 395 KiB | ≤80 KiB |
| 全页 `fetchPriority=high` 图片 | 约 13，理论 21–24 | ≤1 |
| 首屏下方 list 请求 | 4 个以上 | LCP 前为 0 |

停止/回滚条件：错误率增加 >0.5 个百分点、登录/分享/深链回归、LCP P75 恶化 >10%、
移动端 active feed 出现空白、或缓存返回个性化数据。任何条件触发即回滚当前单阶段，不把多项
改动一起推上去后再猜哪项有问题。

## 6. 本轮仍缺的最后证据

1. LCP 的安全化元素、频道和资源类别；
2. API 端到端 Resource Timing 与 Worker/nginx 分段；
3. 默认 7 个列表 SQL 在生产数据上的精确 EXPLAIN 与 projection 后复测；
4. 移动端真机 RUM/trace；
5. 服务端 country/colo 和可靠的 synthetic/engaged cohort；
6. `/r/` 图片尺寸分布、实际传输字节与 LCP 命中率。

这些缺口不会阻止 P0/P1 中已证实根因的修复，但会决定 P2/P3 内部的最终排序。
