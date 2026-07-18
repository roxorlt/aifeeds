# 2026-07-18 首页瀑布流 SSR 生产发布证据

## 结论

首页经典版/瀑布版并行方案已经完成开发、代码审查、staging A/B、生产发布和五设备即时验收。
生产默认仍是经典版；瀑布版只由显式 `?view=waterfall` 或有界 `aifeeds_view=waterfall` cookie 进入，
因此本次是可逆的 opt-in canary，而不是把全部生产用户一次性切换到新版。

最终决定：`GO`。RUM、GSC 和 Ahrefs 复抓是上线后的非阻塞观察；Ahrefs 报告中的两条精确 5xx URL
仍是 P0-B 唯一缺失输入，不能用猜测性代码代替。

## 版本与变更对象

| 对象 | 最终值 |
|---|---|
| `main` | `7c660e7ea31b367f66fadb6956273b3c54a76656` |
| waterfall 集成 PR | `#191` |
| hydration 时区修复 PR | `#192`，merge `6b981b2466506fd752d83bc0ea6c45b88682b766` |
| home-feed D1 cursor 修复 PR | `#193`，merge `7c660e7ea31b367f66fadb6956273b3c54a76656` |
| production Worker version | `0d0e09e6-63c6-4d0d-a1c7-bce45f615ebb` |
| production Pages deployment | `https://5ef13c30.xlist-dashboard.pages.dev`，source `6b981b2` |
| production waterfall bundle | `waterfall-GbrZe2tg.js` |
| staging Worker version | `456c41a4-ec56-4a44-87a4-ddffb8a0ae30` |
| staging Pages deployment | `https://219a1609.xlist-dashboard-staging.pages.dev` |

PR `#193` 只修改 Worker，Dashboard artifact 与 `#192` 相同，因此生产 Pages source 保持
`6b981b2`，而 Worker 和仓库 `main` 已到 `7c660e7`。

## staging 门

- Dashboard：unit `333/333`、Functions `24/24`、lint、typecheck、build 全绿。
- Worker：`50` files / `827` tests 全绿。
- 五设备远端功能门：`20/20`；desktop、tablet、iPhone Chromium、iPhone WebKit、Android Chromium。
- kill switch：关闭后 query/cookie 均回经典版，`/_home/feed` 关闭；恢复后重新全绿。
- 10-run 同条件 benchmark：

| 设备/缓存 | classic LCP p75 | waterfall LCP p75 | 变化 |
|---|---:|---:|---:|
| desktop cold | 1728ms | 1580ms | -8.6% |
| desktop warm | 304ms | 300ms | -1.3% |
| mobile cold | 1848ms | 1540ms | -16.7% |
| mobile warm | 560ms | 296ms | -47.1% |

waterfall CLS p75 为 `0`；请求数 `15 vs 24`；cold transfer `130.5KB vs 322.9KB`。

## 生产发布中发现并关闭的两个问题

### 1. 时区相关 hydration mismatch

生产 D1 可返回无时区的 `YYYY-MM-DD HH:mm:ss`。Cloudflare SSR 把它解释为 UTC，而 Asia/Shanghai
浏览器按本地时间解释，卡片日期跨日，React 报 hydration error `#418`。

修复：Dashboard 在渲染边界把严格的无时区 D1 timestamp 归一为 UTC；回归测试在 `TZ=UTC` 和
`TZ=Asia/Shanghai` 下比较相同输出。生产复验无 hydration error。

### 2. home-feed `next_cursor=null`

home-feed 使用 D1 原始 SQLite timestamp 作为稳定 keyset sort value，但 cursor validator 只接受
RFC3339，导致服务端不能为合法生产数据生成续页游标。

修复：严格接受 RFC3339 与 SQLite timestamp，并原样保留 sort value 用于下一页重放，不改变 SQL、
排序或候选上限。生产 page 1/page 2 均返回 `200`、每页 `12` 条、有效 `184` 字符 cursor。

## 生产即时验收

- Playwright 最终单次矩阵：五设备共 `20/20` 通过，覆盖无 JS SSR、hydration/CLS、加载更多、
  classic/waterfall 切换和 cookie 持久化。
- 默认匿名首页刷新后稳定为 `X-AIFeeds-Home-SSR: classic`、nginx `HIT`、无 waterfall bundle。
- `?view=waterfall`：`200`、`24` 个 SSR article、只下载 waterfall entry。
- waterfall cookie：公共 SWR 快照 `24` 条、`has_more=true`、有效续页 cursor。
- `?view=classic` 与 classic cookie：均 `200` classic，nginx `BYPASS`。
- `/_home/feed?view=waterfall&limit=12`：`200` JSON、`12` 条、`has_more=true`、有效 cursor。
- `/_home/feed?view=classic&limit=12`：按设计 `404 not_found`。
- `https://api.ai-feeds.com/api/stats`：`200`。
- Pages 三条 bundle 路径（精确 deployment、pages.dev alias、自定义域）均返回 JavaScript MIME，
  没有 propagation HTML fallback。

第一次默认匿名请求命中了发布前的旧经典缓存壳并触发后台刷新；它仍是经典版且没有 waterfall 内容。
后续请求稳定命中新经典缓存，因此未发生 cohort 交叉污染。

## 发布后 DebugBear 移动端对照

2026-07-18 在 DebugBear project `104156` 触发 20 个 Quick Test：台湾、香港分别对 classic 与
waterfall 各跑 5 次 Mobile 冷加载。本机 Clash 未参与。

| 地域 / view | n | LCP p50 / p75 | TTFB p75 | TBT p75 | CLS p75 | 传输 p50 | 请求数 p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 台湾 classic | 5 | 3.487s / 3.732s | 0.784s | 667ms | 0.07 | 1107KB | 48 |
| 台湾 waterfall | 5 | 2.564s / 2.664s | 1.835s | 255ms | 0 | 327KB | 23 |
| 香港 classic | 5 | 3.065s / 3.136s | 0.828s | 531ms | 0.07 | 1107KB | 48 |
| 香港 waterfall | 5 | 2.536s / 2.611s | 1.874s | 182ms | 0 | 327KB | 23 |

waterfall 相对 classic 的 Mobile LCP p75：台湾改善 `28.6%`，香港改善 `16.7%`；传输中位数
减少约 `70.5%`，请求数减少约 `52%`。四个地域/view 组合 console errors 均为 `0`。

测试 URL 使用 `?view=` 精确锁定 cohort，因此 nginx 按设计 `BYPASS`，waterfall 也没有使用真实
cookie 用户可复用的公共 SWR 快照。这解释了 waterfall TTFB 明显更高；在这种保守 cold renderer
口径下，最终 LCP 仍显著更低。它是 synthetic lab 证据，不是 RUM。

四个代表性 request waterfall（Taiwan classic/waterfall、Hong Kong classic/waterfall）均为
`0` 个 4xx、`0` 个 5xx、`0` 个 GIF 请求；最大资源已不再是 4.276 MB Product Hunt GIF。

代表结果：

- 台湾 classic：<https://www.debugbear.com/project/104156/quickTest/L0EcLVwGd0pL7j2MZnUuy8637/overview>
- 台湾 waterfall：<https://www.debugbear.com/project/104156/quickTest/wBHVgUezyqvSmcULZs7soQSNt/overview>
- 香港 classic：<https://www.debugbear.com/project/104156/quickTest/qjJeby3Q2KrQ5WtrYjnG9pps7/overview>
- 香港 waterfall：<https://www.debugbear.com/project/104156/quickTest/2JWsPOlDPhfANKElgDfb2bhoR/overview>

## SEO 生产即时复核

- GSC 指向页 `/i/x/2061451225762046411` 返回 `200`；JSON-LD 只有一个合法 block，递归检查所有
  字符串的孤立 surrogate 数为 `0`，description 保留完整 `🔥`。
- `/archive/` 与 `/archive/x/` 均 `200` 且 self-canonical；归档首页有 5 个源入口，X 源页有
  37 个月入口。
- `/sitemap-archive.xml` 返回 `200`，包含 404 个 `<loc>`。

## 运行时配置与缓存隔离

- Pages `HOME_API -> xlist-api` Service Binding 已配置。
- Pages 与 Worker 有同值、未回显的 `HOME_RENDERER_TOKEN`。
- Pages `HOME_EXPERIENCE_ENABLED=true`；这只开放 opt-in，默认 resolver 仍返回 classic。
- nginx：默认匿名首页允许经典缓存；view query、view cookie、session/auth cookie 均 `BYPASS`。
- Pages public waterfall cache：fresh `60s`、max-stale `10min`、retention `24h`，stale hit 用
  `waitUntil()` 刷新并有 isolate single-flight；超窗失败 classic fail-open。

## 回滚

回滚顺序：

1. 把 `HOME_EXPERIENCE_ENABLED` 移除或改成非 `true`，验证 query/cookie/feed 全回经典行为；
2. Pages 回退 `a359d6ff-9b91-4a0f-a130-abf55537d5cc`；
3. Worker 回退 `244711bd-28c4-4545-a6cb-a0f857916ea4`；若只撤 cursor hotfix，可回退
   `a37ef6a6-b926-4cbe-8f0d-3cdf12e4bbd5`；
4. 恢复 nginx 备份
   `/etc/nginx/sites-available/aifeeds.conf.bak-waterfall-20260718T075759Z-2c50e77c`，再执行
   `nginx -t` 与 reload；
5. 恢复或移除本 operation 的 Pages/Worker binding、variable、secret 名称，并重跑默认首页与公开 API。

生产 nginx 安装前 SHA-256 为
`2c50e77c65786366292e061a105c001f82e8067dc2218bf12c1c894ddd687587`，安装后为
`0446c7076e8ca1dfdf1e591e74dd6a559a9599791fd2659589edba80f36c2214`。

执行人：Codex。独立回滚负责人和 `rollback_failed` 联系人：roxor。

## 非阻塞后续观察

- RUM：按 `view_mode × ssr_state × device × region` 至少观察 48 小时；每个主要 cohort 达到
  `>=100` 个 LCP 样本后确认长期收益。样本不足只表示置信度不足，不回退本次已通过的 opt-in 发布。
- DebugBear：台湾/香港 Mobile classic/waterfall 各 5 次已完成；后续仅按需要复测，不阻塞当前终态。
- GSC：等待 Unicode 修复验证与结构化数据复抓。
- Ahrefs：2–4 周后复看 orphan/depth/internal backlinks；取得两条精确 5xx URL 后执行 P0-B 逐条根因闭环。
