# 瀑布流视觉与公共混排 v2 发布清单

日期：2026-07-18

状态：`STAGING GO / PR CI PENDING`

分支：`codex/waterfall-compact-card-prototype`

## 1. 用户面与发布边界

- 经典首页继续为默认；瀑布流仍只由有效 `?view=waterfall` 或 `aifeeds_view=waterfall` cookie 进入。
- 移动端固定双列；PC 随内容区显示 3–6 列，1440px 为五列；两端均无左侧栏和分类 Tab。
- 九个来源完全混排，卡片内部保留来源身份；点击继续打开既有详情抽屉和可复制深链。
- 本次只发布公共排序 v2 与曝光 shadow。shadow decision 不得删除、隐藏或重排任何 SSR/客户端卡片。
- 没有 D1 migration、回填、正式个性化过滤或默认视图切换。

## 2. Worker/Dashboard 滚动兼容

- 新 Pages 对无 cursor 请求发送 `X-Home-Ranking-Version: 2`，新 Worker 才使用
  `ranking_version=2`、九源及 live YouTube。
- 旧 Pages 不发送协商头；新 Worker 必须对它返回 `ranking_version=1` 和原八源候选集。因此
  `旧 Pages + 新 Worker` 不会把 YouTube 交给不认识该 source 的旧 renderer，也不会退回经典版。
- `新 Pages + 旧 Worker` 中旧 Worker 忽略协商头且没有 `ranking_version` 字段；新 Pages 把
  “字段缺失”精确归一为 legacy v1，同时仍拒绝其它非法版本。`新 Pages + 新 Worker` 才进入
  显式 v2。此矩阵是滚动发布和回滚的兼容边界。
- v2 在固定 `asOf` 内计算内容家族/来源重复惩罚、来源内年龄归一热度和稳定 keyset。
- 已打开页面携带的 v1 cursor 继续使用原八源候选集和原 v1 分数，响应保持
  `ranking_version=1`；cursor version 优先于协商头，禁止把 v1 cursor 悄悄升级到 v2。
- staging 固定先 Pages、后 Worker，并在两步之间验证 v1；生产仍只允许 `main` 的两个 CI
  工作流发布，协商矩阵保证其并发先后均安全。

## 3. 本地 G0

2026-07-18 在同一工作树完成：

- Dashboard unit：`348/348`。
- Worker Vitest：`50 files / 834 tests`。
- 根目录/运维 contracts：`175 pass / 2 environment-skips`。
- waterfall 本地 HTTPS 五设备：`30/30`。
- classic 五设备角色矩阵：`32 pass / 83 role-skips`。
- Dashboard lint、Dashboard/Functions/Worker TypeScript、production build：通过。
- 视觉检查：1440px PC 五列、390px 移动双列；无分类 Tab、无侧栏、无破图和横向溢出。
- 图片夹具先以空响应触发 `naturalWidth=0` 红测，再改为可解码方图并用同一断言转绿。
- staging 真实中文资讯卡暴露 no-JS SSR 比 row-span 预留高约 16px；已用失败回归测试固定该
  CJK 换行密度，并额外预留一个完整 grid row，避免卡片越过 masonry track。
- 已知非阻塞告警：既有 `TweetDrawer` minified chunk 大于 500KB；本批次未扩大该边界。

## 4. staging 同步门

2026-07-18 已完成同步 staging，最终对象与结果如下：

- 冻结源码：`7327fba5e687a7bcf664dea3ce7ef9c333a8aeb3`。
- Pages deployment：`7faca6bb-a1df-42e4-8015-e5eebb8c949d`，构建身份
  `0bb5cad1463328541fbee34e41117920648781f725783d20570a7bcc3b0811a9`。
- Worker version：`f4ee4d50-05f8-4304-88e4-697e1b1f3255`。
- 新 Pages + 旧 Worker 返回 legacy v1；旧 Pages + 新 Worker 保持 v1/八源；新 Pages + 新
  Worker 返回 v2。v1 cursor 重放继续为 v1 且无 YouTube，v2 两页各 24 条且 ID 重叠为 0。
- 九源临时夹具只用于 staging 验收；九个 source 均出现后已删除，复核
  `fixture_count=0`。清理后真实数据请求仍为 HTTP 200、`SSR=waterfall`、
  `ranking_version=2`，且不存在夹具标记。
- desktop 1440、tablet 820、iPhone Chromium/WebKit 390、Android 412 的远端门
  `20/20` 通过；密集 CJK row-span 修复后无越轨、横向溢出或 CLS。
- 每个 view/device/cache 各 10 次的性能门通过：desktop cold waterfall/classic LCP p75
  `1556/1872ms`（`-16.9%`），mobile cold `1532/1844ms`（`-16.9%`）；
  desktop warm `300/292ms`（`+2.7%`），mobile warm `280/276ms`（`+1.4%`）；
  waterfall CLS p75 `0`、请求数 p50 `16 vs 24`、传输 p50 约
  `135.77–139.58KB vs 317.41–323.27KB`。
- staging 决定：`GO`。尚未完成的发布门只有 PR 全绿、合入 `main`、生产工作流和生产即时验收。

部署前必须冻结并记录：

1. clean commit、相对最新 `origin/main` 的包含关系；
2. 当前 staging Worker version 与 Pages deployment；
3. 当前 flag/binding/secret **名称**，不记录值；
4. 新 Worker version、Pages deployment 及对应回滚对象。

验收必须覆盖：

- 新 Pages + 旧 Worker 的缺版本 legacy 响应归一为 v1 且不 fallback；再发布新 Worker 后同一
  fresh 请求返回显式 v2；
- 旧 Pages 语义（不带 `X-Home-Ranking-Version`）调用新 Worker 时仍返回 v1/八源；
- `/api/home-feed` 首屏 `ranking_version=2`、九源 live gating、固定 cursor 重放和跨页零重复；
- 人工构造/保留的 v1 cursor 仍返回 v1 且不出现 YouTube；
- desktop 1440、tablet 820、iPhone Chromium/WebKit 390、Android 412 五设备全绿；
- classic 默认和 classic E2E 不变；API/renderer 失败仍清偏好并退回经典版；
- `item_impression` 只含 allowlist 字段，任意附加字段在 Worker ingest 被删除；
- shadow reason 变化时条目数量、顺序、DOM 和 CLS 不变；
- classic/waterfall × mobile/desktop × cold/warm 每格 10 次，waterfall LCP p75 不比 classic
  差超过 10%，CLS p75 `<=0.1`，无横向溢出和非预期 4xx/5xx。

任一项失败为 `NO-GO`，不得进入 `main`。

## 5. 回滚与生产门

- staging 回滚：先关闭 `HOME_EXPERIENCE_ENABLED`，再回退 Pages deployment、Worker version，
  最后恢复本批次修改的远端配置；以经典首页 smoke 为终态。
- staging 全绿后才允许合入/推送 `main`，由现有 CI 发布生产；禁止 feature branch 手工部署生产。
- 生产即时门：默认经典、瀑布 opt-in、v2/v1 cursor、九源、五设备、深链、shadow-only、错误率与
  LCP/CLS 合成检查。
- 生产失败先用 kill switch 回经典，再按 Pages → Worker 回滚点恢复；`rollback_failed` 由 roxor
  独立接管。
- RUM 按 `view_mode × ssr_state × device × region` 观察 7–14 天；48 小时/100 LCP 样本只用于
  判断长期收益与是否另开正式个性化过滤，不阻塞本次代码和 opt-in 发布终态。
