# 运营看板 + 内容池设计 v1

> **设计时间**：2026-05-21
> **状态**：v1 设计 + 进入 Phase 1 实施
> **目的**：admin 加面向运营者的内容池，识别热门内容、追踪趋势、发现潜在 list author 候选

---

## 1. 背景

aifeeds 当前 admin 有「📊 仪表盘」(user 行为数据) + 「🔧 运维工具」(SMS 管理)。缺一个**面向内容运营**的池子，回答三类问题：

- 今天哪些 AI 内容真正爆了？（hot / 爆推）
- 哪些内容正在加速上涨？（趋势推）
- 应该把哪些圈外 X 博主加进 list？（发现博主）

---

## 2. 核心概念

| 概念 | 触发条件 | 呈现位置 | PushDeer |
|------|---------|---------|----------|
| **hot 标 🔥** | 单条 item 互动 score > 滑动 P90 | feed 卡片显示 🔥 emoji（无新模块）| 不推 |
| **爆推** | 单条 item score > P99 AND 满足绝对底线 | 运营看板顶部 | 推 |
| **趋势推 📈** | 单条 item likes/h 增速 > P95 AND likes_total > 起跑线 | 运营看板第二模块 + sparkline | 推 |
| **发现博主 👤** | 14d 窗口被 list 内 AI tweet 引用/回复 ≥ N 次的外部作者 | 运营看板第三模块 | 推（首次进池时）|

---

## 3. 一处坑全坑约束：所有 cron / SQL 必须 `WHERE is_relevant=1`

### 3.1 为什么

2026-05-21 数据预跑发现（X 7d 数据，n_total=28200 / n_AI=18242）：

| 分位 | 全量 | AI only | 差异 |
|------|----:|--------:|----:|
| P50 | 311 | 469 | **+51%** |
| P75 | 1654 | 1987 | +20% |
| P90 | 6614 | 6498 | -2% |
| P95 | 14967 | 12671 | -15% |
| P99 | 49506 | 34454 | **-30%** |

非 AI 长尾把头部基线撑高 30%。**用全量算 AI 爆推阈值会让爆推池常年空着**（AI 内容达不到非 AI 八卦/政治的极端数）。

### 3.2 各源 AI 占比（2026-05-21 7d）

| 源 | 7d 总数 | is_relevant=1 | 占比 |
|-----|------:|-------------:|----:|
| x_list | 38,380 | 25,244 | 66% |
| **clawhub** | 4,578 | 4,578 | **100%** |
| **huodongxing** | 1,584 | 1,584 | **100%** |
| product_hunt | 451 | 265 | 59% |
| github | 122 | 85 | 70% |
| **hf_paper** | 59 | 59 | **100%** |

clawhub / huodongxing / hf_paper 三个源 100% AI 相关，filter 对它们是 no-op。**代码层统一加 filter，不做特例**（防遗漏）。

---

## 4. score 公式

### 4.1 X：参考 X 开源算法（Grok 版本 2026-01）

公式权重来自 [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)：

```
score = likes × 1
      + bookmarks × 10
      + replies × 13.5
      + retweets × 20
```

views 不入 score（多数 view 是被动 impression），只用作 engagement_rate 分母：

```
engagement_rate = score / MAX(views, 500)
```

500 是绝对底线防小样本（views 极少时 ER 失真）。

### 4.2 其他源

| 源 | 公式 | 数据依据 |
|-----|------|---------|
| **GH** | `stars + forks×5 + watchers×3 + 当日 stars 增量×10` | star 增量是早期信号，权重最高 |
| **PH** | `votes + comments×5` | comment 比 vote 体现深度参与 |
| **HF Paper** | `upvotes + comments×8` | 学术圈 comment 价值更高 |
| **ClawHub** | `uses + watchers×5`（待 check schema 字段） | 实际使用 vs 关注 |
| **活动行** | `报名人数 + 关注人数` | 活动专用 |

---

## 5. 阈值（基于 2026-05-21 数据预跑）

### 5.1 X 源（AI-only 基线，7d 滑动）

| 池子 | 触发条件 | 数据依据 | 估算频度 |
|------|---------|---------|--------|
| **hot 🔥** | `score > 6500` (P90) | 7d 18242 中前 10% | ~260/天 |
| **爆推** | `score > 34000` (P99) AND `likes ≥ 300` | 7d 头 1% | ~25-30/天 |
| **趋势推 📈** | `likes/h > 230` (P95) AND `likes_total ≥ 50` | 3d 约 10/天 | ~10/天 |
| **发现博主 👤** | 14d `distinct_tweets ≥ 5` AND not in list | 14d Top ~30 人 | ~5-10/周 |

### 5.2 数据快照（基线 cron 启动前用作初值）

**X 7d score 分位数 (AI only, n=18242)**：

| P50 | P75 | P90 | P95 | P99 | Max |
|----:|----:|----:|----:|----:|----:|
| 469 | 1987 | 6498 | 12671 | 34454 | 377066 |

**X 3d likes/h 增速分布 (n=704)**：

| P50 | P75 | P90 | P95 | P99 | Max |
|----:|----:|----:|----:|----:|----:|
| 10.5 | 35 | 116 | 229 | 501 | 11678 |

**14d 外部作者频次直方图（AI tweet 引用，不去重）**：

| 频次 | 作者数 |
|------|----:|
| 1 | 2161 |
| 2 | 247 |
| 3 | 90 |
| 4-5 | 56 |
| 6-10 | 35 |
| 11-20 | 3 |
| 21+ | 3 (felixrieseberg 44 / elonmusk 31 / NotebookLM 23) |

### 5.3 阈值动态性

- **hot/爆推 P90/P99**：每日凌晨 02:00 BJT 基于过去 7 天 AI tweet 重算 → 写 `ops_pool_baseline` 表
- **趋势推 P95**：同上，基于过去 3 天
- **发现博主**：无基线，直接 `distinct_tweets` 计数（每 30min 检查）

### 5.4 dilution_ratio 显示

发现博主卡片同时展示三个数：

```
@<handle>   distinct_tweets: 7   total_mentions: 11   dilution: 1.6
```

含义：
- **dilution ≈ 1.0** → 多条不同 tweet 被引用（**持续输出**，更值得加 list）
- **dilution > 1.5** → 单条爆款被多次引用（**事件信号**，加 list 需观察）

---

## 6. 数据架构

### 6.1 新建表（migration `016-ops-pool-tables.sql`）

```sql
-- 滑动基线快照。每日重算覆盖。
CREATE TABLE ops_pool_baseline (
  source_type TEXT NOT NULL,
  metric_key TEXT NOT NULL,     -- 'score_p90' / 'score_p99' / 'rate_p95' / 'rate_p99'
  value REAL NOT NULL,
  computed_at INTEGER NOT NULL, -- unix sec
  sample_size INTEGER,
  PRIMARY KEY (source_type, metric_key)
);

-- 池子条目。每个 item 在每个池子里最多一行（pool_type+item_id 主键）。
-- 对发现博主：item_id 用 'handle:<handle>' 形式（hack 重用主键）。
CREATE TABLE ops_pool_items (
  pool_type TEXT NOT NULL,      -- 'baopui' | 'trend' | 'discover'
  item_id TEXT NOT NULL,        -- items.id OR 'handle:<handle>' for discover
  payload TEXT,                 -- JSON：score / rate / dilution / etc
  added_at INTEGER NOT NULL,    -- unix sec, 首次进池时间
  pushed_at INTEGER,            -- pushdeer 推送时间，NULL = 未推
  PRIMARY KEY (pool_type, item_id)
);
CREATE INDEX ops_pool_added ON ops_pool_items(pool_type, added_at);

-- items 表加 is_hot，让 feed UI 直接读不用 join
ALTER TABLE items ADD COLUMN is_hot INTEGER DEFAULT 0;
CREATE INDEX items_is_hot ON items(is_hot) WHERE is_hot = 1;
```

**注意**：hot 不进 `ops_pool_items`，因为量大（260/天 × 30 天 ≈ 8000 行）且 feed 已经能通过 `items.is_hot=1` 直查。爆推 / 趋势推 / 发现博主进 `ops_pool_items` 是因为它们是「事件」而非「状态」，需要 first_added 时间 + push 记录。

### 6.2 cron 触发

worker 现有 `*/5 * * * *` 入口加分流（worker/src/index.ts 的 scheduled handler）：

- **`HH:10`**（每日 02:10 BJT，KV 哨兵防多跑）→ `runOpsBaseline`
- **`HH:15` / `HH:45`** → `runOpsDetect`

新增 worker 文件：
- `worker/src/ops/baseline.ts`：跑 SQL 算 P 值 → 写 `ops_pool_baseline`
- `worker/src/ops/detect.ts`：扫最近 1h 新 item / 最近 3h snapshot pair → 算 score 增速 → 对比基线 → 写 `ops_pool_items` + 更新 `items.is_hot` + 触发 PushDeer

### 6.3 PushDeer payload（中文）

参考现有 `worker/src/notifier.ts`。emoji 区分池子：

```
🔥 爆推 · @<handle>
score 50321（爆推阈值 P99=34000）
likes 800 / retweets 120 / replies 80 / bookmarks 45
"<content_translated 前 80 字...>"
https://ai-feeds.com/x/<item_id>
```

```
📈 趋势推 · @<handle>
增速 285 likes/h（阈值 P95=230）
当前 likes 320（30min 前 200）
"<content_translated 前 80 字...>"
https://ai-feeds.com/x/<item_id>
```

```
👤 发现博主 · @<external_handle>
14d 被引用 7 条不同 tweet（共 11 次提及，dilution 1.6）
最近被 @list_author1 / @list_author2 / ... 引用
查看：https://x.com/<external_handle>
```

---

## 7. UI（`/admin/ops`）

新 admin 路由 `/admin/ops`，跟 `/admin/dashboard` `/admin/tools` 并列。

### 7.1 顶部 nav 加链接

`worker/src/admin.ts` 的 `adminNavHtml` 加：

```
📊 仪表盘  |  📦 运营  |  🔧 运维工具
```

### 7.2 模块布局

```
┌──────────────────────────────────────────────────┐
│ 🔥 爆推（24h 内 N 条）                            │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐              │
│ │ @author │ │ @author │ │   ...   │              │
│ │ score   │ │ score   │ │         │              │
│ │ likes…  │ │ likes…  │ │         │              │
│ │ content │ │ content │ │         │              │
│ └─────────┘ └─────────┘ └─────────┘              │
├──────────────────────────────────────────────────┤
│ 📈 趋势推（24h 内 N 条）                          │
│ @author1  +285 likes/h  ╱╲╲___╱╲╲              │
│ @author2  +130 likes/h  ╱___╱╲╲                │
├──────────────────────────────────────────────────┤
│ 👤 发现博主（14d 池，按 distinct_tweets 倒序）    │
│ @felixrieseberg    7 条 (11 mentions, d=1.6) [→] │
│ @elonmusk         24 条 (26 mentions, d=1.1) [→] │
│ @NotebookLM       17 条 (21 mentions, d=1.2) [→] │
│ ...                                              │
└──────────────────────────────────────────────────┘
```

- **爆推卡片**：可点击 → 跳详情页 drawer（feed 已有路由复用）
- **趋势推 sparkline**：60×20 px inline SVG（10-15 snapshot 点），无 echarts 依赖
- **发现博主 row**：点击 → 跳 `https://x.com/<handle>` + 鼠标 hover 显示「最近被这 N 个 list 内作者引用过」

---

## 8. 实施阶段

### Phase 1（本 PR）

X 全套（hot + 爆推 + 趋势推 + 发现博主）+ admin/ops UI + PushDeer + feed 🔥 显示。

文件改动：
- `docs/plans/2026-05-21-ops-pool-design.md`（本文档）
- `worker/queries/baseline-eda.sql`（预跑 SQL 存档）
- `worker/migrations/016-ops-pool-tables.sql`
- `worker/src/ops/baseline.ts`
- `worker/src/ops/detect.ts`
- `worker/src/admin-ops.ts`（HTML + JSON metric endpoints）
- `worker/src/admin.ts`（nav 加 link）
- `worker/src/index.ts`（路由 + cron 分流）
- `worker/src/notifier.ts`（加 `notifyOpsPool` helper）
- `dashboard/src/components/TweetCard.tsx`（is_hot=1 显示 🔥）

预计 2 天工期。

### Phase 2

GH / PH / HF Paper 的 hot + 爆推（无趋势推 / 发现博主，因为这两个 X 专属）。各自 score 公式。0.5 天。

### Phase 3

ClawHub / 活动行（看 schema 是否合适，可能跳过 — 活动行场景不太适合"hot/爆推"概念）。0.5 天。

### 上线日期 + 启用条件

- Phase 1 部署后立即跑 baseline 计算 cron（用历史数据回填首次基线）
- 第一天可能误判较多（基线还在收敛），先**只跑不推**（环境变量 `OPS_PUSHDEER_ENABLED=false`）
- 跑 3 天观察数据 → 切 `OPS_PUSHDEER_ENABLED=true` 启用

---

## 9. 容量边界与防御

### 9.1 SB API 当前消耗（2026-05-21 实测 refresh_log）

- 每天 48 cron run × 平均 90 subreq/run = **~4,500 SB calls/day**
- 每月约 **~135k SB calls**
- list 内 distinct authors: 1,435

### 9.2 SB 容量外推

| list authors | 月 SB calls | 月成本估算 ($0.001-0.005/call) |
|-------------:|-----------:|-----:|
| 1,435（现在）| 135k | $135-$675 |
| 3,000 | 280k | $280-$1,400 |
| 5,000 | 470k | $470-$2,350 |
| 10,000 | 900k | $900-$4,500（**不可持续**） |

### 9.3 防御预案

发现博主推得太勤导致 list 失控扩张 → SB API 成本爆炸。措施：

1. v1 不做硬限，但发现博主卡片明确显示 `distinct_tweets` + `dilution_ratio`，让运营 informed decision
2. 扩到 **3,000 author** 前加 `daily SB budget cap`（worker 内硬熔断）+ 每天 PushDeer 推「昨日 SB calls / 周环比」
3. 扩到 **5,000 author** 时把 tier 4 完全停 refresh（只 keep tier 0/1/2）
4. 扩到 **10,000** 时切换抓取方案（X API / 自建）

### 9.4 业务风险预案

| 风险 | 现象 | 措施 |
|------|------|------|
| 事件 cascade | 单日大事件 → list 全员讨论 → 次日 hot 阈值偏高 | 7d 滑动基线自然平滑；观察 2 周后决定是否切 14d |
| 内聚 | list 内互转 → likes 累加 | **不算扭曲**（X 数本来反映全网真实），无需防御 |
| dilution 高 | 单条爆款被多次引用 → 假发现博主 | 用 `distinct_tweets` 触发阈值（不是 `total_mentions`）|
| 阈值漂移 | 流量增长 → P 值上涨 → 阈值跟涨 → 老内容被边缘化 | 这是 desired behavior；定期 PushDeer 报基线漂移 |

---

## 10. 未决事项 / 未来 v2

| 项 | v1 状态 | v2 考虑 |
|----|--------|--------|
| 聚合推送 | 不做（user 说"先推不聚合"） | 看 1 周推送量是否扰人 |
| 发现博主一键加 list | 手动 | 加按钮 + 调 X list API |
| 池子之间去重 | 不做（同 tweet 可 hot + 趋势）| 看运营反馈 |
| 跨源对比 | 不做（X 跟 GH 不比）| 暂无需求 |
| 发现博主 author quality 加权 | 不做 | 被引用作者的 X followers 数也算分 |

---

## 11. 附录

### 11.1 预跑 SQL 存档

见 `worker/queries/baseline-eda.sql`（跟本 PR 一起 commit），运营调阈值时可重跑对比。

### 11.2 学术 / 业内参考

- [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) — X 开源 For You 算法权重
- [Hootsuite Engagement Rate 2026 update](https://blog.hootsuite.com/calculate-engagement-rate/) — 业内 weighted engagement rate
- [How the Twitter/X Algorithm Works in 2026 — posteverywhere.ai](https://posteverywhere.ai/blog/how-the-x-twitter-algorithm-works) — 简化版权重解读
