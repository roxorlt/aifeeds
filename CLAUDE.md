- [ ] # xList Scraper

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

- `/Users/roxor/brain/30-projects/xlist-scraper/` 已是 git 仓库（含 dashboard + worker + docs；`.gitignore` 排除 data/、node_modules/、exports/）。无 remote，本地分支管理
- `/Users/roxor/.claude/skills/xlist-scraper/` 是 git 仓库（scraper 脚本）
- 改动按"开 feature branch → 验证 → 合 main"流程走，两个仓库各自独立分支

### 发布前 checklist

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
- **翻译/过滤**：DeepSeek Chat API（OpenAI 兼容），批量处理
- **分页容错**：每页暂存到 data/pages/，崩溃后自动恢复
- **停止条件**：时间盒 / 连续无新增 / 已知覆盖率高（见下方"抓取停止条件"节）

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

## ⚠️ 自动化 Chrome 工作流统一规范（强制，跨 session 适用）

> 适用范围：**所有由本项目自动打开 Chrome 的 pipeline**——抓取（list_scraper）、长文补全（enrich_longform）、热度数据补全（refresh-metrics）、quote/link_card 补全、reply 补全、thread 补全、未来任何新加的浏览器侧补全任务。
>
> 核心原则：**自动化 Chrome 必须不影响用户正常办公**。窗口可以可见，但不能抢焦点；进程可以驻留，但绝不能 cron 跑完后泄漏 PPID=1 的孤儿。

### 1. 不抢用户焦点（焦点恢复模式）

- launch Chrome 之前，调用 `_snapshot_frontmost()` 抓取用户当前 frontmost 进程名（用 `osascript` + System Events）
- launch Chrome 之后立刻调用 `_push_chrome_to_back(prev_frontmost)`，把焦点还给用户原本在用的 app
- 每次 `bu open <url>` 之后也要再 push 一次（macOS Chrome 每次导航都可能 re-activate）
- 视觉效果：Chrome 是开着的、可见的，但被用户的窗口盖住，document.visibilityState 仍是 `visible`，JS 不被 throttle

### 2. ❌ 禁用 `set visible to false` / `osascript ... set visible to false`

- 历史教训：曾经用「set visible to false」把 Chrome 隐藏，后果：
  - Chrome 的 `document.visibilityState` 翻成 `hidden` → X 把 setTimeout/rAF 限频到 1Hz → JS eval 拿不到 tweet → 抓取卡死
  - `bu close --all` 在 hidden 状态下不可靠 → daemon 退出后 Chrome 子进程被 reparent 到 launchd（PPID=1）→ 跨 cron 周期累积成几十个 Chrome 孤儿，用户手动关不掉
- 正确做法：**用 push-to-back（焦点恢复）替代 hide**。Chrome 必须保持 visible，只是 z-bottom

### 3. ⚠️ 焦点恢复必须用 `open -a` 或 `tell app to activate`，**禁用** `set frontmost of process`

- 历史教训：最初用 `tell application "System Events" to set frontmost of process "X" to true`，结果 osascript 返回 rc=0 但 z-order 根本没变——Chrome 仍盖在前台干扰用户
- 根因：System Events 的 `set frontmost = true` 在 macOS 上**只翻一个内部 frontmost 标记位**，对 Electron / 跨平台 app（WeChat、VS Code、Slack、QQ 等）**根本不会真正抬起窗口**。看似成功，实则无效
- 正确做法（按可靠性优先）：
  1. **首选**：`open -a "<AppName>"`（走 NSWorkspace.launchApplication，对所有 app 类型都可靠抬窗）
  2. **兜底**：`osascript -e 'tell application "<AppName>" to activate'`（标准 Apple Event）
  3. **额外兜底**：在 push 之前先 `_snapshot_frontmost()` 看一眼，如果当前 frontmost 已经不是 Chrome（用户已自己切走），就跳过这次 push，避免抢用户当前 app 的焦点
- **不要**写"先 set frontmost、不行再降级"这种链路，第一招就用 `open -a`

### 4. 兜底关闭（kill-by-data-dir）

- 每个 pipeline 必须在 `finally` 块里：先 `bu close --all`，再 `_kill_chrome_by_data_dir(session_data_dir)`
- 为什么：browser-use daemon 的 Chrome 子进程在 setsid 后属于不同的进程组，SIGKILL daemon **不会**传染到 Chrome；只有按 `--user-data-dir=<temp_dir>` pgrep 命中才能精准杀掉本次 run 的 Chrome
- 写法：snapshot 启动前的 browser-use Chrome PID 集合 → 启动后跑业务 → 退出时 pgrep 命中 data-dir → SIGTERM → 等 2s → 残留 SIGKILL

### 5. launchd wrapper 兜底（多层防护）

- `cron.sh` / `longform-cron.sh` 等 launchd 拉起的 wrapper 必须有 PRE/POST PID diff 兜底，防止 Python 异常退出绕过 finally
- 不能只检测 PPID=1（browser-use daemon 主动 setsid，PPID=1 是正常态，不是孤儿信号）
- 必须用「本次 run 启动前 vs 退出时的 PID 集合 diff」识别真正的泄漏

### 实现模板

参考 `scripts/list_scraper.py` 中的 `_snapshot_frontmost`、`_push_chrome_to_back`、`_find_session_data_dir`、`_kill_chrome_by_data_dir`，以及 `scrape_list()` 的 `prev_frontmost` 串联方式。新写的 pipeline 直接 import / 抄过去，不要重新发明轮子，更不要走回 hide 那条路，也不要把 push 实现成 `set frontmost`。

### 验收标准

- 自动化任务跑起来时，用户能看到 Chrome 弹出又退到后面，全程不打扰前台 app（VS Code / 浏览器 / 终端 / WeChat 等）
- `tail -f data/cron.log data/longform-cron.log` 能看到 `[focus] restored frontmost: <AppName>`，且**用户实际感知到** Chrome 退到了后面（rc=0 不等于成功，必须用眼睛验证 z-order）
- 任务结束后 `pgrep -f browser-use-user-data-dir-` 返回空
- launchd 跑了 N 个周期之后，`pgrep -f browser-use-user-data-dir- | wc -l` 仍然是 0

## SQLite Schema

- `lists` 表：list_id, name, url, cursor
- `tweets` 表：tweet_id, list_id, author(显示名), handle(@用户名), text(正文), created_at(发布时间), metrics(JSON), media(JSON 附件), scraped_at, is_ai(0/1/NULL), translated, emitted(0/1), quote_of_id, quote_of(JSON), link_card(JSON), thread_root_id, reply_to_id

## 架构概览（2026-05-04 更新）

```
[X List]            → list_scraper.py (browser-use)            ─┐
[GitHub trending]   → CF Worker runGithubFetchTrending           ├→ /api/ingest → D1 (items 表统一 schema)
[Product Hunt]      → scrapers/ph/scraper.py (browser-use)      ─┘                    ↓
                                                                          (源专属字段全在 extra JSON)
                                                                                       ↓
X 增量补全：worker cron */5 → backfill-quotes / refresh-metrics / fill-translations / detect-longform
PH 资源迁移：worker/src/ph.ts → R2 (logo/screenshot/video/avatar) + /r/<key> 反代
                                                                                       ↓
                                                              Dashboard (React + Vite + Tailwind) → CF Pages
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

**位置**：[docs/frontend-ux-guidelines.md](docs/frontend-ux-guidelines.md)

**基线**：以 X List 卡片（`TweetCard.tsx`）的视觉风格为整站标准。GitHub 卡片 / Drawer / 弹窗 / 设置页 / 未来源都要向它对齐。

**强制约定**：

- **写新前端组件 / 改现有组件之前必须读这份规范**（设计 token、按钮 variant、表单错误位置、模态结构等）
- 颜色、字号、间距、圆角、阴影、转场都按规范的 token，不出现 `text-[14px]` / `bg-blue-600` / 自创色彩这类离群值
- 业务真需要规范外的元素（新色 / 新字号 / 新组件），先在规范文档里讨论 + 加进去，再实施
- 检查清单见规范文档第六节，提交 dashboard 改动前对照过一遍

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
