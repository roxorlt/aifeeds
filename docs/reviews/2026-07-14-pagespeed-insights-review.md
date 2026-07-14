# 2026-07-14 首页 PageSpeed Insights 复核

状态：`CURRENT PRODUCTION BASELINE / PLAN INPUT`

## 1. 结论

Fable 对“首页初始 HTML 没有内容、首图不能被浏览器提前发现”和“图片尺寸浪费”的判断方向正确，
但它引用的数值不是用户提供的当前 PageSpeed 报告。当前首页并非只有一个 SSR 问题：移动端还同时受
React 执行、布局、首屏媒体竞争和总下载量影响。

因此执行顺序保持为：

1. 先发布当前性能分支已经实现的同源 API、紧凑列表 DTO、全局单一 LCP 图片优先级、延迟下方频道、
   响应式图片和遥测；
2. 发布前补齐本报告暴露的可独立修复项；
3. 用同内容 staging Lighthouse/浏览器 trace 验证移动端 CPU 和 LCP；
4. 首页 SSR/流式首屏并入后续瀑布流改版设计，不阻塞本轮发布，也不能用来替代本轮媒体与 CPU 优化。

## 2. 当前报告基线

来源：用户提供的同一次 PageSpeed Insights 分析。

- [移动端报告](https://pagespeed.web.dev/analysis/https-ai-feeds-com/9t93znqzj4?utm_source=search_console&form_factor=mobile&hl=zh_CN)
- [桌面端报告](https://pagespeed.web.dev/analysis/https-ai-feeds-com/9t93znqzj4?utm_source=search_console&form_factor=desktop&hl=zh_CN)

| 指标 | 移动端 | 桌面端 |
|---|---:|---:|
| Performance | 49 | 72 |
| Accessibility | 81 | 80 |
| Best Practices | 96 | 96 |
| SEO | 92 | 100 |
| FCP | 1.7 s | 0.4 s |
| LCP | 13.0 s | 3.0 s |
| TBT | 550 ms | 120 ms |
| CLS | 0.087 | 0.033 |
| Speed Index | 12.4 s | 6.3 s |
| 总传输量 | 10,345 KiB | 21,471 KiB |
| 主线程工作 | 8.3 s | 4.2 s |

移动端主线程中约 2.91 秒用于脚本执行、2.66 秒用于样式和布局；React vendor 的脚本执行约
2.63 秒。桌面端主要成本是约 1.59 秒样式和布局。报告中的 LCP breakdown 与顶层 LCP 数值不自洽，
本评审只把顶层 Lighthouse 指标作为基线，不使用 breakdown 的分项时长做精确归因。

## 3. 与 Fable 分析的差异

| Fable 表述 | 当前报告/现场证据 | 评审 |
|---|---|---|
| 移动 LCP 3.274 s | 当前链接为约 13.0 s | 数值不对应当前报告 |
| 桌面 LCP 5.788 s | 当前链接为约 3.0 s | 数值不对应当前报告 |
| SEO 100 | 移动 SEO 92，存在两个不可抓取链接 | 需单独修复移动端锚点 |
| 总资源约 2.4 MB | 移动 10.3 MiB，桌面 21.5 MiB | 严重低估媒体竞争 |
| 主 JS 约 14 KB，JS 不是问题 | 14 KB 只是入口；当前初始 JS gzip 约 132.6 KB，移动 React 执行约 2.63 s | JS/水合 CPU 是移动端验收风险 |
| 三套字体阻塞首屏 | 生产 HTML 已在 load/idle 后加载字体 CSS | 仍有后加载流量，但不是当前首要 LCP 根因 |
| 首页 CSR 是唯一决定因素 | 首图不可从 HTML 发现为真；同时存在 CPU、布局、媒体数量和尺寸问题 | 应按多因素处理 |
| `/i` 页 LCP 111 ms | 提供的 PSI 只测 `/`；抽样 `/i` 确有服务端正文，但当前区域 curl TTFB 约 2.09 s | 架构判断可参考，111 ms 未被本次证据证明 |

## 4. 已确认根因

### 4.1 首屏内容和 LCP 图片发现过晚

生产首页 HTML 约 5.1 KB，正文只有空的 `<div id="root"></div>`，没有卡片或图片；PageSpeed 在双端均
记录 LCP 资源 `requestDiscoverable=false`。浏览器必须等待入口脚本、API 返回和 React 提交后才知道首图。
移动端报告还显示首图没有 `fetchpriority=high`。

### 4.2 生产首页制造了过多媒体竞争

当前生产实现会在每个 PC Feed 中把前三行媒体设为 eager/high。多频道同时挂载时会产生大量高优先级
候选。PageSpeed 桌面端出现单个约 6.85 MB 的 `/img` 资源，并有多张 0.4–2.2 MB 图片；移动端虽然单张
较小，但总传输仍达 10.3 MiB，说明数量同样失控。

### 4.3 移动端 JS 与布局成本过高

移动端 8.3 秒主线程和 550 ms TBT 证明网络优化后仍需验证 CPU。生产入口压缩后约 14.6 KB，但首页
modulepreload 的初始 JS 合计约 132.6 KB；不能用入口文件大小代替实际启动成本。当前性能分支的关键 JS
约 144 KB gzip，网络和数据调度会明显改善，但 bundle 本身略增，因此必须用 staging trace 验证，而不是
预估分数。

### 4.4 API 需要第二条连接且列表字段过宽

生产 HTML 预取跨域 `https://api.ai-feeds.com/api/items?source_type=x_list&limit=30`。2026-07-14 的当前区域
抽样约为 TLS 0.98 秒、TTFB 1.78 秒、总时长 1.92 秒；解码后约 87 KB，并包含列表首屏不需要的详情字段。
这不是全球用户分布，但足以证明同源复用和紧凑 DTO 有实际价值。

### 4.5 独立质量问题

PageSpeed 还记录：

- viewport 禁止缩放；
- button name、对比度、label/visible-name 和 heading order 问题；
- 移动端两个不可抓取链接；
- 视频 MP4 被送入图片代理导致连接失败；
- 匿名 `/api/auth/me` 返回 401 被记为控制台错误；
- 一条 CloudFront 图片经 `/img` 返回 403；
- Product Hunt maker avatar 仍可能请求原始大图。

这些问题不需要等待 SSR，可以在本轮发布前逐项修复或明确降级行为。

## 5. 当前分支覆盖情况

当前 `codex/fix-motion-system` 分支已经覆盖本轮最主要的可立即交付项：

- 首页列表从 30 条降为 12 条；
- 同源 `/api`，减少跨域连接；
- 紧凑列表查询/DTO；
- 全页面只有一个 `fetchpriority=high` 图片候选；
- PC 下方频道延迟挂载，移动端只先取当前频道；
- 取消 LCP 前的批量预取；
- 卡片图片 variant、`srcset`、`sizes`、`width`、`height`；
- 字体延迟到交互或 load 后 10 秒再 idle，省流量/弱网跳过；
- feed-ready、LCP、媒体与服务端分段遥测。

尚未由现有代码或测试充分关闭的项目：viewport 缩放锁、PH avatar 尺寸、视频/403 图片代理降级、匿名
401 控制台噪声、移动不可抓取链接、剩余对比度/按钮名称，以及移动端关键 JS/布局 CPU。

## 6. 发布与验收调整

本轮 staging 必须保留既有 cold/warm 硬顶，并新增以下证据：

1. 同一份种子内容、同一视口做分支前后移动 Lighthouse/trace；
2. 记录首个 LCP 图片的发现时刻、URL、优先级和实际宽度；
3. 记录 LCP 前图片请求数量、总字节、长任务和 React/布局时间；
4. 验证视频 URL 不进入图片代理，图片 403 有稳定 fallback；
5. 跑可访问性与移动 SEO 审计，确认 viewport、锚点、按钮名和对比度；
6. 若移动 cold LCP 仍超过 7 秒或 feed-ready 超过 5 秒，停止生产发布并继续做启动 CPU/DOM 分片，
   不以 SSR 改版尚未完成为豁免。

生产 RUM 继续作为上线后的非阻塞观察任务：每阶段观察至少 48 小时且至少 100 个 LCP 样本，再决定
扩大或回滚；它不阻塞本地代码交付和 staging 验收。

## 7. 后续首页 SSR/瀑布流改版约束

未来改版若引入 SSR/流式首屏，应满足：匿名首屏 HTML/边缘缓存、首视口数据直接内嵌、唯一 LCP 图片在
HTML 中带尺寸和高优先级、服务端确定卡片几何避免 masonry CLS、客户端接管时复用服务端数据而不重复
请求。这样 SSR 才会解决“发现晚”，而不是把同样过量的媒体和 DOM 提前塞进 HTML。
