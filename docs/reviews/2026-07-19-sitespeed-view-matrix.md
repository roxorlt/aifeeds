# 2026-07-19 classic / waterfall 外部只读对照

## 结论

生产 `classic` 与 `waterfall` 已在 GitHub 托管的外部 runner 上完成
`2 views × 2 devices × 5 runs` 同条件对照。waterfall 在桌面与移动端的 LCP、传输量、请求数和
CLS 均优于 classic；因此本轮瀑布流 canary 的 synthetic 性能门通过。

本次测试只允许 `GET`、`HEAD` 和 `OPTIONS`。页面埋点与 impression refresh 在浏览器层被拦截，
测试结束后又逐条检查 HAR；四个 cohort 的变更型请求均为 `0`，因此它是只读生产验证。

执行记录：

```text
workflow: External sitespeed.io baseline
run:      29681318422
commit:   21658e5e9f9631f9a500fad55ffde825c580b14e
result:   4/4 jobs success
workflow PR: #203, merge 135bf838e8d248519b02fe5e8c9dbc951ae0fa08
```

## 结果

下表均为每个 cohort 五次冷加载的 sitespeed.io 汇总值。

| view / device | TTFB | LCP | CLS | Speed Index | Fully loaded | Transfer | Requests |
|---|---:|---:|---:|---:|---:|---:|---:|
| classic desktop | 0.890s | 6.060s | 0.031 | 3.715s | 9.418s | 5.9MB | 84 |
| waterfall desktop | 1.848s | 3.480s | 0 | 2.874s | 5.094s | 842.8KB | 30 |
| classic mobile | 1.286s | 5.084s | 0.072 | 4.637s | 8.823s | 1.0MB | 43 |
| waterfall mobile | 2.495s | 3.808s | 0 | 3.884s | 6.876s | 611.8KB | 26 |

相对 classic：

- desktop waterfall LCP 改善 `42.6%`，请求数减少 `64.3%`，传输量约减少 `85.7%`；
- mobile waterfall LCP 改善 `25.1%`，请求数减少 `39.5%`，传输量约减少 `40.3%`；
- waterfall 两端 CLS 均为 `0`。

显式 `?view=` URL 会按设计绕过匿名首页公共缓存，因此 waterfall 的 TTFB 是冷 SSR 保守口径，
不是已有 waterfall cookie 用户命中 SWR 的体验。即使在这个口径下，waterfall LCP 仍明显更快。

## 只读门

workflow 对页面运行时的两个写入口进行阻断：

```text
https://api.ai-feeds.com/api/track*
https://api.ai-feeds.com/api/items/*/refresh*
```

随后定位每个结果中唯一的 `browsertime.har`，用 `jq` 检查所有请求方法；只接受：

```text
GET
HEAD
OPTIONS
```

四份 HAR 均通过，未向生产写入测试埋点、曝光或刷新任务。artifact 名称包含
`view × device × run_id × run_attempt`，重跑不会覆盖第一次证据。

## Product Hunt 媒体结果

此前确定的 `4,276,378 B` Product Hunt GIF 在四个 cohort 中均未再出现，批次 D 的已知目标已经
关闭。waterfall 四组共没有 GIF 请求。

classic desktop 仍存在另一类独立的媒体预算：

- 每次运行会请求两个约 `222KB`、`110KB` 的动画 Product Hunt logo；
- 最大三张独立 Product Hunt 图片约为 `1.806MB`、`689KB`、`465KB`；
- 这些资源解释了 classic desktop 的 `5.9MB`，但不是原先已修复的 4.276MB GIF 回归。

因此当前结论不是“所有 classic 图片都已经很小”，而是：

1. 原计划中的单个 4.276MB GIF 自动加载问题已修复；
2. waterfall 的当前图片路径和首屏预算已通过；
3. classic desktop 的新残余大图与动画 logo 应作为后续独立 P1 媒体预算任务处理，不阻塞本轮
   waterfall opt-in 发布。

## 与 RUM 的关系

本结果是外部 synthetic 证据，可以立即用于判断回归和两种视图的相对性能；它不能替代真实用户
网络、设备和地区分布。RUM 继续按 `view_mode × device × region` 在发布后累计，但不再阻塞代码、
测试、合入或本轮生产交付。
