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

- `/Users/roxor/brain/30-projects/xlist-scraper/` 目前**非 git 仓库**（含 dashboard + worker + docs + data）
- `/Users/roxor/.claude/skills/xlist-scraper/` 是 git 仓库（scraper 脚本）
- 下次做需要严格流程的改动前，先在前者 init git 并把 `.gitignore` 配好（排除 data/、node_modules/、exports/）

### 发布前 checklist

- [ ] 不含敏感数据（cookie、API key、token、本地绝对路径）
- [ ] worker 改动：先本地 `wrangler dev` 验证 endpoint
- [ ] dashboard 改动：`npm run build` 无 error，dev server 手动 smoke
- [ ] scraper/processor 改动：小批量跑一次，看 DB 状态
- [ ] 涉及 D1 数据同步：确认 `push_to_cloud()` 已覆盖本地变更
- [ ] **远端服务变更同步更新运维文档**（见下方"运维手册"节），遗漏会导致跨 session 维护断档

## 技术要点

- **Cookie 解密**：从 Chrome Default profile 提取 x.com cookie（AES-128-CBC + macOS Keychain），注入到 Profile 1 的 browser-use 会话
- **浏览器**：browser-use Python API，用 Profile 1（体积小，~500MB）+ 注入 Default 的 cookie
- **翻译/过滤**：DeepSeek Chat API（OpenAI 兼容），批量处理
- **游标**：基于 tweet snowflake ID，存在 lists 表的 cursor 字段
- **分页容错**：每页暂存到 data/pages/，崩溃后自动恢复
- **停止条件**：遇到游标 / 超过 max(100, 当日推文数) / 连续无新内容

## SQLite Schema

- `lists` 表：list_id, name, url, cursor
- `tweets` 表：tweet_id, list_id, author(显示名), handle(@用户名), text(正文), created_at(发布时间), metrics(JSON), media(JSON 附件), scraped_at, is_ai(0/1/NULL), translated, emitted(0/1), quote_of_id, quote_of(JSON), link_card(JSON), thread_root_id, reply_to_id

## 架构概览（2026-04-17 更新）

```
[X List] → list_scraper.py (browser-use) → SQLite
                                              ↓
                                     tweet_processor.py (keyword + LLM 分类 + 翻译)
                                              ↓
                                     output.py → push_to_cloud() → Cloudflare Worker → D1
                                              ↓
                                     enrich_from_syndication.py (syndication API 补 quote/card/metrics/翻译)
                                              ↓
                                     Dashboard (React + Vite + Tailwind) → Cloudflare Pages
```

### Syndication API enrichment

scraper 的 DOM 抓取无法可靠识别引用推文（X 把 quote card 的 /status/ 链接去掉了）。
用 `cdn.syndication.twimg.com/tweet-result` API（react-tweet 同款）补全：
- `quote_of`: 被引用推文完整内容（作者/handle/content/media/published_at）
- `link_card`: URL 预览卡（title/description/domain/image）
- `metrics`: 互动数据刷新
- 翻译: quote_of.content + link_card.title/description → DeepSeek

脚本: `enrich_from_syndication.py --mode backfill-quotes|fill-translations|refresh-metrics|full`

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
