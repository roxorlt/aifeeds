# 瀑布流视觉与公共混排 v2 发布清单

日期：2026-07-18

状态：`LOCAL GO / STAGING PENDING`

分支：`codex/waterfall-compact-card-prototype`

## 1. 用户面与发布边界

- 经典首页继续为默认；瀑布流仍只由有效 `?view=waterfall` 或 `aifeeds_view=waterfall` cookie 进入。
- 移动端固定双列；PC 随内容区显示 3–6 列，1440px 为五列；两端均无左侧栏和分类 Tab。
- 九个来源完全混排，卡片内部保留来源身份；点击继续打开既有详情抽屉和可复制深链。
- 本次只发布公共排序 v2 与曝光 shadow。shadow decision 不得删除、隐藏或重排任何 SSR/客户端卡片。
- 没有 D1 migration、回填、正式个性化过滤或默认视图切换。

## 2. Worker/Dashboard 滚动兼容

- 新的无 cursor 请求使用 `ranking_version=2`，候选包含九源及 live YouTube。
- v2 在固定 `asOf` 内计算内容家族/来源重复惩罚、来源内年龄归一热度和稳定 keyset。
- 已打开页面携带的 v1 cursor 继续使用原八源候选集和原 v1 分数，响应保持
  `ranking_version=1`；禁止把 v1 cursor 悄悄升级到 v2。
- Dashboard 同时接受 v1/v2；新 Dashboard 对旧 Worker 的缺失/非法 v2 响应保持既有 fail-open。
- 发布顺序固定为 staging Worker → staging Pages；生产仍只允许 `main` 的 CI 工作流发布。

## 3. 本地 G0

2026-07-18 在同一工作树完成：

- Dashboard unit：`346/346`。
- Worker Vitest：`50 files / 832 tests`。
- 根目录/运维 contracts：`175 pass / 2 environment-skips`。
- waterfall 本地 HTTPS 五设备：`30/30`。
- classic 五设备角色矩阵：`32 pass / 83 role-skips`。
- Dashboard lint、Dashboard/Functions/Worker TypeScript、production build：通过。
- 视觉检查：1440px PC 五列、390px 移动双列；无分类 Tab、无侧栏、无破图和横向溢出。
- 图片夹具先以空响应触发 `naturalWidth=0` 红测，再改为可解码方图并用同一断言转绿。
- 已知非阻塞告警：既有 `TweetDrawer` minified chunk 大于 500KB；本批次未扩大该边界。

## 4. staging 同步门

部署前必须冻结并记录：

1. clean commit、相对最新 `origin/main` 的包含关系；
2. 当前 staging Worker version 与 Pages deployment；
3. 当前 flag/binding/secret **名称**，不记录值；
4. 新 Worker version、Pages deployment 及对应回滚对象。

验收必须覆盖：

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
