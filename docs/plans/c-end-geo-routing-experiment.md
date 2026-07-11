# C 端地域路由独立 A/B 实验方案

> 状态：**仅完成实验设计，当前禁止启动（BLOCKED）**
> 日期：2026-07-11
> 关联：[`2026-07-10-c-end-performance-optimization-plan.md`](2026-07-10-c-end-performance-optimization-plan.md)、
> [`../reviews/2026-07-10-c-end-performance-deep-dive.md`](../reviews/2026-07-10-c-end-performance-deep-dive.md)、
> [`../operations.md`](../operations.md)

## 1. 决策摘要

当前生产的 `ai-feeds.com`、`www.ai-feeds.com`、`api.ai-feeds.com` 和
`fonts.ai-feeds.com` 全部先到香港 VPS，再分别回源 Cloudflare Pages、Worker 或 R2。
本实验要验证的唯一假设是：**在不牺牲大陆与受保护网络体验的前提下，让可信服务端地理判定为
非大陆的流量直达 Cloudflare，是否能降低冷导航与 LCP 的 P75/P95。**

现在不能启动，原因同时包括：

1. `edge_country` / `edge_colo` 的服务端可信归因刚进入本分支，尚无足量、稳定的生产样本；
2. 还没有能跨四个生产 host 稳定分桶、并向观测系统提供可信 arm 标识的路由层；
3. “生产 host 直达 Cloudflare”尚未完成证书、custom domain、origin gate、Cookie、CORS、Range、
   Service Worker、登录、分享和深链的隔离验证；现有运维记录反而说明直接切换 custom domain
   存在架构约束；
4. 尚未取得针对 DNS/CDN 变更的独立、明确基础设施审批。

客户端 `mainland_hint` 只是 `Asia/Shanghai` 时区提示，可能被系统设置、漫游或 VPN 影响，
**既不是地理事实，也绝不能作为路由、实验分组或发布决策依据**。实验资格和归因只允许使用
DNS/CDN/Worker 在服务端产生并校验的粗粒度国家、colo，以及未来经单独隐私与安全评审的
服务端网络分类。

本文不授权修改 TTL、DNS 记录、Cloudflare custom domain/CDN、证书、nginx、Worker route 或
生产流量权重。即使代码计划整体获准执行，任何上述基础设施动作仍需另开变更单并再次明确审批。

## 2. 实验臂与适用人群

| 臂 | 可信服务端地理/网络分类 | 路径 | 角色 |
|---|---|---|---|
| A：control | 全部 | 当前全量香港 VPS 路径 | 同期对照，不改变现状 |
| B：geo candidate | `CN`、未知地理、受保护网络 | 仍走香港 VPS | 安全保持组，监控路由层是否带来副作用 |
| B：geo candidate | 满足门槛的非大陆地理 | 直达 Cloudflare | 待验证 treatment |

“受保护网络”必须是路由层提供的可信服务端 ASN/网络分类白名单，启动前冻结版本并经审批；
在该能力可用前，白名单为空，`CN` 与未知地理一律保守走香港。客户端上报的 IP、时区、语言、
`mainland_hint` 或任意自声明字段均不得进入白名单。

在每个有资格的非大陆地理层内，A/B 目标比例为 50/50，分桶必须稳定且可审计。四个生产 host
必须属于同一 arm，不能出现页面壳走直连、API 或字体仍随机走另一臂的“混合拓扑”。如果实现只能
做递归解析器级 DNS 加权而不能稳定标记独立分配单元，就不能称为用户级 A/B；在补齐 resolver
cluster 归因和聚类分析前不得启动。

## 3. 启动前硬门槛

以下项目全部为 **AND 条件**，任一未满足即保持 BLOCKED：

### 3.1 上游阶段与基线稳定

- P0/P1/P2 每阶段独立发布并至少稳定观察 48 小时；不存在错误率增加超过 0.5 个百分点、
  LCP P75 恶化超过 10%，或登录/分享/深链/移动端 active feed 回归。
- 最终候选版本连续 14 天无其他性能、路由、缓存或媒体策略变更，并形成实验前基线。
- 生产 RUM 能同时查询 `all-clean`、`engaged` 与显式 `synthetic`；owner 和 synthetic 不混入
  主分析，无互动的真实慢用户仍保留在 `all-clean`。
- `perf_nav`、`perf_lcp`、`feed_ready`、`perf_api` 均已稳定采集服务端写入的
  `edge_country` / `edge_colo`，缺失率不超过 5%。

### 3.2 地理样本与 arm 归因

- 至少先收集 14 天可信地理基线；每个拟开放 treatment 的地域必须达到第 5 节样本门槛。
- 路由层必须产生不可由客户端伪造的 `route_arm`、`route_generation`、粗粒度 `route_geo`，
  并能与 RUM、nginx/CDN 日志和请求 ID 对齐。客户端任意同名字段都必须由服务端覆盖或丢弃。
- 同一分配单元在实验期内保持同臂；不得因刷新、登录状态或某一个 host 的缓存命中而换臂。
- assignment unit 必须在实验登记表中写明。若是设备/会话则按设备/会话聚类；若是 resolver 或
  edge cluster，则样本量和置信区间必须按 cluster 计算，不能把同一 cluster 下的每次 pageview
  当成独立样本。

### 3.3 直达 Cloudflare 的隔离验收

在不会接收真实用户流量的候选 host 上，PC 与移动端都必须验证：

- 生产 host/SAN 证书、SNI、Pages/Worker/R2 custom domain 与 origin gate 可同时成立；
- 首页、`www` 规范跳转、相对 `/api`、登录 Cookie、搜索、反馈、分享短链/海报、日报和 item
  深链、Service Worker 更新都正确；
- 字体 CORS/TAO、图片、视频和音频 Range、缓存 key、错误响应不缓存均正确；
- 四个 host 的 arm 一致，响应与日志可证明真实路径，没有绕过安全、限流或回源密钥；
- synthetic 探针显式标记，绝不混入真实用户 RUM。

### 3.4 运维与审批

- 指定实验 owner、DNS/CDN 执行人、监控人、回滚执行人和变更窗口；回滚执行人与审批人在线。
- 在变更单中逐项记录四个 host 的当前记录类型、name、value、proxy 状态、TTL、custom domain、
  证书和路由策略；敏感值只存受控运维系统，不写入仓库。
- 预演第 8 节回滚并留存只含非敏感结论的证据。
- 获得一次**仅针对该次 DNS/CDN/证书/权重改动**的明确基础设施审批；模糊的“继续计划”或代码
  合并批准不算授权。

## 4. 预注册分组与流量推进

### 4.1 分析分组

主分析使用 `all-clean`，`engaged` 作为一致性复核，`synthetic` 只用于可用性探测，不用于证明
用户体验收益。每条结论都必须同时按以下维度拆分：

- 路由地理：`CN`、受保护网络、未知、符合资格的非大陆地域；
- 非大陆报告层：亚太（不含上述保留组）、北美、欧洲、其他；启动前把 ISO country → region
  映射作为变更单附件冻结，实验中不得为了结果重新分组；
- 任一国家单臂达到 200 个独立会话时，必须额外单列，不能被大区平均数掩盖；
- 设备：mobile `<768px`、tablet `768–1279px`、desktop `>=1280px`；
- 访问：cold（`sw=0` 且 `nav_type=navigate`）与 warm/SW 分开；
- 网络：`effectiveType` 和 saveData 只作客户端体验切片，不作路由依据。

任何一个地域或设备层恶化都必须明确呈现。全球平均只能作流量构成说明，不能作为接受 treatment
的依据。样本不足的地域保持原香港路径，不得用其他地域的收益外推。

### 4.2 推进顺序

取得独立审批后，仍只能按以下顺序推进：

1. 候选 host synthetic + 内部验收，真实用户 0%；
2. 符合资格的非大陆流量 5%，至少 2 小时且所有护栏正常；
3. 25%，至少 24 小时且覆盖一个业务高峰；
4. 50/50 正式采样，达到第 5 节门槛或最多 28 天。

每次权重变化后的 `max(30 分钟, 2 × 当前权威 TTL)` 为 burn-in，只看安全护栏，不计入效果样本。
低于 50/50 的 canary 数据也不与正式效果样本混算。实验至少持续 7 个完整自然日；28 天仍未达到
样本门槛即判为“样本不足/无结论”，不得放量。

## 5. 样本量、指标与判定

### 5.1 固定样本门槛

按分配单元去重，同一设备/会话/页面 30 分钟内只取首个有效事件，并按实际 assignment unit
做 cluster bootstrap：

- P75 决策：每个“主地域 × 设备 × arm”至少 200 个 `perf_lcp`，且对应 cold
  `perf_nav` 至少 200 个；
- P95 决策：每个“主地域 × arm”至少 500 个 `perf_lcp` 和 500 个 cold `perf_nav`，保证尾部
  至少有约 25 个观测；未达 500 时 P95 只能标为方向性数据，不能用来通过实验；
- `feed_ready` 每个主地域 × arm 至少 200 个；`engaged` 无硬门槛，但必须完整报告实际 n；
- 移动端任一 arm 未达到 200 个 LCP 时，该端结论为不足，不得用 desktop 结果替代。

正式启动前用 14 天基线做一次预注册的 bootstrap/power 复核；若计算要求的样本高于上述硬下限，
取较高值并在启动审批里锁定，启动后不得降低门槛。

### 5.2 指标

**共同主指标（各地域分别判定）：**

- cold `perf_nav.ttfb`（实际为 `responseStart - startTime`，包含 DNS/TCP/TLS）的 P75/P95；
- `perf_lcp.value` 的 P75/P95。

**次要指标：** `feed_ready`、FCP、导航 DNS/TCP/TLS/request/response、首个 items 与 manifest 的
`perf_api.total`、transfer KiB、warm/SW LCP，以及 nginx/CDN/Worker/D1 分段。分位数必须使用项目
统一的 nearest-rank/预注册实现，不能用平均数替代尾部。

**可用性与功能护栏：**

- DNS/TLS/HTTP 可用率、5xx/429、`api_error`、`feed_load_error`、JS error；
- 登录、搜索、反馈、分享、深链、Cookie、CORS、字体、图片、视频/音频 Range；
- 四 host arm 不一致、证书/SNI 错误、安全 gate 绕过或个性化缓存污染。

RUM 看不到“DNS 失败后根本没打开页面”的用户，因此可用率必须同时由分地域 synthetic（明确标记）
和 DNS/CDN/nginx/Worker 服务端数据覆盖，不能只用成功加载后的 RUM 作分母。

### 5.3 接受与停止线

只有以下条件**全部**满足，某个符合样本门槛的非大陆地域才可提出后续放量申请：

- 相对同期 control，cold nav P75 与 LCP P75 均改善至少 10%，bootstrap 95% CI 不跨 0；cold nav
  P75 同时达到优化计划的 `<=1.5s` 目标；
- P95、`feed_ready` P75 及各设备层 LCP P75 均未恶化超过 10%；
- HTTP/API/前端错误率相对 control 与基线均未增加超过 0.5 个百分点；可用率不低于 99.9%，
  且相对 control 不下降超过 0.1 个百分点；
- `CN`、受保护网络和未知组继续走香港，且没有因新增路由层恶化；
- 功能与安全护栏零严重回归。

证书/SNI 失败、错误路由到错误 arm、登录/分享/深链回归、安全 gate 绕过、个性化缓存串臂属于
立即回滚项。其他停止线连续两个 15 分钟窗口触发即回滚。全球平均变好但任一已达样本门槛的地域
或设备层明显恶化，结论仍为拒绝；样本不足则为无结论，不是通过。

## 6. TTL 与缓存预热

- 实验期目标权威 TTL 为 300 秒，整个实验及结束后至少 24 小时保持短 TTL；实际变更前先记录
  当前 TTL 和常见递归解析结果。**降低 TTL 本身也是 DNS 变更，必须包含在独立审批中。**
- TTL 至少在首次真实流量切换前 24 小时降低，并等待 `max(24 小时, 2 × 旧 TTL)` 后才能推进；
  若供应商或递归解析器实际最小/最大 TTL 不同，以更保守的观测值为准。
- A/B 使用独立的 route generation/缓存命名空间。只预热匿名、公开、可缓存的 `/`、`sw.js`、
  哈希静态资源及经缓存安全测试的 manifest/list；登录、收藏、订阅、反馈、分享 mutation 和任何
  个性化响应禁止预热或跨臂缓存。
- 分别从目标地域预热香港与 Cloudflare 两臂，记录 HTTP 状态、证书、cache status、响应字节和
  route arm。预热请求必须标记 synthetic，并从真实用户效果样本中排除。
- 预热后复测字体 CORS/TAO、媒体 Range、HTML/SW 版本相容和错误响应不缓存。除非确认缓存内有
  错误或敏感内容，不做全局 purge；优先失效具体 arm/generation，避免把回滚变成双臂冷启动。

## 7. 观测与结果记录

正式报告每个地域、设备和 cold/warm 层至少包含：

| geography | device | cohort | arm | assignment units | LCP P75/P95 | cold nav P75/P95 | feed_ready P75/P95 | error/availability | 95% CI | decision |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 待实验填入 | 待填 | all-clean/engaged | A/B | — | — | — | — | — | — | — |

报告同时固定 commit、Worker version、nginx/CDN/DNS config generation、证书版本、TTL、权重变化时间、
缓存预热窗口、burn-in、回滚值和异常时间线。不得删除失败窗口，也不得把 synthetic 并入 RUM。

## 8. 回滚与审批边界

启动审批必须附一份按当时真实配置生成的逐项回滚清单；本文不预写可能过期的生产命令。触发回滚时：

1. 立即停止继续放量，把 treatment 权重归零；若路由系统不可用，按变更前记录恢复四个 host 的
   精确 DNS/CDN/custom-domain/proxy/TTL 值；
2. 核对权威 DNS、证书/SNI、apex、www、API、fonts、登录、分享、深链和 Range；日志不得输出
   Cookie、Authorization、回源密钥或完整敏感配置；
3. 等待至少 `2 × 当前 TTL`，持续监控至少 60 分钟；保留短 TTL 24 小时，确认稳定后再另行审批
   是否恢复常规 TTL；
4. 只在确认错误缓存时失效对应 arm/generation；记录回滚时刻并把后续样本排除出正式窗口；
5. 结论标记为失败或无结论。任何再次尝试都需新的变更单和独立审批。

最终全量切换也不是本实验自动授权的结果。即使 treatment 达标，仍需提交逐地域放量范围、DNS/CDN
差异、成本、安全能力、值班与回滚方案，获得新的明确生产审批。

## 9. 当前门禁清单

- [x] 完成仅文档的实验预注册方案
- [ ] P0/P1/P2 已逐阶段上线并稳定观察
- [ ] 可信 `edge_country` / `edge_colo` 已有 14 天足量生产基线
- [ ] synthetic、owner、all-clean、engaged 分组已线上验证
- [ ] 可信且稳定的跨 host arm 分配/归因已实现
- [ ] Cloudflare 直达候选 host 已完成 PC/移动端与安全验收
- [ ] 各拟开放地域达到固定样本门槛
- [ ] DNS/CDN 当前值与可执行回滚清单已受控留档
- [ ] 已取得本次基础设施变更的独立明确审批

**结论：当前保持全量香港路径，不启动地域实验。**
