# C 端访问慢根因定位（2026-07-10）

> **状态：已被同日的深入采证报告修正。** 本文是第一轮定位快照；其中“没有证据指向
> D1 查询本身”、`perf_img w=400` 的样本结论，以及移动端覆盖度判断均已被后续证据
> 推翻或收窄。请以
> `docs/reviews/2026-07-10-c-end-performance-deep-dive.md` 为当前结论。

## 结论

当前“非常慢”的主因不是 HTML/JS 文件下载，也没有证据指向 D1 查询本身；慢点主要发生在**首次访问的网络建连与香港中转回源**：用户先与香港 VPS 建立 DNS/TCP/TLS，再由 VPS 回源 Cloudflare Pages；首屏数据又需要对 `api.ai-feeds.com` 建第二条独立连接，并由香港回源 Worker。冷访问中，这些等待远大于实际响应体下载。

这条链路有三个放大器：

1. **冷访问没有 Service Worker 兜底**，所以完整暴露跨境连接与回源开销；回访会被 SW 显著掩盖。
2. **站点壳与首屏数据分属两个域名**，首次内容呈现至少经历两次独立 TLS/代理链路。
3. **PC 同时挂载多个频道，每个频道把前三行媒体设为 eager/high**。这会让首屏出现最多约 21 个高优先级媒体候选，放大弱网下的 LCP 和图片长尾；这是高可信代码风险，但现有 RUM 没记录 LCP 元素/URL，尚不能把它定性为第一根因。

此外，生产域名目前让**所有地区用户都经过香港**。这对大陆平均值曾有改善，但本次样本里非大陆用户的 LCP 显著更差，是明确的地域副作用。

本报告只定位，没有改动性能路径、缓存、路由、图片优先级或埋点。

## 证据链

### 1. 冷导航慢在建连和等首字节，不在下载

近 7 天 RUM 的冷导航切片（`sw=0`、`nav_type=navigate`，样本 52）：

| 阶段 | P50 | P75 | P95 |
|---|---:|---:|---:|
| DNS | 0 ms | 2 ms | 542 ms |
| TCP（字段包含 TLS 总段） | 436 ms | 1,003 ms | 1,906 ms |
| TLS | 114 ms | 503 ms | 1,641 ms |
| requestStart → responseStart | 176 ms | 369 ms | 1,110 ms |
| `responseStart - startTime` | 1,221 ms | 1,896 ms | 4,329 ms |
| response 下载 | 1 ms | 2 ms | 9 ms |
| DOM interactive | 1,254 ms | 1,936 ms | 4,341 ms |
| load | 1,998 ms | 3,068 ms | 6,022 ms |

关键判断：P95 下载只有 9 ms，而同一批冷导航 P95 建连/首字节是秒级。继续压缩约 2–5 KB 的 HTML 或几十 KB 的首屏 JS，不会解决这里的主体等待。

埋点里的 `ttfb` 名称容易误读：实现实际记录的是 `responseStart - startTime`，因此**包含 DNS、TCP 和 TLS**，不是纯后端执行时间；`request` 才更接近请求发出后到首字节的代理/上游等待。实现见 `dashboard/src/lib/telemetry/vitals.ts`。

### 2. 回访快、首次访问慢，指向连接/缓存层而非 React 计算

4G 导航切片：

| 场景 | 样本 | 平均 load | 平均 `responseStart-startTime` | 平均下载 | 平均传输 |
|---|---:|---:|---:|---:|---:|
| 冷导航，`sw=0` | 49 | 3,218 ms | 2,311 ms | 11 ms | 2 KB |
| SW 控制的回访 | 45 | 923 ms | 303 ms | 3 ms | 0 KB |

同一应用逻辑在 SW 命中后快约 2.3 秒，说明最主要的差异发生在导航网络路径。Service Worker 当前会直接返回缓存壳，运维文档也记录过回访导航约 22 ms/0 字节；这解释了为什么老用户偶尔觉得快，而新用户、无痕窗口、刚清缓存或 SW 未接管的访问非常慢。

按日看，7 月 9 日平均 load 3,251 ms、首字节口径 2,318 ms；7 月 10 日分别回落到 1,417 ms、569 ms。波动也集中在首字节之前，而不是下载阶段，符合线路/代理/上游抖动，而不是固定 bundle 体积或稳定的客户端解析成本。

### 3. 当前架构天然存在两段代理和两条首屏连接

生产链路在 `docs/operations.md` 中已明确：

```text
用户 → 香港 VPS
     → Cloudflare Pages（前端壳）
     → Cloudflare Worker（API）
```

`ai-feeds.com`、`api.ai-feeds.com` 都解析到香港 VPS，前者回源 Pages，后者回源 Worker。首页还会在 HTML 中 preconnect 并立即预取 `https://api.ai-feeds.com/api/items?...`，所以首屏内容依赖第二个 origin 的独立连接；相关代码见 `dashboard/index.html` 和 `dashboard/src/lib/apiBase.ts`。

2026-07-10 的现场 curl 快照（只作链路旁证，不代替用户 RUM）：

- `ai-feeds.com` 首页：TLS 约 0.94–1.26 s，TTFB 约 1.34–1.62 s，响应体约 2–5 KB。
- 直连 `xlist-dashboard.pages.dev`：TTFB 约 1.51 s。
- `api.ai-feeds.com/api/items`：TLS 约 1.09 s，TTFB 约 1.95 s，总耗时约 2.23 s，响应约 68 KB。

这说明香港代理并不是唯一慢点：当前测试网络到 Pages 源本身也慢；但生产架构会把“用户→香港”和“香港→CF 源”串在一次请求里，并让 API 再走一遍独立域名链路。对冷访问而言，二者共同构成可见等待。

### 4. LCP 慢于壳加载，首屏数据/媒体是第二阶段瓶颈

近 7 天整体指标：

| 指标 | P50 | P75 | P95 |
|---|---:|---:|---:|
| FCP（n=119） | 936 ms | 1,796 ms | 5,460 ms |
| LCP（n=82） | 2,892 ms | 5,480 ms | 9,228 ms |
| load（n=127） | 1,197 ms | 2,186 ms | 5,166 ms |

LCP 的 P75 比 load 晚约 3.3 秒，说明“页面壳加载完成”不等于“主要内容出现”。首页数据预取仍依赖 API；数据到达后，卡片媒体才有机会参与 LCP。

代码中 PC 会渲染所有可用频道；`Feed.tsx` 对每列前三行传 `eager=true`，各卡片进一步设置 `loading="eager"` 和 `fetchPriority="high"`。当前约 7 个有效频道时，浏览器可能同时面对约 21 个高优先级媒体请求。高优先级本应留给极少数确定的 LCP 候选，这里的列级局部策略在 PC 全局组合后失控。

图片 RUM 也存在明显长尾：

| 图片宽度 | 样本 | P50 | P75 | P95 | 最大值 |
|---|---:|---:|---:|---:|---:|
| `w=80` | 287 | 700 ms | 4,973 ms | 15,423 ms | 157,140 ms |
| `w=400` | 625 | 8 ms | 17 ms | 989 ms | 156,409 ms |

`w=80` 的头像/小图长尾尤其严重，`w=400` 的主体封面多数很快但仍有极端尾部。需要注意：跨域 Resource Timing 未必暴露 transfer/decoded size，现有 `cached` 字段在缺少 `Timing-Allow-Origin` 的响应上不可靠，不能据此计算真实缓存命中率。

### 5. 所有地区强制走香港，非大陆样本明显更差

4G LCP 按现有 `mainland_hint` 切片：

| 用户提示 | 样本 | 平均 | P50 | P75 | P95 |
|---|---:|---:|---:|---:|---:|
| 大陆时区 | 60 | 3,107 ms | 2,616 ms | 4,964 ms | 8,152 ms |
| 非大陆时区 | 10 | 10,622 ms | 9,228 ms | 10,504 ms | 39,584 ms |

样本偏小，`mainland_hint` 也只是时区提示而非真实地理位置；但差距足够大，且与“所有用户含海外都走香港”的当前运维设计一致。可以确认它至少是非大陆体验的重要放大器。

## 根因分级

### 已证实

1. 冷导航的主要时间消耗是 DNS/TCP/TLS/首字节等待，响应体下载只占极小部分。
2. SW 回访显著快于未接管的首次访问。
3. 首屏壳和数据位于两个生产 origin，均经香港 VPS 再回源 Cloudflare。
4. LCP 明显晚于 load，慢体验不只发生在 HTML 壳，还发生在数据/媒体阶段。
5. 非大陆样本在当前全量香港路由下显著更慢。

### 强推断，尚缺最后一跳证据

1. PC “每列前三张 high priority”造成跨列资源竞争，推高 LCP/图片尾部。
2. 7 月 9 日的异常主要来自线路、VPS 或上游回源抖动，而非前端包体；现有 RUM 能定位到首字节之前，但不能区分 VPS 入站、VPS 排队和 HK→CF 上游三者。

### 目前不能下结论

- 不能仅凭现有数据认定 D1 SQL 慢；客户端 RUM没有 API 内部分段。
- 不能认定 React 渲染或 JavaScript 解析是主因；当前数据反而显示它们不是第一瓶颈。
- 不能用现有 `perf_img.cached` 判断图片缓存命中，因为 TAO/跨域字段可能被浏览器隐藏。

## 下一轮建议采证（未实施）

按优先级建议先补证据，再决定改法：

1. 导航/API 响应增加 `Server-Timing`：至少拆 `vps_queue`、`upstream_connect`、`upstream_header`、Worker handler/D1；这样能把现有 `request` 的 176–1,110 ms 再拆开。
2. RUM 记录 LCP 条目的安全化元素类型、资源 origin/path 类别、所在频道和是否 eager，不记录用户内容文本。
3. 记录首个 `/api/items` 的 DNS/connect/TTFB/response 与数据可渲染时间，补齐“壳快、内容慢”的第二条瀑布。
4. 为图片响应统一核对 `Timing-Allow-Origin`，再统计可信的 cache hit/transfer size。
5. 做受控对照：香港生产链路、直连 Pages/Worker、按地域分流三组；按大陆运营商与海外区域看 P50/P75/P95，而不是只看一次 curl。

这些证据拿齐后，再讨论是优先做地域路由、连接复用/同源、VPS/upstream 调整，还是收紧 PC 媒体优先级。现在直接改其中任一项，都可能只改善某一人群并恶化另一人群。
