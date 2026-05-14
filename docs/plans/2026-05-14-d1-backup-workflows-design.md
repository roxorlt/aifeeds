# D1 自动备份方案（CF Workflows + R2）

> 2026-05-14。落地：`worker-backup/`，运维：[`../operations.md`](../operations.md) §「D1 备份」节。
>
> 闭合 TODO §1 数据备份子项 + B 长期方案。

## 背景

prod D1 (`xlist`, ~140MB) **零自动备份**，只能手动 `wrangler d1 export`。三个灾难场景都会永久丢数据：误操作 SQL / cron bug 写坏字段 / 平台事故。需要每天自动备份 → 长期归档。

## 方案选型

TODO 原写"CF 阶段 5 用 Container 跑 wrangler d1 export → R2"。调研发现 CF 有更简单的官方方案 — **CF Workflows + D1 REST export API**。

| 维度 | Container 方案（TODO 原方案） | **Workflows 方案（采用）** |
|---|---|---|
| 配置复杂度 | Dockerfile + wrangler 容器内安装 + token | 一个 worker + 两个 step.do |
| CF API 调用 | 容器内 wrangler 间接调 | worker 直接 fetch CF REST API |
| 重试逻辑 | 手写 retry / sleep | step.do 内置 retry config |
| 启动延迟 | 容器冷启动几秒 | worker 毫秒级 |
| 学习成本 | 容器服务（preview 阶段） | worker + workflow（GA） |
| 成本 | Container 按时间计费（含量内仍 $0） | 在 Workers Paid 含量内 ($0) |
| 官方 example | 无现成模板 | [backup-d1](https://developers.cloudflare.com/workflows/examples/backup-d1/) |

## 架构

```
┌─ Worker: aifeeds-d1-backup ────────────────────────┐
│                                                    │
│  scheduled() ── cron "30 4 * * *" (UTC) ─┐        │
│  fetch /trigger (POST) ──────────────────┤        │
│                                          ▼        │
│  env.D1_BACKUP_WORKFLOW.create()                  │
│         │                                          │
│  ┌──── D1BackupWorkflow ──────────┐                │
│  │ step 1: POST /export {polling} │  ─→ at_bookmark│
│  │   retries: 3 × 5s              │                │
│  │                                │                │
│  │ step 2: poll + download + R2   │                │
│  │   retries: 30 × 20s (10 min)   │                │
│  │   timeout: 15 min              │                │
│  │   ─→ R2 put daily/<date>.sql   │                │
│  └────────────────────────────────┘                │
└────────────────────────────────────────────────────┘
                        │
                        ▼
       ┌─ R2 bucket: aifeeds-d1-backups ─┐
       │  daily/2026-05-14.sql            │  ← 当天
       │  daily/2026-05-13.sql            │
       │  ... (lifecycle 30 天后删)       │
       └──────────────────────────────────┘
```

## D1 export REST API 流程

CF 用 polling pattern 而非长 HTTP 连接：

1. 启动：`POST /accounts/{acc}/d1/database/{db}/export` body `{"output_format":"polling"}`
   → 立即返回 `{result: {at_bookmark: "..."}}`
2. 轮询：`POST` 同 URL body `{"current_bookmark":"<bk>"}`
   - 还没好：返回 `{result: {at_bookmark, messages: ["..."]}}`（无 signed_url）
   - 准备好：返回 `{result: {signed_url, filename, success: true}}`
3. 下载：fetch signed_url → SQL 流 → R2.put

CF 在后台异步生成 dump，140MB DB 通常 10-30s 完成。我们用 `step.do` 的 retry config 实现轮询：未 ready 时 throw → step.do 按 delay 间隔自动重试，跨 retry 不消耗 CPU 时间（这是 Workflows 的核心价值，不是普通 worker 的 setTimeout 阻塞）。

## 关键决策

### 1. 独立 worker 而非加进 xlist-api

**选独立 worker `aifeeds-d1-backup`** 因为：
- 隔离 — 备份失败不影响主业务
- cron schedule 不跟主 worker 的 `*/5` cron 抢 invocation
- 调试方便（独立 logs / metrics）
- 独立 deploy 流程（备份代码改动不需要 redeploy 主 worker）

### 2. R2 命名 + 路径策略

- bucket：`aifeeds-d1-backups`（prod）/ `aifeeds-d1-backups-staging`（staging）
- 路径：`daily/<BJT-date>.sql`（不压缩 — 14MB SQL gzip 下也只省到 ~3MB，不值得加 fflate 复杂度）
- 同日多次触发自动覆盖（PUT 是 idempotent）

### 3. 保留策略

**v1：30 天滚动**（用 R2 lifecycle rule 自动删 `daily/` 30 天前的对象）。
**v2 按需扩展**：如果 30 天不够灾难恢复 RTO，加 `weekly/<YYYY-WXX>.sql`（12 周）+ `monthly/<YYYY-MM>.sql`（12 月）。当前 v1 简单优先。

### 4. Cron 时间：BJT 12:30 (UTC 04:30)

**用户指定**。理由：业务低峰 + 避开主 worker `*/5` cron 整点峰值（`:00 :05 :10 ...`）。

### 5. Token 鉴权

新 secret 名 `D1_BACKUP_API_TOKEN`。两个选项：
- **A. 复用 `CF claude-ops` token**（`.secrets/cf-claude-ops.env`）— 已有 D1:Edit 权限，简单
- **B. 单独建 `aifeeds-d1-backup` 子 token** — 仅需 D1:Read 权限，最小权限原则

v1 先用 A 跑通，未来按需切 B（只换 secret 值，代码不动）。

### 6. 错误处理

step.do 内置 retry 已经覆盖 transient 失败。整体失败（30 次轮询超时 / token 失效 / R2 故障）会让 workflow instance 状态变 `errored`，CF dashboard 可见但**当前没主动告警**。v2 加 PushDeer 推送（复用现有 `PUSHDEER_ADMIN_KEYS`）。

## 月成本算账（Workers Paid $5/月含量）

| 资源 | 月含量 | 实际用量 | 占比 |
|---|---|---|---|
| Workflow 调用 | 1000 万 req/月 | 30 次 + step.do 内部调用 ~100 次 | <0.01% |
| Workflow CPU-ms | 30M ms/月 | ~5s × 30 = 150s | 0.5% |
| R2 存储 | 10 GB 免费 | 30 × 140 MB ≈ 4 GB | 40% |
| R2 PUT (Class A) | 100 万次/月 免费 | 30 次 | <0.01% |
| R2 GET (Class B) | 1000 万次/月 免费 | 仅人工恢复时用 | <0.01% |
| **合计** | | | **$0** |

## 限制 / 已知坑

- **Workflows 单 instance 状态保留 30 天**（Workers Paid，Free 是 3 天）。失败 instance 30 天内能在 dashboard 排查
- **D1 export 是整库 dump**，无法增量备份（CF 不支持）
- **R2 lifecycle 规则配置在 dashboard / wrangler r2 bucket lifecycle 命令行**，需运维一次性设置
- **未配 secret 时 worker 跑会立刻 fail step 1** — 部署前必须先 `wrangler secret put`

## 部署 / 验证步骤

完整步骤见 [`../operations.md`](../operations.md) §「D1 备份」节。简版：

1. `wrangler r2 bucket create aifeeds-d1-backups`
2. dashboard 配 lifecycle rule (daily/ 30 天后删)
3. `echo "<TOKEN>" | wrangler secret put D1_BACKUP_API_TOKEN`
4. `wrangler deploy`
5. `curl -X POST https://aifeeds-d1-backup.<acc>.workers.dev/trigger`
6. `wrangler r2 object list aifeeds-d1-backups` 确认 daily/<today>.sql 存在
