# C 端性能灰度验收记录模板

> 本模板只记录证据，不授权部署、DNS、D1、Pages、证书或 nginx 变更。每个外部动作仍按
> `docs/operations.md` 的对应门禁单独审批。

## 1. 变更身份与回滚

| 项 | 值 |
|---|---|
| 日期 / owner | |
| Dashboard commit / Pages deployment | |
| Worker version | |
| D1 migration 与 apply 记录 | |
| nginx config checksum / backup | |
| R2 variant version | |
| 灰度 cohort / 流量比例 | |
| 精确回滚 Dashboard / Worker / nginx / migration | |

## 2. 样本口径

分别填写 desktop/mobile、cold/warm SW、CN/非 CN、网络档位；owner、synthetic、bot 与异常导航必须
单列，不混入 all-clean。每个主 cohort 至少观察 48 小时且有 ≥100 个独立 LCP，才可判断目标是否
达到。

| cohort | 会话数 | LCP 样本 | 清洗规则 | 版本覆盖率 |
|---|---:|---:|---|---:|
| desktop cold | | | | |
| desktop warm SW | | | | |
| mobile cold | | | | |
| mobile warm SW | | | | |

## 3. 端到端时序与字节

| 指标 | baseline P50/P75/P95 | candidate P50/P75/P95 | 目标 / 结论 |
|---|---|---|---|
| FCP | | | |
| LCP | | | desktop all-clean P75 ≤3.5s；warm ≤2.5s |
| feed_ready | | | cold P75 ≤2.5s；warm ≤1.5s |
| API dns / connect / tls / ttfb / total | | | |
| Worker D1 / map / json | | | |
| nginx connect / header / response | | | |
| LCP 前 list transfer | | | desktop ≤250KiB；mobile ≤100KiB |
| GitHub 30 list gzip | | | ≤80KiB |
| high-priority images | | | ≤1 |
| LCP 前 below-fold list | | | 0 |

附五项目（desktop Chromium 1440×900、tablet Chromium 820×1180、iPhone Chromium 与 WebKit
390×844、Android Chromium 412×915）的 `cold-warm-page-performance.json` 与
`same-origin-api-timing.json`。每份证据只允许项目名、FCP/LCP/feed-ready、聚合字节、媒体计数、
request-id/解析后的 Server-Timing 数值、Navigation Timing 的 `workerStart`/固定协议，以及按固定类别
聚合后的 resource timing（count、总/最大耗时、传输/编码字节、cache hit、LCP 前计数/字节）；禁止
逐资源时序、URL、query、item id、用户标识、响应正文或标题。运行时若
`PerformanceObserver.supportedEntryTypes` 不支持 Paint/LCP，记录 `null` 和明确的 unsupported，不伪造
数值；运行时声明支持却没有采到则验收失败。

每项目还记录隐私安全的视觉摘要：可见卡图/成功 decode/失败数量、400/800 variant 请求与失败/悬空
数量、CLS 累计值。不得记录图片 URL。G8 单次 lab 的灾难性 smoke ceiling 为 cold feed-ready ≤5s、
LCP ≤7s，warm feed-ready ≤3s、LCP ≤5s，且受支持浏览器 CLS ≤0.1；WebKit 不支持 LCP/layout-shift
时用 feed-ready 作为请求竞争 cutoff，并把 CLS 明确记 `unsupported`，不得写成 0。这些宽松硬顶不能
替代上表 RUM P75 目标。

LCP lab freeze 前必须等待 expected Feed 全部 2xx/可见、可见图片 decode 和 video poster 请求完成；
不得用真实键盘输入提前截断候选。CLS observer 与 LCP 分开结束：用非受信任事件触发 deferred 字体，
等待 stylesheet、`document.fonts.ready`、媒体和布局稳定后才冻结 CLS，确保字体位移仍被计入。
400/800 `/r/` variant 的授权资源 origin 是 `staging-api.ai-feeds.com`，不是 perf 页面 origin。
移动端切到 blog/podcast 后以当前可见图关联 w400，并要求 w800=0（封面 CSS 仅 96/72px）。

warm SW 的单次证据还必须同时包含：SW controller、`aifeeds-shell-*` 中 `/` 的 CacheStorage 命中前置、
`workerStart>0` 与 navigation transfer=0。LCP 前 list/media 竞争统一按 fetch/Playwright request
`startTime` 计入，包含采集时仍在传输的媒体；desktop 必须精确请求 x_list、blog,podcast、
product_hunt，tablet 精确请求前两者，mobile 精确请求 x_list，不能只校验“至多 3/2/1”。额外请求
数必须为 0。证据同时记录 cutoff 是 `lcp` 还是 `feed_ready`。

一次五设备 lab run 只作为 cold/warm SW 配对 smoke，不能填入 P50/P75/P95；上表分位只使用满足第 2
节样本口径的 RUM cohort，或另行记录足量独立新 context 的 lab 分布。

远端登录验收关闭并禁止 trace、HAR、截图、录像、HTML report 和 storageState；失败断言只能比较
boolean、固定枚举、状态码、长度或脱敏摘要，不能把 live HTML/XML/JSON/JS 作为 matcher received
value 写入日志。400/800 图片实际尺寸/字节、DPR 1/2/3 清晰度与 CLS 使用不含正文的独立摘要，
另附 X 视频和播客音频 Range=206 的状态码/content-range 摘要。

## 4. 功能与隔离矩阵

- [ ] 匿名首页 / feed / search / suggestion / 空态 / 429 / 一次失败恢复
- [ ] 既有 Cookie、邮件验证码登录、logout；SMS 保持既定 disabled 响应
- [ ] subscription / feedback / share / 二维码；favorite = N/A（当前无 route/table/UI）
- [ ] `/t` `/g` `/ph` `/c` `/e` `/h` `/o` 与 settings/feedback 等 SPA 深链
- [ ] `/daily` `/i` robots / sitemap / llms / hashed assets 未被同源 API route 吞掉
- [ ] Drawer 拉到完整 README / deep_analysis / body，list DTO 不携带全文
- [ ] 两 Origin、两 filter、cursor、pinned、匿名/登录响应无缓存串数据
- [ ] PC 下方行滚动前无 list/media；移动 active tab 可用且真实触摸横滑正常
- [ ] saveData 不注入字体、不后台预取；字体/图片 Resource Timing 可见
- [ ] perf-staging 将 origin gate / 真实访客 IP / per-IP 限流记 N/A；生产私有 secret 链路另验

## 5. 停止线与结论

任一项触发立即停止放量并执行预登记回滚：错误率增加 >0.5pp、任一主 cohort LCP 恶化 >10%、
移动 active feed 空白、登录/Cookie 回归、个性化缓存串数据、视频/音频 Range 退化、request-id/
Server-Timing 无法 join，或某地域被整体均值掩盖而显著变差。

最终决定：`继续灰度 / 全量 / 回滚 / 延长观察`。记录判断人、时间、证据链接和下一次检查点。
