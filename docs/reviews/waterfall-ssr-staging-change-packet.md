# 首页瀑布流 SSR staging 变更包

状态：`STAGING APPLIED AND PASSED / PRODUCTION FOLLOW-UP COMPLETED`

当前决定：`GO — completed 2026-07-18`

本变更包把首页经典版/瀑布版并行方案的 staging 配置、部署、验收、kill switch 和回滚收敛为一次
可审阅操作。用户已授权持续完成计划内开发、测试与发布；本文件仍不包含 production，也不允许把
staging 通过自动解释为生产放量。RUM 是 production 上线后的观察任务，不是 staging 或代码交付门。

> 2026-07-18 后续视觉/混排 v2 是新的同步发布批次，不复用本页旧 deployment/version 作为新证据。
> 新批次的范围、兼容矩阵、本地门与回滚条件见
> [`2026-07-18-waterfall-mixing-v2-release.md`](2026-07-18-waterfall-mixing-v2-release.md)。
> v2 批次不得沿用本页初次上线的 Worker → Pages 顺序：新 Pages 先发送
> `X-Home-Ranking-Version: 2`，验证其与旧 Worker 的 v1 响应兼容后再发布新 Worker；新 Worker
> 对无协商头的旧 Pages 保持 v1/八源。该协议也保护生产两个并发 CI 工作流的任意完成顺序。

## 0. 执行结果

- staging Worker 最终版本：`456c41a4-ec56-4a44-87a4-ddffb8a0ae30`。
- staging Pages 验收 deployment：`https://219a1609.xlist-dashboard-staging.pages.dev`。
- 五设备远端功能门：desktop Chromium、tablet Chromium、iPhone Chromium、iPhone WebKit、
  Android Chromium 共 `20/20` 通过；覆盖 SSR、hydration/CLS、加载更多与视图切换。
- kill switch 已在 staging 演练：关闭后 query/cookie 均回经典版且 `/_home/feed` 关闭，恢复后重新全绿。
- classic/waterfall 同条件 benchmark：每个 view/device/cache `10` 次；waterfall 的 desktop cold
  LCP p75 `1580ms`（classic `1728ms`，`-8.6%`），mobile cold `1540ms`
  （classic `1848ms`，`-16.7%`），mobile warm `296ms`（classic `560ms`，`-47.1%`）；
  waterfall CLS p75 `0`，请求数 `15 vs 24`，cold transfer `130.5KB vs 322.9KB`。
- staging 通过后按独立生产清单发布；生产对象、回滚点和最终验收见
  [`2026-07-18-waterfall-ssr-production-release.md`](2026-07-18-waterfall-ssr-production-release.md)。

## 1. 范围与风险

- 分支：`codex/waterfall-ssr-main-sync`。
- 服务：`xlist-api-staging` 与 `xlist-dashboard-staging`。
- 用户面：staging 匿名首页；无偏好时仍为经典版，瀑布版只由显式 `?view=waterfall` 或有效 cookie 进入。
- 数据面：只读现有 `items`；没有 D1 migration、回填或写入。
- 新运行时依赖：Pages `HOME_API` Service Binding、Pages/Worker 同值
  `HOME_RENDERER_TOKEN`、Pages `HOME_EXPERIENCE_ENABLED`。
- 风险：`high`。原因是跨 Pages/Worker 的运行时配置与公开 SSR 路径；blast radius 被 staging、
  默认经典版、fail-open 和 kill switch 限定。
- 失败形态：绑定、token、数据或 renderer 异常必须返回经典首页并清除瀑布偏好，不能返回空白页或 5xx。

## 2. Migration

- Type: runtime configuration only。
- Affected Surface: staging Pages bindings/variables/secrets 与 staging Worker secret。
- Run Before Rollout: 先部署支持 `/api/home-feed` 的 staging Worker，再部署 Pages。
- Rollback Safe: 是；无 schema/数据变化，先关闭 flag，再分别回退 Pages deployment 与 Worker version。
- Operator Warning: 不得提交 Pages Wrangler 配置来“顺手同步”远端项目；它会成为项目配置事实源。
  执行前必须只读记录当前 Pages bindings、variables、secrets 名称和上一 deployment id。

## 3. 单次 staging 授权边界

执行前由 Codex 生成一个只读冻结清单，记录：

1. clean commit SHA 与本文件 SHA；
2. 当前 staging Worker version id、Pages deployment id；
3. 当前 Pages/Worker binding 与 secret **名称**（不记录值）；
4. 本节 4–8 的精确前向步骤和精确回滚步骤；
5. Codex 为执行人，roxor 为独立回滚负责人及 `rollback_failed` 联系人。

roxor 只需批准这一个冻结清单。该批准同时覆盖清单内的 staging 前向动作、验收期 kill-switch 演练，以及
触发条件命中后的清单内精确回滚；不再按每条无差异命令重复索要业务授权。以下情况使授权失效并必须重新
冻结：commit/SHA、目标项目、binding 目标、命令、回滚对象或执行窗口发生变化。

单次授权明确不覆盖：

- production 的 binding、secret、flag、Worker、Pages、DNS、VPS 或流量；
- 合并或推送 `main`；
- D1/R2/KV 写入；
- 将任意 secret 值写入仓库、日志、聊天或 evidence。

## 4. G0：本地与只读远端前置门

进入 staging 写操作前必须同时满足：

- 分支包含最新 `origin/main`，工作区 clean，冻结 commit 后不再修改代码。
- `dist/waterfall.html` 有且仅有一个 64 位 `aifeeds-build-id`，placeholder 已消失；verifier 归一
  identity 槽后复算整个 `dist` artifact graph 并与该值完全一致。相同 artifact 重复构建 identity
  稳定；同一 commit 的不同 mode/env 产物 identity 不同；回滚同一 artifact 能回到对应 namespace。
- Dashboard：lint、全量 unit、build、Functions tests/typecheck、经典首页 E2E 全绿。
- 瀑布流本地 HTTPS fixture：五项目 30/30 全绿，覆盖无 JS SSR、水合、CLS、键盘、触控、
  `Secure` cookie、加载更多、Drawer 与 fail-open。
- Worker 全量测试全绿；根目录 CI contract tests 全绿。
- 只读盘点 staging Pages/Worker 现状，确认没有同名 binding 指向未知服务。
- 记录 classic entry 与 waterfall entry 的构建产物；经典 entry 相对冻结的 `origin/main` 若变大，
  必须在证据中解释并审阅，不能静默接受。

任一项失败为 `NO-GO`，不得靠跳过测试或复用旧 evidence 继续。

2026-07-17 本地 G0 证据：Dashboard unit `329/329`、Functions `23/23`、Worker
`812/812`、root contracts `187 pass / 2 environment-skips`、waterfall 五设备 `30/30`、classic
`32 pass / 83 role-skips`；lint、production build、构建身份 verifier 与相关 typecheck 均通过。
首次浏览器命令只因受限执行环境拒绝监听 `127.0.0.1:4187` 而未启动测试；在允许本地监听后，
同一未修改测试命令全绿，不计作产品失败。

## 5. 配置与部署顺序

以下步骤作为同一个 staging operation 顺序执行：

1. 生成一次随机 renderer token，只保存在 0600 临时 evidence 中，不回显。
2. 把同一 token 注入 `xlist-api-staging` 与 `xlist-dashboard-staging` 的
   `HOME_RENDERER_TOKEN` secret。
3. 在 `xlist-dashboard-staging` 的 production environment 创建或核对
   `HOME_API -> xlist-api-staging` Service Binding。
4. 设置 Pages variable `HOME_EXPERIENCE_ENABLED=true`；值必须是精确小写字符串。
5. 部署 staging Worker；记录新 version id，匿名公开路由与旧首页 API smoke 必须先通过。
6. 部署 staging Pages；记录新 deployment id。
7. 验证无 query/cookie 仍返回经典入口；显式瀑布入口返回 SSR HTML，且两个入口不互相下载对方 entry。

Worker 与 Pages 的 token 必须同 operation 生成、同 operation 注入。禁止从历史聊天、旧日志或生产 env
复制值。staging token 不得复用到 production。

## 6. staging 功能与性能门

功能门：

- PC 1440、平板 820、iPhone Chromium 390、iPhone WebKit 390、Android Chromium 412 均完成：
  SSR 首屏、单列/双列/三列、键盘/触控切换、cookie 持久化、加载更多、Drawer 深链和返回。
- 正常请求不得出现 `X-AIFeeds-Home-SSR: fallback`、水合错误、横向溢出或非预期 5xx。
- `view_mode` 只允许 `classic|waterfall`；`home_view_switch` 只含固定字段。
- 经典版默认、瀑布版 opt-in；无效 query/cookie 必须回经典版。

性能门：

```bash
cd dashboard
npm run benchmark:home-views -- \
  --classic-url "https://staging.ai-feeds.com/?view=classic" \
  --waterfall-url "https://staging.ai-feeds.com/?view=waterfall" \
  --runs 10 \
  --output "output/home-view-benchmarks/staging-gate"
```

- 两个 `?view=` 只用于校验有限 cohort；benchmark 会写入对应 `aifeeds_view` cookie 后访问 canonical
  `/`，避免 QA query 绕过公共 SWR。每条样本必须保留 `ssr_state`、`X-AIFeeds-Home-SSR`、
  freshness 与 age，不能把浏览器 warm 冒充 edge fresh。
- benchmark 定义的 desktop/mobile × view 各至少 10 次 cold 样本，并保留 warm 样本作诊断。
- 每个设备 waterfall p75 LCP 不得比 classic p75 差超过 10%。
- 每个设备/view CLS p75 `<=0.1`，横向溢出为 0。
- 样本 view label 必须与目标一致；SSR 瀑布样本必须有至少 12 个首屏 article。
- 单次 lab/benchmark 只决定 staging 是否继续，不替代生产 RUM。

## 7. kill switch 演练

在 staging 验收完成但尚未宣布通过前：

1. 把 `HOME_EXPERIENCE_ENABLED` 设为非 `true` 值或移除；
2. 验证无偏好、瀑布 query、瀑布 cookie 都返回经典入口；
3. 验证 `/_home/feed` 不再开放，Pages 不调用 renderer binding；
4. 验证后仅在其余 gate 全绿时恢复精确值 `true`。

kill switch 任一步失败为 `NO-GO`，直接执行第 8 节完整回滚。

## 8. 回滚触发与顺序

任一条件立即回滚：

- 首页 5xx、空白、循环导航或无法恢复经典版；
- 正常流量出现 fallback、token/binding 泄漏或 scope 扩大；
- hydration/console error、CLS 超标、横向溢出、键盘/触控不可用；
- waterfall LCP gate 失败或经典 bundle 未解释回归；
- Worker 公开 API、origin gate、CORS 或现有经典首页回归；
- 无法独立关闭 flag。

回滚顺序：

1. 立即关闭 `HOME_EXPERIENCE_ENABLED`，确认 staging 回经典版；
2. Pages 回退到本 operation 前记录的 deployment id；
3. Worker 回退到本 operation 前记录的 version id；
4. 移除或恢复本 operation 新增/修改的 Service Binding、variable 与两端 secret；
5. 重跑经典首页 smoke，确认没有瀑布入口、运行时残留或错误 cookie；
6. 保存 deployment/version id、时间、触发条件和终态；`rollback_failed` 立即由 roxor 接管。

没有数据 migration，因此没有 D1 rollback。禁止把“flag 已关”当作完整回滚终态。

## 9. 通知与最终决定

- 执行前：Codex 向 roxor 报告窗口、冻结清单 SHA、旧 deployment/version id、风险与回滚触发线。
- 执行中：只有 gate 结果、对象 id 和非敏感摘要进入协作记录；secret 值不进入 stdout/stderr。
- 执行后：报告五端功能矩阵、10-run benchmark、kill-switch、回滚可用性与最终 deployment/version id。
- Support/用户侧：staging 为 opt-in，无生产用户动作；若 staging 链接用于验收，明确“经典版为默认，
  瀑布版为实验入口”。

当前最终决定：`GO`。本地 G0、远端配置盘点、staging 五设备功能门、10-run 对照和 kill-switch
演练均已完成；随后生产按独立冻结清单发布并通过五设备验收。生产上线后继续按
`view_mode × ssr_state × device × region` 累积 RUM，样本门槛只用于确认长期收益或后续扩大默认范围，
不反向改变本次代码与 opt-in canary 的完成状态。
