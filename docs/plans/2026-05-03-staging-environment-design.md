# Staging 环境设计 — ai-feeds

> **目标**：在 prod（ai-feeds.com）旁边建一套同构但隔离的 staging 环境，所有「写操作 / 部署演练 / schema 变更 / 限流测试」都在 staging 跑，prod 数据永远干净。
>
> **背景**：当前架构只有 prod 一套（D1 / KV / R2 / Worker / Pages）。dev 时直接调 prod worker（vite proxy），登录测试会真发短信、真写 sessions 表、命中真风控。dashboard 升级时跟 worker 不同步会全站挂（PR3 第一次部署翻车的根因）。
>
> **状态**：设计稿。下一阶段（PR6 上线加固）再实施。

---

## 一、问题陈述

### 当前的痛点

| 类别 | 当前做法 | 痛点 |
|---|---|---|
| 登录测试 | dev → prod worker | 真发短信，污染 24h 风控、消耗 SMS daily cap |
| schema 变更 | 直接 `wrangler d1 execute --remote` 改 prod | 错一个字段全用户挂 |
| Worker 部署 | `wrangler deploy` 直接覆盖 prod | dashboard 旧 bundle + worker 新 bundle 不兼容（PR3 第一次部署 CORS 全挂的根因） |
| 数据备份 | 无 | prod D1 误删无法恢复 |
| 实验功能 | 跟 prod 挤一条 main 分支 | 半成品上线 |

### staging 要解决的核心 3 件事

1. **隔离写操作** — 登录、注销、收藏、订阅在 staging 跑，prod 不被污染
2. **演练部署** — Worker / Dashboard / D1 schema 变更先 staging 验证，再 prod
3. **数据备份点** — 周期性 `wrangler d1 export` prod → 存 R2，灾备可恢复

---

## 二、架构总览

```
┌──────────────────  Production  ──────────────────┐
│                                                  │
│  https://ai-feeds.com                            │
│    └→ xlist-dashboard.pages.dev (main branch)    │
│        └→ fetch https://api.ai-feeds.com         │
│            └→ Worker: xlist-api                  │
│                ├→ D1: xlist                      │
│                ├→ KV: AUTH_KV                    │
│                └→ R2: xlist-readme-assets        │
│                                                  │
│  Cron: 抓取 / enrich / refresh-metrics 全开      │
│  Secrets: 真 Tencent SMS / 真 Turnstile          │
│  数据: 用户真实数据                              │
└──────────────────────────────────────────────────┘

┌────────────────────  Staging  ───────────────────┐
│                                                  │
│  https://staging.ai-feeds.com                    │
│    └→ xlist-dashboard-staging.pages.dev          │
│        └→ fetch https://staging-api.ai-feeds.com │
│            └→ Worker: xlist-api-staging          │
│                ├→ D1: xlist-staging              │
│                ├→ KV: AUTH_KV_STAGING            │
│                └→ R2: xlist-readme-assets-stg    │
│                                                  │
│  Cron: 默认全关（手动触发 / 频率降到 1h）        │
│  Secrets: PushDeer 推 admin（不发真短信）        │
│  数据: 从 prod 拉一次种子 + 手动测试数据         │
└──────────────────────────────────────────────────┘

┌────────────────────  Local Dev  ──────────────────┐
│                                                   │
│  localhost:5173 (vite dev server)                 │
│    └→ vite proxy /api → 默认指向 staging worker   │
│       VITE_API_PROXY=https://api.ai-feeds.com     │
│       临时切回 prod 的覆盖（仅只读测试用）        │
└───────────────────────────────────────────────────┘
```

---

## 三、Cloudflare 资源清单

新建以下并行资源（每个都是独立 ID / namespace，不会跟 prod 共享数据）：

| 资源 | Prod | Staging |
|---|---|---|
| Worker name | `xlist-api` | `xlist-api-staging` |
| Worker URL | `xlist-api.ltsms86.workers.dev` | `xlist-api-staging.ltsms86.workers.dev` |
| Custom domain | `api.ai-feeds.com` | `staging-api.ai-feeds.com` |
| D1 database | `xlist`（id `2973d54b-…`） | `xlist-staging`（新建） |
| KV namespace | `AUTH_KV`（id `07d666…`） | `AUTH_KV_STAGING`（新建） |
| R2 bucket | `xlist-readme-assets` | `xlist-readme-assets-staging` |
| Pages project | `xlist-dashboard` | `xlist-dashboard-staging` |
| Pages domain | `ai-feeds.com` | `staging.ai-feeds.com` |

**成本**：所有资源仍在 Cloudflare Free / Workers Paid 已含的额度内，月增费用 **0 元**。
- D1 Free 5GB / 5M reads / 100k writes
- KV Free 100k reads / 1k writes / day
- R2 Free 10GB
- Workers Paid plan 已含 Browser Rendering（Phase 1 PH POC 用）

---

## 四、wrangler.toml 配置

`worker/wrangler.toml` 加 `[env.staging]` section（top-level 是 prod 默认值）：

```toml
name = "xlist-api"
main = "src/index.ts"
compatibility_date = "2024-12-01"

# Production (top-level = main env)
[[d1_databases]]
binding = "DB"
database_name = "xlist"
database_id = "2973d54b-ca13-48e4-8d20-1430c57f5260"

[[r2_buckets]]
binding = "READMES"
bucket_name = "xlist-readme-assets"

[[kv_namespaces]]
binding = "AUTH_KV"
id = "07d666433fef483a9457146f7d5a62d5"
preview_id = "78f0a9567d434d8b87c71cc29eea88f9"

[triggers]
crons = ["*/5 * * * *"]

# ─── Staging override ───
[env.staging]
name = "xlist-api-staging"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "xlist-staging"
database_id = "<新建后填>"

[[env.staging.r2_buckets]]
binding = "READMES"
bucket_name = "xlist-readme-assets-staging"

[[env.staging.kv_namespaces]]
binding = "AUTH_KV"
id = "<新建后填>"
preview_id = "<新建后填>"

# Staging cron 默认全关，手动触发即可
[env.staging.triggers]
crons = []
```

部署命令：
- prod：`wrangler deploy`（不带 env，走 top-level）
- staging：`wrangler deploy --env staging`

---

## 五、Secrets 配置

每个 staging secret 独立设置，**不**复制 prod 的真实值：

```bash
# Turnstile：staging 可以共用 prod sitekey（hostname 加 staging.ai-feeds.com 就行），
# 但建议另开一个 staging sitekey + secret，干净隔离
wrangler secret put TURNSTILE_SECRET_KEY --env staging  # 输入 staging sitekey 的 secret

# SMS：staging 一律走 PushDeer fallback（不发真短信）
wrangler secret put SMS_PROVIDER --env staging  # 值: pushdeer
wrangler secret put PUSHDEER_ADMIN_KEYS --env staging  # 同 prod

# 不设：TENCENT_SMS_* 这一组（让 staging 走 PushDeer 路径）

# Admin panel
wrangler secret put ADMIN_USER --env staging
wrangler secret put ADMIN_PASS --env staging

# DeepSeek（staging 也要 enrich，可共用 prod key 或单独申请）
wrangler secret put DEEPSEEK_API_KEY --env staging

# GITHUB_TOKEN（GH 抓取，staging 抓的频率低，可共用）
wrangler secret put GITHUB_TOKEN --env staging
```

---

## 六、Dashboard 配置

`dashboard/.env.staging` 文件（git ignore）：
```
VITE_API_BASE=https://staging-api.ai-feeds.com
```

`package.json` 加 script：
```json
{
  "scripts": {
    "build": "tsc -b && vite build",
    "build:staging": "tsc -b && vite build --mode staging",
    "deploy:staging": "npm run build:staging && wrangler pages deploy dist --project-name=xlist-dashboard-staging --commit-dirty=true"
  }
}
```

vite.config.ts 已经支持 `VITE_API_PROXY`，dev 时只需：
```bash
# dev 默认连 staging（最常用）
npm run dev

# dev 临时连 prod（只读验真数据）
VITE_API_PROXY=https://api.ai-feeds.com npm run dev
```

---

## 七、staging D1 schema 同步

prod schema 变更时，staging 必须同步。流程：

```bash
# 1. prod 产生新 migration
worker/migrations/009-xxx.sql

# 2. staging 先跑（验证 schema 改动不破坏现有数据）
cd worker
wrangler d1 migrations apply xlist-staging --env staging --remote

# 3. staging worker 部署 + 跑测试
wrangler deploy --env staging
# ... 验收

# 4. prod 跑 migration
wrangler d1 migrations apply xlist --remote

# 5. prod worker 部署
wrangler deploy
```

---

## 八、staging 数据 seed

第一次建好 staging 后，需要灌入种子数据让 dashboard 不空。两种方式：

### 方案 A：从 prod export 一次（快，约 5 分钟）

```bash
# prod 导出
wrangler d1 export xlist --remote --output=prod-snapshot.sql

# 删 staging 现有
wrangler d1 execute xlist-staging --env staging --remote --command="DROP TABLE IF EXISTS items"
# ... 其他表

# 导入 staging
wrangler d1 execute xlist-staging --env staging --remote --file=prod-snapshot.sql

# 注意：导入会带上 prod 真用户的 sessions / events，建议 export 时 --no-data 仅导 schema，
# 用户表手动加测试账号即可
```

**陷阱**：用户的 phone identity / sms_send_log 也会被复制过去。隐私敏感的 staging 应该
- 用 `wrangler d1 export --no-data` 只导 schema
- 然后 `wrangler d1 execute --file=` 跑一份 staging 种子（手动写的几条假数据）

### 方案 B：跑一次完整 enrich pipeline（慢，但数据完全干净）

```bash
# staging 上手动触发抓取 / enrich
curl -X POST -H "Authorization: Bearer $INGEST_TOKEN_STAGING" \
  https://staging-api.ai-feeds.com/api/enrich/run?mode=github-fetch
# ... github-enrich, refresh-metrics 等
```

**推荐 A 的 schema-only + 加几条手动测试数据**，最干净。

---

## 九、定时任务（Cron）

**Prod cron 全开**（`*/5 * * * *`，含抓取 / enrich / refresh-metrics）。

**Staging cron 默认全关**：
- 不需要每 5min 跑（数据是种子，不会动态产生新内容）
- 测试 cron 行为时手动触发：`curl https://staging-api.ai-feeds.com/cdn-cgi/handler/scheduled`
- 或临时打开降频：`crons = ["0 */6 * * *"]`（每 6h 一次）

---

## 十、数据备份

利用 staging 的 R2 bucket 做 prod 的灾备点：

`worker/src/index.ts` 加一个 cron 任务（每周日 02:00 UTC）：

```ts
// scheduled handler
if (cron === '0 2 * * 0') {
  // 1. wrangler d1 export 不能在 worker 里跑（外部命令）
  //    所以备份用本地 launchd cron 或 GitHub Actions 走
}
```

更实际的方案（本地 launchd cron）：
```bash
# ~/Library/LaunchAgents/com.aifeeds.d1-backup.plist
# 每周日 02:00 跑
cd ~/brain/30-projects/xlist-scraper/worker
DATE=$(date +%Y%m%d)
wrangler d1 export xlist --remote --output=/tmp/xlist-$DATE.sql
gzip /tmp/xlist-$DATE.sql
# 上传到 staging R2 bucket（用 R2 不重复花钱）
wrangler r2 object put xlist-readme-assets-staging/backups/xlist-$DATE.sql.gz \
  --file=/tmp/xlist-$DATE.sql.gz
# 清理本地
rm /tmp/xlist-$DATE.sql.gz
# 保留最近 12 周备份（旧的删）
# ...（用 R2 lifecycle rule 或脚本）
```

恢复流程：
```bash
# 从 R2 拉回备份
wrangler r2 object get xlist-readme-assets-staging/backups/xlist-20260503.sql.gz \
  --file=/tmp/restore.sql.gz
gunzip /tmp/restore.sql.gz
# 灌回 prod（先创建一个 xlist-restore D1 验真，再切换）
wrangler d1 create xlist-restore
wrangler d1 execute xlist-restore --remote --file=/tmp/restore.sql
# 验真后改 wrangler.toml 的 database_id 切过去
```

---

## 十一、Turnstile / SMS 隔离

### Turnstile 三选一

| 方案 | 实施 | 适用 |
|---|---|---|
| 共用 prod sitekey | hostname allowlist 加 `staging.ai-feeds.com` | 最简单 |
| 独立 staging sitekey | 在 CF Turnstile 新建，仅 staging hostname | 隔离干净 |
| Test sitekey `1x00000000000000000000AA`（永远 pass） | staging.ai-feeds.com 上写死 | 完全 bypass，纯前端开发 |

**推荐方案 1**（共用 + 加 hostname），最少配置。

### SMS 三选一

| 方案 | 实施 | 真发短信？ |
|---|---|---|
| `SMS_PROVIDER=pushdeer` | staging worker secret 设这个 | 否，推 admin |
| 用 Tencent 测试模板 + 测试号 | staging 配 testing 模板 + 自己手机号白名单 | 是但仅自己 |
| 完全 mock | worker 加 `MOCK_SMS=1` 直接返回 success，code = '123456' | 否，code 写死 |

**推荐方案 1**（pushdeer），跟现在 prod 已部署的 pushdeer fallback 一致，零改动。

---

## 十二、git 流程

新约定：

```
main (prod)                ← 已合并、已部署
  ↑
  └─ feature branch        ← worktree 隔离开发
       ↓ 完成
       push staging        ← deploy --env staging
       ↓ 验收
       merge main
       ↓
       deploy prod
```

`CLAUDE.md` 「发布前 checklist」加：
- [ ] 已先 deploy staging 验证
- [ ] schema 变更先 staging 跑 migration
- [ ] worker 改动跟 dashboard 改动一起部署，避免 PR3 那种 dashboard 新 / worker 旧 CORS 挂掉

---

## 十三、实施步骤（PR6 时按这个跑）

### Step 1：建资源（约 30min）
```bash
# D1
wrangler d1 create xlist-staging
# 拿到 database_id 写入 wrangler.toml [env.staging]

# KV
wrangler kv:namespace create AUTH_KV --env staging
wrangler kv:namespace create AUTH_KV --env staging --preview

# R2
wrangler r2 bucket create xlist-readme-assets-staging

# Pages
# CF dashboard 手动建 xlist-dashboard-staging project + 绑定 staging.ai-feeds.com
```

### Step 2：迁 schema（约 5min）
```bash
wrangler d1 migrations apply xlist-staging --env staging --remote
```

### Step 3：配 secrets（约 10min）
（见第五节）

### Step 4：seed 数据（约 10min）
（见第八节方案 A）

### Step 5：部署 worker + dashboard（约 5min）
```bash
cd worker && wrangler deploy --env staging
cd dashboard && npm run deploy:staging
```

### Step 6：自定义域绑定（约 10min）
- CF dashboard → Worker → Custom Domains → 加 `staging-api.ai-feeds.com`
- CF dashboard → Pages → Custom Domains → 加 `staging.ai-feeds.com`
- DNS 自动配（同 zone）

### Step 7：更新 dev 默认指向（约 2min）
- `dashboard/vite.config.ts` 默认 proxy target 改成 `https://staging-api.ai-feeds.com`
- `.env.staging` 写明

### Step 8：写本地备份 launchd（约 15min）
（见第十节）

### Step 9：更新文档（约 10min）
- `docs/operations.md` 加 staging section
- `CLAUDE.md` 发布 checklist 加项
- HTML 教程（独立交付）

**总计约 1.5 小时一次性投入，之后零维护成本**（除了周备份是本地 cron 自动）。

---

## 十四、风险与注意

1. **不要把 prod 真用户数据复制到 staging**。staging 数据应该是 schema-only + 假数据。隐私 + 合规风险。
2. **staging Turnstile sitekey 加 hostname 后，prod 行为不变**——hostname allowlist 是 superset。
3. **wrangler env 用错**会把 staging 改动推上 prod。所有命令必须显式 `--env staging` 或 `(默认 prod)` 心知肚明。
4. **Staging 应该有自己的 admin panel 凭据**（ADMIN_USER/ADMIN_PASS），不要共用 prod 凭据。
5. **CF Workers Paid plan 仅一个 $5/月 plan 就够 prod + staging 共用**——配额是 account 级的不是 worker 级的。
6. **Pages 自定义域需要 zone 在同一个 CF account**（ai-feeds.com 已在）。
7. **D1 free tier 是 account 级**：xlist + xlist-staging 共享 5GB / 5M reads / 100k writes 配额。staging 写少，影响小。

---

## 十五、Open question

1. **Telemetry 写哪里**？dev / staging / prod 都写自己的 events 表？还是 staging 也写 prod？
   - 建议：写自己的，避免污染 prod 的漏斗分析数据
2. **staging 是否要自己的 ai-feeds.com cron**（GitHub Trending 抓取等）？
   - 建议：默认关，schema 验证够用；要测 cron 行为时手动触发
3. **是否每条 PR 都开 preview 部署**（CF Pages 的 preview branch deployment）？
   - 建议：preview 部署解决 dashboard 验收，但 worker 改动还是要走 staging
