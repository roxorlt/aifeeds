# 行业要闻候选发现 / 授权两阶段拆分（2026-09-02 D1 CPU 超限事故修复）

> 运维侧同款内容已写进本地 `docs/operations.md` § 2a「D1 热点查询预算守则」。
> operations.md 因含服务器坐标不进公开仓（见 `.gitignore` 末段），故把**不含运维坐标**的
> 工程守则单独落这份可入库文档，供后续 session / 协作方直接引用。

## 1. 事故

- 9/2 早 07:50 行业要闻批次重建连败 3 次，08:00 回补再败 3 次，全部因 D1 CPU 超限。
- 论文与最终推送被连坐停摆；六连败期间无任何告警，owner 08:45 自己发现。
- 故障日人审工作流整体不可用。

**根因**：8/27 PR #220 把「正式信源授权」JOIN 直接嵌进候选发现大查询（`worker/src/digest/selection.ts`
的 `selectNewsByScoreWithAudit`）：

1. `registry` 是 CTE（无索引），连接键 `json_extract(i.extra,'$.feed_id')` 外面还套 `CASE`
   （表达式不可索引）；
2. 时间窗写成 `datetime(i.scraped_at) >= datetime('now','-3 day')`——**列被函数包住，`items`
   上所有 `scraped_at` 索引一律失效**；
3. 规划器只剩 `idx_items_deleted` 这类几乎无选择性的索引可选（96,370 行里 96,369 行满足
   `deleted_at IS NULL`），推算数百万行扫描 + 每行多次 JSON 解析，而实际目标只有约 144 条。

这条查询每天 07:50 都跑，修复上线前每天都会复发。

## 2. 修复：两阶段

### 阶段一 · 候选发现（`discoverNewsCandidateIds`）

纯索引、单表、**不 JOIN** registry / sources：

```sql
/* news_selection:candidate_discovery */
SELECT i.id FROM items i
 WHERE i.source_type IN ('blog','podcast')
   AND i.is_relevant = 1
   AND i.scraped_at >= ?            -- asOf 分支再加 AND i.scraped_at < ?
   AND <噪音过滤：标题 LIKE 那批，逐字保留>
 ORDER BY i.scraped_at DESC
 LIMIT 5000
```

三个要点：

- **时间边界改成 JS 算好的裸串绑参**。`items.scraped_at` 对 blog/podcast 的全部写入方
  （`worker/src/blog.ts`、`worker/src/podcast.ts` 的 `new Date().toISOString()`，
  `worker/src/digest/manual-news-leads-store.ts` 的 `new Date(now).toISOString()`）都是定宽
  24 字符 `YYYY-MM-DDTHH:MM:SS.sssZ`，同格式定宽 UTC 串的字典序 ≡ 时序。
  （格式不一致的是 x_list 那批空格分隔串，阶段一已把 `source_type` 限死在 blog/podcast。）
- **窗口语义与事故前逐字节等价**（`newsCandidateWindow`）：
  - 默认分支：`datetime()` 两边都截到秒，所以下界 = 「now 向下取整到秒再减 3 天」，毫秒位固定 `.000`；
  - asOf 分支：`datetime('YYYY-MM-DD')` = 该日 00:00:00 UTC，故下界 = D-3 日 `00:00:00.000Z`、
    上界 = D 日 `00:00:00.000Z`（严格小于，**绝不加 `'+1 day'`**，加了历史页回填整体错位一天）；
  - D 非法时事故前是 `datetime('garbage')` → NULL → 选不出任何行，这里用一个不可能满足的边界
    复刻同样的 fail-closed，不新增抛错路径。
- **刻意不带 `deleted_at IS NULL`**。它覆盖率 99.999%，是 `idx_items_deleted` 的诱饵，正是事故里
  规划器选错索引的直接原因；它属于授权谓词，交给阶段二。

**不需要新建索引**：`schema.sql` 里早有 `idx_items_source_scraped(source_type, scraped_at DESC)`，
一直因为 `datetime()` 包裹而吃不到。生产规模夹具上实测计划为
`SEARCH i USING INDEX idx_items_source_scraped (source_type=? AND scraped_at>? AND scraped_at<?)`。
（顺带评估过补一条 `(source_type, is_relevant, scraped_at)`：10 万行本地建索引 ~40ms，但既然现有索引
已经够用，就不给 96K 行的生产表付这份 D1 CPU + 写放大成本。）

**安全阀**：`LIMIT 5000`（生产 3 天窗口实测量级几百条，~35x 冗余）+ `ORDER BY scraped_at DESC`，
命中即打 `console.warn`。目的是让阶段二的驱动集合**永远有上限**。

### 阶段二 · 授权（`authorizeNewsCandidateRows`）

授权谓词（`formalNewsScheduledSqlPredicate` + registry/sources JOIN）**一字未改**，只把驱动集合
换成 `json_each(候选ids)` 按主键探 `items`，每批 300 个 id：

```sql
/* news_selection:candidate_authorization */
WITH registry AS MATERIALIZED (...), requested AS (SELECT value AS id FROM json_each(?))
SELECT ... FROM requested q
  CROSS JOIN items i ON i.id=q.id
  CROSS JOIN registry r ON r.id=json_extract(CASE ... END,'$.feed_id')
  CROSS JOIN sources s ON s.id=r.id
 WHERE <阶段一同款非授权谓词> AND <授权谓词，逐字未改>
```

两处规划器约束，**只影响执行顺序，不影响结果集**：

- `registry AS MATERIALIZED (...)`：把 registry 落成临时表，外层 JOIN 才能对 `r.id` 建 automatic
  index，而不是每条候选重新展开一次 `json_each(?)`。
- 三个 `CROSS JOIN`：SQLite 把 CROSS JOIN 当作「禁止重排这两张表」的指令（语义等同 INNER JOIN），
  把循环顺序钉成「候选 id → items 主键 → registry → sources」。**不钉不行**——生产规模夹具上实测，
  不写 CROSS JOIN 时规划器会改成 `SCAN r → SEARCH s → SEARCH i USING idx_items_source_scraped`，
  即 registry 重新变成外层驱动，正是事故那条大查询的形状。

### 等价性论证

记原查询谓词为 `P_base ∧ P_auth`。阶段一 = `P_base`（外加安全阀 LIMIT），阶段二 =
`(id ∈ 阶段一结果) ∧ P_base ∧ P_auth`。只要安全阀未命中，阶段一结果 ⊇ 原查询结果，
于是两阶段合起来 ≡ 原查询，逐行相同。这一点由
`worker/src/digest/selection-news-authorization-matrix.test.ts` 在真 SQLite 上对每一格形态
**同时跑两条路径并断言结论一致**来守护，而不是只重述当前实现的行为。

## 3. D1 热点查询四条守则

写任何跑在 cron / 批次里的 D1 查询前对照：

1. **候选发现与授权分层**。先用「纯索引、单表、无 JOIN」的查询把候选收敛到有明确上限的 id 列表，
   再喂给授权 / 校验查询（`json_each(?)` + 主键探测）。授权谓词本身一字不改，只换驱动集合。
2. **绝不把索引列包在函数里做范围比较**。边界在 JS 里算好、绑参、对裸列比较。
3. **别在热点查询里放「诱饵谓词」**（覆盖率接近 100% 的条件）。
4. **id 驱动的多表 JOIN 要钉死循环顺序**（`CROSS JOIN` + `MATERIALIZED` CTE）。

## 4. 验收方式：生产规模夹具 + 计划/时间双断言

- **夹具**：`worker/src/digest/selection-news-query.test-fixture.ts` 用 `schema.sql` +
  `migrations/*.sql` 建出**生产同款索引集合**，灌 10 万行 `items`（96k X list + 4k blog/podcast，
  blog/podcast 摊 90 天 ≈ 44 条/天、3 天窗口内 ≈ 134 条，`deleted_at` 只有 1 行非空）。
  索引集合不还原，`EXPLAIN QUERY PLAN` 的断言就没有意义。
- **双断言**：`worker/src/digest/selection-news-query-budget.test.ts` 既断言计划形状，也断言
  整条流水线的执行时间预算（2s，本地实测 ~32ms，给 CI 共享 runner 留 60x 冗余）。
  只测时间会被小夹具糊弄；只测计划会漏掉 JS 侧 O(n²) 打分那种非 SQL 的开销。
- **变异验证**（都实跑过、确认会红）：
  - 把事故前那条单体大查询原样放回同一份夹具：旧形态 ~130ms vs 阶段一 ~0.6ms（>200x），
    且计划里 `scraped_at` 范围条件消失；
  - 阶段二删掉授权谓词：radar 信源与禁用信源立刻漏放行，矩阵变红。

## 5. 授权 JOIN 消费点审计清单

`FORMAL_NEWS_REGISTRY_CTE` 的全部消费点，新增消费点时补进本表并加计划断言
（`selection-news-query-budget.test.ts` 里的「审计」用例会在生产规模夹具上跑 EXPLAIN 逐条钉死）：

| 位置 | 驱动集合 | 上限 | 结论 |
|---|---|---|---|
| `selection.ts` `authorizeNewsCandidateRows` | 阶段一候选 id | 阶段一 `LIMIT 5000` + 每批 300 | 本次改造，已钉顺序 |
| `selection.ts` `fetchNewsCandidatesByIds` | 已推账本 id | 每批 `D1_ID_BATCH_SIZE=80` | 本次同法钉顺序 |
| `news-source-policy.ts` `loadScheduledAuthorizationRows` | `json_each(候选ids)` | 评审批次候选数 | `LEFT JOIN` 已钉外层，实测计划正确，无需改 |
| `news-source-policy.ts` `formalNewsFinalGuardCtes`（3 处调用） | `formal_expected`（发布快照条目） | 单期发布条目数 | `LEFT JOIN` 已钉外层，实测计划正确，无需改 |

## 6. 遗留风险

- **D1 的规划器统计与本地 SQLite 不完全一致**。本次已用「不依赖统计」的手段（CROSS JOIN 钉顺序、
  裸列比较让索引可用）把计划固定下来，但 `idx_items_source_scraped` 是否真被 D1 选中，仍需上线后
  实测确认（可用 `EXPLAIN QUERY PLAN` 走 `wrangler d1 execute --remote` 验一次）。
- **阶段一安全阀命中时会静默丢弃最旧的候选**（只有 `console.warn`）。当前留了 35x 冗余，
  如果未来接入源变多，应把它升级成一条告警。
- **JS 侧打分是 O(n²)**（`scoreNewsCandidatesForDigest` 对候选两两比事件指纹）。生产 ~144 条
  无压力，但若安全阀真被顶到 5000，25M 次比较自身就是 CPU 风险 —— 这条与本次 SQL 修复正交，
  未来若候选量级上台阶需要单独处理。
