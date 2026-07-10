# aifeeds Codex 项目指南

> 本文件是 Codex 在本仓库的入口说明，适用于整个仓库。它由根目录
> `CLAUDE.md` 按 Codex 的工具、技能和协作方式改写而来；项目事实以当前代码、
> `docs/operations.md` 和 `TODO.md` 为准，避免照搬历史上已经失效的说明。

## 项目身份

- 产品名：`aifeeds`。
- 生产环境：前端 `https://ai-feeds.com`，Worker API `https://api.ai-feeds.com`。
- Staging：前端 `https://staging.ai-feeds.com`，API `https://staging-api.ai-feeds.com`。
- GitHub 私有仓：`roxorlt/aifeeds`；`origin/main` 是协作与 CI 基线。
- Cloudflare 资源沿用历史 `xlist-` 前缀：Worker `xlist-api`、Pages
  `xlist-dashboard`、D1 `xlist`；staging 使用对应 staging 资源。
- 当前主要数据源与架构以 `docs/operations.md` 的“架构总览”和端点清单为准。

## Session 开始检查

1. 读本文件。
2. 读 `TODO.md` 的“进行中”和与任务有关的条目。
3. 读 `docs/operations.md` 与任务相关的架构、部署、故障记录；远端或性能任务至少读
   “三环境”“自定义域名与 DNS”“香港中转加速”“Web Analytics”“健康检查”。
4. UI 任务必须读 `docs/frontend-ux-guidelines.md` 和 `docs/design-handoff.md`。
5. 检查 `git status --short --branch`、当前分支、`origin/main` 差异与现有 worktree；
   不覆盖用户或其他任务的未提交改动。

## Secret 管理（强制）

- 唯一来源：`.secrets/aifeeds-prod.env` 与 `.secrets/aifeeds-staging.env`。
- 禁止创建散落 `.env`，禁止把 secret 值写入代码、日志、测试、文档或回复。
- 新增 secret 只加入上述环境文件，并同步维护 `.secrets/README.md` 与
  `docs/operations.md`；CI 需要的 secret 还要按运维手册同步 GitHub Actions。
- 运维命令应 `set -a` 后 source 整个环境文件，确保
  `CLOUDFLARE_ACCOUNT_ID` 等关联变量完整注入；不要用 grep 单挑 token。
- 诊断 account-scoped Cloudflare token 时使用 account 级 API；不要用
  `/user/tokens/verify` 误判 token 失效。
- 不要假设历史 `xlist-scraper` Claude skill 存在；它已删除，项目不依赖它。

## 开发流程

所有 feature、bugfix、行为变化都必须从最新 `main` 建分支；Codex 默认使用
`codex/<type>-<topic>`，并优先在已忽略的 worktree 中隔离工作。

1. `git fetch origin main`，确认本地 `main` 与 `origin/main` 的关系。
2. 建分支/worktree，不直接改 `main`。
3. 先复现或写失败测试，再实现最小修复；不把无关清理混进同一分支。
4. 按风险运行分层验证，并保留完整输出。
5. review diff，确认没有 secret、本地绝对路径、生成物或无关文件。
6. 只有用户明确要求时才 push、开 PR 或部署。生产部署只从 `main` 走 CI；不要从
   feature branch 手动发布 prod。

### 验证分层

- Dashboard：至少 `cd dashboard && npm run build`，相关自动化测试，以及 PC/移动断点
  浏览器 smoke。全仓 lint 若有基线债务，要区分既有问题与本次新增问题。
- Worker：运行相关 Vitest；需要集成时用 `wrangler dev` 或 staging，禁止直接拿 prod
  当试验场。
- Scraper/processor：先 dry-run，再小批量 `--limit N`，检查落盘与幂等。
- Dashboard + Worker 协议同时变化：必须同步在 staging 验证，不能单边发布。
- D1 migration：先 staging、验证后 prod；任何 prod 数据写入或迁移需用户明确授权。

## Codex 技能路由

当可用技能与任务匹配时，先读取并遵循对应 `SKILL.md`，不要照搬 Claude 专属 skill
名称：

- 新功能、交互或视觉行为：先用 `brainstorming`；需求/设计已由用户明确批准时，可把
  已批准方案记入计划后直接实施。
- 多步骤实现：`writing-plans`；执行计划时使用适用的执行技能。
- 功能或 bugfix：`test-driven-development`，必须看到预期失败后再写生产实现。
- Bug、性能和线上异常：`systematic-debugging`，先定位根因，不先猜修复。
- Web 动效评审/修改：`review-animations`，遵循精确时长、缓动、GPU、手势与
  reduced-motion 标准。
- 浏览器实测：优先 `browser:control-in-app-browser`；手势最终必须补真机验收。
- 完成、提交或交付前：`verification-before-completion`。

## Dashboard 设计与动效基线

- 内容优先、UI 沉静；灰阶为主，品牌橙只用于 Logo。
- 以 `TweetCard.tsx` 为卡片基线；颜色、字号、间距、按钮和错误态遵循
  `docs/frontend-ux-guidelines.md`。
- UI chrome 使用项目 `icons.tsx` 的 lucide 风格 SVG；emoji 只能来自源内容。
- 仅动画 `transform` 和 `opacity`。进入/退出使用强 ease-out
  `cubic-bezier(0.23, 1, 0.32, 1)`；在屏移动用
  `cubic-bezier(0.77, 0, 0.175, 1)`；Drawer 使用
  `cubic-bezier(0.32, 0.72, 0, 1)`。
- 普通 UI 小于 300ms；Popover 125–200ms，Dropdown 150–250ms，Modal/Drawer
  200–500ms。频繁动作应删除或大幅弱化动效。
- 手势必须跟手、可反向打断，并有速度阈值、边界阻尼、pointer capture/多指保护。
- 所有位移动效遵循 `prefers-reduced-motion`；Hover 位移必须限制在
  `(hover: hover) and (pointer: fine)`。
- 键盘高频动作即时响应；例如 Escape 关闭 Lightbox/Drawer 不等待退出动画。

## 前端架构要点

- Dashboard：React 19 + Vite 8 + Tailwind 4，位于 `dashboard/`。
- Dev 的 `/api` 与 `/r` 默认代理 staging；临时目标用 `VITE_API_PROXY`，不要复制一份
  API base 判断。公共解析统一复用 `dashboard/src/lib/apiBase.ts`。
- 生产前端、API、字体经香港 VPS nginx 中转；staging 仍直连 Cloudflare。任何性能
  判断都必须区分冷首开/Service Worker 回访、HTML/API/图片，以及大陆/海外样本。
- Service Worker 只缓存 SPA 壳与哈希 assets，不拦 API、图片、字体、Range 视频和
  SEO 静态路由。修改 SEO 路由时同步 worker、nginx 权威副本和 `public/sw.js`。
- Drawer 为 lazy chunk；不要让 markdown、海报、登录等低频依赖重新进入首屏 bundle。

## Worker 与数据约束

- 远端 D1 是数据真相源；本地 SQLite 只是抓取暂存。
- 新数据源复用 `items` 大一统 schema、完整性 gate、source-specific extra 和前端三件套；
  详细 SOP 见 `docs/source-integration-sop.md`。
- 所有搜索、推荐、静态页和新内容出口必须复用已有相关性、软删除、去重与涉华合规过滤。
- DeepSeek 默认使用项目现有 flash 配置处理翻译、分类和轻抽取；只有明确需要复杂多步
  推理时才使用 pro，并在 PR 说明成本和理由。
- 任何 endpoint、cron、D1 表、远端资源、secret 或运维流程变化必须同步
  `docs/operations.md` 与相关 TODO/设计文档。

## 发布边界

- Prod 默认由 GitHub Actions 在 `main` push 后部署；feature branch 不部署 prod。
- Staging 手动验证前先确认分支包含最新 `origin/main`，避免 Cloudflare 整包发布回退
  其他人的代码。
- 发布 Dashboard 前运行 build 与浏览器 smoke；视觉改动对照 UX checklist。
- 发布 Worker 前验证 endpoint、CORS、环境变量、staging；涉及 Dashboard 协议时同步发布。
- 本任务未明确包含发布时，停在本地分支与验证结果，不 push、不开 PR、不部署。

## 文档维护

- 当前工作与状态更新同步 `TODO.md`。
- 运维事实更新同步 `docs/operations.md`。
- 设计与实现计划放在 `docs/plans/YYYY-MM-DD-<topic>.md`。
- 文档中只写仓库相对路径和公开 URL，不写本机绝对路径或任何 secret 值。
