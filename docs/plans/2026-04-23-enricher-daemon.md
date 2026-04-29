# 设计：enricher daemon — L0-L5 分层 metrics 刷新

生成时间：2026-04-23
状态：M1/M1.5/M2/M3 已完成（2026-04-23），M4 已全量上线（2026-04-29，REFRESH_MODE=tiered + REFRESH_TIER_MAX=4），M5 观测调优进行中
相关 TODO：`enricher daemon: L0-L5 分层 metrics 刷新，按热度衰减调度`

---

## 问题陈述

Worker 端 `refresh-metrics` 模式当前是**盲目 round-robin**：对过去 14 天所有推文做均匀轮询。

观察到的两个问题：

1. **热推刷太慢**：发布 1 小时内正在爆的推文，要等 1-2 天才能被再次 refresh，metrics 严重滞后。Dashboard 上的点赞数看起来像僵尸数据。
2. **冷推刷太勤**：发布 3+ 天后 metrics 基本定型，但仍按同样频率占用 CF Free tier 的 50 subreqs/invocation 配额，挤占热推的名额。

根因是"一刀切"策略和真实数据分布（典型幂律）不匹配：少数推文是流量大头，多数推文发完 24h 就静止了。

## 目标

1. **热推 metrics 始终新鲜**（< 10min 延迟），以 Dashboard 上看到的点赞数不输 X 官方页面为标准
2. **冷推按衰减减少刷新**，把省下的额度还给热推
3. **可观测**：能看到每个 tier 的刷新次数、占用额度比例，方便后续调优
4. **低风险**：首版不改现有 `backfill-quotes` / `fill-translations` 模式，只改 `refresh-metrics`；旧逻辑降级为兜底

## 分层定义（L0-L5）

按**推文年龄 + 最近一轮 metrics 增速**双维度分档。年龄是硬边界，velocity 是软调节（把已老但突然爆的推文捞回上层）。

**阈值已于 M1 数据探测后更新**（2026-04-23，N=1369，见 `docs/plans/2026-04-23-enricher-daemon-m1-findings.md`）：

| Tier | 年龄 | velocity（Δlikes / Δminute）| 刷新间隔 | 预期占比 |
|:----:|------|-----------------------------|----------|---------|
| L0 | < 1h | 任意（通常只靠 upgrade 填充）| 10 min | ~1-2% |
| L1 | 1-6h | ≥ 0.2 | 20 min | ~3-5% |
| L1 | 1-6h | < 0.2 | 45 min | |
| L2 | 6-24h | ≥ 0.08 | 60 min | ~8-12% |
| L2 | 6-24h | < 0.08 | 120 min | |
| L3 | 1-7d | ≥ 0.05 | 6 h | ~25-30% |
| L3 | 1-7d | < 0.05 | 24 h | |
| L4 | 7-14d | ≥ 0.04 | 3 d | ~20-30% |
| L4 | 7-14d | < 0.04 | 7 d | |
| L5 | > 14d | 任意 | 不刷 | ~25-40% |

**upgrade 逻辑**：任意 tier 发现本轮 Δ 超过当前 tier 对应 velocity 阈值 → 升一级（例如一条 L3 突然涨了 0.25 likes/min → 可直接升到 L1）。

**注意**：这组阈值基于 **likes / age_hours 累积均值** 的 p50-p75 区间反推。累积均值会系统性**低估热推当前速度**（分母含冷却期），**高估冷推历史速度**。真 Δ 在爆发期通常是累积均值的 2-3x，所以上线后若发现"升级过严"（热推没被及时升到 L0/L1），再按真 Δ 校准。

## 数据 schema 改动

### D1 `items` 表新增 4 列（M3 一次性上线）

```sql
ALTER TABLE items ADD COLUMN tier INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN next_refresh_at INTEGER;  -- Unix timestamp
ALTER TABLE items ADD COLUMN last_velocity REAL DEFAULT 0;  -- likes/min 本轮
ALTER TABLE items ADD COLUMN deleted_at INTEGER;       -- Unix timestamp, syndication 返回 404 时写入，前端 feed 过滤
CREATE INDEX idx_items_next_refresh ON items(next_refresh_at);
CREATE INDEX idx_items_deleted ON items(deleted_at);
```

本地 SQLite（`data/xlist.db`）同步加列，`push_to_cloud` 补字段。

### `refresh_log` 表（观测用，保留 30 天，M3 随上线加）

```sql
CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refreshed_at INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  items_count INTEGER NOT NULL,
  subrequests_used INTEGER NOT NULL,
  duration_ms INTEGER,
  errors INTEGER DEFAULT 0
);
```

### `metrics_snapshots` 表（**M1.5 立刻上线**，积累真 Δ 数据）

```sql
CREATE TABLE metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,           -- D1 items.id
  captured_at INTEGER NOT NULL,    -- Unix timestamp
  likes INTEGER,
  retweets INTEGER,
  replies INTEGER,
  bookmarks INTEGER,
  views INTEGER
);
CREATE INDEX idx_snapshots_item_time ON metrics_snapshots(item_id, captured_at);
CREATE INDEX idx_snapshots_time ON metrics_snapshots(captured_at);
```

**为什么提前**：M1 发现累积均值（`likes / age_hours`）和真 Δ 有 2-3x 系统性偏差，要让 M4 灰度时已经有 1-2 周真 Δ 可用，schema 必须现在就上线，`runRefreshMetrics` 每次覆盖 `items.metrics` 时同步 append 一行 snapshot。存储估算：1369 推文 × 7 次/天 × 30 天 ≈ 29 万行，~20MB，D1 空间充裕。

## 架构

**不需要新起 daemon 进程**。所有逻辑都落在 Worker 端（已有的 `*/5 * * * *` cron 入口），新增 `refresh-tiered` 模式。

```
Worker cron (5min tick)
  └→ 按现有时间槽分派（00/30 = refresh, 15/45 = translate, 其他 = backfill）
     └→ refresh 槽位改调用 runRefreshTiered()：
        1. SELECT ... WHERE next_refresh_at <= NOW()
           ORDER BY tier ASC, next_refresh_at ASC
           LIMIT batch_size
        2. 按 subrequest 配额分批取 syndication API
        3. 计算 velocity = (new_likes - old_likes) / Δmin
        4. 按新 velocity + age 重算 tier → 写 next_refresh_at
        5. 日志落 refresh_log 表
```

**配额分配**（CF Free: 50 subreqs/invocation）：

- 保留 5 个给其他 worker 调用（/ingest、/api/* 等）
- 剩下 45 给 refresh，每次 invocation 理论 45 条
- L0 优先（ORDER BY tier ASC），再 L1，依次填满
- 凡是没轮到的留给下一次 tick

## 回滚策略

- 整个特性用环境变量 `REFRESH_MODE` 控制：`tiered` / `legacy`（旧 round-robin）/ `off`
- 坏了就 `wrangler secret put REFRESH_MODE legacy` 回退到旧逻辑，不需要重新部署代码
- `items.tier` 列保留，不会阻塞回滚（新 schema 向后兼容）

## Milestones

| M | 内容 | 预估 | 状态 |
|:-:|------|------|------|
| 1 | 数据探测：`scripts/probe_delta_likes.py`，拉 14 天 likes/hour_since_publish 分布，初定阈值 | 0.5 天 | ✅ 2026-04-23 完成（N=1369，幂律确认，阈值下调至 L1=0.2/L2=0.08/L3=0.05/L4=0.04） |
| 1.5 | metrics_snapshots 表 schema + Worker 每次覆盖 items.metrics 时同步 append 一行。让 M4 灰度时已经有真 Δ 数据 | 0.3 天 | ✅ 2026-04-23 完成（D1 表 + Worker `updateMetrics` 改用 `env.DB.batch([UPDATE, INSERT])` 原子写） |
| 2 | 模拟器：`scripts/simulate_enrich.py`，用历史数据重放 tier 策略 vs 现有 round-robin，对比"hot 推 metrics 滞后时间" + "总 subrequest 消耗" | 1 天 | ✅ 2026-04-23 完成（-49% 刷新次数；L0 p95 滞后 114→12 likes，L1 187→25） |
| 3 | D1 `items` 4 列迁移 + `refresh_log` 表 + 本地 schema 同步 + 回填首版 tier | 0.3 天 | ✅ 2026-04-23 完成（回填 34,702 行：L1=22/L2=118/L3=834/L4=1,025/L5=32,702；L0=0 因最新推文已 ≥69min） |
| 4 | Worker 新增 `runRefreshTiered` + 环境变量开关，灰度：先只对过去 6h 的推文启用（L0+L1），7d+ 继续走旧逻辑 | 1 天 | ✅ 2026-04-29 代码上线 + 全量启用（先 `REFRESH_TIER_MAX=1` 灰度验证 by_tier={1:11, 2:8, 3:1}，确认无回归后直接调到 `REFRESH_TIER_MAX=4` 覆盖 L0-L4，跳过 3-7 天观察期） |
| 5 | 观测 & 调优：看 `refresh_log` 表，用真 Δ（snapshots）校准阈值，全量启用（覆盖 L0-L5） | 0.5-1 天 | 待做 |

**合计：约 3.5-4 天**。M1.5 是 M1 之后加的前置工作（让 M4 有真 Δ 可用），换来 M5 校准质量大幅提升。

## 开放问题 & 决策（2026-04-23 讨论落定）

1. **velocity 阈值怎么选**：上面列的 0.5/0.2/0.1 是拍的 → **决策：M1 拉 30 天 Δlikes histogram 后再定**，当前表只是初版占位。
2. **deleted tweets 怎么处理**：syndication API 返回 404 → **决策：新增 `deleted_at` 列，物理过滤出前端 feed + 停止刷新**。不靠 tier=L5 隐式表达删除，避免数据语义混淆。
3. **velocity 要不要 EMA 平滑**：**决策：首版不做，只看最近一次 Δ**。开销 ≈ 0 但过度工程风险，等 M4 灰度 2 周跑出真实误升级率（升到 L0/L1 又 2-3 轮内降回的比例），若 >20% 再加 EMA（改几行）。
4. **L5 永久不刷的逃生门**：**决策：复用已有 TODO "前端 on-demand metrics 刷新"（`/api/refresh/:id`）**。用户看到老数据陈旧 → 手动点刷新 → 精准低频唤醒。不做系统性兜底。上线后若漏得多，再加 L5 每周随机抽 10% 刷的周期性兜底。

## 相关上下文

- 与刚做的 scrape scheduler（C2 hybrid + 周度 auto-tune）形态类似，都是"按热度分级调度"模式
- Worker 现有 enrich 逻辑：`worker/src/enrich.ts`
- 现有 refresh-metrics 代码：同文件内 `runRefreshMetrics`
