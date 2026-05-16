- [ ] # aifeeds（产品名）

> **项目身份卡**（每次新 session 必读）
>
> - **项目名**：`aifeeds`（产品代号）。本地目录 `~/brain/30-projects/aifeeds/`。
> - **公网**：`https://ai-feeds.com`（前端）/ `https://api.ai-feeds.com`（worker）
> - **CF 资源命名**（保留历史 `xlist-` 前缀，迁移成本太高）：worker = `xlist-api` / Pages = `xlist-dashboard` / D1 = `xlist`（staging 是 `xlist-staging`）
> - **数据源现状（4 个）**：X 走 ScrapeBadger API / GitHub trending 走 GH API / Product Hunt 走 PH GraphQL API + worker cron / ClawHub 走 Convex
> - **GitHub 私有仓**：`roxorlt/aifeeds`（备份用，CICD 待接）
> - **Token 速查**：见 `docs/operations.md` § 4「运维 Token 速查」
>
> **🔐 Secret 管理（强制约定，2026-05-16 OPS 事故后统一改造）**：
> - **唯一源**：本项目所有 secret 只在 2 个文件 — `.secrets/aifeeds-prod.env`（prod）/ `.secrets/aifeeds-staging.env`（staging）
> - **禁止再建散落 .env 文件**（admin-prod / cf-claude-ops / cf-ops / gh-claude-ops / ph-oauth-prod / staging-ingest-token 等历史散文件 2026-05-16 已合并 + 全部删除）
> - **新增 secret** 时加到上面对应文件，OPS 部署 / 注入 / 验证 / 恢复脚本一律 `source .secrets/aifeeds-{prod,staging}.env`
> - **跨项目共享 token**（CF master / GH PAT 等）也在本项目文件保留副本 — aifeeds 用到啥就有啥，简单 > DRY
> - 详见 `.secrets/README.md`（文件结构 + 维护规则 + OPS 常用 source 模式）+ `docs/operations.md` §3「Secrets」
>
> **不要做的事**：
> - ❌ 不要假设 `~/.claude/skills/xlist-scraper/` 存在 — 那个 skill 已于 2026-05-10 删除（含本地目录 + GitHub 公开仓）。aifeeds 跟它没任何依赖关系，名字相似纯属历史巧合。
> - ❌ 不要把任何 secret 值写到 docs / CLAUDE.md / 设计文档里 — 只引用文件路径（`.secrets/aifeeds-prod.env` / `.secrets/aifeeds-staging.env`）。所有 token 来源 + 再生方式见 operations.md § 3 / § 4。
> - ❌ 不要新建散落 `.env` 文件存 secret（违反上方强制约定）；新增 secret 加到统一文件
> - ❌ 不要在没 review diff 的情况下 push 到 GitHub — 私有仓也要防 secret 写错。
> - ❌ 不要混淆 prod 域名 `api.ai-feeds.com` 和 staging `staging-api.ai-feeds.com`。运维操作前确认目标环境。

---

X (Twitter) List 抓取工具。自动抓取 List 中的 AI 相关推文，翻译英文为中文，存入 SQLite。

## 目录结构

```
data/
  xlist.db          SQLite 数据库（lists + tweets 表）
  pages/            分页抓取临时缓存（崩溃恢复用，正常完成后自动清理）
exports/
  YYYY-MM-DD-{list_id}.md   每次抓取导出的 AI 相关推文 markdown
docs/
  plans/            设计文档
```

## 使用方式

通过全局 skill `/xlist-scraper` 触发，或直接运行：

```bash
~/.browser-use-env/bin/python3 ~/.claude/skills/xlist-scraper/scripts/main.py <list_id_or_url>
```

## 开发流程（强制）

任何新 feature / bug 修复 / 改动线上行为的任务，**必须**走以下流程，不能直接在 main 上改：

1. **开分支**：从 main 开 feature branch，命名 `feat/xxx`、`fix/xxx`、`chore/xxx`
2. **本地测试**：改动落盘后，按"验证分层"跑通对应层次：
   - 纯前端：`npm run build` + dev server 手动 smoke（icon/copy/交互）
   - scraper / processor：小批量跑 `--limit N` 验证，检查 DB 落盘
   - worker：`wrangler dev` 本地起，curl endpoint 验证
   - 翻译 / enrich：先 `--dry-run` 看候选，再小批量跑验证
3. **合版**：PR 审核通过后合到 main
4. **上线**：只从 main 发布
   - Worker：`cd worker && npx wrangler deploy`
   - Dashboard：`cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard`
   - Scraper：无需发布（直接跑脚本）

### 何时可以跳过分支

- 纯文档修改（CLAUDE.md、TODO.md、docs/）
- 紧急修 prod 事故（事后补 PR 说明）
- 本项目尚未 init git 的阶段可暂时直接改，但**一旦 init 就必须严格遵守**

### 本项目 git 状态

- `/Users/roxor/brain/30-projects/aifeeds/` 已是 git 仓库（含 dashboard + worker + docs；`.gitignore` 排除 data/、node_modules/、exports/）。无 remote，本地分支管理
- `/Users/roxor/.claude/skills/xlist-scraper/` 是 git 仓库（scraper 脚本）
- 改动按"开 feature branch → 验证 → 合 main"流程走，两个仓库各自独立分支

### 发布前 checklist

- [ ] **rebase 检查**：部署 staging 或 prod 前必须确认当前 branch 已 rebase 上最新 main（多 session 并行时尤其关键，避免覆盖别人的改动）。即使是 prod 紧急 hotfix 直接在 main 改，也要先 `git log --oneline main..HEAD` 看是否落后；多 worktree 并行时主仓库 HEAD 可能被切动，部署前 `git status` + `git rev-parse HEAD` 确认在预期 branch 上
- [ ] 不含敏感数据（cookie、API key、token、本地绝对路径）
- [ ] worker 改动：先本地 `wrangler dev` 验证 endpoint
- [ ] **worker 改动：deploy staging 验证（`wrangler deploy --env staging`）再合 main 部署 prod**（PR3 翻车教训：dashboard 升级 fetch credentials，worker CORS 没跟上 → prod 全挂）
- [ ] dashboard 改动：`npm run build` 无 error，dev server 手动 smoke（dev 默认连 staging worker）
- [ ] **dashboard 视觉改动：对照 `docs/frontend-ux-guidelines.md` 检查 token / 组件规范**（颜色、字号、间距、按钮 variant、错误位置等不能跑偏）
- [ ] **dashboard + worker 同时改：必须同步部署 staging 验证 → 同步部署 prod**（不要单边升级）
- [ ] **D1 schema 变更：先 staging 跑 migration（`wrangler d1 execute xlist-staging --env staging --remote --file=migrations/0NN.sql`），验证后再 prod**
- [ ] scraper/processor 改动：小批量跑一次，看 DB 状态
- [ ] 涉及 D1 数据同步：确认 `push_to_cloud()` 已覆盖本地变更
- [ ] **远端服务变更同步更新运维文档**（见下方"运维手册"节），遗漏会导致跨 session 维护断档

## 技术要点

- **Cookie 解密**：从 Chrome Default profile 提取 x.com cookie（AES-128-CBC + macOS Keychain），注入到 Profile 1 的 browser-use 会话
- **浏览器**：browser-use Python API，用 Profile 1（体积小，~500MB）+ 注入 Default 的 cookie
- **翻译/过滤/LLM 判别**：DeepSeek API（OpenAI 兼容），批量处理。**模型选型**见下方"DeepSeek 模型选型"节
- **分页容错**：每页暂存到 data/pages/，崩溃后自动恢复
- **停止条件**：时间盒 / 连续无新增 / 已知覆盖率高（见下方"抓取停止条件"节）

### DeepSeek 模型选型（所有 LLM 任务通用）

文档：https://api-docs.deepseek.com/zh-cn/

| 场景 | 模型 | 选型理由 |
|------|------|---------|
| **翻译**（summary / changelog / 推文 / 文章正文 / README 等）| `deepseek-v4-flash` | 简单转写任务，要求时效高、批量并发，flash 足够 |
| **AI 相关性判别**（is_relevant 二分类，X / GH / PH）| `deepseek-v4-flash` | 单分类轻量任务，flash 足够 |
| **简短结构化抽取**（ai_category / ai_summary 等单字段填充）| `deepseek-v4-flash` | 同上 |
| **复杂推理任务**（多步比较、综合分析、长上下文判断、需要 chain-of-thought）| `deepseek-v4-pro` | 推理深度优先，时效次要 |
| **文档关系图谱抽取 / 跨内容综合 / 主题自动归类**（未来场景）| `deepseek-v4-pro` | 同上 |

**默认 fallback**：拿不准就用 `deepseek-v4-flash`；只有明确判断"需要深度推理 + 不在意 5-10s 延迟"时才升 pro。

**配置位置**：
- Python（scrapers/）：`scrapers/_lib/config.py` 的 `DEEPSEEK_MODEL`
- Worker（worker/src/）：各业务文件顶部的 `DEEPSEEK_MODEL` 常量（如 `worker/src/github.ts`、`worker/src/enrich.ts`）

**统一规范**：新加的源/任务遵循上表，不要凭感觉乱挑模型。如有"必须升 pro"的复杂场景，先在 PR 里写清楚理由。

### ⚠️ 抓取停止条件：禁用 ID 游标（反复踩过的坑）

**核心事实**：X list 页面的默认排序是**热度排序**（For You / Top），**不是时间倒序**，**不是 ID 倒序**。
这意味着：

- 往下滚 ≠ ID 依次变小
- 新热的 tweet 可能 ID 比"更老但冷门"的 tweet 大
- 一个 batch 里会同时出现 2025-10 的老爆款 + 2026-04 的新帖

**禁止的做法**（已经讨论过很多次，别再提了）：

- ❌ 基于 `tweet_id ≤ last_max_tweet_id` 做早停
- ❌ 把 snowflake ID 当成 "pagination cursor" 来判断"是否已经翻过"
- ❌ 把 `lists.cursor` / `lists.last_max_tweet_id` 列当 ID 边界用（这些列的存在是历史包袱，不要依赖）

**允许的停止信号**（都是 sort-agnostic，热度乱序下也成立）：

1. **连续 N 个 batch 都是"0 new-to-DB"**：`known_ids` 命中率 100% 持续 N 轮 → feed 已耗尽新内容
2. **已知覆盖率 ≥ 阈值持续 K 轮**：例如最近 3 个 batch 里 ≥80% 的 tweet 都在 DB 里 → 已经在反复看老货
3. **时间盒**：整轮超过 T 秒强制结束（当前 30 分钟，可以收紧到 5-10 分钟）
4. **滚动轮数上限**：超过 M 次 scroll 直接停（粗粒度兜底）

如果某 PR 里出现"根据 tweet_id 判断是否过了游标"这种逻辑，就是走错了路，打回重写。

## 自动化 Chrome 工作流（已退役 2026-05-06，规范归档）

X 抓取已全量切到 ScrapeBadger API，本地 launchd（`com.xlist-scraper.cron` / `.tune` / `.longform`）已 unload。
完整规范（5 条焦点 / 关闭 / launchd 兜底踩坑）见 [`docs/archive/automation-chrome-rules.md`](docs/archive/automation-chrome-rules.md)。

**何时回头看这份归档**：接入新数据源（YouTube / Podcast / arXiv 等）需要本地 chrome 抓取，或 SB 需要回滚到本地流程时。**默认不加载这套 prompt**，避免新 session 误以为这套规则还在用。

## SQLite Schema

- `lists` 表：list_id, name, url, cursor
- `tweets` 表：tweet_id, list_id, author(显示名), handle(@用户名), text(正文), created_at(发布时间), metrics(JSON), media(JSON 附件), scraped_at, is_ai(0/1/NULL), translated, emitted(0/1), quote_of_id, quote_of(JSON), link_card(JSON), thread_root_id, reply_to_id

## 架构概览（2026-05-05 更新）

```
[X List]            → list_scraper.py (browser-use)            ─┐
[GitHub trending]   → CF Worker runGithubFetchTrending           ├→ /api/ingest → D1 (items 表统一 schema)
[Product Hunt]      → CF Worker runPhDailyFetch (GraphQL API)   ─┤                    ↓
[ClawHub]           → CF Worker runClawhubFetchList             ─┘    (源专属字段全在 extra JSON)
                                                                                       ↓
X 增量补全：worker cron */5 → backfill-quotes / refresh-metrics / fill-translations / detect-longform
PH 增量加工：worker cron */5 → ph-enrich (DeepSeek) → fill-translations → ph-r2-migrate
PH 资源迁移：worker/src/ph-r2.ts → R2 (logo/screenshot/video/avatar) + /r/<key> 反代
                                                                                       ↓
                                                              Dashboard (React + Vite + Tailwind) → CF Pages

[分享]：dashboard 抽屉「分享」按钮 → /api/share/create (cookie auth) → share_relations
        → /api/share/poster/:token (resvg-wasm + Noto SC 子集 + R2 海报缓存)
        → /s/:token (302 redirect 到详情页 + 落地回流统计)
```

数据源接入流程（新源）：见 `docs/source-integration-sop.md`（PH 接入即按这套 7 阶段 SOP 走完，可复用）。

### Syndication API enrichment

scraper 的 DOM 抓取无法可靠识别引用推文（X 把 quote card 的 /status/ 链接去掉了）。
用 `cdn.syndication.twimg.com/tweet-result` API（react-tweet 同款）补全：
- `quote_of`: 被引用推文完整内容（作者/handle/content/media/published_at）
- `link_card`: URL 预览卡（title/description/domain/image）
- `metrics`: 互动数据刷新
- 翻译: quote_of.content + link_card.title/description → DeepSeek

脚本: `enrich_from_syndication.py --mode backfill-quotes|fill-translations|refresh-metrics|full`

## 前端 UX 规范

**组件规范**：[docs/frontend-ux-guidelines.md](docs/frontend-ux-guidelines.md)（token / variant / 错误位置 / 模态结构）
**设计决策**：[docs/design-handoff.md](docs/design-handoff.md)（品牌色 / HarmonyOS Sans SC 字体 / lucide 图标 / Logo / AppBar / 登录弹窗等）— **做 UI 改动前先读**

**基线**：以 X List 卡片（`TweetCard.tsx`）的视觉风格为整站标准。GitHub 卡片 / Drawer / 弹窗 / 设置页 / 未来源都要向它对齐。

**强制约定**：

- **写新前端组件 / 改现有组件之前必须读这份规范**（设计 token、按钮 variant、表单错误位置、模态结构等）
- 颜色、字号、间距、圆角、阴影、转场都按规范的 token，不出现 `text-[14px]` / `bg-blue-600` / 自创色彩这类离群值
- 业务真需要规范外的元素（新色 / 新字号 / 新组件），先在规范文档里讨论 + 加进去，再实施
- 检查清单见规范文档第六节，提交 dashboard 改动前对照过一遍
- **⚠️ emoji 不准当 icon 用**（mockup + 真实代码都不行）：UI chrome 一律 SVG（lucide-react 同款）；emoji 仅允许出现在「源数据原文」（如用户推文 / skill emoji 字段）。详细规则见 [`docs/source-integration-sop.md`](docs/source-integration-sop.md) § 4.5 F

## 三环境（dev / staging / prod）

- **设计文档**：[docs/plans/2026-05-03-staging-environment-design.md](docs/plans/2026-05-03-staging-environment-design.md)
- **vibe coder 教程**（推荐先看这份）：[docs/dev-staging-prod-guide.html](docs/dev-staging-prod-guide.html)
- **资源对照表**：见 [docs/operations.md](docs/operations.md) §「Staging 环境」节

URL：
- Prod: `https://ai-feeds.com` / `https://api.ai-feeds.com`
- Staging: `https://staging.ai-feeds.com` / `https://staging-api.ai-feeds.com`
- Dev: `localhost:5173`（vite proxy 默认连 staging worker）

## 运维手册

**位置**：[docs/operations.md](docs/operations.md)

**内容**：所有远端服务（CF Worker / D1 / Pages）+ 本地服务（launchd / 手动脚本 / 数据目录）+ secrets 的完整清单，以及部署、查日志、停启任务、手动触发等常用运维命令。

**维护强制约定**（本项目最大的跨 session 维护风险就是"改完代码忘了写文档"）：

- **任何远端服务变更都必须同步更新 operations.md**，包括：
  - 新增/删除/改名 Worker、新增/修改 endpoint、改 cron 频率或 limit
  - 新增/修改 D1 表或 schema
  - 新增/删除 Pages 项目
  - 新增/旋转 secrets
  - 新增/删除本地 launchd agent 或手动脚本
- **session 开始流程**：先读 `docs/operations.md` 了解 stack 现状 → 再读 `docs/TODO.md` 了解待办
- **发布前 checklist** 已加入"operations.md 是否同步改了"这一项，PR 审核时也要把这个当必查项

## 待办

见 [TODO.md](TODO.md)。每个 session 开始时先读 TODO.md 了解当前待办状态。任务的新增、完成、删除必须同步更新 TODO.md。

## 字段映射（scraper → DB）

scraper 输出的 dict 字段名和 DB 列名不同，`output.py` 的 `save_to_db()` 负责映射：

| scraper 字段 | DB 列 |
|-------------|-------|
| author_name | author |
| author_handle | handle |
| content | text |
| published_at | created_at |
| attachments | media |

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
