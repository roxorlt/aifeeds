# 首页瀑布流 SSR 与经典版并行设计

**日期：** 2026-07-17

**状态：** 已按产品方向进入本地原型；生产保持经典版且冻结，等待当前 RUM 窗口结束
**范围：** C 端首页 PC/移动端、视图偏好、SSR 首屏、性能对照工具；不改变搜索、设置、详情协议或 Worker 数据接口

## 1. 目标与非目标

本阶段要回答三个问题：新版瀑布流是否比经典分栏更容易浏览；匿名用户能否稳定地在两个版本间切换；SSR 首屏能否消除首页“先空壳、再请求、再渲染”的等待。交付物是一个不进入生产构建的可运行 SSR 原型、一套可重复的 PC/移动端实验室基准工具，以及 GitHub Actions Node 24 兼容升级。

本阶段不接入生产流量，不改首页真实接口，不做生产同源 API 切换，不引入 nginx 微缓存，也不把原型代码直接塞进现有 `DashboardHome`。当前生产 RUM 仍只观察已经发布的经典版性能修复。

成功标准：

- 无偏好时始终返回经典版，现有用户行为不变。
- 用户切换后，下一份 HTML 已经是目标版本，不发生 hydration 布局翻转。
- 经典版和瀑布版拥有独立 `view_mode` 标签与资源统计，可以分别计算 LCP、CLS 和资源体积。
- PC 展示多列瀑布，移动端回落为单列连续流，避免窄屏双列造成正文不可读。
- 视图切换、键盘焦点、减少动态效果和失败回退均有明确契约。

## 2. 方案选择

采用同一组首页/详情 URL，由顶层 `HomeExperience` 根据服务器已经确定的视图模式选择 `ClassicHome` 或惰性加载的 `WaterfallHome`。不采用独立 `/v2`，因为那会分叉详情深链、返回栈、SEO canonical 和分享链接；也不采用服务端随机分桶，因为产品要求用户能够主动选择，且随机分桶会干扰当前低流量 RUM。

并行期的切换是一次低频整页导航，不在同一次 React 会话里热切两个大型首页。用户点击后写入 `aifeeds_view=classic|waterfall` cookie，再导航回相同 canonical URL。这样服务端能在下一份 HTML 中直接输出正确首屏，浏览器只下载所选版本的 bundle，性能 cohort 也不会混合。后续如果真实数据证明切换频率高，再评估客户端惰性热切换；现在不为假设需求增加复杂度。

偏好优先级：

1. `?view=classic|waterfall`：仅用于 QA、分享和基准测试，本次请求生效，不自动持久化。
2. `aifeeds_view` cookie：SSR 权威偏好，`SameSite=Lax; Path=/; Max-Age=15552000`。
3. 没有合法值：经典版。

`localStorage` 只做 cookie 被清理时的客户端辅助记录，不能作为 SSR 权威来源。登录账号同步属于后续增强；如果增加，服务端仍应把账号偏好镜像到 cookie，避免每个 HTML 请求查询 D1。

## 3. 页面与响应式交互

两个版本共用 Logo、搜索、账号、订阅入口、详情 Drawer、卡片语义和内容数据。切换器不放进内容筛选器，避免用户误以为它是频道条件。

PC（≥1024px）在 AppBar 右侧提供“经典 / 瀑布”分段控件，当前项使用 `aria-pressed=true`。经典版保留当前按来源分栏且各列独立滚动的模型；瀑布版使用三列内容流，按时间/质量统一排序，卡片高度由正文和媒体决定。平板降为两列。正式实现不能依赖会改变阅读顺序的 `grid-auto-flow:dense`；原型可以验证视觉密度，但上线实现必须保留 DOM/键盘顺序，并在跨浏览器测试后决定受控 lane 算法或成熟的可访问 masonry 实现。

移动端（<768px）使用单列连续流，顶部仍保留现有频道筛选和横滑手势。视图选择放在紧凑的“视图”菜单中，触控目标不小于 44px；选择后明确显示“正在切换到瀑布版/经典版”再导航。移动端不做双列 Pinterest 式布局，因为 375–430px 宽度下正文、元信息和媒体会被压缩，并增加误触。

视觉沿用灰阶、无卡片阴影、`border-neutral-200` 和内容优先原则。切换本身不做页面飞入或大面积重排动画；`prefers-reduced-motion` 下完全即时反馈。详情深链仍使用原 URL，关闭 Drawer 后回到用户所选首页布局。

## 4. SSR 数据流与失败策略

目标生产数据流如下：

1. 浏览器请求 `/` 或现有详情深链，附带视图 cookie。
2. 首页文档渲染层读取 query/cookie，调用匿名、可缓存的首屏聚合接口。
3. HTML 直接输出 AppBar、首屏卡片、确定的媒体宽高和经过 JSON 安全转义的 `__AIFEEDS_INITIAL_DATA__`。
4. 客户端以相同数据 hydrate，不重复请求首屏；之后复用现有分页、Drawer、登录和埋点能力。
5. 首屏数据使用短 TTL + stale-while-revalidate，只允许匿名公共字段；个性化内容在 hydration 后请求。

渲染层部署形态在生产阶段再通过独立 spike 选定：优先评估与 Dashboard 同版本发布的 Cloudflare Pages/Worker 文档渲染器，香港 nginx 只转发和缓存公开 HTML，不承担业务渲染。原型用本地 Node 服务器模拟同一契约。

故障必须 fail open：首屏聚合超时或渲染异常时返回经典 SPA 壳，不返回 5xx；非法视图值回经典版；瀑布 bundle 加载失败时显示可操作的“返回经典版”，并清除瀑布 cookie。服务端输出不包含账号、设备标识、原始 referrer/query 或任何 secret。

## 5. 观测、测试与上线门槛

所有首页性能事件增加有限枚举 `view_mode=classic|waterfall`，同时保留 `device_class`、冷/热访问和网络类别。切换事件只记录 `from_view`、`to_view` 和入口类型，不记录 URL 查询或用户内容。新版 cohort 不与当前经典版观察窗混算。

本地基准工具对两个显式 URL 运行桌面 Chromium 与移动 Chromium，分别采集冷启动/热启动的 TTFB、FCP、LCP、CLS、请求数和传输体积，输出 JSON 与 Markdown。它默认拒绝生产域名，只允许 localhost、staging 和隔离的 perf-staging。

生产资格门槛：

- 原型评审通过，PC/移动端键盘、触控和 reduced-motion 验收通过。
- 新版首屏 HTML 含真实内容、LCP 图片 URL/尺寸/优先级，不依赖 hydration 才出现。
- staging 每个设备至少 10 次冷启动，瀑布版 p75 LCP 不劣于经典版 10%，CLS ≤0.1，JS gzip 增量有解释。
- 经典版仍为默认并保留一键回退；新版先 opt-in，不替换 canonical 或详情路由。
- 当前生产 RUM 窗口完成后，才允许部署任何会改变 Dashboard 产物的代码。

## 6. 本阶段文件边界

- `dashboard/prototypes/waterfall-ssr/`：本地 SSR 原型，不进入 Vite 生产入口。
- `dashboard/scripts/benchmark-home-views.mjs`：安全的双视图基准 CLI。
- `dashboard/src/lib/*.test.mjs` 或原型同目录测试：模式解析、转义、SSR 契约。
- `.github/workflows/`：Node 24 action major 升级及静态契约测试。
- `docs/plans/`：本设计与实施计划。

任何真实 `App.tsx` 首页切换、Worker endpoint、Pages Function、生产部署或 RUM cohort 放量都属于下一阶段，需要基于本阶段证据另行批准。
