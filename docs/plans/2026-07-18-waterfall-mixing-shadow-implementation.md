# Waterfall Mixing and Exposure Shadow Implementation Plan

> **For Codex:** REQUIRED SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 把 opt-in 瀑布流改成移动双列、PC 自适应多列、无侧栏与无分类 Tab 的来源感知紧凑卡片流，并上线确定性的全源公共混排和只记录不隐藏的曝光影子规则。

**Architecture:** Worker 在固定 `asOf` 候选窗口内完成来源家族去连排、来源内热度归一和稳定 keyset 分页；Dashboard 只消费服务端顺序，不在客户端二次洗牌。共享 SSR/SWR 始终保持公开可缓存，设备级历史仅在客户端计算 `would_filter` 并随全源曝光遥测上报，第一阶段绝不删除或重排卡片。

**Tech Stack:** Cloudflare Workers + D1/TypeScript、React 19、Vite SSR、CSS masonry row-span、Node test runner、Vitest、Playwright。

---

## Execution status

- Tasks 1–9：完成。Dashboard `348/348`、Worker `834/834`、root contracts
  `175 pass / 2 environment-skips`、waterfall 五设备 `30/30`、classic
  `32 pass / 83 role-skips`；lint、类型检查、production build 与双端截图均通过。
- Task 10：进行中。staging 同步、滚动兼容矩阵、九源/分页、五设备和 10-run 性能门已通过；
  临时九源夹具已清理且复核为 0。feature branch 尚未合入 `main`，生产尚未发布。
- 曝光过滤仍为 shadow-only；7–14 天 RUM 只决定后续是否单独开启个性化过滤，不阻塞本次 opt-in 发布。

## Guardrails

- 现有 classic 默认模式、搜索、详情抽屉、SSR fail-open 和深链协议不变。
- 第一阶段只发布公共混排与 shadow exposure；`would_filter` 只能进入有限枚举遥测，不能改变 API items、SSR HTML 或 hydrated DOM。
- 热度只做同来源、同候选窗口内的归一；禁止把 X likes、GitHub stars、Product Hunt votes 等原始值跨平台直接比较。
- 缺少热度数据按中性冷启动处理；热度加分封顶为等价 2 小时新鲜度。
- 所有行为代码严格按 red → green → refactor 实施；视觉原型作为用户明确要求的 throwaway HTML，不要求先写自动化测试。
- 本地和 staging 验收通过前不改 production 默认视图，也不开正式曝光过滤。

## Task 1: 修正并冻结双端视觉样例

**Files:**
- Modify: `docs/plans/_mockups/2026-07-18-waterfall-compact-cards.html`
- Modify: `docs/plans/2026-07-18-waterfall-compact-cards-design.md`

**Steps:**

1. 移除 PC 左侧栏和两端全部分类 chips/Tab，仅保留品牌、搜索和视图切换。
2. PC 内容区改为居中最大宽度，1440px 为五列；390px 保持固定双列 177px。
3. 用隐藏的来源家族顺序重新组织样例卡片，但不增加可见分类控件。
4. 在 390/768/1024/1440/1680 视口验证列数、无横向滚动、卡片独立边界和 DOM 顺序。

## Task 2: 修复共享曝光观察器的多卡回调

**Files:**
- Create: `dashboard/src/lib/telemetry/impressions.test.mjs`
- Modify: `dashboard/src/lib/telemetry/impressions.ts`

**Steps:**

1. 先写失败测试：两个元素分别注册回调，observer 触发时必须调用各自回调且互不覆盖。
2. 运行 `node --test dashboard/src/lib/telemetry/impressions.test.mjs`，确认失败原因是全局 callback 被后注册卡片覆盖。
3. 把 callback 存入每个元素的 observation state，删除全局 handler。
4. 重跑测试并覆盖取消观察、重复触发和未达 1 秒不触发。

## Task 3: 建立曝光影子规则与有限本地历史

**Files:**
- Create: `dashboard/src/home/exposureShadow.test.mjs`
- Create: `dashboard/src/home/exposureShadow.ts`

**Steps:**

1. 先写失败测试覆盖 source→family、普通曝光/强消费 cooldown、活动结束、无历史、损坏存储和 256 条上限。
2. 运行 `node --test dashboard/src/home/exposureShadow.test.mjs` 确认红灯。
3. 实现纯函数判定和版本化、30 天 TTL、最大 256 条的 localStorage 适配器。
4. 保证输出原因只来自 `none|impression_cooldown|consumed_cooldown|event_expired`，且任何存储失败均 fail-open。

## Task 4: 实现公共全源混排 v2

**Files:**
- Modify: `worker/src/home-feed.test.ts`
- Modify: `worker/src/home-feed.ts`
- Modify: `dashboard/src/types.ts`

**Steps:**

1. 先补失败测试：连续同家族/同来源降权、来源内热度 bonus、缺指标中性值、bonus 封顶、固定 `asOf` 重放、跨页无重复。
2. 运行 `npm --prefix worker test -- --runInBand src/home-feed.test.ts` 或仓库实际的定向等价命令，确认新断言失败。
3. 在 SQL 候选层计算隐藏 family、family rank、source rank 和 source-relative heat percentile。
4. 使用确定性分数：
   `sort_epoch - (family_rank - 1) * 7200 - (source_rank - 1) * 3600 + heat_bonus`
   ，其中 `0 <= heat_bonus <= 7200`，缺数据使用中性 3600。
5. 升级游标/响应 ranking version；新请求使用 v2，滚动发布前已打开页面的 v1
   游标继续按旧分数完成翻页并保持 v1，避免发布瞬间报错、错页或强制刷新。
6. 重跑定向与 worker 全量测试，记录查询时间回归。

## Task 5: 补齐 YouTube 与家族契约

**Files:**
- Modify: `worker/src/home-feed.test.ts`
- Modify: `worker/src/home-feed.ts`
- Modify: `dashboard/src/home/homeData.test.mjs`
- Modify: `dashboard/src/home/homeData.ts`
- Modify: `dashboard/src/types.ts`

**Steps:**

1. 先写失败测试：manifest live 时 YouTube 进入候选并映射 `video` 家族；非 live 时不进入。
2. 补齐 Worker source whitelist、Dashboard label/icon/card model 和 response parser。
3. 验证九源 API 顺序稳定且现有八源 fixture 不受影响。

## Task 6: 实现来源感知紧凑卡片

**Files:**
- Create: `dashboard/src/home/waterfallCardModel.test.mjs`
- Create: `dashboard/src/home/waterfallCardModel.ts`
- Modify: `dashboard/src/home/WaterfallCard.tsx`
- Modify: `dashboard/src/home/homeData.ts`
- Modify: `dashboard/src/home/waterfall.css`

**Steps:**

1. 先写失败测试覆盖 X、GitHub、Product Hunt、HF Paper、Blog、Podcast、ClawHub、活动和 YouTube 的身份、主文本、媒体与最多两个核心指标。
2. 实现无 JSX 的来源感知 view-model；缺字段必须有稳定降级，不能展示 `undefined` 或空指标壳。
3. 重写紧凑卡片，复用 `SourceIcon`、现有安全图片 URL、详情 href 与抽屉交互。
4. Product Hunt 流内只允许静态预览；首屏图片预算保持现状，其余 lazy-load。

## Task 7: 落地双端自适应瀑布布局

**Files:**
- Modify: `dashboard/src/home/home-ui.contract.test.mjs`
- Modify: `dashboard/src/home/WaterfallHome.tsx`
- Modify: `dashboard/src/home/waterfall.css`
- Modify: `dashboard/e2e/waterfall-home.spec.ts`

**Steps:**

1. 先把旧的“移动单列/PC 三列”契约改成 390 双列、768 三列、1024 四列、1440 五列、1680 六列，并断言无 sidebar/category Tab/大标题。
2. 运行 Node contract 测试，确认当前 CSS 红灯。
3. 删除大标题，保持紧凑 AppBar 和视图切换；内容区居中并限制最大宽度。
4. 调整 grid/row-span 和卡片边界，保持 DOM 顺序、键盘顺序与 reduced-motion。
5. 跑五设备 Playwright，断言列数、无溢出、CLS ≤ 0.1、SSR 12 卡和 load-more/drawer 回归。

## Task 8: 接入全源曝光和 shadow telemetry

**Files:**
- Modify: `dashboard/src/home/WaterfallCard.tsx`
- Modify: `dashboard/src/home/WaterfallHome.tsx`
- Modify: `dashboard/src/home/exposureShadow.test.mjs`
- Modify: `dashboard/e2e/waterfall-home.spec.ts`

**Steps:**

1. 先写失败测试：每张 waterfall card 在 50% 可见 1 秒后只上报一次独立事件。
2. 上报有限字段：`item_id`、`source`、`family`、`view_mode=waterfall`、`shadow_filter_reason`、`shadow_rule_version`。
3. 普通曝光写弱历史；打开详情、外链点击或有效播放写强消费历史。
4. 断言 shadow reason 无论为何都不改变卡片数量、顺序和布局。

## Task 9: 完整本地封板

**Files:**
- Modify as required by failures only.

**Steps:**

1. 运行 Dashboard Node contracts、Dashboard build、Functions tests、Worker tests/TypeScript、root contracts。
2. 运行 waterfall 五设备与 classic 回归；检查 console/page errors、键盘、reduced-motion、no-JS SSR、深链和 fail-open。
3. 比较修改前后的 SSR HTML 大小、首屏图片请求数、JS chunk 和本地 LCP/CLS；不得突破现有性能预算。
4. 保存命令、commit SHA、测试计数和已知非阻塞观察项。

## Task 10: staging、合并与生产发布

**Files:**
- Modify: `docs/reviews/waterfall-ssr-staging-change-packet.md`
- Modify: `TODO.md`

**Steps:**

1. 推送 feature branch，运行 CI，并部署到 perf-staging。Pages 请求用
   `X-Home-Ranking-Version: 2` 显式协商；无协商头的新 Worker 只返回 v1/八源。staging
   先 Pages、后 Worker 并验证中间态；新 Pages 将旧 Worker 缺失的 `ranking_version` 精确归一
   为 v1。生产并发工作流由同一兼容矩阵保护。
2. 在 staging 对 classic/waterfall × mobile/desktop 做功能、视觉、SSR、查询延迟和 synthetic 对照。
3. 确认公共混排 v2 生效、YouTube live gating 正确、shadow 只记录不隐藏，随后按既有 release gate 合入 main。
4. 生产保持 classic 默认、waterfall opt-in；即时冒烟和性能验证通过后关闭发布任务。
5. 生产 shadow 观察 7–14 天是发布后非阻塞任务；正式个性化过滤必须另开 feature flag、单独计划与批准。
