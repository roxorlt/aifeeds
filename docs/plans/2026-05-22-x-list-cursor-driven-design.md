# X list 抓取改为游标驱动 — 设计文档

> 日期：2026-05-22
> 状态：设计已 review，待开 feature branch 实施
> 触发事件：排查「为什么 karpathy 的 https://x.com/karpathy/status/2056753169888334312 没被 aifeeds 抓到」时，连带澄清了几个对 X list 抓取链路的关键误解，决定重构当前的「固定 maxPages=3 + 早停」逻辑。

---

## 1. 背景：触发这次改造的排查过程

用户问「这条 karpathy 推文为什么没在库里」，顺藤摸瓜走完一整轮排查：

1. **现象**：prod 数据库里 karpathy 入库 4 条全部停在 2026-02 / 2026-03，4 月以后 70+ 天 0 新数据。目标推文（按 snowflake 解码约 2026-05-19 发）不在库。
2. **初步错误判断**：基于 `CLAUDE.md` 写的「X list 默认热度排序」，推测是 ScrapeBadger（以下简称 SB）返回的 list timeline 按热度排序导致 karpathy 冷门推文被压制。
3. **实测反转**：直接调 `GET https://scrapebadger.com/v1/twitter/lists/{id}/tweets` 拉一页，看 `created_at` 字段：61 条**严格时间倒序**（100% 单调递减），fav 数完全混乱与顺序无关。SB 用的是 X 官方 `ListLatestTweetsTimeline`（时序版），不是 web 端那个 For You / Top 热度排序。
4. **真根因**：用户后来确认「sorry 我好像刚刚把他加到 list 名单里」—— list `1643236611378008066` 之前不包含 karpathy（或他被移除过），所以 SB 时序拉 list timeline 时根本看不到他的推文。库里那 4 条历史数据来自更早期某个 list 版本，或通过 quote/reply 嵌套 backfill 引进来。

**虽然 karpathy 那条本身是 list 配置问题，但排查过程暴露了两个值得修复的问题**：

- `CLAUDE.md` 里整节「⚠️ 抓取停止条件：禁用 ID 游标（反复踩过的坑）」是基于**错误前提**（热度排序）写的，跨 session 会持续误导
- 既然 SB 是时序排序，「每 30 分钟硬抓 3 页 + 整页全 known 即早停」其实是给热度排序设计的保守策略，时序排序下「游标驱动 + 翻到上次顶端为止」是更优解：常态成本更低、异常下零漏更可靠

---

## 2. 核心目标 & 非目标

**核心目标（用户选定）**：

- **零漏 list 内 AI 相关推文**。worker 短期下线 / SB 偶发抽风 / list 短时爆发 都不能丢数据。

**非目标**：

- 不追求降低 SB credits 成本（新方案常态会比现状省，但不是优化目标）
- 不追求降低入库延迟（保持 30 分钟一次的 cron 节奏）
- 不解决「list 成员配置错误 / 漏加 KOL」类问题（那是 list 维护问题，本次只解决「list 里有的人，推文一条不漏」）

---

## 3. 关键设计决策汇总

| # | 决策项 | 选定方案 |
|---|---|---|
| 1 | 游标体语义 | 上次抓到的顶端 10 个 tweet_id 集合（seen_set） |
| 2 | 停止条件 | 本页任意一条 id 出现在 seen_set 里就停（时序排序下命中 1 个就够，命中之后的全是上次见过的旧推） |
| 3 | 硬上限 | 10 页（约覆盖 30 小时窗口；单次最大开销约 ¥0.6） |
| 4 | 异常补漏分流 | 本轮新增 ≤ 70 → 全部立即触发加工流水线；> 70 → 最新 70 立即触发，其余标记「待加工」由后续 tick 慢慢消化 |
| 5 | 游标 commit 时机 | 仅在整轮成功结束才覆盖 seen_set；中途任何失败保留旧值（数据库 upsert 无副作用，下一轮重头来即可） |
| 6 | 前端可见性 | 保持现有约束（只显示 `extra.workflow_completed_at` 非空的 x_list 项），不改动 |
| 7 | cron 频率 | 保持 30 分钟一次 |
| 8 | 灰度策略 | 加 `LIST_POLL_MODE` 开关（fixed-pages / cursor-driven），staging 跑 3-7 天再合 prod |

---

## 4. 整体架构

### 4.1 改动范围

- `worker/src/enrich.ts` — `runListPollIngest()` 重写为游标驱动
- `worker/src/index.ts` — `scheduled()` 增加「待加工」消费 + catch-up 阈值常量 + `LIST_POLL_MODE` 开关
- `worker/migrations/016-x-list-cursor.sql` — 数据库改动：
  - 复用 `sources.cursor` 字段（当前全 null），改语义为「上次顶端 N 个 id 的 JSON 数组」
  - 新增 `items.pending_workflow` 字段（默认 0），并建立部分索引加速查询

### 4.2 数据库改动

```sql
-- migrations/016-x-list-cursor.sql

-- sources 表：cursor 字段语义改造
-- 旧：null（从未启用）
-- 新：JSON 数组，存上次顶端 10 个 tweet_id，例 '["2057121410556842160", ...]'
-- 旧值 null 视为冷启动，新逻辑首次执行时按硬上限走，结束时把 page 1 顶 10 个写入

-- items 表：新增「待加工」标志
ALTER TABLE items ADD COLUMN pending_workflow INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_items_pending_workflow
  ON items(pending_workflow, published_at)
  WHERE pending_workflow=1;
```

### 4.3 一次定时任务（30 分钟一次）流程总览

```
1. 读 sources.cursor → 解析成 seen_set（10 个 tweet_id）
2. 翻页循环（硬上限 10 页）：
    a. 调 SB 拿一页 (~55 条)
    b. 判断本页 ids ∩ seen_set 是否非空？
       - 非空 → 停翻页（已撞到上轮顶端）
       - 空   → 继续 next_cursor
    c. 本页 batch upsert 入 items
3. 整轮成功后：
    a. 统计本轮 newly_inserted
    b. ≤ 70 → 全部触发 XTweetPipelineWorkflow（同现状）
    c. > 70 → 按 published_at desc 排序，最新 70 条立即触发；其余 items.pending_workflow=1
    d. 更新 sources.cursor = JSON.stringify(本轮 page 1 顶 10 个 id)
4. 主流程结束后顺手消「待加工=1」队列：
    - 按 published_at asc 取 70 条（最老优先）
    - 逐条 trigger workflow，触发成功的 pending_workflow=0
```

---

## 5. 核心算法

### 5.1 停止判断（举例）

假设上次抓完后 `sources.cursor` = `'["A","B","C","D","E","F","G","H","I","J"]'`（A 是上次最顶 id）。

本次 page 1 拿到 N1...N55（按时间从新到老）。判断：

- N1...N55 这 55 个 id 里，有没有任意一个在 ABCDEFGHIJ 里？
  - **没有** → 这 55 条全是上次没见过的，全部 upsert + 翻 page 2
  - **有**，假设 N40 == A → N1...N39 这 39 条 upsert（新增）；N40 及之后的不再处理（时序排序保证它们都比 A 老 = 上次抓过）；停翻页

为什么时序排序下命中 1 个就够：page 内按 published_at 严格倒序，一旦撞到 seen_set 任一成员，那条之后的全部更老 = 上轮覆盖过。

### 5.2 cursor 更新时机

仅在「整轮完整成功」时覆盖。「完整成功」定义：

- 中途无 SB error（429 / 5xx / timeout / parse failure）
- 中途无 D1 batch upsert error
- 终止原因属于以下之一：页内命中 seen_set / 翻到 10 页硬上限 / SB next_cursor 为空

更新值：本轮 page 1 的最顶 10 个 id（最新的 10 条）。

### 5.3 失败重试（零漏的核心保障）

任何中途失败 → **cursor 原地不动**。已经写入的页保留（D1 upsert 无副作用）。下一轮 30 分钟后从原 cursor 起点重头翻一遍：

- 前几页大概率第一页就撞到 seen_set 某个（30 分钟内 list 通常只新增几十条），停在 page 1
- 少数情况要翻到失败那一页接着拿
- **漏不了**

### 5.4 极端情况：seen_set 里 10 个全被作者删

会一直翻到 10 页硬上限才停（最多 550 条入库）。然后更新 cursor 为这一轮全新的 10 个。下次从新基准对照。

发生概率：单个用户短时间删 10 条推 + 这 10 条恰好同时占据 list 顶端 → 几乎不可能。即便发生：单次多花约 ¥0.6 API 钱，无数据副作用。

---

## 6. 异常补漏分支

### 6.1 触发条件

整轮抓取写完后统计本轮 `newly_inserted`（不包括只是 metric 更新的）：

- ≤ 70 → 常态，所有新条全部立即触发 workflow（行为同现状）
- \> 70 → 进入分流逻辑

阈值 70 的推导：一次 cron tick 30 秒上限，单条 workflow trigger（写 DO storage + create instance）约 50 ms，70 条全启约 3.5 秒，留 25 秒余量给 SB 调用和 D1 upsert。

### 6.2 分流（举例 350 条 newly_inserted）

按 `published_at desc` 排序 → N1, N2, ..., N350。

- N1...N70 → 立即触发 workflow（同常态）
- N71...N350 → `pending_workflow = 1`，本轮不触发

数据全部已 upsert，分流只决定 trigger 时机。

### 6.3 「待加工」消化（每个 tick 收尾）

每个 cron tick 主流程结束后：

```sql
SELECT id FROM items WHERE pending_workflow=1 ORDER BY published_at ASC LIMIT 70;
```

对查到的 70 条逐条 trigger workflow，触发成功的 `pending_workflow = 0`。

按这个节奏：280 条积压 ÷ 每 tick 消 70 条 = 4 个 tick（2 小时）全部加工完毕 → 全部出现在前端 feed。

### 6.4 通知（复用 PushDeer）

扩展 `notifyCronSummary` 增加 3 个信号：

- **补漏触发**：`X List 补漏: 本轮新增 N 条（>70），已分流 N-70 进入积压`
- **硬上限触发**：`X List 警告: 翻满 10 页未撞 seen_set，可能 seen_set 全被删 / list 突增 / SB 异常`
- **连续失败**：`X List 告警: 连续 3 轮失败，cursor 已 N 小时未推进`

### 6.5 几个不会发生的情况

- ❌ 前端不会看到「没翻译没 AI 标签的半成品」（前端 `extra.workflow_completed_at IS NOT NULL` 过滤逻辑不动）
- ❌ 不会丢数据（数据先 upsert 入库，只是 trigger workflow 时机不同）
- ❌ 积压不会无限增长（list 一天约 261 条 = 30 分钟约 6 条 ≪ 70 阈值，常态根本不会进积压）

---

## 7. 灰度上线 / 验证 / 回滚

### 7.1 上线顺序

按项目「开 feature branch → staging 验证 → 合 main → prod 上线」流程：

1. 开分支 `feat/x-list-cursor-driven`，git worktree 隔离开发
2. staging 部署（`xlist-staging` D1 + `staging-api.ai-feeds.com` worker）
3. staging 让它自然跑 3-7 天（覆盖至少一次小补漏场景）
4. 验证通过 → 合 main → 部 prod

### 7.2 验证方法

**横向比对**：staging 跑新逻辑 vs prod 跑旧逻辑，同一时间窗口（如 staging 上线后 24 小时）内：

- 新逻辑入库的 X 推文数应 ≥ prod
- 缺口超过 5% 视为可能漏抓，需要深查

**纵向比对**：用 SB user-timeline 接口（`/v1/twitter/users/{handle}/tweets`）单独抓 list 内 5-10 个 KOL（包括 karpathy）的最近 100 条 timeline，对比 staging 库里这些人的推文数：

- 一致或差距 < 5% = 真零漏（差距可能来自 SB list endpoint 自身不返某类推文，如纯回复）
- 差距 > 5% = 还有其他漏抓路径，需要继续排查

**运维信号**：staging 跑期间，PushDeer 不应该频繁收到「硬上限触发」「连续失败」通知。如果天天弹，说明逻辑有问题。

### 7.3 回滚预案

加 worker secret `LIST_POLL_MODE`，值：

- `fixed-pages` — 旧逻辑（目前 prod 行为）
- `cursor-driven` — 新逻辑

部署时新代码默认走 `cursor-driven`。出问题秒级回滚：

```bash
source .secrets/aifeeds-prod.env
echo 'fixed-pages' | (cd worker && npx wrangler secret put LIST_POLL_MODE)
```

数据库改动可保留（旧代码忽略新字段，不影响）。

---

## 8. CLAUDE.md 同步更新

本次 PR 同时改 `/Users/roxor/brain/30-projects/aifeeds/CLAUDE.md`：

### 8.1 删除 / 改写

- 整节「### ⚠️ 抓取停止条件：禁用 ID 游标（反复踩过的坑）」**作废**：基于「X list 默认热度排序」前提，已被 2026-05-21 实测推翻
- 「**核心事实**：X list 页面的默认排序是**热度排序**」改为：「**X web 端**显示默认是热度排序；但 **aifeeds 走的 ScrapeBadger `/lists/{id}/tweets` endpoint 是严格时间倒序**（2026-05-21 实测确认，文档无明示但实际行为如此，等价于 X 官方 `ListLatestTweetsTimeline`）」

### 8.2 新增章节

```markdown
### X list 抓取：游标驱动停止条件（2026-05-22 上线）

ScrapeBadger 的 list endpoint 是时间倒序，所以抓取策略改为「游标驱动 + 翻到上次顶端为止」：

- sources.cursor 存上次抓完后 page 1 的顶端 10 个 tweet_id（JSON 数组）
- 每次抓取从最新一页开始翻，本页任意 id 命中 seen_set 即停
- 硬上限 10 页（兜底，防 seen_set 全被删导致无限翻）
- newly_inserted > 70 自动进入「分批触发 workflow」分支，items.pending_workflow=1 标记，
  后续每个 cron tick 收尾消 70 条

详见 docs/plans/2026-05-22-x-list-cursor-driven-design.md。
```

---

## 9. 不在本次范围内（明确排除）

以下三件事是排查时讨论过的 follow-up，但**不在本次改造范围**，等本方案 prod 稳定运行 ≥ 1 周后再单独评估：

- **per-user timeline 兜底**：对 list 里的核心 KOL 用 SB user-timeline endpoint 单独抓 timeline，作为 list-poll 的兜底通路。本次改造后零漏目标应该已经达到，不再需要这个兜底。
- **手动补抓 endpoint**：`/api/admin/x-ingest-by-id?id=...` 直接调 SB get-tweets-by-ids 把指定 tweet 拉进库 + 触发 workflow。属于运维便利工具，不解决核心问题。
- **list 成员审计工具**：karpathy 案例暴露了「list 加错成员 / 缺成员」类问题。可以加个定期跑的脚本对比「list 当前成员」vs「最近 30 天有推文入库的 handle」，但属于运维工具，不在本次。

---

## 10. 实施清单（开 feature branch 后执行）

待开 feature branch 后转入 `writing-plans` skill 细化为可逐步执行的实施计划。粗粒度任务：

1. 写 migration `016-x-list-cursor.sql` + staging 跑一次 `wrangler d1 execute`
2. 改 `worker/src/enrich.ts` 的 `runListPollIngest`：加 `LIST_POLL_MODE` 分支，新逻辑实现 5.x 节算法
3. 改 `worker/src/index.ts` 的 `scheduled()`：cron tick 收尾消「待加工」队列
4. 改 `worker/src/index.ts` 的 `notifyCronSummary`：扩展 3 个新通知信号
5. 改 `CLAUDE.md`：作废旧节 + 加新节
6. staging deploy + 3-7 天观察 + 横/纵比对验证
7. 合 main + prod deploy + 1 周 prod 观察
8. 如稳定，删 `fixed-pages` 分支代码 + 删开关变量
