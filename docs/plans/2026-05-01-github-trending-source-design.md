# 设计：GitHub Trending AI 源接入

生成时间：2026-05-01
状态：设计已确认，待实施
分支：`feat/github-trending-source`
mockup：`docs/plans/_mockups/2026-05-01-github-card-mockup.html`
依赖关系：第一个 X 之外的源，验证多源管道骨架

---

## 1. 目标与范围

xlist-scraper 此前只有 X List 一个源。本设计接入 5 个新源中的第 1 个：**GitHub trending AI projects**。

**ACB 优先级**（用户黏性 > 内容差异化 > 入口扩展）下，GitHub 是首选：高频更新（每日有新内容）、跟现有 X 受众（程序员/研究者）人群重叠最高、实现成本最低（HTML scrape 无需 OAuth）。同时它**作为首个非 X 源，要把 schema / 卡片 / drawer / URL routing / 分享回流的多源骨架落地**，后续 PH / arXiv / YouTube / 播客直接套用同套模式。

非目标（留给后续）：
- 其他 4 个源接入
- README 中文翻译的 enrich pipeline（设计在内，但实施留 v2）
- Stars 趋势 sparkline（需要至少 7 天历史数据，留 v2）

---

## 2. 抓取策略

### 数据源
- URL: `https://github.com/trending?since=daily`（无 language 限制）
- 工具：`requests + BeautifulSoup`，**不用 browser-use**（静态 HTML，省 Chrome 资源）
- 频率：BJT 01:00 + 13:00 各一次（每天 2 跑）

### 流程

```
1. cron 触发
   ↓
2. fetch trending HTML，解析 ~25 条
   每条提取：owner/repo, description, language, total_stars,
            today_stars, contributors avatars[], sponsor 标记
   ↓
3. 对每条：先查 DB owner_repo 是否已存在
   - 存在 → append 一行 metrics + update last_seen_on_trending_at（不重跑 LLM）
   - 不存在 → 进 4
   ↓
4. 对新 repo（含 sponsor）：
   a. fetch README via raw.githubusercontent.com（main / master 两种 branch fallback）
   b. fetch /repos/:owner/:repo via GitHub API（带 token）拿
      forks_count, subscribers_count(watchers), open_issues_count,
      license, latest commit time, license SPDX
   c. 调 DeepSeek V4 Flash 一次：传 metadata + README 全文 →
      输出 {is_ai, ai_category, ai_summary}
   d. README 语言判定（CJK 占比 ≥ 30% → 'zh'，否则 'en'/'other'）
   e. INSERT 主表 + 第一行 metrics
   ↓
5. cron 跑完后 batch 重排：当日所有 is_ai=1 AND sponsor=0 按 today_stars
   倒序 ROW_NUMBER → update daily_rank
   ↓
6. push_to_cloud → D1
```

### 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 不限 language | ✅ | Rust/Go/TS 的 AI infra 项目（vllm/burn/ollama）也要收 |
| sponsor 也过 LLM | ✅ | 管理员后台需要解读判断是否手动外显 |
| 全量过 LLM 不预筛 | ✅ | trending 一页才 ~25 条，DeepSeek 单次 ~$0.001，省不下几个钱却丢精度 |
| 重复 repo 不重跑 LLM | ✅ | 节省成本；首次 snapshot 的 today_stars 留作历史基准 |
| 不强凑 top 10 | ✅ | 实有几条入几条；前端 query 时 `LIMIT 10` 截断 |
| 仅 top 10 抓 README | ❌ | 改为 **全部 AI 相关都抓**（README 是 LLM 输入的核心，不能省） |

### 抓取实现注意

- HTML 解析：trending 页 DOM 结构稳定，关键 selector：`article.Box-row`（每条 repo），`.Sponsor-tag`（sponsor 标记），`a.text-bold`（owner/repo），`p.col-9`（description），`span[itemprop=programmingLanguage]`，`a[href$=/stargazers]`（total stars），`span.float-sm-right`（today stars 文本含 "X stars today"）
- 不用 GitHub search API（trending 没有官方等价 endpoint）
- failure: HTML 解析失败（DOM 改了）→ 整次 cron 退出 + PushDeer 通知 + 留 raw HTML 供 debug

---

## 3. DB Schema

**架构**：本地 SQLite **分表**（每源一张），D1 **大一统**（items + extra JSON），metrics 历史**按源分表**。

理由：
- **本地按源分表**：每个 scraper 自带 schema 演进，互不干扰；字段强类型清晰；scraper 故障也不会污染其他源。这是现状（X 用 `tweets` 表，独立 SQLite db）。
- **D1 大一统**：worker schema header 注释直接写"统一内容模型，支持多数据源"，已为多源准备好（`source_type`/`source_id`/`extra` JSON/`is_relevant`）。现有 X 36k 条已经在跑，沿用即可。
- **metrics 历史按源分表**：X 走 chrome / 风控严 / 字段是 likes/retweets，GitHub 走 API / 风控宽 / 字段是 stars/forks，硬合一会让 query 复杂。未来 PH/arXiv/podcast 各自独立 metrics 表。

push_to_cloud 时本地 row → D1 row 做 schema 映射。

### 本地 SQLite

ai-feeds 项目自带本地 DB（不复用 skills/xlist-scraper 的 `data/xlist.db`，**两个 scraper 互不干扰**）。位置：`data/aifeeds.db`。

scraper 启动时 `CREATE TABLE IF NOT EXISTS`，无需独立 migration 文件。

```sql
CREATE TABLE github_repos (
  -- 标识
  owner_repo TEXT PRIMARY KEY,           -- 'pytorch/pytorch'
  url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,

  -- 基础元数据
  description TEXT,
  language TEXT,                         -- 可空
  license_spdx TEXT,                     -- 'Apache-2.0' / 'MIT' / NULL
  default_branch TEXT,

  -- Trending snapshot（首次抓取的快照）
  total_stars_first INTEGER,
  today_stars_first INTEGER,
  forks_first INTEGER,
  watchers_first INTEGER,

  -- LLM 输出
  is_ai INTEGER,                         -- 0/1/NULL（NULL=待重试）
  ai_category TEXT,                      -- 'agent'|'model'|'tool'|'infra'|'app'|'tutorial'|'other'
  ai_summary TEXT,
  llm_raw_response TEXT,
  llm_model TEXT,
  llm_called_at INTEGER,

  -- README
  readme_excerpt TEXT,                   -- 抓到的 README 全文
  readme_lang TEXT,                      -- 'zh' | 'en' | 'other'
  readme_translated TEXT,                -- 中文翻译（异步 enrich，v2）
  readme_fetched_at INTEGER,

  -- Built-by 头像（best-effort）
  contributors_json TEXT,                -- JSON [{login, avatar_url}, ...]
  contributors_count INTEGER,

  -- 标记
  sponsor INTEGER NOT NULL DEFAULT 0,
  emitted INTEGER NOT NULL DEFAULT 1,

  -- 排名 & 时间
  daily_rank INTEGER,                    -- 当日 AI 相关里按 today_stars 的排名
  trending_date_str TEXT,                -- '2026-05-01' BJT
  first_trending_at INTEGER,
  first_scraped_at INTEGER,
  last_seen_on_trending_at INTEGER,
  last_pushed_at INTEGER                 -- 最后一次同步到 D1 的时间
);

CREATE INDEX idx_gr_trending_date ON github_repos(trending_date_str);
CREATE INDEX idx_gr_is_ai_rank ON github_repos(is_ai, daily_rank);
CREATE INDEX idx_gr_sponsor ON github_repos(sponsor);

-- 本地 metrics 历史
CREATE TABLE github_repo_metrics (
  owner_repo TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  trending_date_str TEXT,
  total_stars INTEGER,
  today_stars INTEGER,
  forks INTEGER,
  watchers INTEGER,
  open_issues INTEGER,
  open_prs INTEGER,
  PRIMARY KEY (owner_repo, measured_at)
);
CREATE INDEX idx_grm_owner_at ON github_repo_metrics(owner_repo, measured_at);
```

### D1（CF）

复用现有 `items` 大一统表（schema 不动）。push_to_cloud 时映射：

| `items` 列 | GitHub 含义 |
|---|---|
| `id` | `gh:owner/repo` |
| `source_type` | `'github'` |
| `source_id` | `owner/repo` |
| `title` | `owner/repo` |
| `content` | description |
| `author` | owner |
| `url` | repo URL |
| `media` | JSON: README 里的图片（v2 落 CF 后） |
| `metrics` | JSON: `{stars, today_stars, forks, watchers, open_issues, open_prs, license_spdx}` |
| `published_at` | first_trending_at（ISO string） |
| `scraped_at` | first_scraped_at（ISO string） |
| `is_relevant` | `is_ai`（X 也用这个判 AI 相关） |
| `lang` | `readme_lang` |
| `extra` | JSON: `{ai_category, ai_summary, llm_model, llm_called_at, readme_excerpt, readme_translated, contributors[], contributors_count, sponsor, daily_rank, trending_date_str, first_trending_at, last_seen_on_trending_at, default_branch}` |

**GitHub 历史 metrics 独立 D1 表**（用户决策：X 走 chrome 风控严，GitHub 走 API 宽松，字段维度差异大，独立更清晰）：

```sql
-- worker/migrations/004-metrics-snapshots-gh.sql
CREATE TABLE IF NOT EXISTS metrics_snapshots_gh (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,                 -- 'gh:owner/repo'
  captured_at INTEGER NOT NULL,
  trending_date_str TEXT,
  total_stars INTEGER,
  today_stars INTEGER,
  forks INTEGER,
  watchers INTEGER,
  open_issues INTEGER,
  open_prs INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msgh_item_time ON metrics_snapshots_gh(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_msgh_trending_date ON metrics_snapshots_gh(trending_date_str);
```

`metrics_snapshots`（X 专用，likes/retweets/...）保持现状不动。未来 PH/arXiv/podcast 各自再开 `metrics_snapshots_ph` / `_arxiv` / `_pod`。

### 同步流程

```
GitHub trending HTML
  ↓ scrape + GitHub API enrich + LLM
本地 aifeeds.db: github_repos 一行 + github_repo_metrics 一行
  ↓ push_to_cloud（schema 映射）
D1: items UPSERT (source_type='github', source_id='owner/repo') + metrics_snapshots_gh INSERT
```

每次 cron：
- 本地 `github_repos`：已存在 repo 只 update `last_seen_on_trending_at` + 新 metrics 行；新 repo 走完整 LLM 流程后 INSERT
- 本地 `github_repo_metrics`：每次 cron 都 append 一行（含已存在 repo）
- push_to_cloud：把本地未同步的 row 推到 D1（按 `last_pushed_at < last_seen_on_trending_at` 选）

### Migration

只有 D1 端新建一张表：

```bash
cd worker && npx wrangler d1 execute xlist-db --remote --file migrations/004-metrics-snapshots-gh.sql
```

`items` 表不需要 migration，extra JSON 容纳所有 GitHub 特定字段。本地 SQLite 走 `CREATE TABLE IF NOT EXISTS`，scraper 启动时自动建。

---

## 4. LLM Prompt

### 调用结构

每条 repo 一次调用，DeepSeek V4 Flash + `response_format={"type":"json_object"}`。

**输入构造**：

```
项目: {owner}/{repo}
GitHub Description: {description or "无"}
主语言: {language or "未知"}
总 stars: {total_stars}（今日新增 {today_stars}）

README（截断到前 800000 字符）:
---
{readme}
---
```

README 上限 80 万 chars 是因为 DeepSeek V4 Flash 长 context 能装得下；典型项目 README 1-3 万 chars，远低于上限。极端情况（超长 awesome list）才触发截断。

### System Prompt

完整版见 `/tmp/test_gh_llm.py`（一次性测试脚本，不入库）。要点：

```
你是 AI 信息聚合看板的内容审核员。任务：判断 GitHub 项目是否"AI 相关"，
并给中文用户写一段简短解读。

【判别标准】is_ai=1：
- LLM/agent 框架与应用（langchain, autogpt, crewai）
- ML/DL 模型权重、训练/推理实现（llama.cpp, sglang）
- AI 开发工具（cursor, aider, continue 类）
- AI 基础设施（向量库、RAG、推理引擎、eval、部署）
- 终端用户 AI 应用（comfyui, openwebui）
- AI 教程 / awesome list / prompt 集合
- AI 论文实现 / 复现仓库

is_ai=0：
- 通用 web 框架、数据库、操作系统
- DevOps / 监控 / 容器编排（除非专为 ML）
- 区块链 / 加密货币
- 纯算法/数据结构库（除非专为 ML）
- 通用编辑器、设计工具
边界模糊时按"项目主要价值是否依赖 AI/ML"判。

【分类】ai_category（is_ai=1 时必填，选最主要的一个）：
- agent / model / tool / infra / app / tutorial / other

【解读】ai_summary（is_ai=1 时必填，80-150 中文字）：
- 第一句：项目做什么（不要抄 description；不要以"项目名+是一个"开头）
  反例：「TradingAgents 是一个多智能体框架...」（错）
  正例：「多智能体金融交易框架，把分析师/研究员/交易员拆成专门 agent...」（对）
  正例：「通过 LangGraph 编排多个 LLM Agent 模拟交易团队协作...」（对）
- 第二句：为什么值得看（亮点 / 跟同类的差异 / 当前热度的原因）
- 如果 README 有 disclaimer / license 限制 / "research-only" 等声明，
  必须在 summary 末尾保留一句（如"研究向，非投资/医疗建议"）
- 中国 AI 从业者口吻，专有名词保留英文
- 禁用营销腔（"必看"/"重磅"/"最强"）

【输出】严格 JSON：
{"is_ai": 0或1, "ai_category": "..."|null, "ai_summary": "..."}
is_ai=0 时 ai_category=null, ai_summary=""。
```

### 实测验证

**TradingAgents 实跑结果**（2026-05-01 prompt v2，加正反例 + disclaimer 强化后）：

```json
{
  "is_ai": 1,
  "ai_category": "agent",
  "ai_summary": "多智能体金融交易框架，通过 LangGraph 编排分析师、研究员、交易员、风控等角色协作决策。亮点在于专门针对金融交易场景的多 Agent 设计，支持 OpenAI/Gemini/DeepSeek 等主流 LLM，并具备持久化记忆和断点恢复功能。研究向，非投资建议。"
}
```

- 不以"项目名+是一个"开头 ✅
- 末尾保留 disclaimer ✅
- 字数 120 字（在 80-150 内）
- token 消耗 4430 / 调用，约 $0.001 / 调用，年成本 < $20

### 失败处理

- LLM 输出非法 JSON → catch → 重试 1 次 → 仍失败 标 `is_ai=NULL`，`llm_raw_response` 留全文
- LLM API 调用失败 / 超时 → 标 `is_ai=NULL` + 调 PushDeer 推送（参考 `/Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py:230-302` 的 `_send_pushdeer`）
- 下次 cron 拣 `is_ai IS NULL` 重试

PushDeer keys（写到 config.yaml `pushdeer.groups.admin`）：
- iPhone: `PDU39431TnkGWKTVjyTTSb1s2lcMVPuzKRPk2Fv0J`
- Mac: `PDU39432TXJ3Dn7LYZdpVKVn9yBMoExBvwAIdjGN4`

通知格式：

```
title: xList | GitHub LLM 失败
body:
  仓库: TauricResearch/TradingAgents
  错误: JSON 解析失败 (重试 1 次)
  trending_date: 2026-05-01
```

---

## 5. 卡片样式（dashboard）

**前端架构**：dashboard 已经预留 6 列 column-per-source（见 `dashboard/src/App.tsx:18-25` `SOURCE_COLUMNS`）。GitHub 列即第 3 列，`source_type === 'github'` 时由新建的 `GithubCard.tsx` 渲染。

**列表卡片（终稿）**：见 mockup `2026-05-01-github-card-mockup.html` 的"方案 B · 终稿"列。要点：

```
┌─────────────────────────────────────────────────────┐
│ [40px owner avatar]                                  │
│ TauricResearch / TradingAgents      [agent chip]     │
│ ● Python · ★ 18.2k · ⑂ 3.1k · 👁 542                  │
│                                                      │
│  多智能体金融交易框架，通过 LangGraph 编排...        │
│  ...支持 OpenAI/Gemini/DeepSeek...                  │
│  ...研究向，非投资建议。                            │
│  展开 ↓                                             │
│                                                      │
│ 04-29 🏆 2nd       [⚪⚪⚪] 12 contributors           │
└─────────────────────────────────────────────────────┘
```

- summary 截 3 行 line-clamp（PC + mobile 都是 3）
- header metrics 用 GitHub octicons（star / fork / eye SVG）
- 底部 strip：左侧 `04-29 🏆 2nd` 带 hover tooltip "4 月 29 日 GitHub 热榜第 2 名"；右侧 contributors 头像组 + "N contributors" 文字（best-effort，没拿到就留空）
- 卡片视觉跟现有 TweetCard（X 推文卡）保持同款 rounded-2xl + neutral-200 border + p-4 padding
- 数字格式化：18200 → 18.2k；1200000 → 1.2M（写一个 utils 函数 `formatCompact(n)`）

---

## 6. Drawer

**架构**：复用 `TweetDrawer.tsx` 的整套基础设施（slide-in panel + backdrop + swipe-to-close + ESC 关 + URL routing），新建 `GithubDrawer.tsx`（或在统一 `ItemDrawer.tsx` 内根据 source 分支渲染）。

**视觉差异**：见 mockup 的 "Drawer · 点开卡片后的详情页" 章节。要点：

| 区域 | 内容 |
|---|---|
| header（三栏 grid） | ✕ / "GitHub 项目详情" / "在 GitHub 打开 ↗"（外跳 button） |
| repo 头部 | 12px avatar + name + 元数据 metrics 行（GitHub octicons） + agent chip |
| chip + 元数据 | 04-29 🏆 2nd · GitHub 热榜（外显文字，无 hover）+ License/Issues/PRs/commit 一行 + contributors 头像组 + "N contributors" |
| AI 解读 | summary 全文（无小标题，无水印） |
| README | "README" 标题 + 条件渲染 tab（中文不出 tab，非中文出 "English / 中文"）|

**README 条件渲染规则**：

```typescript
{readme_lang === 'zh' ? (
  <Markdown>{readme_excerpt}</Markdown>
) : (
  <Tabs defaultValue="en">
    <Tab id="en" label="English">{readme_excerpt}</Tab>
    <Tab id="zh" label="中文">
      {readme_translated || <Pending>翻译中...</Pending>}
    </Tab>
  </Tabs>
)}
```

`readme_lang` 在抓取阶段用启发式判定（CJK 字符占比 ≥ 30% → 'zh'，否则 'en'/'other'），存到 `github_repos.readme_lang`。

`readme_translated` 是异步任务（v2），未填充时 "中文" tab 显示 placeholder 文案。

**移动端**：`useIsNarrow()` 分流到全屏 page，复用现有 mobile breakpoint 逻辑，不另写一份 layout。

---

## 7. URL routing & 分享回流

复用 `2026-04-30-dashboard-url-routing-design.md` 已落地的 X 推文 `/t/:id` 模式。

### URL 结构

```
/                  首页
/t/:id             X 推文详情（已上线）
/g/:owner/:repo    GitHub repo 详情（新增）
/p/:paper_id       arXiv（未来）
...
```

用 source-prefixed slug（不用统一 `/i/:source/:id`），URL 更短可读，分享出去人眼能识别"这是个 GitHub 项目"。

### 深链行为

- 应用内点卡片 → `history.pushState('/g/:owner/:repo')` → drawer 开
- 关闭 → `history.back()` → 回 `/`
- 冷启动深链 → `replaceState('/')` + `pushState('/g/...')` seed 历史栈，后退键回首页不退出站

### 分享回流：被分享 repo 强插到 feed 顶部

复用 `d80a38f` commit 的"被分享推文强插到 feed 顶部"机制。

- Worker 新增 endpoint：
  - `GET /api/items/github/:owner/:repo` → 返回单条
  - `GET /api/feed?source=github&pinned=:owner_repo` → query 时把 pinned id 排首位
- 前端从 `/g/:owner/:repo` 进入时，feed query 自动带 `?ref=share&pinned=...`
- 上报 SDK（依赖前置 3 完成）落 `events` 表，分享外链点击 → drawer 打开 → 强插 → 关闭后保留在 feed 顶部，回流路径完整

---

## 8. 资源管线（README 翻译 + 图片落 CF）

### README 中文翻译（v2）

异步 enrich job：

- 新建 cron 槽位（如 BJT 02:00 / 14:00，错开主抓取）
- 每次拣 N 条 `readme_translated IS NULL AND readme_lang != 'zh'` 的 repo
- 整段 README 喂 DeepSeek 翻译（不分段，DeepSeek 长 context 装得下）
- 翻译时保留 markdown 结构（`#` `##` 标题、`-` 列表、` ``` ` 代码块、链接 / 图片不翻译）
- 翻译里的 `<img src="...">` 资源 URL 抽出 → 下载到 CF R2 → 重写 src 为 R2 URL，落库

### README 图片落 CF R2

参考现有 link_card 图片落 CF 的做法（worker 已有 R2 binding）：

1. 抓 README 时正则 match `<img>` 标签 + markdown `![alt](url)` 语法
2. 每个 image URL：
   - HEAD 请求验证 200 + content-type
   - 大小 < 5 MB（避免下大图）
   - 下载 + 上传到 R2 bucket `xlist-readme-images/<owner>/<repo>/<sha256-hash>.{ext}`
   - 拿到 R2 URL（如 `https://r2-pub.../xlist-readme-images/...`）
3. README 文本里的 src 全部改写成 R2 URL，落到 `readme_excerpt`（同时保留原始 markdown 副本到 `readme_excerpt_original` 备份）

**v1 不做**（设计在内但实施留 v2）。原因：v1 先把"抓 + LLM 解读 + 上 feed"链路打通，翻译和图片落 CF 是质量提升项不是阻断项。

---

## 9. Worker 端

新增 endpoints（全部基于 D1 `items` 表 + `metrics_snapshots_gh` 表）：

```typescript
// 单条 repo 详情
GET /api/items/github/:owner/:repo
→ {
    ...items row WHERE source_type='github' AND source_id='owner/repo',
    metrics_history: [...latest 30 days from metrics_snapshots_gh]
  }

// GitHub 列分页 feed
GET /api/feed?source=github&limit=20&cursor=<id>&pinned=<owner_repo>
→ {
    items: [...],
    next_cursor: ...
  }

  query 大致：
    SELECT * FROM items
    WHERE source_type='github'
      AND is_relevant=1                                          -- AI 相关
      AND json_extract(extra, '$.sponsor') = 0                   -- 非 sponsor
      AND deleted_at IS NULL
      AND json_extract(extra, '$.trending_date_str')
          = (SELECT MAX(json_extract(extra, '$.trending_date_str'))
               FROM items WHERE source_type='github')            -- 当日
    ORDER BY (CASE WHEN id = ? THEN 0 ELSE 1 END),               -- pinned 顶上
             json_extract(extra, '$.daily_rank') ASC
    LIMIT ? OFFSET ?

// 跨源统一 feed（admin / 全局搜索用）
GET /api/feed?source=all
→ 直接打 items 表，不需要 view（source_type 字段已经够区分）

// LLM null 重试（worker cron 调，可选）
POST /api/github/retry-llm
→ pick is_relevant IS NULL AND source_type='github' 的 row，重新跑 LLM
```

**ingest endpoint 改造**：现有 `/api/ingest` 接受 tweets payload。需要支持 `source_type='github'` 的 payload：

- 共用一个 endpoint，按 payload `source_type` 分流写入 items 表
- GitHub payload 字段映射在 worker 端做（参考 Section 3 的 D1 字段映射表）
- metrics_snapshots_gh 行随 ingest 一起 INSERT

---

## 10. 实施步骤（PR 拆分建议）

按"小步快跑"切：

1. **PR 1：Schema + scraper**（不上线，只本地验证）
   - 在 ai-feeds main repo 新建 `scrapers/github/`（不动 skills/xlist-scraper）+ `scrapers/_lib/`（共享 db/config/pushdeer 模块）
   - 本地 SQLite `data/aifeeds.db`：`github_repos` + `github_repo_metrics` 走 `CREATE TABLE IF NOT EXISTS`
   - 新写 `scrapers/github/scraper.py`（HTML scrape + GitHub API enrich）
   - 单元测试：mock trending HTML → 解析正确
   - 集成测试：`--dry-run` 实跑一次 trending → 写本地 SQLite → 看数据完整

2. **PR 2：LLM enrichment + cron 接通**
   - 新写 `scrapers/github/llm_judge.py`（prompt v2 + JSON 校验 + 失败重试 + PushDeer 通知）
   - 把 system prompt 落到 module-level 常量
   - cron 接入：launchd plist 或 ai-feeds 自己的 `cron.sh`（BJT 01:00 + 13:00）
   - 本地跑一次实战，看 DB 完整 + LLM 输出 quality
   - 写 `scrapers/github/sync.py` 推到 D1（schema 映射本地 `github_repos` → D1 `items` + `metrics_snapshots_gh`）

3. **PR 3：Worker endpoints**
   - 新增 `/api/items/github/:owner/:repo`
   - 新增 `/api/feed?source=github` + pinned 支持
   - 改 `/api/ingest` 接受 github source
   - wrangler dev 本地验证

4. **PR 4：Dashboard GitHub 列**
   - `GithubCard.tsx`（卡片）
   - 接入 Feed 组件，按 source_type 分流
   - 头部 metrics 用 octicons SVG
   - 底部 strip + contributors
   - 视觉对齐 mockup 终稿

5. **PR 5：Drawer + URL routing**
   - `GithubDrawer.tsx`（PC + mobile 全屏）
   - `/g/:owner/:repo` 路由 + seed-history
   - README tab 条件渲染（中文不出 tab）
   - "在 GitHub 打开" 外跳

6. **PR 6（依赖前置 3 完成）：分享回流 + 强插 pinned**
   - feed query 加 `?pinned=` 参数
   - 卡片接受"被分享强插"视觉锚点（参考 X 那条实现）

7. **v2（设计内但留下次）：**
   - README 中文翻译异步 enrich
   - README 图片落 CF R2
   - Stars 趋势 sparkline（攒够 7 天 metrics 后启用）

每个 PR 独立可上线，前 5 个完成 GitHub 列就能产出价值。PR 6 等 PR-D（数据上报 SDK + 数据看板，分享功能链 4 个前置）落地后再做。

---

## 11. 测试计划

### LLM 金标（已起点）

`tests/github_llm_golden.jsonl`（待建）：

| 类型 | 示例 repo |
|---|---|
| 强正例 | langchain, autogen, comfyui, llama.cpp, ollama, awesome-llm |
| 强反例 | next.js, kubernetes, postgres, hyperfine |
| 边界 | n8n（自动化 + AI integ）、supabase（DB + AI extension）、playwright |
| 中文 | openrlhf, chatglm, qwen |
| 误判易发 | ai-shell（shell 工具，名字带 ai） |

**目标准确率 ≥ 90%**。每改 prompt 一次跑回归。

### scraper 单测

mock trending HTML → 验证解析提取 owner/repo / description / language / stars / sponsor / contributors avatars 都对。

### 端到端

`scripts/github_scraper.py --dry-run` 模式：抓 + 解析但不写 DB，输出 JSON 到 stderr 给人 review。

---

## 12. GITHUB_TOKEN 用法

```python
# scripts/config.py 已 append
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

# 用法
import requests
headers = {"Authorization": f"Bearer {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}
r = requests.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers)
```

未授权 60/hr，授权后 5000/hr。每天 25 repo × 2 cron × 1 enrich call = 50 次/天，授权后绰绰有余。

token 已写入 `/Users/roxor/.claude/skills/xlist-scraper/scripts/.env`（与 DEEPSEEK_API_KEY 同一文件）。token 标签 `claude-code`，scopes `gist, read:org, repo, workflow`，已实测 5000/hr 正常。

---

## 13. 参考

- mockup（视觉终稿）：`docs/plans/_mockups/2026-05-01-github-card-mockup.html`
- 现有 X drawer 模式：`dashboard/src/components/TweetDrawer.tsx`
- URL routing 前置：`docs/plans/2026-04-30-dashboard-url-routing-design.md`
- PushDeer 通知模块：`/Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py:230-302`
- 抓取停止条件原则：`CLAUDE.md → 抓取停止条件：禁用 ID 游标`（X 用，github 不复用因为 trending 是固定页面无滚动）
- 自动化 Chrome 工作流：`CLAUDE.md → 自动化 Chrome 工作流统一规范`（GitHub scrape 用 requests 不用 browser-use，不需要焦点恢复 / kill-by-data-dir 这套）
