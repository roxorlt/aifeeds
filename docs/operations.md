# xList Scraper 运维手册

> 维护目标：跨 session、跨设备、跨人都能快速搞清楚「谁在哪里跑什么」。
> 每次新增/下线服务都要同步改这个文档。

最后更新：2026-07-18（首页瀑布流 SSR opt-in 生产发布、经典默认、手动 SWR、五设备验收与回滚点已写入 §5a）

历史：2026-05-09（ClawHub v2：抽屉内容跟 ClawHub 网页对齐。抓取从「自己解 ZIP 挑文件」改成「调 ClawHub 自家的 `skills:getReadme` 接口」，拿到啥就翻啥，不再纠结 README.md 还是 SKILL.md。新增「可疑 skill」处理：ClawHub 自家 LLM 标记的可疑项也拉回来，存 `extra.is_suspicious`，前端默认隐藏，开关切换时加 `?include_suspicious=true`。删除 `extra.skill_md`（ZIP 流程废弃）。详见下方「ClawHub」段）

历史：2026-06-25（微博科技热搜源接入：HK RSSHub 新增 `/weibo/hot/tech`，Worker registry 新增 `blog:weibo-hot-tech`，cookie 只放 `.secrets/aifeeds-prod.env` 的 `WEIBO_COOKIES` 并由 Worker 以 `X-Weibo-Cookie` 转发；缺/失效 cookie 返回 401/403 并 PushDeer 告警。源总数 38→39；真实 200 验收需先补 `WEIBO_COOKIES`）

历史：2026-07-11（增加香港 nginx 上游 connect/header/response 分段性能日志的版本化配置与审批后部署/轮转/回滚手册；本次未部署）

历史：2026-07-14（GL-a 首次操作因生产缺少 logrotate 留在 `rollback_failed(prepared)`；本地完成 initialized-candidate 正常恢复修复和可审计 exceptional recovery，独立恢复 10/10、冻结矩阵 135/135 全绿；生产事务尚未按新 helper 对账，禁止启动新 GL-a operation）

历史：2026-07-15（旧 GL-a 已完成 exceptional recovery 并终态对账；新 operation `20260715165904-2d2f27fe` 在唯一 probe 发现生产缓存 HIT 会把三个 upstream timing 序列化为空串后自动回滚。source/rollback 均为 `rolled_back`、14/14 runtime cleanup 完成、site 恢复原 SHA、运行时残留为 0。validator 现仅在缓存 HIT/STALE/UPDATING/REVALIDATED 分支接受数字、`-` 或空串；非缓存与 API 仍必须为数字。再次执行须重新 clean G0、冻结新清单并单独批准）

历史：2026-07-17（首页经典版/瀑布版并行的生产集成代码与本地五设备 SSR gate 在隔离分支完成；功能默认关闭、异常 fail-open 到经典版。当前未合 main、未推送、未改 staging/production；staging 按一次性变更包执行，RUM 是上线后观察而非发布前置门）

历史：2026-07-18（首页瀑布流 SSR 已合入 `main` 并完成 staging/production 发布：默认访客仍为经典版，瀑布版仅显式 query/cookie opt-in；手动 SWR、五设备生产 20/20、续页游标、hydration 和 nginx 缓存隔离均验收通过。RUM/GSC/Ahrefs 继续作为非阻塞观察项）

历史：2026-07-11（新增 C 端地域路由独立 A/B 实验门禁与预注册方案；当前 BLOCKED，未改 TTL/DNS/CDN/生产流量）

历史：2026-07-11（新增同源 API 的本地构建开关、版本化 nginx location 与 perf-staging/生产切换回滚手册；当前未部署）

历史：2026-05-07（ClawHub v0 接入：第 4 个数据源，全云端无本地 launchd。Phase 1+2（fetchList / enrichPending）、`metrics_snapshots_clawhub` 表、`renderClawhubContent` SVG 模板、前端 `BrandClawhub` logo 都在这次落地）

历史：2026-05-06（email 验证码登录上线：Resend HTTPS API + disposable 黑名单 + MX DoH 预校验 + 100/天 + 3000/月 cap，备案前 email 是主登录路径；SMS 通道保留 + `ENABLE_SMS_LOGIN=false` flag 隐藏，备案后翻 flag 恢复双通道。详见下方「3.6. Resend Email 服务」节）

历史：2026-05-06（CF Workers Paid 升级到 $5/月：subrequest 50→1000、CPU 10ms→30s、解锁 DO/Queues。后续架构决策默认按 Paid 配额算账，详见下方「CF 计划与配额」节）

历史：2026-05-06（Turnstile widget 升级到 v3 `0x4AAAAAADJyUx6JD4IMD_1i`，prod + staging worker `TURNSTILE_SECRET_KEY` 同步换新；起因是诊断中误把 chrome-devtools-mcp 触发的 600010 当成 widget 配置 bug — **CF 600010 是 DevTools 检测机制**，普通用户访问不会触发，社区证据见 https://community.cloudflare.com/t/turnstile-errors-600010-when-devtools-is-open/733892）

历史：2026-05-06（ScrapeBadger 接入：refresh-tiered 用 batch endpoint 拿回 retweets/views，本地 chrome list-scraper 退役（launchd `.cron` + `.tune` unload，SB list-poll-ingest cron */30 接管），频率 / 成本表见 [`scrapebadger-cost-and-frequency.md`](scrapebadger-cost-and-frequency.md)）

历史：2026-05-05（PR6.6 lazy-enrich-on-drawer：新增 `POST /api/items/:id/refresh` endpoint，drawer 打开主动刷 X syndication / GitHub REST，dashboard 通过 itemUpdateBus 同步 feed 卡片）

历史：2026-05-02（PR2 auth backend：4 张表 + 5 个 endpoint + 4 层 SMS 防刷 + Turnstile + PushDeer 告警；M4 enricher daemon 全量上线 + M5 配套：`REFRESH_MODE=tiered` + `REFRESH_TIER_MAX=4` cron 走 `runRefreshTiered`；新增每天 03:35 UTC 的 `runCleanup` 清 30 天前 snapshots/refresh_log；M5 阈值校准脚本 `analyze_tier_perf.py` 已就位）

---

## 架构总览

```
┌─────────────────── 本地 MacBook ──────────────────┐     ┌───────────── Cloudflare ─────────────┐
│                                                   │     │                                      │
│  launchd.cron  (5min tick + C2 hybrid gate) — X   │     │  Worker: xlist-api                   │
│  launchd.tune  (周一 04:00 重算 params.json)      │     │                                      │
│                                                   │     │    - POST /api/ingest   (接收本地)  │
│    └→ cron.sh                                     │     │    - GET  /api/items    (dashboard) │
│         ├→ list_scraper.py  (browser-use 抓 X)   │     │    - GET  /api/sources  (dashboard) │
│         ├→ tweet_processor.py (DeepSeek 分类+翻译)│─push│    - GET  /api/stats    (dashboard) │
│         └→ output.py push_to_cloud ───────────────┼────→│    - POST /api/enrich/run (手动)    │
│                                                   │     │    - GET  /r/<key>     (R2 反代)    │
│                                                   │     │    - scheduled() + cron */5 * * * * │
│  本地 SQLite: data/xlist.db (staging)             │     │      ├→ runBackfillQuotes           │
│                                                   │     │      ├→ runRefreshMetrics           │
│                                                   │     │      └→ runFillTranslations         │
└───────────────────────────────────────────────────┘     │                                      │
                                                          │  D1: xlist                           │
                                                          │    items / sources / run_stats /     │
                                                          │    enrich_state / metrics_snapshots  │
                                                          │    refresh_log                       │
                                                          │  R2: xlist-readme-assets             │
                                                          │    GH README + PH logo/screenshot    │
                                                          │  Pages: xlist-dashboard              │
                                                          │    (React + Vite, 读 Worker API)     │
                                                          └──────────────────────────────────────┘
```

数据唯一真相源：**远端 D1**。本地 SQLite 只是抓取暂存，push_to_cloud 成功后可随时丢。

---

## CF 计划与配额（2026-05-06 升级 Workers Paid）

> 在评估「能不能在 worker 里多塞点活」「要不要拆 cron 槽」「能不能直接下 zip」时**默认按这套配额算账**，不要再用 Free tier 心智。

| 维度 | Workers Free（已退出） | **Workers Paid（当前，$5/月）** |
|---|---|---|
| Subrequests / invocation | 50 | **1000**（20×）|
| CPU time / invocation | 10ms | **30s**（3000×，wasm 渲染、ZIP 解压、PDF parse 等 CPU-heavy 操作不再担心 timeout）|
| Cron 频率 | 最高 1/min | 同 1/min（不变，但 invocation 限额 +∞）|
| 包含 requests | 100k/天 | 1000 万/月 |
| Durable Objects | ❌ | ✅（未来可解锁分布式协调）|
| Queues | ❌ | ✅（producer/consumer 模式拆任务） |

**架构选型默认假设**：
- `*/5` cron 单次跑可消耗 ~200-300 subreq 仍有大量余量，不需要再为「省 subreq」做拆 cron 槽这种纯配额优化（保留按业务语义拆槽，比如 backfill / refresh / translate 解耦）
- 接新源时算账模板：1 list fetch + N detail fetch + N zip/asset fetch + N×2 D1 write，N 一般 ≤ 50，安全
- batch D1 写入仍然推荐（`db.batch([...])` 一次 subreq），但目的是性能不是节流
- 新加 cron 模式不需要先精算 50 预算

**升级路径回顾**：CF Dashboard → 头像 → Plans → Workers & Pages 切到 Paid，绑卡即生效，无需重部署。

**反向降级判断**（什么时候考虑切回 Free）：流量持续 < 100k req/天 + 无 cron 业务 + 不依赖 DO/Queues。当前都不满足，长期保持 Paid。

---

## Staging 环境（2026-05-03 上线）

> 完整设计：[`docs/plans/2026-05-03-staging-environment-design.md`](plans/2026-05-03-staging-environment-design.md)
> vibe coder 教程：[`docs/dev-staging-prod-guide.html`](dev-staging-prod-guide.html)

| 资源 | Prod | Staging |
|---|---|---|
| Worker | `xlist-api` (`api.ai-feeds.com`) | `xlist-api-staging` (`staging-api.ai-feeds.com`) |
| D1 | `xlist` (`2973d54b-…`) | `xlist-staging` (`fc029d89-6871-4e5c-b653-7ed27e6fb649`) |
| KV | `AUTH_KV` (`07d666…`) | `AUTH_KV_STAGING` (`76f7a326a94c4b8685668e39a23b3fe9`, preview `f187810317a845eca4b20f6e7b357a79`) |
| R2 | `xlist-readme-assets` | `xlist-readme-assets-staging` |
| Pages | `xlist-dashboard` (`ai-feeds.com`) | `xlist-dashboard-staging` (`staging.ai-feeds.com`) |
| Cron | `*/5 * * * *` 全开 | 全关（手动触发） |
| SMS | tencent / pushdeer fallback | `pushdeer`（不发真短信） |
| Secrets | 真值 | 独立设：`INGEST_TOKEN` 新生成；`ADMIN_USER/PASS` 共用；`TURNSTILE/DEEPSEEK/GITHUB/PUSHDEER` 共用 |

**部署命令**：
```bash
# 注意:必须先 set -a + source 整个 env 文件再 deploy,不要单独 grep 挑 token。
# 详见下方「⚠️ deploy 命令模板:必须 source 整个 env 文件」节。

# Worker(staging)
cd worker
set -a; . /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env; set +a
npx wrangler deploy --env staging

# Dashboard(staging)
cd dashboard
set -a; . /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env; set +a
npm run deploy:staging         # = build:staging + wrangler pages deploy
```

> ⚠️ **staging 前端构建输入坑位（2026-07-05 事故）**：`dashboard/.env.staging`（`VITE_API_BASE`）一度是未跟踪文件，worktree / CI 干净构建拿不到它 → 运行时兜底暴露出 `lib/auth.ts` API_BASE 镜像缺 staging 分支 → staging 页面 auth 打 prod、业务打 staging-api → 登录死循环。已根治：`.env.staging` 入库（`.gitignore` 显式 `!` 例外）+ `dashboard/src/lib/apiBase.ts` 单一事实源（新增 base 解析一律 import 它，**不许再写镜像**）+ api.ts 401 断路器。残留非致命镜像（GithubCard/GithubDrawerBody/utils.ts 的 /r/ /img 媒体代理）待后续 PR 收编。

**手动触发 staging cron**：
```bash
curl https://staging-api.ai-feeds.com/cdn-cgi/handler/scheduled
```

### ⚠️ 多人协作 deploy:必须先同步 main(2026-05-19 事故教训)

**根因**：Cloudflare deploy(worker / pages)是**整包替换**,不是 patch 合并。当 BE / FE 多人并行开发,各自从**自己的 PR branch** 直接 deploy 时,后 deploy 的会**覆盖前者已 deploy 的改动**。即使两个 PR 改的是不同文件,只要任一方 deploy 时的本地 branch 没合并对方的 commit,对方那些文件就会回退到 branch 上的旧版本(因为整包替换里那些文件还是旧的)。

**典型事故**(`2026-05-19` 海报模板回退):

| 时间 | 操作 | 后果 |
|---|---|---|
| `09:18` | FE deploy `xlist-api-staging` v6.6 hf poster(`d0c5c85d`)|  staging 含 hf 分支正确 dispatch |
| `09:29` | FE deploy v6.7 hf poster(`a2766d25`)| staging 含 hf 分支 v6.7 完整 |
| `09:40` | BE 从 PR #85 figure lookahead branch deploy(`603d2554`)— 该 branch **没合并** FE 09:18/09:29 的 share/poster 改动| 整包覆盖,FE 改动全丢,海报回退走 X fallback 模板 |
| `~10:10` | PM 截图发现 paper 海报又是 X 模板 | 排查 → 从 `main` HEAD redeploy worker 恢复 |

**强制约束**：

1. **deploy 前必须先 `git pull origin main` 把对方 commit 合到当前 branch**(或 rebase 到 main HEAD)。`wrangler deploy` 不接受 dirty index 之外的 sanity check,你自己要保证 worktree 是 main HEAD 的超集
2. **从 `main` HEAD deploy 最稳**:即使你的 PR 还没 merge,本地 `git checkout main && git pull` 再 deploy 也比从自己 branch 直 deploy 安全(代价是只能 deploy 已 merge 的改动)
3. **deploy 完立刻同步**:在 issue / PR / 协作频道说一句「已 deploy worker staging Version XXX,含 PR #YY」,让另一方知道当前 staging 是哪个版本,避免重复覆盖
4. **应急恢复**:发现自己 deploy 的改动消失 → 从 `main` HEAD redeploy 即可(`main` 永远是双方改动的并集,前提是改动都已 PR merge)
5. **跨域改动不要拆开 deploy**:同时动 `worker/src/share/` 和 `worker/src/hf-paper/` 时,两个 PR 合并到 main 后再 deploy 一次,不要分两次各 deploy 各自的

### ⚠️ 手动 deploy 边界(2026-05-25 PR6 收尾教训)

**默认**:prod deploy **永远走 CICD**(`.github/workflows/deploy-worker.yml` + `deploy-dashboard.yml`),push 到 main 自动触发。不要手动 `wrangler deploy` 推 prod。

**根因**:即使有 §「多人协作 deploy」L132-138 的"deploy 前 rebase main"约定,手动 deploy 仍是事故温床 — branch 切换 / worktree HEAD / 漏 fetch 等环境状态都可能让 rebase 失效。CICD 在 GitHub-side 跑,branch state 由 main HEAD 唯一确定,无环境分叉。PR6 期间手动 deploy 4 次实际是因为 CI auto-deploy 挂了的兜底,而不是常规习惯 — 后续 OPS 修好 CI 后必须切回 CICD-only。

**允许手动 wrangler deploy 的场景**(白名单,其他都禁):

| 场景 | 目标环境 | 允许原因 |
|---|---|---|
| Staging spike(BE/FE 跑 spike 验证假设) | staging | 不影响 prod,快速迭代 |
| Prod emergency rollback(prod 挂了,需要立刻回退到 main HEAD) | prod(临时) | CICD 跑 ~2-3min 太慢,事故时手动 deploy 从 `main` HEAD 立刻恢复 |
| CICD 挂了 BE 必须 unblock | prod / staging | 配合 OPS 排查 CI 同时手动 deploy 兜底 |

**手动 deploy 必走 `predeploy-check`**(2026-05-25 PR #N 落地):

`worker/package.json` 和 `dashboard/package.json` 已加 `predeploy` npm lifecycle hook,自动跑 `scripts/predeploy-check.sh`。这个脚本:

1. `git fetch origin main`
2. `git merge-base --is-ancestor origin/main HEAD` — HEAD 必须包含 origin/main HEAD
3. 失败 → 报错列出缺失 commits + 提示 `git pull --rebase origin main`

`npm run deploy` 会自动跑这个 check,fail 时 deploy 不触发。

**应急逃生**(慎用):`SKIP_PREDEPLOY_CHECK=1 npm run deploy` 跳过 check(知道自己在做什么时用)

### ⚠️ deploy 命令模板:必须 source 整个 env 文件(2026-05-20 教训)

**根因**:wrangler 4.x 在 deploy 前会查 `https://api.cloudflare.com/client/v4/memberships` 列出当前 token 可访问的 account 列表。如果 token scope 不含 `User → Memberships → Read`,这个调用返 `code 9106 Authentication failed` → deploy 卡死。**但**只要 env 里有 `CLOUDFLARE_ACCOUNT_ID`,wrangler 会跳过 `/memberships` 调用直接用该 ID,无需 Memberships scope。

`.secrets/aifeeds-{prod,staging}.env` 里**已经有** `CLOUDFLARE_ACCOUNT_ID`,所以正确的 deploy 命令必须**把整个 env 文件 source 进 shell**(让 ACCOUNT_ID 也 export 到 env),而不能只 grep 单挑 token。

**正确模板**(所有 deploy 命令一律按此):

```bash
# 把整个 env 文件所有 var 都 export 到当前 shell(含 CLOUDFLARE_ACCOUNT_ID)
set -a; . /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env; set +a
# 如需用 ops token override 默认 CLOUDFLARE_API_TOKEN(L47 旧 / L49 新 ops)
CLOUDFLARE_API_TOKEN="$CF_OPS_API_TOKEN" npx wrangler pages deploy dist \
  --project-name=xlist-dashboard --branch=main --commit-dirty=true \
  --commit-message="ASCII commit msg"   # 注意 commit-message 必须 ASCII 防 CF 8000111 UTF-8 bug
```

**错误模板**(不要写):

```bash
# ❌ 单独 grep 挑 token,丢失 CLOUDFLARE_ACCOUNT_ID,wrangler 走 /memberships fallback 撞 9106
PROD_OPS=$(grep '^CF_OPS_API_TOKEN=' .secrets/aifeeds-prod.env | cut -d= -f2-)
CLOUDFLARE_API_TOKEN="$PROD_OPS" npx wrangler pages deploy ...
```

**事故时间线**(`2026-05-20`):

| 时间 | 操作 | 后果 |
|---|---|---|
| `~01:00` | FE deploy 用 `set -a + source` 模式 | ACCOUNT_ID 在 env,wrangler 跳过 /memberships,deploy 成功 |
| `~01:15` | PM 把新 ops token 更到 env L49,FE 为了 override token 改用 `grep | cut` 单挑 | env 里没 ACCOUNT_ID,wrangler 查 /memberships,token 缺 Memberships scope → 9106 |
| `~01:20` | FE 误以为是 token scope 问题,让 PM 加 Memberships scope | 改了仍 fail,因为 wrangler 缓存或 CF 一致性延迟 |
| `~02:20` | 实际试 `CLOUDFLARE_ACCOUNT_ID=$ACCT wrangler ...` | 立刻 success;真相是 env vars 模式问题,token scope 早就够 |

token scope 其实**不需要** Memberships:Read,只要 deploy 命令带 CLOUDFLARE_ACCOUNT_ID 就 OK。

### ⚠️ CF account-scoped token 不要用 /user/tokens/verify 诊断（2026-05-20 晚教训）

**坑**：account-owned token（claude-ops、CF_OPS_API_TOKEN 这类，权限范围全是 `Entire <account_id> account`）调 `https://api.cloudflare.com/client/v4/user/tokens/verify` 必然返：

```json
{"success":false,"errors":[{"code":1000,"message":"Invalid API Token"}]}
```

或者调 `/user` 路径返 `code 9109 Invalid access token`。

**这不是 token 失效**，是 CF API 设计：user-scope 路径要求 token 带 user-level 权限，account-owned token 没有这个 scope，必然被拒。CF 的错误码（1000「Invalid Token」/ 9109「Invalid access token」）措辞极具误导性，看着就像 token 真挂了。

**正确的 account token 验证路径**（任选其一，能力上 wrangler 实际要用的）：

```bash
TOKEN=$(awk -F= '/^CLOUDFLARE_API_TOKEN=/ {sub(/^CLOUDFLARE_API_TOKEN=/,""); print; exit}' .secrets/aifeeds-prod.env)
ACCT=$(awk -F= '/^CLOUDFLARE_ACCOUNT_ID=/ {sub(/^CLOUDFLARE_ACCOUNT_ID=/,""); print; exit}' .secrets/aifeeds-prod.env)

# 调 D1 list（最常用 — wrangler deploy 实际要的能力）
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/d1/database?per_page=2"

# 或调 account 元信息
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT"
```

返 HTTP 200 即正常；只有这种 account 路径才真实反映 token 状态。

**事故时间线**（`2026-05-20` 晚）：

| 时间 | 操作 | 后果 |
|---|---|---|
| `~22:30` | session 推 BRIDGE_SECRET 到 staging worker，撞 9109 → 误以为 token 失效 | 让 PM 走 Roll 流程，把好好的 token 换掉 |
| `~23:00` | PM Roll claude-ops 后 .env 已更新，再 curl `/user/tokens/verify` 仍 401（路径就拒 account token） | session 再次误判，PM 接近崩溃 |
| `~23:20` | 改用 `/accounts/<id>/d1/database` curl → 200 OK | 真相浮出水面：token 一直没坏 |

**不要把这两条误用路径写进任何诊断脚本 / skill / agent prompt**。下次任何 AI session 排查 wrangler / CF API 401 时，先按本节方法验证 token，**不要让用户去 Roll**。如果 account 路径返 200 但 wrangler 仍报错，再排查 wrangler 参数 / 缓存 / ACCOUNT_ID 注入等问题。

**staging D1 schema 同步**（prod 改 schema 时）：
```bash
# 先在 staging 上执行 migration 文件验证
cd worker
npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/0NN-xxx.sql
# 验证后再 prod
npx wrangler d1 execute xlist --remote --file=migrations/0NN-xxx.sql
```

**Dev 默认连 staging**：`vite.config.ts` proxy 默认 target 已切到 `staging-api.ai-feeds.com`。临时连 prod：`VITE_API_PROXY=https://api.ai-feeds.com npm run dev`。

### 2026-05-17 新增:X workflow 完整性 gate filter

**Env var**:`WORKFLOW_COMPLETED_FILTER`(wrangler.toml `[env.staging.vars]` / `[vars]`)

- **staging**:`'true'`(已启用)— `/api/items` SQL 加 `WHERE source_type != 'x_list' OR json_extract(extra, '$.workflow_completed_at') IS NOT NULL` 筛掉 workflow 未完成的 X 数据
- **prod**:默认未设(='false' / no-op)— 等批 4 backfill 老数据完成后再开,避免 feed 突然变空

**开 prod filter 操作**:
```bash
cd worker
# wrangler.toml [vars] 加 WORKFLOW_COMPLETED_FILTER = "true"
rm -f ../wrangler.jsonc
npx wrangler deploy
```

**回滚**:把 `WORKFLOW_COMPLETED_FILTER` 改回 `'false'` 或删行 → redeploy。

**设计 / 落地**:
- [`docs/plans/2026-05-17-x-workflow-redesign.html`](plans/2026-05-17-x-workflow-redesign.html)
- [`docs/plans/2026-05-17-x-workflow-rollout-plan.md`](plans/2026-05-17-x-workflow-rollout-plan.md)

---

### 2026-05-25 新增:CICD 加固 + GH secret 同步规范(PR #119)

**背景**:
- 2026-05-20 admin-dashboard 三次浏览器级 SyntaxError 事故(PR #92/#93/#94/#95):TS 文件嵌 HTML/JS 字符串的隐藏坑(`document.write('...</script>...')` / template literal 里 `\d` `\/` 被 V8 当 invalid escape 吃掉),tsc + esbuild 都不报,只有真浏览器加载才暴露
- 同期 `CLOUDFLARE_API_TOKEN` GH secret 跟本地 `.secrets/aifeeds-prod.env` 不同步,导致最近 5 次 `Deploy Worker` 全 `Authentication error code 9109` fail,prod 全靠 BE 本地 `wrangler deploy` 手动兜底(问题被掩盖)

**两道防线**(GitHub Free + private repo 无法 require status checks,所以分软硬两层):

| 层 | 文件 | 触发 | 作用 |
|----|------|------|------|
| PR 软门槛 | `.github/workflows/pr-validation.yml` | `pull_request` | tsc / build / smoke,UI 红叉**不阻断 merge**(GitHub Free 限制下自然如此) |
| Deploy 硬防线 | `deploy-worker.yml` / `deploy-dashboard.yml` 内 `validate-before-deploy` job | `push: [main, staging]` / 手动 dispatch | 跟 deploy job 间 `needs:`,validate fail → deploy abort + PushDeer 推手机；按实际 prod/staging 目标互斥，更新的 run 会取消同目标旧 run，手动 prod 只接受 `refs/heads/main` |

**关键脚本**:
- `scripts/ci/admin-dashboard-smoke.sh` — 静态 grep 拦 `document.write </script>` 这类已知坑;playwright 断言等 BE 给 admin-dashboard.ts 加 `data-testid` 后填(P0.5 增量)
- `scripts/ci/pushdeer-notify.sh` — 守卫 `PUSHDEER_ADMIN_KEYS` 缺时静默 skip(不让缺 secret 把 abort 路径自己 abort)

**当前状态（2026-07-11）**：Worker TypeScript baseline 已清零；`deploy-worker.yml` 与
`pr-validation.yml` 都会硬跑 `npx tsc --noEmit`，不得恢复 `if: false` 或用软失败绕过。

**GH Actions secret 同步规范**(强制约定):

> ⚠️ 本地 `.secrets/aifeeds-prod.env` rotate / 新增 secret 后**必须**同步到 GH Actions secret,否则 CI deploy 9109 fail。今后 § 3「Secrets」的「新增 / rotate secret 流程」隐含第 5 步:**如果该 secret 用于 GH Actions**(CI deploy / 通知),同步推到 GH。

```bash
# 模板(分两行,避免 zsh `!` 触发时单行被粘连)
set -a; source .secrets/aifeeds-prod.env; set +a
printf '%s' "$SECRET_NAME" | gh secret set SECRET_NAME --repo roxorlt/aifeeds
# 验证
gh secret list --repo roxorlt/aifeeds | grep SECRET_NAME
```

**当前已同步到 GH 的 secret 清单**(2026-05-25):
- `CLOUDFLARE_API_TOKEN`(2026-05-25 rotate 同步)
- `CLOUDFLARE_ACCOUNT_ID`
- `PUSHDEER_ADMIN_KEYS`(2026-05-25 新加)

**手动触发 staging deploy 验证 any time**:`gh workflow run deploy-worker.yml --repo roxorlt/aifeeds -f env=staging`

---

### 2026-05-25 新增:分享海报转 c 端 + share 闭环 fix

**架构变更**:
- 海报渲染从 worker `resvg-wasm SVG → PNG`(`/api/share/poster/:token`)切到 c 端
  `modern-screenshot` 截图(`dashboard/src/components/PosterCanvas.tsx`)
- 原因:worker 字体 bundle 大小限制只能 embed Noto SC 子集,c 端可直接复用
  浏览器已加载的 HarmonyOS Sans SC + 真实 Card 组件,WYSIWYG
- worker `svg-template.ts` 保留作 og:image fallback(分享链 LinkPreview scan 仍用)

**Bot UA gate exempt 加 `/s/<token>`**(`worker/src/index.ts:isBotGateExempt`):
- 分享二维码扫码命中点,微信内置浏览器 / 二维码扫描 app UA 经常被判 bot 403
- 加进 exempt list 后正常 302 redirect 到 dashboard 详情页

**`buildDetailPath` 必须剥所有 source_type 前缀**
(`worker/src/share/handlers.ts:buildDetailPath`):
- `x_list:1234` → `/t/1234` (而非 `/t/x_list:1234`),否则 dashboard `parseDeepLinkFromPath`
  再加一次 prefix 拼出 `x_list:x_list:1234` 找不到 item → 显示"推文不存在"
- 同理 `hf_paper:`(`/h/`)、`github:`(`/g/`)、`product_hunt:`(`/ph/`)、
  `clawhub:`(`/c/`)、`huodongxing:`(`/e/`)

**c 端 nullable session discovery 与 `authStore.hydrate` 降级**
(`dashboard/src/lib/authStore.ts`):
- 匿名 `GET /api/auth/me` 是公开的 session discovery，返回 `200 {"user":null}`，避免把正常匿名访问
  记成浏览器控制台错误；需要登录的 subscription/feedback/logout 等接口仍保持 401
- hydrate 的网络或服务错误保留 persisted user(乐观信任 localStorage)，正常的 `user:null` 则清空旧状态
- 真 cookie 失效兜底:用户后续 action 仍会自然 401 → openLoginModal 弹登录

**sharer 默认 profile 复用** (`dashboard/src/lib/defaultProfile.ts`):
- BE 邮箱注册时 `display_name` / `avatar_url` 默认 null
- c 端用 `displayNameOf` / `avatarUrlOf`(基于 `user.id` 稳定 hash)派生
  昵称(32 词 + 4 位数字)+ 头像(30 张默认池),海报跟流内 UserMenu 一致

---

## 远端服务（Cloudflare）

### 1. Worker: `xlist-api`

- **源码**：`worker/src/` (index.ts + enrich.ts)
- **配置**：`worker/wrangler.toml`
- **公网地址**：
  - 自定义域：`https://api.ai-feeds.com`（dashboard 和前端用这个）
  - 默认域：`https://xlist-api.ltsms86.workers.dev`（仍可用，作为 fallback）
- **部署命令**：`cd worker && npm run deploy`

**端点清单**：

| 路径 | 方法 | 用途 | 鉴权 |
|------|------|------|------|
| `/api/ingest` | POST | 接收本地 push 的 tweets → 写 D1 items/sources | Bearer `INGEST_TOKEN` |
| `/api/items` | GET | Dashboard 列表（支持分页、filter、`sort=hot`、`source_type=github` 走 daily_rank 排序 + `pinned`） | 无（只读） |
| `/api/items/:id` | GET | 单条详情 + thread siblings（`:id` 是 composite，如 `x_list:123…` 或 `github:owner/repo`）；`source_type=github` 时附 `metrics_history`（最近 30 天 `metrics_snapshots_gh`） | 无（只读） |
| `/api/items/:id/refresh` | POST | Drawer 打开时 dashboard 主动调，触发 on-demand enrich：`x_list` 走 syndication API 拉 metrics + quote_of + link_card；`github` 走 GitHub REST 拉 stars/forks/watchers/issues/PRs/contributors。返回 `{refreshed,source_type,reason,metrics?}`，dashboard 拿到 `refreshed:true` 后重新 `fetchItem` 并 dispatch 到 feed。`product_hunt` 当前返回 `unsupported_source`（待 Browser binding）。KV `item-refresh-throttle:<id>` 60s throttle | 无（只读） |
| `/api/sources` | GET | Dashboard 左栏 source list | 无 |
| `/api/stats` | GET | Dashboard 顶部总览（总数、今日、分源） | 无 |
| `/api/search` | GET | **C 端站内搜索**（2026-07-06，`worker/src/search/handlers.ts`）：`q` 必填（trim 后 1-100 字，空/纯符号分词后为空 → 400 `empty_query`，超限 400）。**无 `source` → 分组模式**（`{mode:"grouped", groups:[{source_type,total,items:≤3}], query_time_ms}`，组序按组内 max 相关性降序）；**有 `source` → 单源 list 模式**（`{mode:"list", items, next_cursor, has_more}`，`cursor` base64 offset 分页 / `limit` 默认 20 上限 50）。`source` 非法 → 400。Item 结构与 `/api/items` 完全一致（复用 `item-row.ts`）。KV 限流 **12/min per device**（超限 429 `rate_limited`）；边缘缓存 `max-age=60`（归一化 `q+source+cursor+limit` 为 key，匿名无个性化） | 无（匿名可搜） |
| `/api/search/suggest` | GET | **搜索联想 / 热搜**（同上文件）：`prefix`（0-50 字）。**空 prefix → 热搜 top 10**（hot_query 优先、不足补 entity 高权重词）；**非空 → term_norm 前缀范围查询 top 8**。响应 `{terms:[{term,term_type}]}`。KV 限流 **40/min per device**；边缘缓存 `max-age=300`。**任何内部错误 → 200 + 空数组**（联想永不阻塞主流程；仅 prefix 超 50 字返 400） | 无（匿名） |
| `/api/enrich/run` | POST | 手动触发 enrich（支持多模式） | Bearer `INGEST_TOKEN` |
| `/api/longform/pending` | GET | 长推 fetch 队列（`?limit=20`，最多 50；`attempts < 3`） | Bearer `INGEST_TOKEN` |
| `/api/longform/submit` | POST | 提交本地浏览器抓回的完整长推正文 | Bearer `INGEST_TOKEN` |
| `/api/track` | POST | Dashboard telemetry 上报（dashboard SDK 用，必带 `X-Device-Id`） | 无（CORS 白名单 + did 必填） |
| `/api/dub-wishlist` | POST | 播客「翻译成中文音频」假门(painted door)：记录需求信号（body `item_id`，必带 `X-Device-Id`，登录则附 `user_id`）。`INSERT OR IGNORE` 去重，返回 `{ok,already}`。点击不真做配音，计数只在 admin 看板（2026-06-21 上线，`worker/src/dub-wishlist.ts`，表 `dub_wishlist` migration 023） | 无（匿名，必带 X-Device-Id） |
| `/api/dub-wishlist` | GET | `?item_id=X` 查当前设备是否已点过 → `{wishlisted}`，前端「历史已点则隐藏整块」用 | 无（必带 X-Device-Id） |
| `/api/feedback` | POST | 用户反馈提交（multipart：`content` 必填 ≤2000 字 / `image` 选填 ≤5MB jpeg png webp gif / `device` 前端设备信息 JSON）。**限频：每账号每 BJT 自然日 3 条**，超出 429 `rate_limited`（C 端 toast「操作太频繁了，稍后再试」）。图片入 R2 `feedback/<sha256>.<ext>`；服务端快照 device_info（request.cf country/colo/asn + ip/ua）与 account_info（display_name + identities）（2026-07-05，`worker/src/feedback.ts`，表 `feedback`/`feedback_replies` migration 024，入口 UserMenu/Settings 仅登录+非微信 UA 展示） | session（cookie） |
| `/api/feedback/mine` | GET | 我的反馈列表（最近 50 条 + 回复线程 + `unread_count`） | session（cookie） |
| `/api/feedback/read` | POST | 本人全部官方回复标记已读（C 端红点清零，打开反馈页自动触发） | session（cookie） |
| `/api/feedback/unread-count` | GET | 未读官方回复数（UserMenu 红点数据源，登录 hydrate 后拉一次，不轮询） | session（cookie） |
| `/api/auth/sms/send` | POST | 发送短信验证码（必带 `X-Device-Id` + Turnstile token） | 无 + 4 层防刷 |
| `/api/auth/login` | POST | 提交 phone+code 登录或自动注册（必带 `X-Device-Id`） | 无 |
| `/api/auth/logout` | POST | 撤销当前 session | session token |
| `/api/auth/logout-all` | POST | 撤销该 user 全部 session | session token |
| `/api/auth/me` | GET | 返回当前 user（含脱敏 phone） | session token |
| `/api/share/create` | POST | 生成 share token + 短链 + 海报 url（item_id 在 body） | session（cookie） |
| `/api/share/poster/:token` | GET | 海报 PNG（首次 SVG → resvg → R2 缓存；后续 R2 HIT 1.4s 内返回） | 无（CORS `*`） |
| `/s/:token` | GET | 扫码落地：写 to_did + landed_at，302 redirect 到详情页 | 无 |
| `/api/share/landing` | POST | 落地详情页前端调，补 to_did（redirect 时 cookie 可能缺 device_id） | 无（必带 X-Device-Id） |
| `/api/admin/share/:token` | GET | 看一个 token 的扫码 / 落地统计 | CF Access JWT（Basic Auth fallback，见 § 7a） |
| `/admin` | GET | 302 redirect 到 `/admin/dashboard`（2026-05-17 加） | CF Access JWT（边缘拦截，见 § 7a） |
| `/admin/dashboard` | GET | 仪表盘默认页：DAU/WAU/MAU 头部 KPI、30 天 DAU 折线、行为漏斗、会话时长直方图、每日新增vs回访（反向口径表格，2026-06-18）、留存矩阵（正向 cohort；未到期格显示「—」非误导性 0%）、事件类型分布（中文标签）、错误明细、重度设备表（留存/回访表默认 5 行可展开）、**🎧 中文配音需求（假门）卡片**（2026-06-21：想听 KPI + 需求强度漏斗「打开播客详情→点想听」转化率 + 需求排行榜）。echarts CDN，单文件 HTML（`worker/src/admin-dashboard.ts`） | CF Access JWT（Basic Auth fallback） |
| `/admin/tools` | GET | 原 SMS 限流 / user 详情 / 清除测试账号 / 今日 SMS 用量 4 张卡（`worker/src/admin.ts` 的 `TOOLS_HTML`，2026-05-17 从 `/admin` 路径迁来） | CF Access JWT（Basic Auth fallback） |
| `/api/admin/analytics?metric=<name>` | GET | 仪表盘 SQL JSON 数据源。`metric` ∈ `overview` / `dau-trend` / `retention` / `returning`(反向回访口径) / `event-distribution` / `funnel` / `session-duration` / `errors` / `top-devices` / `dub-wishlist`(中文配音需求假门) / `search`(C 端搜索监控：使用/性能/异常/索引滞后，2026-07-06)（实现在 `worker/src/admin-dashboard.ts`） | CF Access JWT（Basic Auth fallback） |
| `/admin/feedback` | GET | **用户反馈看板页**（2026-07-05，`worker/src/admin-feedback.ts`）：列表 + 搜索（user_id 精确 / 昵称 / identity 模糊 → 按账号查该用户全部历史）+ 状态过滤（未回复/已回复）+ 分页 + 详情（device_info / 账号快照 / 回复线程）+ 图文回复用户 | CF Access JWT（Basic Auth fallback） |
| `/api/admin/feedback` | GET | 反馈列表数据源（`q` / `status=all,pending,replied` / `page` / `page_size≤100`） | CF Access JWT（Basic Auth fallback） |
| `/api/admin/feedback/:id` | GET | 反馈详情 + 回复线程（device_info/account_info 解析后 JSON） | CF Access JWT（Basic Auth fallback） |
| `/api/admin/feedback/:id/reply` | POST | 图文回复用户（multipart：`content` ≤5000 必填 / `image` 选填同 C 端规则）；写 `feedback_replies` + 刷 `feedback.last_reply_at`；`admin_email` 取 CF Access JWT email claim（Basic 兜底为 NULL） | CF Access JWT（Basic Auth fallback） |
| `/api/admin/search/reindex` | POST | **搜索索引手动重建**（2026-07-06，`worker/src/search/sync.ts handleSearchReindex`）：单请求内循环跑 `syncSearchIndex`（~20s 时间预算，追平或 errored 即停），返回 `{rounds,lastScanned,totalUpserted,backfillDone,backfillRowid,elapsed_ms}`。**`?reset=1`** 先重置 backfill 进度（`fts_backfill_rowid=0` / `done=""`）+ 播种增量水位为当前时刻，再从头全量重建（5.5 万行 ≈ 2.3h，可反复调用加速）。**prod 首次上线用它循环追平 backfill** | CF Access JWT（Basic Auth fallback，见 §7a；prod/staging `/api/admin/*` 走 CF Access 边缘拦截，backfill 需服务令牌或 `wrangler dev` remote-bindings） |
| `/api/admin/search/rebuild-terms` | POST | **suggestion 词表手动重建**（2026-07-06，`worker/src/search/terms.ts rebuildSearchTerms`）：全量重算 entity 词（GH 仓库/PH 产品/skill 名/hf keyword/媒体名/高频作者/分类）+ hot_query（近 7 天 `search_submit` 聚合），物化到 `search_terms`。**staging cron 全关，词表靠手动触发** | 同上 |
| `/img` | GET | 图片反代（绕 GFW + 边缘 resize/compress + format=auto）；视频走原反代 + Range | 无（host 白名单） |
| `/r/<key>` | GET | R2 资源反代（GitHub README 图 + PH logo/screenshot/video/avatar），`key` 是 SHA-256；24h 边缘缓存。**referer 白名单**（2026-05-17）：空 referer + `*.ai-feeds.com` + `twitter.com/x.com/t.co` + `producthunt.com` + `github.com` + `*.pages.dev` + `localhost` 放行，其他 referer → 403 防热链 | 无 + referer 白名单 |
| `/daily/:date` | GET | **每日静态日报页**（SEO P0，2026-07-06，`worker/src/seo-routes.ts`）：`:date`=`YYYY-MM-DD`，命中 R2 `daily/<date>.html` 返回 200 静态 HTML（`max-age=3600`）；miss → `noindex` 简洁 404 页；日期形状对但日历越界（`2026-13-99`）→ 302 归档 | 无（公开，bot gate 豁免） |
| `/daily/` `/daily` | GET | 日报归档索引（从 D1 `daily_pages` 表实时渲染，按月分组倒序，`max-age=3600`）；`/daily/<其它非法段>`（如 `/daily/abc`）→ 302 本页 | 无（公开，bot gate 豁免） |
| `/robots.txt` | GET | 决策 5 全放（含 AI 训练爬虫），仅 `Disallow` `/api/` `/admin` `/settings` `/me/` `/unsubscribe`；末行 `Sitemap:` 指 `SITE_BASE/sitemap.xml`（`max-age=86400`） | 无（公开，bot gate 豁免） |
| `/sitemap.xml` | GET | 站点地图（`/` + `/daily/` + 全部 `daily_pages` 行，`lastmod` 取各行 `generated_at` 日期部分，`max-age=3600`） | 无（公开，bot gate 豁免） |
| `/llms.txt` | GET | AI 检索友好站点说明（Markdown：中英各一行定位 + 归档/订阅入口 + 最近 7 天日报链接，`max-age=86400`） | 无（公开，bot gate 豁免） |
| `/<INDEXNOW_KEY>.txt` | GET | IndexNow 域名归属校验文件：路径 = `/<INDEXNOW_KEY 值>.txt` 时返回 key 纯文本（`max-age=86400`）；未配置 secret / key 不匹配的其它根目录 `.txt` → 404 `no-store` | 无（公开，bot gate 豁免） |

**每日静态日报页 + SEO 伺服**（2026-07-06 上线，PR #161，`worker/src/seo-routes.ts`）：
- 上述 6 条公开路由在 `index.ts` 里 **bot gate 之后、鉴权路由之前**由 `handleSeoRoute` 统一伺服；`isSeoPath` 与 `isBotGateExempt` 并联豁免 bot UA 闸（决策 5 全放，让搜索引擎 / AI 检索 / 训练爬虫全部可达，放行策略统一收口 robots.txt）
- **绝对 URL 一律走 `env.SITE_BASE`（`getBases`），禁止取 request host** —— 香港中转会把 `Host` 改写成 `workers.dev`（2026-06-08 事故教训），canonical / 深链 / sitemap `loc` / IndexNow host 全部用 env 域
- 归档索引 / sitemap / llms 均从 D1 `daily_pages` 表**实时读取，不做 R2 list**（R2 `READMES` bucket 只存 `daily/YYYY-MM-DD.html` 快照）
- 日报页 HTML **零可执行 `<script>`**：唯一的 `<script>` 是 `application/ld+json` JSON-LD 数据岛（`ItemList` 结构化数据，`<` 转义防 `</script>` 越权）；外部 title 字段一律 `escapeHtml`
- 静态页生成挂在 digest 早 8 点 workflow 的 **Phase 4**（详见下方「订阅推送子系统」§「每日静态日报页 Phase 4」）；手动 `POST /api/enrich/run?mode=daily-page` 重建 / 回填
- **主域 `ai-feeds.com` 经香港 nginx 转发**：front server 块加 regex location 把这 6 类路径转发到与 api 块同一 worker upstream（详见下方 §6b 六续 note；2026-07-08 起该 location 再扩 `/i/*` 与 sitemap 分片，见 §6b 七续 + 下方「item SSR 静态页」段）；api 域 `api.ai-feeds.com` 直接可达不受影响
- 设计文档：[`plans/2026-07-06-daily-static-page-seo-design.md`](plans/2026-07-06-daily-static-page-seo-design.md)

**item SSR 静态页 `/i/*` + sitemap 分片**（2026-07-08 上线，`worker/src/seo/item-routes.ts` + `worker/src/seo-routes.ts`）：
- `GET /i/<source>/<id...>`：五源单页（`x`/`gh`/`ph`/`hf-paper`/`news`），伺服逻辑、404/410 与 `isSeoPath` 判定见设计 `docs/plans/2026-07-08-item-ssr-pages-design.md` §4.4/§4.6；bot gate 豁免（`isSeoPath` 的 `pathname.startsWith('/i/')`，裸 `/i` 不豁免）
- `GET /sitemap.xml` 已改 sitemap-index；`GET /sitemap-<source>.xml`（超 5 万续 `-2 -3…`）为各源实际 URL 列表，正则见 `worker/src/seo-routes.ts` 的 `SITEMAP_SHARD_RE`
- 主域经香港 nginx 转发：同上 regex location 已扩至含 `i/.*` 与 `sitemap-[a-z0-9-]+\.xml`（§6b 七续），权威副本 [`deploy/nginx/aifeeds-seo-location.conf`](../deploy/nginx/aifeeds-seo-location.conf)

**`/img` 图片代理与 `/media` 视频兼容代理**（2026-04-20 上线，2026-05-16 加 cf.image 边缘转换；
2026-07-14 拆分视频路由）：
- 前端 `dashboard/src/lib/utils.ts` 的 `proxyImg()` 统一路由白名单域名到此端点
- 前后端使用同一收敛方向的 host allowlist；旧 `force` 参数不再扩大白名单，未知 OG/CloudFront 图片
  保持直连并由卡片 `onError` 稳定降级，防止生成必然 403 的 `/img` URL 或把端点变成开放代理
- CDN 边缘缓存：`cacheTtl=86400` + `Cache-Control: max-age=604800, immutable`
- 命中 GFW 封锁的 CN 用户借此恢复图片加载
- **2026-05-16 边缘 transform**（CF 迁移阶段 2）：
  - 图片走 `cf.image` option（worker fetch 内嵌触发，不受 zone "Allow external source" toggle 限制）
  - 查询参数：`?w=` resize 宽度（可选）/ `?q=` quality（默认 85）/ format=auto（按 Accept 自动 webp/avif）
  - prod 实测：avatar 28573B (460x460 jpeg) → 2532B (80x80, w=80) 省 91%；→ 18074B (400x400, w=400) 省 37%
  - ⚠️ format=auto 实测未强转 webp（仍返 jpeg），可能 CF cf.image 默认行为，后续视效果调整
  - 新前端只把 legacy `video.twimg.com` 发往专用 `/media`；该路由只接受这个精确 host，逐跳复验 redirect，
    透传 Range/206、`Content-Range`、`Accept-Ranges` 并返回 `Cache-Control: no-store`，不走 cf.image
  - `/img` 暂保留旧客户端 video 兼容，但新页面的 video `/img` 数量必须为 0；staging 与生产发布后都要用
    0–1023 bytes smoke 验证实际返回 206/1024 bytes，防止重现 2026-06-09 的全量视频回源事故
  - zone toggle：OPS 2026-05-16 已 enable `image_resizing`（PATCH `/zones/{zone_id}/settings/image_resizing`）

**`/api/items` 热度排序**（2026-04-21 上线）：
- 加 `sort=hot` 参数时按 HN 风格重力衰减分数排序：
  `score = (likes + 2*retweets + 3*replies) / (age_hours + 2)^1.5`
  覆盖 30 天 `published_at` 窗口，老病毒推文可与新推文混排
- 返回项额外带 `hot_score` 浮点字段（仅 hot 模式）
- 游标格式 `score|id`（score 为浮点）；前端 `dashboard/src/components/Feed.tsx` 配合 localStorage 曝光过滤（500 条 LRU + 3 天 TTL）

**`/api/enrich/run` 查询参数**：
- `mode=backfill-quotes`（默认）/ `backfill-replies` / `reclassify-threads` / `refresh-metrics` / `refresh-tiered` / `fill-translations` / `detect-longform` / `cleanup`（手动跑：`?mode=cleanup&retention_days=30`）/ `clawhub-fetch` / `clawhub-enrich`（ClawHub phase 1/2 手动触发）/ `blog-fetch` / `podcast-fetch`（官方新闻 phase 1 手动拉取,staging crons=[] 验证 + 回灌用,2026-06-11）/ `backfill-blog-workflow` / `backfill-podcast-workflow`（扫 wc_at IS NULL 的 stuck blog/podcast 行重 trigger,兜底无专属 cron slot,只手动跑）/ `reenrich-feeds-titles`（行业新闻标题严肃化存量回填:`?mode=reenrich-feeds-titles&limit=40&days=4`,Bearer INGEST_TOKEN,对 digest 窗内 blog/podcast 重跑 enrich 刷新 `title_zh`，新标题 prompt 上线后刷存量用,幂等,2026-06-22）/ `daily-page`（SEO 静态日报页生成/回填,Bearer INGEST_TOKEN,2026-07-06：`?date=YYYY-MM-DD` 重建指定日 / `?backfill=1` 遍历 digest_pool 历史全量回填 / `?dry=1` 只算不落盘,详见下方「订阅推送子系统」§「每日静态日报页 Phase 4」）/ `cover-quality-sweep` / `blog-cover-generic-sweep` / `blog-cover-og-backfill` / `blog-cover-bodyhero-backfill`（封面质量四件套,详见下方 4 条）/ `blog-body-redecode`（RSSHub 源正文实体编码 `<p>` 泄漏存量清洗,2026-07-06,详见下方）/ `the-verge-editorial-image-cleanup`（The Verge 作者蓝色头像存量清理,2026-07-15,详见下方）/ `ph-description-translate`（PH 英文 description → `description_zh` 中文回填,供 daily 页 SEO,2026-07-06,详见下方）
- `mode=cover-quality-sweep`（一次性数据清洗,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06）：`?mode=cover-quality-sweep&limit=N[&dry=1]`。清洗 blog/podcast 的低质 R2 封面 + 外链残留封面（症状 2）。分页扫描 `source_type IN ('blog','podcast')` 且 cover 存在、未 swept、(R2 形态 OR 迁移 marker 已置位) 的 item：R2 封面走 binding `.get` 读回 buffer 过 `passesFeedImageQualityGate`（ar 0.25–4 / density≥0.05 / maxDim≥300）→ 不过 / 读不到 → `json_remove` 清 `cover_image`；外链态（能进批 ⇒ 迁移 marker 已置位）直接清空、数据面归零。已处理项打 `$.cover_swept_at` 分页游标（batch 与 remaining 共用同一 SQL 谓词，保证 remaining 单调递减），循环调用直到 `remaining=0`。返回 `{scanned, cleared, remaining}`；`?dry=1` 只统计不落盘。`limit` 默认 40、上限 100（R2 读走 binding 非 HTTP 子请求，稳在限额内）。**这是全局数据层操作,影响所有封面消费方（日报页 / 前端卡片 / 抽屉 / 邮件）,务必先 `dry=1` 看规模再真跑。**
- `mode=blog-cover-generic-sweep`（Fix 2a 源级通用图剔除,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06）：`?mode=blog-cover-generic-sweep[&min=3][&limit=50][&dry=1]`。统计特征法揪「源级通用图」——**仅 `source_type='blog'`**（审查修复 2026-07-06：播客单集共用节目封面是合法常态，且 og-backfill 只回填 blog，清了 podcast 簇没回填方 → 永久掉封面，故收敛到 blog-only）。同一 source（`COALESCE(feed_key, show_key, source_type)`，blog 实际落 `feed_key`）内 `cover_image` 命中**同一 R2 hash** ≥ `min` 次（默认 3、下限 2）即判为通用图（作者署名头像 / 站点通栏图 / 二维码横幅都逃不过这个共用特征，如 qbitai 89 条共用 1 张、the-verge 5/4/3 条按作者头像聚簇）。整簇 `json_remove` 清空 `cover_image` **并一并清 `cover_og_backfilled_at` 游标**（让随后 `blog-cover-og-backfill` 能重新拉真 hero 回填），打 `$.cover_generic_cleared_at` marker + 记被清 R2 key 到 `$.cover_generic_cleared_hash`（供 og-backfill 判「回填的 og:image 又是同一张通用图」→ 跳过写入终止 sweep↔backfill 循环）。只统计 R2 形态封面（外链态不入簇）。返回 `{clusters:[{src,cover,count}], clustersCleared, itemsCleared}`；`?dry=1` 只列簇明细供人工核对、零写。`limit` = 单批处理簇数（默认 50、上限 500）。**先 `dry=1` 核对簇清单再真跑**——阈值调低会误伤「系列文合法复用同一 hero」，3 是保守值。
  - 🆕 **2026-07-06 品牌 logo 护栏联动（本批次）**：本批次给 `blog-pipeline` step4（`migrateMediaForBlog`）加了「源级品牌 logo 采用护栏」——新入库 blog 的 og:image 若与同源已有 ≥3 条 item 的 cover 是同一张（内容 hash 归一），判为站点品牌 logo，**不采用**、就地改从正文 body hero 补图（选不到才留空走 monogram），并记 `cover_generic_cleared_hash`。此外 `blog-cover-og-backfill` 的循环护栏改为**只查 `cover_generic_cleared_hash`**（去掉 `cover_generic_cleared_at` 门，堵住 live 护栏只写 hash 不写 at 时 og-backfill 侧路把 logo 灌回的缺口，终审 I1）。存量清簇仍走本 `blog-cover-generic-sweep`（jiqizhixin `29014a03`×154 / qbitai `74b581f9`×108），清完后的差异回填走下方新增的 `blog-cover-bodyhero-backfill`（**强依赖：必须先 generic-sweep 清簇、置位 cleared_hash，再跑 bodyhero-backfill**）。
  - ⚠️ **局限（无选择性排除单簇）**：`min` / `limit` 是**全局旋钮**，dry 核对簇明细后**没有**「排除某个具体簇、只清其余」的参数——真跑会清掉当前 dry 列出的**全部** ≥`min` 的簇。若发现簇明细里混进了「合法系列文共用同一题图」（该清的和不该清的簇并存），**不要直接真跑**：先把 `min` 调高避开那批合法簇，或对确需清的簇改用人工 SQL（按 `feed_key` + `cover` 精确 `UPDATE`）逐簇处理。
  - ⚠️ **判簇阈值 min 默认 3 不要直接真跑**（2026-07-07 品牌 logo 根治实操教训）：prod 实测 `min=3` 会把合法系列文章共用题图误判成簇（如 OpenAI Codex-for-work 系列、mistral/techcrunch 边界簇）。正确姿势：先 `dry=1` 看簇明细人工核对；清品牌 logo 用高阈值——2026-07-07 实操用 `min=50` 精准命中 jiqizhixin/qbitai 两大簇；3-49 条的小簇留人工判定。现存未清的边界小簇（openai 系列 / mistral / techcrunch R2 簇）为有意保留，不是遗漏。
  - 🆕 **2026-07-07 封面品牌 logo 三层防御定型（Fix A 关键词前置 + Fix B 源级 no-cover）**：07-07 二轮复盘查实——og:image 采用入库那一环此前**从不**跑 `COVER_BLACKLIST`（qbitai 的 og 字面就是 `qbitai-logo-1.png`，只过尺寸门 300×300 通过；迁 R2 后文件名变内容 hash，关键词信息永久丢失，下游渲染层黑名单全部失守），且统计护栏有「新 logo 变体前 ≤2 篇成簇前泄漏」固有窗口。现 `migrateMediaForBlog`（`worker/src/feeds/media-r2.ts`）封面采用路径为**三层防御**（自最早到最晚，前层命中后层不需触发）：**层 0 关键词（Fix A）**——采用前对**原始 og URL**（迁移前、关键词还在的时机）跑 `COVER_BLACKLIST`（`logo|qrcode|avatar|icon|badge|footer…`，`worker/src/feeds/cover-heuristics.ts`），命中即**不迁 R2、不采用**（记 `$.cover_keyword_blacklisted_at`），就地 `pickBodyHeroCover` 回落正文 hero（无则空走 monogram）——第 1 篇就拦，闭合统计护栏的前 2 篇泄漏窗口；**层 1 统计簇**——同源 ≥3 条共用同一 R2 内容 hash（`isSourceLevelBrandLogo` live 计数）；**层 2 持久 hash 拒绝**——同源曾清过该 hash（`cover_generic_cleared_hash`）。**Fix B `NO_COVER_SOURCES` 源级 no-cover 名单**（配置位置：`worker/src/feeds/cover-heuristics.ts`，feed_key 口径，初始 = `jiqizhixin`）：名单内源的 item **一律不采用任何封面**（og 不采、正文 hero 不回退、`cover_image` 恒空走 monogram），生效点 3 处——① `migrateMediaForBlog` 封面分支入口直接跳过（原值清空 + 记 `$.cover_nocover_source_at`）；② `blog-cover-og-backfill` 谓词排除该源；③ `blog-cover-bodyhero-backfill` 谓词排除该源（②③经 `noCoverSourcesSqlExclusion` 拼进 SQL，防 Fix B 清空后又被回填灌回）。理由：机器之心 154 篇正文零图、og 恒为品牌 logo，no-cover 是它的诚实终态（用户 2026-07-07 拍板写死）；未来该源正文开始出图，从名单移除即可恢复取图。**qbitai 不进名单**：12/116 有真 hero，og 文件名含 'logo' 由层 0 兜住，正文真 hero 正常回落，不误杀。
- `mode=blog-cover-og-backfill`（Fix 3 og:image 存量回填,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06）：`?mode=blog-cover-og-backfill&limit=N[&dry=1]`。分页扫 `source_type='blog'` 中 `cover_image` 为空（含 Fix 2a 清空 / 迁移拒绝 `''` / 天生无封面）且未打 og 游标、有 `url` 的行 → 外呼原文页（`throttledFetchText` per-origin 串行 + jitter）抽 `og:image`（`extractPageMeta`）→ 过质量门 + 迁 R2（`migrateFeedCover`）→ 写 `cover_image` + `cover_backfilled_at`。游标 `$.cover_og_backfilled_at` 单调（每条处理必置位，无论 adopt/skip，与 `cover_swept_at` / `cover_generic_cleared_at` **独立防互相干扰**）；外站拉不到 / 无 og:image / 门控拒 → 只推进游标，保持前端 monogram 兜底（绝不回退署名头像）。返回 `{scanned, adopted, skipped, remaining}`；`?dry=1` 只统计 og 命中、零写（不迁 R2）。`limit` 默认 15、上限 50（每条外呼原文页，控制子请求量）。循环调用直到 `remaining=0`。**配套顺序：先 `blog-cover-generic-sweep` 清通用图 → 再 `blog-cover-og-backfill` 回填 og:image。** 主修在数据层（`blog-pipeline` 把 og:image 采用从 page-scrape 放开到全部 blog 源），此 mode 只补历史存量。**2026-07-07 起谓词排除 `NO_COVER_SOURCES`（jiqizhixin）**——该源 og 恒为品牌 logo，进批只会灌回（Fix B）。
- `mode=blog-cover-bodyhero-backfill`（品牌 logo 清簇后的正文 hero 差异回填,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06 本批次 Task 2 层 2）：`?mode=blog-cover-bodyhero-backfill&limit=N[&dry=1]`。谓词 = `source_type='blog'` + `cover_image` 空 + `cover_generic_cleared_hash` 置位（被 `blog-cover-generic-sweep` 或 live 护栏判簇清过）+ `cover_bodyhero_backfilled_at IS NULL`。逐条 `pickBodyHeroCover`：只收 `body.assets` 里**已迁 R2**（`/r/` 形态 r2_url）的 image，过黑名单（qrcode/二维码/logo/avatar/icon/badge/footer）+ 尺寸门（maxDim≥240、0.5≤ar≤2）+ 排除与被清 logo 同 hash 的资产 → 选到合格 hero 写 `cover_image`（body 已迁 R2 直接用，不再迁）+ `cover_backfilled_at`；选不到保持空走 monogram。天然按源分流：**qbitai**（92/108 正文有真图）→ 采用正文 hero；**jiqizhixin**（154/154 图荒）→ 保持 monogram。游标 `cover_bodyhero_backfilled_at` 单调，`?dry=1` 零写，`limit` 默认 50、上限 200，循环调至 `remaining=0`。**⚠️ 强依赖：必须先跑 `blog-cover-generic-sweep` 清簇（置位 `cover_generic_cleared_hash`），否则本 mode 谓词命中为空、回填落空。** og:image 是被清 logo（Fix C `cover_generic_cleared_hash` 已挡 og-backfill 回填），故差异回填只能取正文 hero，**不要**对 jiqizhixin/qbitai 跑 `blog-cover-og-backfill`。**2026-07-07 起谓词排除 `NO_COVER_SOURCES`（jiqizhixin）**——该源写死 no-cover，正文 hero 也不回退（Fix B）。
- `mode=blog-body-redecode`（RSSHub 源正文实体编码 `<p>` 泄漏存量清洗,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06 本批次 Task 1）：`?mode=blog-body-redecode&limit=N[&dry=1]`。**根因**：jiqizhixin/weibo-hot-tech 走 RSSHub，正文在 RSS description 里是实体编码 HTML（jiqizhixin 为双重 `&amp;lt;p&amp;gt;`），旧逻辑只剥 CDATA 不解码 → `htmlToMarkdown` 的 tag 正则按字面尖括号匹配全空转 → 末尾 `decodeEntities` 把它们还原成**字面** `<p>` 落进 `body_markdown`（前端 react-markdown 泄漏成可见标签）。live 修复在 `extract.ts htmlToMarkdown` 入口先 `decodeEntityEncodedHtml` 检测并解码一次。本 mode 清存量：谓词 = `source_type='blog'` + `body_redecoded_at IS NULL` + `body_markdown`/`body_markdown_zh` LIKE `%<p%`/`%<img%`（存量泄漏是**真实**尖括号），对含结构标签的字段重跑 `htmlToMarkdown` 清洗写回 `body_markdown`（+ `body_markdown_zh` 如含泄漏）。游标 `body_redecoded_at` 单调（每条必置位，含无实际变更的假阳性行，防重扫），返回 `{scanned, fixed, remaining}`，`?dry=1` 零写不推游标，`limit` 默认 100、上限 500，循环调至 `remaining=0`。预期存量 jiqizhixin ~142 + weibo-hot-tech ~110。
- `mode=the-verge-editorial-image-cleanup`（The Verge 作者署名头像存量清洗,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-15）：`?mode=the-verge-editorial-image-cleanup&limit=N[&dry=1]`。**根因**：The Verge Atom 正文把作者署名头像与文章正文图片混在同一 HTML 中，稳定特征为 URL 路径 `/chorus/author_profile_images/` 或文件名含 `BLURPLE`；旧 `htmlToMarkdown` 无差别把所有 `<img>` 同时写入 `body.assets` 与 `body_markdown`，迁 R2 后哈希 URL 又丢失头像语义，最终污染 C 端抽屉、封面及日报图片/视频。live 修复在 `feeds/editorial-image.ts` 统一判定：**不可逆入库过滤严格限定 `theverge.com` 域名 + 两个强特征**（正常 SVG、小尺寸正文图、hero/截图/人物新闻照片保留），并覆盖正文 `<img>`、RSS stub cover、详情页 OG cover、R2 迁移前 cover 四个入口；`digest/render.ts` 通过原 URL→`r2_url` 映射及持久 `editorial_image_blocked_urls` 同时拦原链、相对 R2 和绝对 R2。此 mode 只扫 `workflow_completed_at`、`blog_media_r2_at` 均完成的 The Verge item（兼容老数据 id 前缀），清 `body.assets`、`body_markdown`、`body_markdown_zh`、顶层 `items.media` 和误用 `cover_image`；头像 cover 优先回退剩余正文图，无图则清空。UPDATE 以原 `extra+media` 做 CAS，检测到并发写则计入 `conflicts`、不推进游标，下轮重试；成功处理才置 `editorial_image_cleaned_at`。返回 `{scanned,fixed,removedImages,conflicts,remaining}`；`dry=1` 零写，默认 100、上限 500，循环到 `remaining=0`。R2 对象本身不删除（内容寻址资源可能被复用），只移除引用。
- `mode=ph-description-translate`（PH 英文 description → `description_zh` 中文回填,Bearer INGEST_TOKEN,staging 加 `X-Dev-Token`,2026-07-06 本批次 Task 3）：`?mode=ph-description-translate&limit=N[&dry=1]`。把 PH item 的 `extra.description`（英文，均值 317 字）经 DeepSeek `deepseek-v4-flash`（复用抽出的 `scrapers/ph-translate.ts translatePhBatch`，CF AI Gateway，chunk≤5）翻译成中文写入 `extra.description_zh`，供 daily 静态页做纯中文 SEO 文本（daily 页扩展摘要 PH 源优先取 `description_zh`，无则回退 `ai_summary`）。谓词即游标 = `source_type='product_hunt' AND extra.description 非空 AND extra.description_zh IS NULL`（写了 zh 就退出谓词，天然单调不重译）；description 空 → 跳过；翻译失败 → 不写坏值、下轮重试；已是中文的 description → 直通写回不调 LLM。返回 `{scanned, translated, remaining}`，**`?dry=1` 零写且不调 DeepSeek**（只预览选中面，不烧钱），`limit` 默认 30、上限 100，循环调至 `remaining=0`。**新入库 PH 走 `ph-pipeline` 的 `translate-fields` step 自动翻**（新增 description task），本 mode 只清存量 backlog。
  - 🆕 **本批次 4 mode 严格执行 runbook（先 dry 后真跑，staging 已验、prod 合并后按此序）**：① `blog-cover-generic-sweep`（dry 看 jiqizhixin/qbitai 簇明细 → 真跑，清簇置 `cover_generic_cleared_hash`）→ ② `blog-cover-bodyhero-backfill`（dry → 真跑，**强依赖 ①**，qbitai 回填正文 hero、jiqizhixin 图荒保持 monogram）→ ③ `blog-body-redecode`（dry → 真跑，修 `<p>` 泄漏，改 `body_markdown*`）→ ④ `ph-description-translate`（dry 确认不烧钱 → 真跑，写 `description_zh`）→ ⑤ daily 页重生成（`mode=daily-page&date=<有 blog+podcast+ph 的日期>`，依赖 ①②④ 落定）。**禁令：不对 jiqizhixin/qbitai 跑 `blog-cover-og-backfill`**（og 是被清品牌 logo，Fix C 会挡但语义上此二源封面只能取正文 hero）。
- `mode=backfill-replies`：回填 reply_to_id + reply_of 父推快照（用 syndication `parent` 字段，与 quote 平行）。cron 占 :05 :35 槽（2/h），历史回补主要靠本地 loop。
- `mode=reclassify-threads`：清理错分的 thread_root_id（默认 `dry_run=1` 只统计；`dry_run=0` 真执行）。一次性，等 backfill-replies 跑完再触发。
- `limit`：默认 20（backfill / refresh / tiered，1-100）；fill-translations 默认 15（1-50）；detect-longform 默认 30（1-80）
- `rate_sleep_ms=400`（backfill / refresh / tiered / detect-longform）
- `lookback_days=14`（仅 refresh-metrics，1-90）
- `max_tier=4`（仅 refresh-tiered，0-4；灰度时设 1 = 只刷 L0+L1）
- `batch_size=5`（仅 fill-translations，1-20；一次 DeepSeek 调用包多少条文本）

**定时任务**（单一 cron 内部模式轮转）：

| cron | 触发 | 调度逻辑 |
|------|------|---------|
| `*/5 * * * *` | `scheduled()` | 按触发时分分流：UTC `17:00` `05:00` → `runGithubFetchTrending`（GH phase 1，触发 GithubPipelineWorkflow）；UTC `08:00` `20:00` → `runClawhubFetchList`（ClawHub phase 1）；UTC `10:10-10:14` → `runPhDailyFetch`（PH 一日一抓，北京 18:10）；`:00` `:30` → `runRefreshMetrics`/`runRefreshTiered`（X metrics 刷新，**不是 workflow**）；`:25` `:55` → `runListPollIngest`（X phase 1，触发 XTweetPipelineWorkflow per new tweet）；`:20` → `runBlogFetch` + `:50` → `runPodcastFetch`（官方新闻 blog/podcast phase 1,占原 hdx-drain 槽,per-feed cadence 由 sources.config 控,触发 Blog/PodcastPipelineWorkflow per new item,各 `recordCronRun` 包裹;**blog/podcast 已上 prod**；**2026-06-22 Phase 2：+4 小宇宙中文播客（硅谷101 / OnBoard! / AI 前线 / 张小珺）经 HK VPS 自托管 RSSHub（`rss.ai-feeds.com`，Codex 运维，token-gated `X-RSSHub-Token`）接入，registry 共 28 源，`via='rsshub'` 走 `RSSHUB_BASE`+`RSSHUB_TOKEN`，部署交付见 `docs/plans/2026-06-22-rsshub-hk-vps-deploy-handoff.md`**；**2026-06-22 Phase 3 page-scrape（无 RSS 的博客，经 `feeds/page-index.ts` 的 `discoverPageIndex`，`fetch_strategy='page-scrape'` 走此路非 `parseFeed`；标题/封面/发布时间由 step3 `extractPageMeta` 从详情页 og:/JSON-LD 补，`toIsoDate` 规整日期）：① sitemap 法（带 lastmod）= AI21 Labs / Cohere；② html-index 法（扒列表页 anchor）= Databricks（首页 anchor，date 靠详情页 og）+ MiniMax（`minimax.io/news` Next.js app-router 但 server 仍渲染最新数篇 `/news/<slug>` anchor，date 靠详情页 og ISO datePublished）+ 美团技术团队（原 RSS `/feed/` 已 301 迁走且停更 → 改 page-scrape 扒首页 + history.html，date 在 URL `/YYYY/MM/DD/`）。registry 共 32 源（美团从原生 RSS 改 page-scrape）。**2026-06-24 +3 国外第三方 AI/科技新闻媒体**（原生 RSS，`via='native'` `kind='blog'` `region='foreign'`，registry 里独立 `FOREIGN_NEWS_MEDIA` 数组）：TechCrunch（`/category/artificial-intelligence/feed/`，RSS，高产、`<description>` 仅摘要无 `content:encoded`）/ The Verge（`/rss/ai-artificial-intelligence/index.xml`，**Atom** `<entry>/<content>`，选题偏消费科技、非 AI 噪音最多）/ MIT Technology Review（`/topic/artificial-intelligence/feed/`，RSS + `content:encoded` 全文，**替代已停更的 VentureBeat AI feed**——其 `/category/ai/feed` 实测最新仅 2026-05-19）——补「厂商官博漏掉的第三方报道 + 突发」，三者均经 `is_ai` gate 滤非 AI、冷启动走 30 天发布窗。**2026-06-24 +2 国内 AI 媒体**（registry 独立 `DOMESTIC_NEWS_MEDIA` 数组，`kind='blog'` `region='domestic'`）：① **量子位** `via='native'`（原生 RSS `qbitai.com/feed`，RFC822 pubDate 经 parseFeed 归一 ISO + `content:encoded` 全文；追产品发布最快、补国内生态热点；staging 实测 10 条 9 AI）；② **新智元** `via='rsshub'`（route `/aiera`，HK VPS RSSHub，Codex 2026-06-24 部署；staging 实测 10 条 9 AI、有正文）。③ **机器之心** `via='rsshub'`（route `/jiqizhixin`，HK VPS RSSHub 官网文章库 API 直连：列表 API 取最新 + 详情 API 补完整 HTML 正文进 RSS description，~4.4KB/条；Codex 2026-06-24 换源——原 `/wechat/sogou/jiqizhixin` 只标题+Sogou 跳转链无正文、worker fetch 抓不到、条目空被过滤，已废；staging 实测 has_body 20、AI 分类正常）。文档 `docs/plans/2026-06-24-rsshub-domestic-ai-media-handoff.md`（§10 = 换源结论，§8 旧 Sogou 记录保留为历史）。**registry 共 39 源**（2026-06-25 另加微博科技热搜 `blog:weibo-hot-tech`，HK RSSHub route `/weibo/hot/tech`，需要 Worker secret `WEIBO_COOKIES` 通过 `X-Weibo-Cookie` 转发；仅此源 `skip_cn_sensitive=true` force `extra.cn_sensitive=0`，is_ai gate 保留；当前真实 200 smoke 等待 prod.env 补 cookie）。**冷启动限深（D10）窗口（2026-06-24 `58e019a`）**：新源首跑只 enrich「最近 `COLD_START_WINDOW_DAYS`=30 天内发布」的（对齐 C 端 blog/podcast 30 天显示窗），窗口外历史压占位（`cold_start_skipped=1` + `is_relevant=NULL`，不 enrich 不展示）。**由原「最近 10 条」count 上限改为发布日期窗** —— 旧上限对 OpenAI/NVIDIA 等高产源会把窗口内该展示的新文也误压成历史（prod 实测误伤 OpenAI 35 / NVIDIA 8 / Anthropic 6 条）；历史不回写、仅未来接新源时生效。`blog.ts` + `podcast.ts` 同步，无/无法解析发布日期当「新」放行。**待后续增量**：智谱（`zhipuai.cn/news` app-router 纯 JS 壳、server 零文章数据、无可用 API → 方案 A 不通，需无头渲染 B：Codex 腾讯云机 / CF-BR，设计 §6.3）；Meta（请求 400 被拒）**，设计 `docs/plans/2026-06-09-ai-vendor-feeds-source-design.md`）；`03:35 UTC` 每天一次 → `runCleanup`（清 30 天前的 snapshots/refresh_log）。**抢占路径**（catch-all tick 在分发前先查 pending 队列）：**PH enrich** / PH r2-migrate / **ClawHub enrich** + PH 字段 fill-translations，pending 非零就走 preempt |

**调度节奏（2026-05-16 阶段 4 cutover 后）**：每小时 2 次 refresh-metrics（`:00` `:30`，ScrapeBadger batch 刷新现有 tweet 互动数据）+ 2 次 list-poll-ingest（`:25` `:55`，拉新 tweet 触发 workflow）。每天 03:35 UTC（11:35 BJT）cleanup。其余 tick 走 catch-all preempt（PH/ClawHub 链）。

**X 主链已迁 CF Workflow**（2026-05-16）：原 6 个 cron mode（classify-pending / fill-translations / backfill-quotes / backfill-replies / detect-longform / longform-via-sb）全部走 `XTweetPipelineWorkflow` 5 step pipeline，每条新 tweet 1 个 instance。详见下方「X 流水线 (Workflow)」节。

**Product Hunt（2026-05-11 v2，全云端 — 迁离 browser-use 本地脚本）**：
- **抓取在云端**：用 PH GraphQL API v2 + client_credentials OAuth（不再走本地 browser-use）。
  - **Phase 1 — `runPhDailyFetch`**（worker/src/scrapers/ph.ts）：dispatcher UTC 10:10-14（北京 18:10-14）窗口触发，KV 哨兵 `ph:fetched:<PT_date>` 防一日内重跑。流程：list query cursor 翻页拿 PT yesterday 全部 featured posts → 每条 detail query 拿 makers/comments/media/topics → transform 成 IngestItem → 内调 `ingestItems()` 写 D1 → append `metrics_snapshots_ph` → 写 KV 哨兵
  - **PH API 单页 cap 20**，必须用 `pageInfo.endCursor` 翻页（max 10 页 = 200 条保护）。实测 PT 一日 featured 通常 30-50 条，原 `first:30` 单页只拿到 20 漏过半
  - **触发时间选 18:10 理由**：PT 切日点 = 北京 15:00 (PDT) / 16:00 (PST)；18:10 给 PH 后端 2-3 小时 settle daily_rank。原 04:10 (UTC 20:10) 太保守，用户次日凌晨才看到
- **Phase 2 — `PhPipelineWorkflow`**（2026-05-16 阶段 6 cutover，原 ph-enrich + ph-r2-migrate + fill-translations PH 分支 3 个 preempt 已删）：runPhDailyFetch 后对每条新 post create instance，3 step pipeline：
  1. `classify-with-llm` — DeepSeek 判 is_relevant + ai_category + ai_summary
  2. `r2-migrate` — logo/gallery/avatar/video → R2（仅 is_relevant=1 跑）
  3. `translate-fields` — tagline + maker_post + top_comments[] 翻译（task #8 写 translated_at）
- **手动 drain**：`POST /api/admin/ph-trigger-pending-workflows-now?limit=400`（Basic Auth）扫 stuck（未分类 / r2 没迁 / 翻译没补）+ marker 30min 防重 — 1 批清完 PH 全部 stuck
- **旧 batch fallback**：runPhEnrich / runPhR2Migrate / fill-translations PH 分支保留作 admin endpoint 兜底（/api/admin/ph-enrich-now / ph-r2-migrate-now / fill-translations-now）
- **PH 数据落 D1**：items 表统一 schema，PH 专属字段全在 `items.extra` JSON：`product_slug` / `launch_date_pt` / `daily_rank` / `topics` / `makers` / `hunter` / `maker_post` / `maker_post_text` / `maker_post_translated` / `top_comments[]` / `ai_summary` / `ai_category` / `ph_url` / `website_url` / `r2_migrated_at`
- **API 限制（重要）**：client_credentials 鉴权下 PH 隐藏所有非 hunter 用户身份（name/username 返回 `[REDACTED]`，id 返回 `0`）。`makers[]` 全 [REDACTED] → 过滤为空数组；comments / maker_post 保留文本但 author 显示 "PH 用户" 占位；hunter 真实可见。这是 PH 反爬虫策略（防 app token 爬用户）。要解需切 OAuth user-token 流程（涉及登录授权）
- **API 不暴露的字段**：`reviews` 详情（只有汇总数 `Post.reviewsCount/reviewsRating`）/ `pricing_type` / `is_open_source` / `followers` 数 — 前端按设计优雅降级（reviews 段隐藏 / pricing+open_source chip 隐藏 / followers KPI 显 "—"）
- **凭证**：PH OAuth Application 在 https://www.producthunt.com/v2/oauth/applications 创建。Worker 端 secret：
  - `PH_CLIENT_ID`：API Key
  - `PH_CLIENT_SECRET`：API Secret（PH 只显示一次，丢失需 regenerate）
  - 注入命令（staging）：`printf '<value>' | npx wrangler secret put PH_CLIENT_ID --env staging`；prod 去掉 `--env staging`
- **手动触发**（admin debug，需 Basic Auth or `Authorization: Bearer $INGEST_TOKEN`）：
  - `POST /api/admin/ph-fetch-now?force=1` 跳哨兵立即抓 PT yesterday
  - `POST /api/admin/ph-fetch-now?force=1&pt_date=YYYY-MM-DD` 指定日期回灌
  - `POST /api/admin/ph-enrich-now?limit=10` 立即跑一次 ph-enrich
  - `POST /api/admin/ph-r2-migrate-now?limit=2` 立即跑一次 r2 迁移
  - `POST /api/enrich/run?mode=fill-translations&limit=30` 触发翻译
- **临时关停**：`worker/src/index.ts` dispatcher 改 `if (false && hour === 20 ...)` redeploy
- **旧 launchd PH 抓取**：已退役并清理（2026-05-13），代码归档见 [`docs/archive/ph-scraper-retired.md`](archive/ph-scraper-retired.md)（含 fallback 恢复步骤）

**GitHub trending（2026-05-02 上线 / 2026-05-16 迁 CF Workflow）**：
- **Phase 1 — `runGithubFetchTrending`**（worker/src/github.ts）：每天 UTC `17:00` + `05:00`（= BJT 01:00 + 13:00），fetch trending HTML → 正则解析 ~25 条 → INSERT items 表（`is_relevant=NULL` + `extra.gh_pending=true`）+ 一行 `metrics_snapshots_gh` + **对每条新 row 调 `env.GITHUB_PIPELINE_WORKFLOW.create(...)` 触发 Workflow instance**。**~2 + N subrequests/run**（N = 新 repo 数）
- **Phase 2 — `GithubPipelineWorkflow`**（worker/src/workflows/github-pipeline.ts）：每个 instance 跑 5 step，每步 retry 3 × 10s 指数 backoff，`is_relevant=0` 早退跳过 step 3-5：
  1. `enrich-metadata` — GH API: repo meta + license + watchers + open_prs + contributors + recent commits + README
  2. `classify-with-llm` — DeepSeek 判 `is_relevant` + `ai_category` + `ai_summary`
  3. `r2-migrate-assets` — README 内 inline 图/视频迁 R2，rewrite URLs 到 `/r/<key>`
  4. `translate-readme` — DeepSeek 翻译 README 到中文（仅 `readme_lang != 'zh'`）
  5. `recompute-daily-rank` — 重算当日 `daily_rank` D1 batch（幂等，并发安全）
- **CF Dashboard 路径**：Workers & Pages → Workflows → `github-pipeline-workflow` (prod) / `github-pipeline-workflow-staging`（staging）。看 instance 列表（ID 形如 `gh-github-owner-repo`）+ 单 instance 各 step 状态。任一 step `errored` 可在 UI "Retry from step" 单步重试
- **容量预算**：6.2 repo/天 × 平均 3.3 step/instance × 30 = ~615 step/月（利用率 0.6%，免费额度 100k）。**月成本 $0**
- **手动触发**：
  - Phase 1（拉 trending 立即跑）：`POST /api/admin/gh-fetch-now`（Basic Auth）
  - 一次性 drain pending（迁移后兜底）：`POST /api/admin/gh-trigger-pending-workflows-now?limit=N`（Basic Auth）— 查 `gh_pending=true` 的 item，每条 create workflow instance
  - 旧 batch fallback（仍可用，正常不需要）：`POST /api/enrich/run?mode=github-fetch | github-enrich | github-r2-migrate | github-readme-translate`（Bearer INGEST_TOKEN）
- **回滚到旧 preempt cron 模式**：revert 实施 PR + `npx wrangler deploy`。Workflow instance 已跑完不重复，未跑完 errored（数据不损失）。Phase 1 自动回到「写 pending row + 等 preempt」模式
- **设计文档**：[`plans/2026-05-16-github-pipeline-workflows-design.md`](plans/2026-05-16-github-pipeline-workflows-design.md)

**X 流水线（Workflow）— 2026-05-16 阶段 4 cutover**：
- **Phase 1 — `runListPollIngest`**（worker/src/enrich.ts）：每 30 min（`:25` `:55`）触发，ScrapeBadger 拉 list page → upsert items → **对每条新 tweet 解析 extra 拿 hasQuoteRef/hasReplyRef/hasLinkCard/hasRetweetRef 信号 + 调 `env.X_TWEET_PIPELINE_WORKFLOW.create({ id: 'x-{tweet_id 转义}', params })`**。**SB ~57 credits/page + 1 SB credit/video（补 mp4）+ workflow create N 个**
- **Phase 2 — `XTweetPipelineWorkflow`**（worker/src/workflows/x-tweet-pipeline.ts）：每个 instance 5 step pipeline，每步 retry 3 × 10s 指数 backoff，`is_relevant=0` 早退跳过 step 2-4：
  1. `classify-with-llm` — DeepSeek 判 `is_relevant` + `ai_summary`
  2. **fan-out (Promise.all)**: `backfill-quote` (syndication + **SB by-ids 兜底 quote_of**，hasQuoteRef 时) + `backfill-reply` (syndication + **SB by-ids 兜底 reply_of**，hasReplyRef 时) + `backfill-retweet` (**SB by-ids 优先 + syndication 兜底**，hasRetweetRef 时，填 `extra.retweet_of` 原作者快照) + `check-longform` (always)。**2026-06-08:retweet_of/quote_of/reply_of 三处「被引用原推快照」统一加 SB by-ids 路径（`fetchTweetSnapshotById`），根治 syndication 从 CF ~30% 成功导致的低填充率**
  3. `longform-via-sb` — 条件：step 2c 检测到长推，ScrapeBadger 拉全文
  4. **fan-out (Promise.all)**: `translate-content` (always) + `translate-quote` (hasQuoteRef) + `translate-link-title` + `translate-link-desc` (hasLinkCard) + `translate-reply` (hasReplyRef) + `translate-retweet` (hasRetweetRef)
- **CF Dashboard 路径**：Workers & Pages → Workflows → `x-tweet-pipeline-workflow` (prod) / `x-tweet-pipeline-workflow-staging`（staging）。看 instance 列表（ID 形如 `x-x-list-2055570810513850777`）+ 各 step 状态
- **容量预算**：80 tweet/天 × 平均 3.5 step/instance × 30 = ~8,400 step/月（利用率 8.4%，免费额度 100k）。峰值 148 tweet/天 × 5 step × 30 = ~22k/月仍 22%。**月成本 $0**
- **手动触发**：
  - Phase 1（拉 list 立即跑）：`POST /api/admin/x-list-poll-now?pages=N`（Basic Auth）
  - 单 itemId 重跑 workflow：`POST /api/admin/x-workflow-trigger-now?itemId=x_list:...`（Basic Auth）
  - 一次性 drain 老 pending：`POST /api/admin/x-trigger-pending-workflows-now?limit=N`（Basic Auth）— 查 `is_relevant IS NULL` 的 X tweet，每条 create instance
  - 旧 batch fallback（仍可用，正常不需要）：`POST /api/enrich/run?mode=classify-pending | fill-translations | backfill-quotes | backfill-replies | detect-longform | longform-via-sb`（Bearer INGEST_TOKEN）
  - **转推长推截断存量回填**（2026-06-02 新增）：`POST /api/enrich/run?mode=retweet-longform-backfill&limit=5`（Bearer INGEST_TOKEN）。转推的长推全文挂在「被转推原推」id 上,旧逻辑全程用「转推壳」id 问 SB/syndication 只拿到 140/280 字 teaser → 正文卡截断。本 mode 用原推 `retweeted_status_id` 去 SB 拿 `full_text`（复用 `fetchLongformViaScrapeBadger`,已修成转推→原推 id 解析）+ `preserveIsRelevant` 重翻,同步写回 `content` + `extra.retweet_of.content`（FE 翻转显示这个字段）。**SB 限速 5 req/min,limit 默认 5,反复调直到 `selected=0`**。选择条件:`is_retweet=1` + `retweet_of.content` 长度 270-290 + 未被本 mode 处理过(`backfill_source NOT LIKE 'sb_retweet_original%'`,覆盖成功 / 真短推 `_same_length` / 原推已删 `_not_found` 三种已尝试标记,保证收敛到 `selected=0`)。**2026-06-02 存量已全量回填:132 条转推长推补全,1 条真·284 字误入选已正确排除**。**新进推文已由 workflow step 2 自动覆盖,无需 cron**。设计/排查见 git `fix/retweet-longform-truncation`
  - **转推原作者快照 `retweet_of` 回填 + 根因修复**（2026-06-08）：`POST /api/enrich/run?mode=backfill-retweets&limit=N&recover=1`（Bearer INGEST_TOKEN，staging 还需 `X-Dev-Token` 过 bot gate）。**根因**：`retweet_of`（被转推原作者头像/名字/handle/✓）由 workflow step `backfill-retweet` 拉，旧逻辑单走 `cdn.syndication.twimg.com`，从 CF worker 出口被 Twitter 节流数据中心 IP，**只有 ~30% 成功** → ~70% 转推 `retweet_of` 永空 → FE TweetCard 翻转 fallback 显示转推者本人（「X 转帖 X 自己的帖子」，正文却是原作者的）。本机住宅 IP 打 syndication 100% 成功，印证是 CF 出口被节流（同一 `fetchTweet` 也压低 `quote_of` 填充率到 ~36%）。**修复**（commit `0976bd4`）：新增 `fetchRetweetOriginSnapshot` —— ScrapeBadger by-ids（`/v1/twitter/tweets/?tweets=<retweeted_status_id>`，API-key 鉴权不受 IP 节流，从 CF 稳定）当主路径，syndication 仅兜底；`sbTweetToQuoteOf` 把扁平 SbTweet 映射成 QuoteOf；workflow step 2c（`backfillRetweetForXTweet`）+ `runBackfillRetweets` 共用同一 helper。`recover=1` 选 `is_retweet=1 AND retweet_of IS NULL`，反复调直到 `processed=0`。**2026-06-08 prod 存量回填 ~488 条**（实测 SB-first 从 CF `failed=0`，对比旧 syndication ~30%）。**注意**：05-25「转推突然全错」并非 git 回退 —— 是当天手动跑了一轮 recover backfill 扫了 228 条历史盖住问题、之后没再扫，把 chronic 的 ~30% syndication 不稳定暴露出来。排查见 git `fix/retweet-of-via-scrapebadger`。
  - **引用/回复快照 `quote_of`/`reply_of` 同款 SB 兜底**（2026-06-08，commit `b6eec2e`）：同根因压低了 `quote_of`（被引用推）填充率到 ~36%、`reply_of`（父推）类似。区别：retweet 按 `retweeted_status_id` 直接拉原推，而 quote/reply 旧逻辑拉**主推**靠 syndication 返 inline `quoted_tweet`/`parent` —— SB by-ids 不返 inline 嵌套推，但 ingest 已存 `quote_of_id`/`reply_to_id`，可直接按 id 拉。**修复**：`fetchRetweetOriginSnapshot` 改名 `fetchTweetSnapshotById`（通用 helper）；`backfillQuoteForXTweet`/`backfillReplyForXTweet`（workflow step）+ `runBackfillQuotes`/`runBackfillReplies`（backfill mode）在 syndication 没拿到 inline 嵌套快照时，按 `quote_of_id`/`reply_to_id` 走 SB by-ids 兜底。**加性改动**：syndication 在线照走（顺带 link_card），不碰正常路径。存量回填：`POST /api/enrich/run?mode=backfill-quotes&limit=N&recover=1`（recover 选 `quote_of_id 有 AND quote_of 空`）；replies 走 `mode=backfill-replies`（无 recover，靠 `reply_enriched_at` sentinel）。**注意**：少量被引用原推已删/账号封禁的，SB+syndication 都拉不到，`quote_of` 保持空（FE 显示「引用推文」占位，正常降级），recover 模式会反复重选这批 —— 回填时按「连续 2 轮 0 进展即停」收敛，残留的删除尾巴属正确结果。排查见 git `fix/quote-reply-of-via-scrapebadger`。
  - **内层引用 `retweet_of.quote_of` 嵌套快照补全 + FE「引用推文」标签去除**（2026-06-08，commit `afd2511`）：retweet_of/quote_of 切 SB by-ids 后,内层引用(A 转推 B、B 又引用 C)只存了 `quote_of_id` 没存 `quote_of` 快照 —— **SB by-ids `/v1/twitter/tweets` 不返 inline 嵌套推**(syndication `apiToQuoteOf` 旧版会递归 inline `quoted_tweet`),导致 FE 内层引用卡渲染不出(只剩占位)。**修复**：`fetchTweetSnapshotById` 加 `depth` 参数 + `embedNestedQuote`(depth<1 再拉一层嵌套 embed,新推文自动覆盖);新增 `POST /api/enrich/run?mode=backfill-nested-quotes&limit=N`(Bearer INGEST_TOKEN，staging 加 `X-Dev-Token`)清存量,用 `json_set($.{retweet_of|quote_of|reply_of}.quote_of, json(?))` 精确写嵌套 path、不覆盖父快照;嵌套原推删了 → 留空,反复调直到 `filled=0`。**2026-06-08 prod 回填 101 条**。**FE（`TweetCard.tsx`）**：删掉顶部「引用推文」placeholder 标签(对齐 X 原生 —— 引用就是底下一张卡、无顶部标签;又转推又引用时顶部只留「已转帖」);引用拉不到(被删/封)时在卡位置显示 X 风格「引用的推文已不可用」灰框(`text-neutral-400`)。排查见 git `fix/nested-quote-snapshot`。
  - **X 转推渲染契约根治：主卡永不冒名转推者 + 去混淆 retweet/quote**（2026-06-09，commit `300b6f6`）：sample `t/2064095913036169589`（fchollet 转推 bigaiguy，却显示成 fchollet 自己）。**3 缺陷叠加**(反复打地鼠的真正根因)：① **FE 翻转无安全兜底** —— `TweetCard.tsx` `is_retweet=1` 但 `retweet_of` 缺失时 `author` fallback 成 `item.author`（转推者）→「A 转帖 A 自己」/「B 内容配 A 头像昵称」；② **数据层 retweet/quote 混淆** —— `backfillNestedXQuoteForXTweet` 扫正文 x.com 链接把纯转推目标错当引用写进 `quote_of`（SB 实返 `quoted_status_id=None`），50 行中招、44 行因此显示重复卡；③ **回填失败永久搁浅** —— `backfillRetweetForXTweet` fetch 失败抛异常不留 sentinel，workflow `allSettled` 跑完不再重处理。**修复（4 层）**：(1) **FE 渲染契约** `TweetCard.tsx`：转推主卡身份只取 `retweet_of` → `quote_of`(当 `quote_of_id==retweeted_status_id` 借用) → `RT @handle`/`user_mentions[0]` 降级，**绝不回退转推者**；嵌套引用卡排除 `quote_of_id==retweeted_status_id` 的幽灵引用。(2) **enrich** `backfillNestedXQuoteForXTweet`：扫到 `id==retweeted_status_id` 时跳过（reason `is_retweet_target`），停止造幽灵引用。(3) **cron `:25` 转推自愈**（`index.ts` scheduled，`runBackfillRetweets(env,3,300,false)` 非 recover、带 `retweet_enriched_at` 哨兵守卫，扫从没 enrich 过的搁浅行重拉，自动跳过健康行 + 已删原推）。(4) **一次性数据手术**（prod）：`json_set($.retweet_of, json($.quote_of))` 移 6 行 quote→rt + `json_remove($.quote_of,$.quote_of_id)` 剥 44 幽灵 + `backfill-retweets&recover=1` 重拉 9 行。**2026-06-09 prod 修复后全量核对：`is_retweet=1 AND retweet_of NULL`=0、幽灵引用=0、1595 条转推 100% retweet_of 健全**。排查见 git `fix/x-retweet-render-contract`。
  - **X 媒体 → R2 缓存**（2026-06-05 新增,P0）：`POST /api/enrich/run?mode=x-media-r2&limit=12[&days=N]`（Bearer INGEST_TOKEN）。把 x_list item 的头像(`_normal`→`_400x400` 升清)+ 媒体(图片/视频 mp4≤20MB/封面)+ L2 嵌套(quote_of/retweet_of/reply_of)资源下载上传到 R2(key `x/<sha256>.<ext>`,内容寻址去重),就地改写 `media` + `extra` 里的 twimg URL 为 `/r/x/...`,标 `extra.x_media_r2_at`。`days=N` 只迁最近 N 天(回填窗口,pending 同窗口算,drain 到 `pending=0` 即停);不传=全量。**新进推文已由 X workflow step 2.5(`x-media-r2`)自动缓存,无需 cron**。代码 `worker/src/x-media-r2.ts`(镜像 `ph-r2.ts`)。**2026-06-05:prod 部署 + 回填最近 14 天(~1034 条);全量 26426 条(~11.8GB / $0.18 月)按需懒缓存,未全量回填**。设计见 `docs/plans/2026-06-04-x-card-render-api.md`
- **API ORDER BY 已翻译优先**（task #8）：非 hot 模式 `/api/items` 排序为 `(content_translated IS NULL) ASC, scraped_at DESC, id DESC`。已翻译 tweet 优先展示，新拉的未翻译靠后（workflow 跑完后下次刷新自动浮上来）
- **translated_at 字段**（task #8）：`items.translated_at` (INTEGER unix ts) 在 step 4 translate-content 完成时写入。给前端「N 条新译文可加载」横条用（translated_at > last_user_fetch_at）
- **i18n 友好接口**（task #7）：`XTweetParams.lang` + `translateXTweetField(env, itemId, field, { lang })` 参数预留多语言。当前硬编码 `'zh'`，未来扩 en/ja 改 prompt 模板不动 schema
- **reply / retweet 翻译覆盖**（task #6）：step 4 fan-out 含 `translate-reply` + `translate-retweet`，替代老 fill-translations 不扫的盲区
- **回滚到旧 preempt cron 模式**：revert 实施 PR + `cd worker && rm -f ../wrangler.jsonc && npx wrangler deploy`。Phase 1 自动回到「INSERT tweet + 等 preempt」模式
- **设计文档**：[`plans/2026-05-16-x-main-pipeline-workflows-design.md`](plans/2026-05-16-x-main-pipeline-workflows-design.md)

**ClawHub（2026-05-09 v2，全云端 — 无本地依赖）**：
- **数据源**：`https://wry-manatee-359.convex.cloud/api/query` Convex 公开接口（无鉴权 / 无 cookie / 无 turnstile）。调用三个：
  - `skills:listPublicPageV4`：列表（query 接口）
  - `skills:getBySlug`：单个 skill 详情（query 接口）
  - `skills:getReadme`：拿 ClawHub 网页 README 标签页的内容（**action 接口**，URL 走 `/api/action`，不是 `/api/query`）。返回 `{path, text}`，path 告诉是 README.md 还是 SKILL.md
- **Phase 1 — `runClawhubFetchList`**：每天 UTC `08:00` + `20:00`（= BJT 16:00 + 04:00）。8 次 list 调用（top 1000 按 stars + top 500 按更新时间 dedup），**不再过滤可疑项**（`nonSuspiciousOnly=false`）→ upsert items（`is_relevant=1` + `extra.ch_pending=true` + `published_at=skill.updatedAt`）+ append 一行 `metrics_snapshots_clawhub`。**~10 调用/次**
- **Phase 2 — `ClawhubPipelineWorkflow`**（2026-05-16 阶段 6 cutover，原 clawhub-enrich preempt cron 已删）：runClawhubFetchList 后对每条新 skill (ch_pending=true) create instance，1 step (CH 无条件分支)：
  1. `enrich-and-translate` — Promise.all 内 3 件并行 (summary translate + LLM finding translate + readme fetch+translate) + 最终 UPDATE D1
- **手动 drain**：`POST /api/admin/ch-trigger-pending-workflows-now?limit=400`（Basic Auth）扫 ch_pending=true + marker 30min 防重
- **旧 batch fallback** runClawhubEnrichPending 保留：每个 `*/5min` cron tick **原抢占式**取 `extra.ch_pending=1` 的行（按 `metrics.stars DESC` 优先），每 tick 处理 2 条。每条三件并行：
  1. **summary 翻译**（DeepSeek，跳过已是中文的）
  2. **LLM finding 翻译**（DeepSeek，跳过已 `lang=zh` 的）
  3. **`skills:getReadme`** 拿 ClawHub 渲染的 README 内容（`{path, text}`）
  - 然后 `translateMarkdown` 翻译 README 文本（**截断 5000 字符**防 DeepSeek 排队 throttle，超长部分加「完整版见 https://clawhub.ai」提示）
  - UPDATE items：`content_translated` 写翻译后 README，`extra` 写 `{license, install, capability_tags, is_suspicious, llm_verdict, llm_status, llm_analysis, readme_file, files_manifest, enriched_at, ...}`
- **可疑 skill 处理**（v2 新增）：
  - ClawHub 自家 LLM 给每个 skill 打 `verdict`（benign / suspicious / 等）和 `status`（clean / flagged 等）
  - enrichPending 把这俩字段读出来，`verdict !== 'benign' || status !== 'clean'` 视为可疑，写 `extra.is_suspicious=true`
  - `/api/items?source_type=clawhub` 默认过滤 `extra.is_suspicious=1`，前端「隐藏可疑」开关关闭时加 `?include_suspicious=true` 解除过滤
- **不接入 LLM judge**：所有 ClawHub skill 默认 `is_relevant=1`（marketplace 已是优选，跳过 X/GH/PH 那道 AI 相关性判别）
- **`/api/items?source_type=clawhub`** 走专用 `handleClawhubFeed`：按 `metrics.stars DESC` 排序 + cursor 分页（cursor 格式 `stars|id`），跟 X/PH 默认时间排序不同。支持的 query 参数：
  - `sort=stars|downloads|installs|updated|name`
  - `category=mcp-tools|prompts|workflows|dev-tools|data|security|automation|other|all`
  - `include_suspicious=true`（默认 false）
- **`/api/items/:id/refresh`** 加 clawhub 分支：drawer 打开主动调，refresh metrics 通过 `getBySlug`（KV throttle 60s）
- **手动触发**：`POST /api/enrich/run?mode=clawhub-fetch` / `POST /api/enrich/run?mode=clawhub-enrich&limit=10`，都需 Bearer `INGEST_TOKEN`
- **海报变体**：`worker/src/share/svg-template.ts` 加 `renderClawhubContent`（GH 同款骨架 + lavender 来源 chip `#d8c8f5`）+ `pickSourceMeta` 加 clawhub 分支
- **prod 数据规模**（2026-05-09）：2765 条 items，2676 条有真 README 翻译（97%），784 条标 suspicious（28%）。staging → prod 数据通过 D1 dump + INSERT OR REPLACE 复制（避免重复 DeepSeek 调用）

**ClawHub item 的 `extra` 字段速查**：

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `slug` | string | API | skill 的 url slug，跟 `source_id` 一致 |
| `latest_version` | string | API | 当前最新版本号 |
| `versions_count` | number | API | 历史版本总数 |
| `category` | string | 关键词派生 | feed 分类标签（mcp-tools / prompts 等 8 类） |
| `owner_image` | string | API | 作者头像 URL |
| `summary_en` | string | API | 英文短描述（< 200 字） |
| `summary_translated` | string | DeepSeek | summary 中文译文，feed 卡片正文用 |
| `ch_pending` | boolean | enrichPending | 是否待 enrich，false=已处理 |
| `enriched_at` | unix sec | enrichPending | 上次 enrich 时间 |
| `license` | string | API | 许可证（MIT / Apache 等） |
| `install` | array | API | 安装方式列表（claw / brew / npm 等） |
| `capability_tags` | array | API | skill 能力标签 |
| `is_suspicious` | boolean | enrichPending | ClawHub LLM 判可疑（v2 新增） |
| `llm_verdict` | string | API | ClawHub LLM 判定（benign / suspicious 等，v2 新增） |
| `llm_status` | string | API | ClawHub LLM 状态（clean / flagged 等，v2 新增） |
| `llm_analysis` | object | enrichPending | `{findings: [...], lang: 'zh'}` 翻译后的安全审查项 |
| `readme_file` | string | enrichPending | ClawHub 选了哪个文件渲染 README（README.md / SKILL.md，v2 新增） |
| `files_manifest` | array | API | skill 包含的文件列表（path + size） |
| `updated_at` | number | refresh | skill 上次更新时间（ms） |

**活动行 huodongxing（2026-05-13 上线，纯云端 HTML 抓取）**：
- **数据源**：`https://www.huodongxing.com/events?tag=AI&city=<city>&orderby=o&page=<N>` SSR HTML（无 turnstile/captcha，robots.txt allow `/events`）。详情页 `/event/<id>` 走 inline 88KB JSON（ASP.NET DataContractJsonSerializer 输出）。
- **24 城市枚举**：`worker/src/scrapers/huodongxing/cities.ts`。6 核心（北京/上海/广州/深圳/杭州/成都）+ 18 次级。`?city=北京` 形式统一（不用 bj.huodongxing.com 子域名）。
- **Phase 1 — `runHuodongxingFetchList`**：起跑 BJT 04:30/16:30（UTC 20:30 + 08:30），KV 状态机（key `hdx:fetch_progress`）跟踪 cities_pending。接力 tick：UTC 20:35-21:05 + 08:35-09:05 共 7 个 5min slot，每 tick budget=40 subreq，节流 page 间 2s。24 城 × ~5 page ≈ 120 fetch / ~3-4 tick 拼齐。
- **Phase 2 — `HuodongxingDetailWorkflow`**（2026-05-16 阶段 5 cutover，原 isHdxEnrichSlot preempt cron 已删）：runHuodongxingFetchList 拉完 list 后对每条新事件 create instance，throttleSec=index×5 错开避免 site WAF。每个 instance 3 step：
  1. step.sleep(throttleSec) — 跨 instance 节流（替代老 batch 内 5s sleep）
  2. `warmup-and-fetch-detail` — **同 worker invocation 内 warm-up + detail**（避开 KV 缓存 cookies 跨节点 IP 触发 403 WAF 的根因 bug）
  3. `persist` — UPDATE D1 (含 active/historical 判断)
  - **风控阈值**（实测）：detail 路径 ~15 fetch/min 持续 4 分钟触发 WAF（200 + 6KB challenge stub body）；list 路径 30+/min 安全。throttleSec=5s 控 12/min。
- **Phase 2.5 — `runHuodongxingDetailEnrich`**（保留作 admin fallback，cron 不再调）：老 batch 模式，admin endpoint /api/admin/hdx-enrich-now 仍可手动触发兜底。
- **Phase 3 — `markStaleEventsHistorical`**：BJT 03:00（UTC 19:00）每天一次。end_time 已过 或 (end_time IS NULL AND start_time + 1d 已过) 的 active event 标 status=historical。
- **数据落 D1**：items 表统一 schema，huodongxing 字段全在 `items.extra` JSON：
  - listing 阶段：`city / district / is_online / time_raw / location_raw / first_seen_at / last_seen_at / status / organizer.{name,slug,org_id,url,avatar_url,fans,is_certified_company,is_vip_gold}`
  - detail enrich 后：`detail_enriched_at / start_time / end_time / start_short / end_short / address / location_full / category / tags[] / is_free / ticket_tiers[] / guests[] / contact / og_image / thumbnail_full`
  - metrics 列：`organizer_fans / max_instance / registered_count / follows / visit_number`
- **`/api/items?source_type=huodongxing`** 走专用 `handleHuodongxingFeed`：
  - 默认 filter `status != 'historical' AND (end_time > 今天 BJT 00:00 OR (end_time IS NULL AND start_time + 1d > 今天 BJT 00:00))`，`?include_historical=1` 取消
    - 边界用"今天 BJT 00:00"而不是当前时刻 — 今天结束的活动**全天可见**，BJT 隔天 00:00 后才剔除（用户期望"BJT 自然日"语义）
  - 排序：状态优先（进行中 > 未开始） + start_time ASC（派生状态 _state 用真实 BJT 时刻判断）
  - cursor 格式：`<state>|<start_time>|<id>`
  - v2 query params: `?city=<encoded>` / `?when=this|weekend|month` / `?form=online|offline`，互相 AND
    - `when` 用**区间重叠语义**：活动期 `[start_time, end_time]` 与过滤区间 `[startIso, endIso)` 重叠即命中（不再要求 start_time 必须落在区间内）
    - `start_time IS NULL`（detail 未 enrich）的卡片也允许放进 `when` 过滤结果，等 enrich 后自动归位 — 避免 list 阶段刚抓回的卡片对用户不可见
- **手动触发**（admin debug，HTTP Basic Auth `ADMIN_USER/PASS`）：
  - `POST /api/admin/hdx-fetch-now?budget=40&reset=1&only_city=北京` 触发 list 抓取（reset=1 清 KV 重新跑，only_city= 跳过 KV 单城抓）
  - `POST /api/admin/hdx-enrich-now?limit=3` 立即跑一批 detail enrich (老 batch fallback)
  - `POST /api/admin/hdx-trigger-pending-workflows-now?limit=400` 阶段 5 治本 drain — 扫 detail_enriched_at IS NULL + workflow_triggered_at 30min 之外的 item 触发 workflow。**limit 上限 400**（CF Worker 单次 1000 subreq 限制），需要 drain 多批分多次跑
  - `POST /api/admin/hdx-sweep-now` 立即清扫过期 → historical
  - `GET /api/admin/hdx-status` 看 detail_pending 数 + 当前 fetch_progress KV 状态
- **手动批量补翻译**（admin debug，HTTP Basic Auth `ADMIN_USER/PASS`）：
  - `POST /api/admin/fill-translations-now?limit=30&batch_size=8` 立即跑一轮 fill-translations（X content / quote_of / link_card + PH content / maker / comments）
  - 默认 limit=30 batch_size=8，上限 limit=100 batch_size=20。用于清积压或验证 prompt 效果
  - 区别于 `POST /api/enrich/run?mode=fill-translations`（需 Bearer `INGEST_TOKEN`，不在本地）
- **POC endpoint**（无鉴权）：`GET /poc/hdx?city=北京&page=1&detail=1` 不入库，返 parse 结果 + 字段统计，FE 可当 mock 数据源
- **临时关停**：`worker/src/index.ts` dispatcher 改 `if (false && (hour === 20 || hour === 8) ...)` redeploy

**HuggingFace Daily Papers（2026-05-19 上线,纯云端 — 走 HF API + arxiv + svelte_ssr 评论解析）**：

- **数据源**:
  - HF API `GET /api/daily_papers` listing(50/day,UTC 00:00 出榜)+ `GET /api/papers/{arxiv_id}` 详情(走 HF_READ token)
  - arxiv.org Atom API `?id_list=<arxiv_id>` 补 categories(CF IP 时段性 429,Phase 3 step 0 兜底)
  - arxiv.org/pdf/<arxiv_id> 抽 figure(自己写 XRef parser,`worker/src/hf-paper/figure-pdf.ts`,**关键**:`fflate.unzlibSync` 不是 inflateSync)
  - HF web page SSR `<div data-target="PaperContent" data-props="...">` 抽 discussion(匿名 fetch,无需 puppeteer)

- **Phase 1 — `runHfDailyFetch`**(`worker/src/scrapers/hf-paper.ts`):cron UTC 00:00-04 触发,KV 哨兵 `hf:fetched:<BJT_date>` 防同日重跑。流程:listing → 50 detail(并发拉)→ batch arxiv categories → INSERT items(`id = hf_paper:<arxiv_id>`,is_relevant=1,无 LLM judge — HF Daily 已策展)→ trigger `HfPaperPipelineWorkflow` per new paper → append `metrics_snapshots_hf_paper`

- **Phase 2 — `HfPaperPipelineWorkflow`**(`worker/src/workflows/hf-paper-pipeline.ts`):每个 paper 1 instance,instance ID 含 hour-bucket 防 already_exists,4 step:
  1. **Step 0**(串行):refresh-paper-detail + fetch-arxiv-categories(per-paper 兜底)
  2. **Step 1**(**必须串行,不要 fan-out**):fetch-ar5iv-and-extract-figure → fetch-discussion → refresh-gh-star → backfill-media-r2(最后跑,读最新 extra)。fan-out 会导致 read-modify-write 互相覆盖 extra,lost update。
  3. **Step 2**:translate-discussion-comments(flash)。**ar5iv 段落级翻译已弃用**(2026-05-19 方案 E,FE drawer iframe arxiv.org/html + 浏览器翻译插件)
  4. **Step 3**(fan-out):8 段独立 pro reasoning(tldr / problem / key_insight / method / experiments / industry_impact / code_status / limitations_and_novelty)+ 1 次 flash translate(title + summary + ai_summary)→ merge → mark-completed
  - **deep_analysis idempotency**:`extra.deep_analysis_input_hash = sha256(title|summary|ai_summary_en|ar5iv_excerpt[:3000])`,backfill 命中 hash 跳 pro 调用(prompt 没改的话省 token)
  - **完整性 gate**:允许 8 段 ≤2 段失败,title_summary 必须成。失败不写 workflow_completed_at,backfill cron 重 trigger

- **手动触发**(admin debug,Basic Auth `ADMIN_USER/PASS` 或 `Bearer $INGEST_TOKEN`):
  - `POST /api/admin/hf-fetch-now?force=1&date=YYYY-MM-DD` 立即跑 daily fetch(`force=1` 跳哨兵)
  - `POST /api/enrich/run?mode=backfill-hf-paper-workflow&limit=200&throttle_ms=3000` 扫未 completed paper batch trigger(filter `workflow_completed_at IS NULL`)
  - `POST /api/enrich/run?mode=hf-rerun-paper&arxiv_id=<id>` 单 paper 重跑(reset hash + 强制 hour-minute-random suffix instance ID),prompt 调优用
  - `POST /api/admin/hf-r2-migrate-from-staging` 一次性 staging R2 → prod R2 搬运(只 prod 用,body `{keys: ["hf/abc.png"], source_origin: "https://staging-api.ai-feeds.com"}`,`force=1` 覆盖,`dry_run=1` 只查不写,batch ≤200/次)

- **prod 上线日数据搬运**(staging → prod 一次性,免 prod 重跑 pro 浪费 token):
  - `source .secrets/aifeeds-prod.env && cd worker && npx tsx scripts/migrate-hf-staging-to-prod.ts`
  - 脚本:wrangler d1 SELECT staging hf_paper rows → 生成 INSERT OR REPLACE SQL → wrangler d1 execute prod;同 `metrics_snapshots_hf_paper`;从 items 抽 R2 keys(`media[].url` + `extra.figure_image.r2_url` + `extra.submitter_avatar` + `extra.discussion_comments[].author_avatar`)→ batch POST `/api/admin/hf-r2-migrate-from-staging`(prod worker 跨网 fetch staging /r/<key> → 写本地 R2)
  - 选项:`--dry-run` / `--d1-only` / `--r2-only` / `--force`(prod 已有 hf_paper 时显式覆盖)

- **HF 数据落 D1**:items 表统一 schema,HF 专属字段全在 `items.extra` JSON:
  - 来自 HF API:`upvotes / num_comments / discussion_id / project_page / github_repo / github_stars / github_repo_added_by / ai_summary_en / ai_summary_zh / ai_keywords / paper_authors[] / submitter_avatar / submitter / arxiv_categories[]`
  - 来自 ar5iv 抓取:`ar5iv_excerpt`(英文前 3000 字给 deep_analysis 用)/ `ar5iv_paragraphs_count`(120 ~ 段)/ `ar5iv_fetched_at` / `figure_image`(source:pdf/ar5iv/hf_thumbnail/none + r2_url + width + height + codec)
  - 来自 svelte_ssr 抓取:`discussion_comments[]`(id / author / author_avatar / content_html / reactions / is_author_reply)/ `discussion_fetch_method:"svelte_ssr"`
  - 来自 deep_analysis:`title_zh / summary_zh / deep_analysis.{tldr,problem,key_insight,method,experiments,industry_impact,code_status,limitations,novelty_rating} / deep_analysis_input_hash / deep_analysis_at / deep_analysis_model / workflow_completed_at`

- **凭证**:HF API 走 `HF_READ` token(读取 daily_papers + papers detail,2026-05-18 prod + staging 都 put);DeepSeek 走 `DEEPSEEK_API_KEY`(8 段 pro + flash 共用)

- **CF Dashboard 路径**:Workers & Pages → Workflows → `hf-paper-pipeline-workflow` (prod) / `hf-paper-pipeline-workflow-staging`(staging)。看 instance 列表(ID 形如 `hf-paper-2604-09839-<hour>`)+ 各 step 状态

- **容量预算**:50 paper/天 × 12 step(8 pro + 4 杂)× 30 = 18k step/月(利用率 18%,免费额度 100k)。**月成本估算**:DeepSeek ¥3-8/月(8 段 pro reasoning 是大头,每 paper ¥0.02-0.05;flash 翻译 ~¥0.5/月)

- **临时关停**:`worker/src/index.ts` dispatcher 改 `if (false && hour === 0 && minute >= 0 && minute < 5)` redeploy

**M4 refresh-metrics 模式切换**（2026-04-29 上线）：
- `REFRESH_MODE` env var：`legacy`（默认，runRefreshMetrics round-robin）/ `tiered`（runRefreshTiered 按 tier+velocity）/ `off`（跳过 refresh 模式槽）
- `REFRESH_TIER_MAX` env var：tiered 模式下只刷 `tier <= N` 的 item（默认 1 = 灰度只刷 L0+L1；调到 4 = 全量 L0-L4）
- 设置：`cd worker && npx wrangler secret put REFRESH_MODE`（输入 `tiered` 即开启灰度）
- 回滚：`npx wrangler secret put REFRESH_MODE` → 输入 `legacy`，无需重部署

> 2026-04-21 曾短暂调成 fill-heavy（8x/hr）清积压，实测 722 条 quote_pending 中仅 **0.3%**（1 条）是非中文，qual_ok 到 20 后彻底停滞。Backfill 才是真正的瓶颈（syndication API hydration）。

**每模式容量**：
- backfill-quotes：20 条/次 × 6 次/小时 × 24 = 2880 条/天（日增 ~100 条，绰绰有余；syndication API 才是真瓶颈）
- refresh-metrics：20 条/次 × 2 次/小时 × 24 = 960 条/天（最近 14 天的 item 轮转刷新）
- fill-translations：30 条/次 × 2 次/小时 × 24 = 1440 条/天（每条最多补 4 个字段：content + quote_of + link_card title/desc；实际翻译候选极少，多数 run 命中 tasks:0）
- detect-longform：25 条/次 × 2 次/小时 × 24 = 1200 条/天（候选 SQL 限 length 270-290 mid-word；命中 ~75% 写 `extra.longform.note_id`，等本地浏览器拉取）

**子请求预算**（CF Free 限 50/invocation）：
- backfill-quotes：~43-48（20 fetch + 20 UPDATE + overhead）
- refresh-metrics：~43-48（同上，metrics UPDATE）
- fill-translations：~30-48（1 SELECT + 3-12 DeepSeek 初翻 + 最多 3 DeepSeek 重试 + 15 UPDATE；sanity check 触发重试时吃上限）
- detect-longform：~43-48（1 SELECT + 25 syndication GET + ~17 UPDATE，命中率 ~70% 时贴上限）

**PR5 分享海报**（2026-05-05 上线）：
- **5 个 endpoint**：`/api/share/create` (POST + cookie auth)、`/api/share/poster/:token` (GET + R2 cache)、`/s/:token` (302 redirect)、`/api/share/landing` (POST + did)、`/api/admin/share/:token` (Basic Auth)
- **数据表**：`share_relations`（migration `009-share-relations.sql`，prod + staging 都已 apply）
  - 字段：token / from_uid / item_id / shared_at / to_did / to_uid / landed_at / registered_at / scan_count / last_scanned_at
  - 4 个索引：token unique / from_uid+time / item+time / to_did
- **海报渲染管线**：worker SVG 模板 (`worker/src/share/svg-template.ts`，~530 行) → resvg-wasm → PNG → R2 缓存（key: `share/poster/<token>.png` in `xlist-readme-assets` bucket）
  - 首次 cold render ~3-4s（wasm init + 渲染 + R2 put），HIT 1.4s 内返回，CDN cache `immutable`
  - 字体：Noto Sans SC Medium 子集（`worker/src/share/assets/noto-sc-medium.woff2`，1MB，覆盖 GB2312 6700+ 字 + ASCII + 标点）
  - 三变体：X / GitHub / Product Hunt，按 `source_type` 自动分发
  - 头像：worker 查 users 表拿 display_name + avatar_url，按 dashboard `defaultProfile.ts` 同款 djb2 hash 推 `/avatars/avatar-NN.png` 默认；fetch + base64 嵌入 SVG
  - 媒体图：GH = readme_excerpt 第一张非 SVG（`/r/*` 永远拉 prod，hash immutable 跨环境安全）；PH = media JSON 第一张 gallery；X = item.media 第一张 image
  - 质量门控：宽高比 > 4 || < 0.25 弃；字节密度 < 0.05 弃（避免 wordmark hero / shields / 大画布小 icon）
- **dashboard 接入**：抽屉头部右上角「分享」按钮 + ShareDialog 模态框；未登录 → openLoginModal('manual', retry=setShareOpen(true))；同 itemId 用 drawer 级 shareCache 不重复换 token；移动端调 `navigator.share({files})` 直接保存到相册，PC 走 `<a download>` 下载
- **CORS**：dashboard fetch poster_url 拿 blob 需要，已加 `Access-Control-Allow-Origin: *`
- **三环境支持**：handlers `originsFor(request)` 根据 host 推 site/api origin；staging-api → staging.ai-feeds.com / api → ai-feeds.com；不再写死 prod 域名

**翻译质量 sanity check**（2026-04-20 上线，两端一致）：
- 阈值：`length_ratio < 0.15 or > 2.0`，`CJK_ratio < 20% or >= 99.9%`
- 命中即重试 1 次；重试后仍 suspect 则保留译文 + 标 `translation_quality='suspect'`
- Worker 返回值含 `sanity_suspect / sanity_retried / items_marked_{ok,suspect}` 便于观察

### 2. D1: `xlist`

- **database_id**：`2973d54b-ca13-48e4-8d20-1430c57f5260`
- **表结构**：见 `worker/schema.sql`
- **21 个表**：
  - `items` — 所有内容的统一表（JSON extra 列装 X 专属字段：quote_of/link_card/hashtags/`enriched_at` 等；`translation_quality` TEXT + `translation_attempts` INTEGER 列标记翻译质量；2026-04-23 M3 新增 `tier` INTEGER + `next_refresh_at` INTEGER + `last_velocity` REAL + `deleted_at` INTEGER 四列，含 `idx_items_next_refresh` / `idx_items_deleted` 两个索引）
  - `sources` — 抓取源列表（list_id、cursor、last_success_at）
  - `run_stats` — 每次抓取的统计
  - `enrich_state` — cron enrich 的进度（processed_ids / failed_ids / not_found_ids）
  - `metrics_snapshots_gh` — GitHub 源专属 metrics 历史（item_id / captured_at / trending_date_str / total_stars / today_stars / forks / watchers / open_issues / open_prs；2026-05-01 加入，跟 `metrics_snapshots`（X 用，likes/retweets/replies/bookmarks/views）独立避免字段维度污染。migration: `worker/migrations/004-metrics-snapshots-gh.sql`）
  - `metrics_snapshots`（2026-04-23 M1.5 新增）— 每次 `runRefreshMetrics` 覆盖 `items.metrics` 时 append 一行 (item_id, captured_at, likes, retweets, replies, bookmarks, views)，append-only 时间序列。为 M4/M5 的 tiered 刷新策略提供真 Δlikes 数据。保留 30 天（清理机制 M5 时加）
  - `refresh_log`（2026-04-23 M3 新增）— 每次 `runRefreshTiered` 执行时 append 一行 (refreshed_at, tier, items_count, subrequests_used, duration_ms, errors)，观测 CF subrequest 配额在各 tier 的分配。保留 30 天（清理机制 M5 时加）
  - `events`（2026-05-01 PR1 新增）— Dashboard telemetry 落地点。完整产品行为上报：导航 / 内容 / 筛选 / 分享 / 登录 / 性能 / 错误。写入：`POST /api/track`（前端 SDK）。索引：`idx_events_did_time` / `idx_events_user_time` / `idx_events_type_time` / `idx_events_path_time` / `idx_events_ingested`。事件白名单：`worker/src/track.ts` `EVENT_TYPE_WHITELIST` 与 `dashboard/src/lib/telemetry/event-types.ts` 镜像（任一端新增需两边都改）。30 天 retention cron 待加（PR 后置 TODO）。完整 schema 见 `migrations/004-events-table.sql` + 设计 `docs/plans/2026-05-01-auth-system-design.md` § 3.5
  - `users`（2026-05-02 PR2 新增）— 永久身份主键。`status` 枚举 active/banned/self_deleted；nanoid 14 字符 id。详见 `docs/plans/2026-05-01-auth-system-design.md` § 3.1
  - `identities`（2026-05-02 PR2 新增）— 登录凭证多对一关联 user。`provider` 枚举 phone/wechat/email；UNIQUE(provider, identity_value, unbound_at) 保证同一凭证同时只能绑定一个 user。详见 § 3.2
  - `sessions`（2026-05-02 PR2 新增）— cookie/bearer 双兼容 token，nanoid 32 字符 id，30 天滑动过期。详见 § 3.3
  - `sms_send_log`（2026-05-02 PR2 新增）— 短信发送日志 + 防刷计数 + 验证码 hash。`result` 枚举 success/rate_limited/turnstile_failed/sms_api_error/budget_capped。30 天 retention cron 待加。详见 § 3.4
  - `share_relations`（2026-05-04 PR5 新增）— 分享关系图。`token` (nanoid 8) UNIQUE / `from_uid` 分享人 / `item_id` 复合 id / `to_did` 落地浏览器 device_id（首次扫码补） / `to_uid` 落地用户后续注册的 user.id / `landed_at` / `registered_at` / `scan_count` / `last_scanned_at`。4 索引：token / from_uid+time / item+time / to_did。社交关系图基础数据。migration `009-share-relations.sql`
  - `metrics_snapshots_clawhub`（2026-05-07 ClawHub 接入新增）— ClawHub skill metrics 历史。每次 phase 1 cron append 一行 (item_id, captured_at, stars, downloads, installs_current, installs_all_time)。30 天 retention（沿用 `runCleanup` 03:35 UTC 每天清理）。两个索引：`idx_msch_item_time` / `idx_msch_captured`。migration: `worker/migrations/011-metrics-snapshots-clawhub.sql`，prod + staging 都已 apply（prod 2026-05-08 跟 ClawHub v2 一起上线）
  - `feedback`（2026-07-05 用户反馈功能新增）— C 端用户反馈主表：user_id / content / image_key（R2 `feedback/<sha256>.<ext>`）/ device_info + account_info（JSON 快照，定位问题用）/ ip / ua / day（BJT，配 `idx_feedback_user_day` 做每日 3 条限频）/ created_at(ms) / last_reply_at。migration `024-user-feedback.sql`，设计 `docs/plans/2026-07-05-user-feedback-design.md`
  - `feedback_replies`（2026-07-05 同上）— 后台图文回复：feedback_id / content / image_key / admin_email（CF Access JWT email，Basic 兜底 NULL）/ created_at(ms) / read_at（用户已读时间，C 端未读红点数据源）。索引 `idx_feedback_replies_fb`。同 migration 024
  - `daily_pages`（2026-07-06 每日静态日报页 SEO P0 新增，migration 025）— 每日静态日报页的 D1 索引表。4 列：`date`(YYYY-MM-DD BJT，PRIMARY KEY) / `title`(页面 title，含当日主题) / `item_count`(INTEGER) / `generated_at`(ISO8601)。`sitemap.xml` + `/daily/` 归档索引 + `llms.txt` 最近日报均从此表读取（**不做 R2 list**；R2 `READMES` bucket 的 `daily/YYYY-MM-DD.html` 只存快照）。写入：`digest/daily-page-run.ts persistPage` 的 `INSERT ... ON CONFLICT(date) DO UPDATE`（同 date 幂等覆盖）。migration `025-daily-pages.sql`，设计 `docs/plans/2026-07-06-daily-static-page-seo-design.md` §4.2
  - `items_fts`（2026-07-06 C 端搜索新增，migration 026）— **FTS5 影子表**（`USING fts5(... tokenize='unicode61')`）。3 个索引列存**预分词后的空格分隔 token 流**：`title_tok`（标题类，权重高）/ `body_tok`（正文摘要类，中）/ `author_tok`（作者/handle，低）；`item_id` / `source_type` / `published_at` 为 UNINDEXED 列。rowid 与 `items.rowid` 对齐（插入时显式指定）。中文靠 `tokenize.ts` 的 bigram 预分词入流，FTS5 自身只用默认 unicode61（不依赖 D1 的 trigram/ICU 编译选项）。**入索引门槛**：`workflow_completed_at IS NOT NULL` 且 `deleted_at IS NULL` 且 `is_relevant=1` 且 `dedup_of IS NULL` 且 `cn_sensitive != 1`。由 cron `syncSearchIndex` 增量维护（delete+insert 幂等 upsert），事后失格行靠每日 `reconcileSearchIndex` 清出。migration `026-search-fts.sql`，设计 `docs/plans/2026-07-06-c-search-design.md` §3.1
  - `search_terms`（2026-07-06 同上，migration 026）— suggestion 词表。列：`term`(展示原文保留大小写) / `term_norm`(小写归一，前缀匹配键) / `term_type`(`entity` | `hot_query`) / `source_type`(可空) / `weight`(REAL) / `updated_at`。主键 `(term_norm, term_type)`，索引 `idx_search_terms_norm(term_norm, weight DESC)`。**entity 词**来自库内真实内容（GH 仓库/PH 产品/skill 名/hf keyword/媒体名/高频作者≥3 条/GH·ClawHub 分类）→ 搜必有果；**hot_query 词**从 events `search_submit` 近 7 天聚合 top 100。每整点由 `rebuildSearchTerms` 全量重建。`/api/search/suggest` 用前缀范围扫描直读此表。设计 §3.3
  - `search_sync_state`（2026-07-06 同上，migration 026）— 搜索索引同步水位（`k TEXT PRIMARY KEY, v TEXT`）。key：`fts_wm_scraped_epoch`（增量水位，scraped_at 的 epoch 秒）/ `fts_wm_translated`（translated_at 水位）/ `fts_backfill_rowid`（backfill 进度游标）/ `fts_backfill_done` / `last_reconcile`（对账 JSON：itemsEligible/ftsRows/drift）。设计 §3.4
  - `item_pages`（2026-07-08 `/i/` 全量内容静态页 SEO 新增，migration 027）— 每条内容 SSR 静态页的 D1 索引表。5 列：`item_id`(composite id，PRIMARY KEY，如 `x_list:123`/`github:owner/repo`/`product_hunt:slug:date`/`hf_paper:2603.x`/`blog:...`/`podcast:...`) / `source`(`x`|`gh`|`ph`|`hf-paper`|`news`，注意此列用 `hf-paper`，但 URL 路径段用 `paper`) / `url_path`(如 `/i/x/123`，sitemap 分片用) / `generated_at`(ISO8601) / `status`(`live` 正常伺服 200 ｜ `gone` 转 410 + noindex + 移出 sitemap；`is_relevant` 被改判 0 或 item 删除时置 `gone`)。索引 `idx_item_pages_source(source, status)`。sitemap 分片、下架判定、伺服 status 全从此表读，**不做 R2 list**（R2 `READMES` bucket 的 `items/<source>/<id-safe>.html` 只存快照）。写入：`worker/src/seo/item-page-run.ts`（enrich 收尾 hook `generateItemPage` + `backfillItemPages`）。**prod live ~3.2 万行**（详见下方「SEO 静态页运维」§9）。migration `027-item-pages.sql`，设计 `docs/plans/2026-07-08-item-ssr-pages-design.md` §4.2

**关键字段语义**：
- `items.extra.enriched_at`（2026-04-20 新增）：ISO timestamp，标记该 item 已被 backfill-quotes 处理过一次（含空结果）。`selectBackfillCandidates` SQL 过滤此字段，防止已处理的 item 被反复捞起
- `items.translation_quality`（2026-04-20 新增）：null / `"ok"` / `"suspect"`。Worker `fill-translations` 每次翻译后写入，基于 length_ratio + CJK ratio sanity check
- `items.translation_attempts`（2026-04-20 新增）：翻译尝试次数，1 = 一次过，2 = sanity check 触发重试

**推 schema**：`cd worker && npm run db:init`（推远程）/ `npm run db:init:local`（本地）。

### 3. Secrets（统一 source 模式，2026-05-16 改造）

> **唯一源**（aifeeds CLAUDE.md「身份卡」强制约定）：所有 prod / staging secret 集中在 2 个本地文件 —
> - `.secrets/aifeeds-prod.env` — prod 全部 secret（worker + wrangler deploy + CF API ops）
> - `.secrets/aifeeds-staging.env` — staging 全部 secret（INGEST_TOKEN 独立，其他跟 prod 共享值）
>
> **历史散文件全部删除**（admin-prod / cf-claude-ops / cf-ops / gh-claude-ops / ph-oauth-prod / staging-ingest-token），值合并到统一文件。详见 `.secrets/README.md`。

**OPS 一键 source 模式**：

```bash
# prod
source .secrets/aifeeds-prod.env
# 之后 $INGEST_TOKEN / $DEEPSEEK_API_KEY / $ADMIN_USER / $CLOUDFLARE_API_TOKEN / $CF_OPS_API_TOKEN / 等 18 个 var 全部就位

# staging
source .secrets/aifeeds-staging.env
```

**事故恢复**（prod worker secret 被擦时一键 restore 12 个 worker secret）：

```bash
cd /Users/roxor/brain/30-projects/aifeeds
set -a; . .secrets/aifeeds-prod.env; set +a
cd worker
for k in INGEST_TOKEN DEEPSEEK_API_KEY GITHUB_TOKEN SCRAPEBADGER_API_KEY \
         TURNSTILE_SECRET_KEY PUSHDEER_ADMIN_KEYS RESEND_API_KEY \
         ADMIN_USER ADMIN_PASS PH_CLIENT_ID PH_CLIENT_SECRET \
         SMS_PROVIDER; do
  printf '%s' "${!k}" | tr -d '\n\r' | npx wrangler secret put "$k"
done
npx wrangler secret list   # 验证 12 个全在
```

**单个 secret 手动注入**（少数情况，比如 rotate 单把 key）：

```bash
cd worker
# 例：rotate TURNSTILE
source ../.secrets/aifeeds-prod.env
printf '%s' "$TURNSTILE_SECRET_KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY
```

**新增 secret 流程**：
1. 加值到 `.secrets/aifeeds-prod.env`（同步 staging 文件如需）
2. `printf '%s' "$NEW_KEY" | npx wrangler secret put NEW_KEY`
3. 提交 1Password / 密码管理器副本
4. **禁止**新建散落 `.env` 文件存这个 secret（违反 CLAUDE.md「身份卡」约定）

**Kill switch**：`SMS_DAILY_CAP=0` 立刻停发短信（不动代码）。
**回滚 secret**：`wrangler secret put X` 输入新值即覆盖；删除用 `wrangler secret delete X`。
**TENCENT_SMS_* 5 个**（备案后启用 SMS 真通道才需要）：当前 prod `SMS_PROVIDER=pushdeer`，备案前不在 `aifeeds-prod.env` 字段清单；启用时按 § 3.4 命令注入 + 同时加入 `aifeeds-prod.env`。

### 3.4. SMS Provider 切换（dev / staging / 冷启动期手动通道）

`worker/src/auth/sms.ts` 的 `sendSmsViaTencent` 实际是 router，按 `SMS_PROVIDER` env 切换：

| SMS_PROVIDER 值 | 行为 | 适用场景 |
|---|---|---|
| 未设置 / `tencent` | 真实腾讯云 V3 API；secret 缺失时 fallback 到 dev simulate（console.warn 明文 code） | 生产正常态 |
| `pushdeer` | 任何 phone 的验证码都推到 `PUSHDEER_ADMIN_KEYS` 的所有设备（admin 自己手机 + Mac），body 含 phone 脱敏 + 6 位 code | 腾讯云审核中、staging 阶段、朋友熟人冷启动期手动验证 |

**切到 PushDeer 通道**（腾讯云未到位时上线）：

```bash
cd worker
npx wrangler secret put SMS_PROVIDER          # 输入 pushdeer
npx wrangler secret put PUSHDEER_ADMIN_KEYS   # 输入 PDU394...,PDU394... 逗号分隔
npx wrangler secret put TURNSTILE_SECRET_KEY  # （独立的，PushDeer 模式仍走 Turnstile 防刷）
npm run deploy
```

**切回腾讯云**（审核通过后）：

```bash
cd worker
# 1. 先把 5 个 TENCENT_SMS_* secret put 进去
npx wrangler secret put TENCENT_SMS_SECRET_ID
# ... (同上其他 4 个)
# 2. 切 provider
npx wrangler secret put SMS_PROVIDER          # 输入 tencent
# 或者直接删（默认就是 tencent）
npx wrangler secret delete SMS_PROVIDER
npm run deploy
```

⚠️ **限制**：`SMS_PROVIDER=pushdeer` 是**单人 dev tool**，不能给真多用户产品用（验证码不发给用户而是发给 admin）。仅适合：
- 本地 dev / staging 测试 PR3 前端登录 UI
- 朋友熟人冷启动期手动转发（admin 收到后微信 / 截图给试用者）

### 3.5. SMS 防刷阈值（PR2 设计参考）

| Layer | 维度 | 阈值 | 修改位置 |
|-------|------|------|---------|
| L1 | CF Turnstile | managed 模式 | CF dashboard |
| L1 | CF Rate Limiting (per IP) | `/api/auth/sms/send` 5/min/IP | CF dashboard rules |
| L2 | phone 60s | ≥ 1 拒 | `worker/src/auth/sms.ts` |
| L2 | phone 5min | ≥ 3 拒 | 同上 |
| L2 | phone 24h | ≥ 10 拒 | 同上 |
| L2 | ip 1h unique phones | ≥ 10 拒 | 同上 |
| L2 | ip 24h total | ≥ 30 拒 | 同上 |
| L2 | device 24h unique phones | ≥ 5 拒 | 同上 |
| L3 | 全局每日 cap | 200 条 | `SMS_DAILY_CAP` env |
| L4 | 验证码错码锁 | 5 次错 → 30 min 锁 | `worker/src/auth/sms.ts` MAX_ATTEMPTS_BEFORE_LOCK / LOCK_DURATION_MS |

### 3.6. Resend Email 服务（2026-05-06 上线，备案前主登录路径）

**用途**：登录验证码邮件发送。绕过 ICP 备案（SMS / 一键登录 / 微信 connect 都依赖备案，Resend 不依赖），国内外通吃。

**API key**：通过 `wrangler secret put` 配置，名 `RESEND_API_KEY`，prod + staging 各一份。
- **永远不要**写到 git tracked 文件
- 旋转：Resend Dashboard → API Keys → Revoke 旧 key → Create new → `cd worker && npx wrangler secret put RESEND_API_KEY`（staging 加 `--env staging`）

**免费档限额**：100 封/天 + 3000 封/月（双重限制，超限服务直接 503）。

**告警阈值（PushDeer，复用现有 admin 通道）**：

| 阈值 | 级别 | 触发动作 |
|---|---|---|
| 当日 ≥ 80 / 95 | warn / urgent | 「今日 email 已发 N/100」 |
| 当日 ≥ 100 | critical | 服务返 503 + 告警 |
| 当月 ≥ 2400 / 2850 | warn / urgent | 「本月 email 已发 N/3000」 |
| 当月 ≥ 3000 | critical | 服务返 503 + 告警 |
| 风控严重命中（24h / locked / ip_24h_total） | info | `worker/src/auth/email-handlers.ts` |
| 一次性邮箱 / MX 失败 | 仅落 `email_send_log`，不告警（噪音太大） | — |

告警去重：同阈值同日 / 同月只发一次（KV `email_alert_<scope>_<level>_<date>`）。

**发件域**：`mail.ai-feeds.com`（子域，独立 reputation；marketing 邮件未来在主域不会拖累 transactional 信誉）。

**DNS 记录（CF DNS 加 4 条 TXT/MX；Resend 后台 Domains 页面给出具体值）**：
- `mail.ai-feeds.com` TXT — SPF
- `resend._domainkey.mail.ai-feeds.com` TXT — DKIM
- `_dmarc.mail.ai-feeds.com` TXT — DMARC
- `feedback.mail.ai-feeds.com` MX — return-path

**配置 secret**：

```bash
cd worker

# Resend HTTPS API key（在 Resend Dashboard - API Keys 创建）
npx wrangler secret put RESEND_API_KEY                # prod
npx wrangler secret put RESEND_API_KEY --env staging  # staging（可与 prod 同 key 或独立）

# Turnstile + PushDeer 已存在（沿用 SMS 时的同一组）
```

**Kill switch**：
- `EMAIL_DAILY_CAP=0` 立刻停发（不动代码）
- `ENABLE_EMAIL_LOGIN=false` 紧急关闭整个 email 通道（503）

**Email auth 多维度防刷**（PR-EmailAuth 设计参考）：

| Layer | 维度 | 阈值 | 修改位置 |
|---|---|---|---|
| L0 | Turnstile | managed 模式（与 SMS 共用 widget） | CF dashboard |
| L1 | 一次性邮箱黑名单 | npm `disposable-email-domains` 包 ~12 万域名 | `worker/src/auth/email-validation.ts` |
| L1 | MX 预校验 | CF DoH 查询，KV 缓存 24h | 同上 |
| L2 | email 60s | ≥ 1 拒 | `worker/src/auth/email-rate-limit.ts` |
| L2 | email 5min | ≥ 3 拒 | 同上 |
| L2 | email 24h | ≥ 10 拒 | 同上 |
| L2 | ip 1h unique emails | ≥ 10 拒 | 同上 |
| L2 | ip 24h total | ≥ 30 拒 | 同上 |
| L2 | device 24h unique emails | ≥ 5 拒 | 同上 |
| L3 | 全局每日 cap | 100 条（Resend free） | `EMAIL_DAILY_CAP` env |
| L3 | 全局每月 cap | 3000 条（Resend free） | `EMAIL_MONTHLY_CAP` env |
| L4 | 验证码错码锁 | 5 次错 → 30 min 锁 | `worker/src/auth/email-rate-limit.ts` |

**Feature flags**（备案完成后翻）：
- `ENABLE_SMS_LOGIN`（worker env）：备案前 = `false`（关闭 SMS 通道，前端 LoginModal 走 email-only）；备案后 = `true` → 重做双 tab UI（届时另起 PR）
- `ENABLE_EMAIL_LOGIN`（worker env）：默认 `true`，紧急关闭设 `false`
- `VITE_AUTH_CHANNEL`（dashboard env）：备案前 = `email`，备案后 = `sms+email` → 触发新 LoginModal UI

**完整设计文档**：[`docs/plans/2026-05-06-email-auth-design.md`](plans/2026-05-06-email-auth-design.md)

### 3.7. Email Routing 收信转发（CF 原生，与 Resend 互不相干）

> Resend（§3.6）只管**发信**（登录验证码）；这里管**收信转发**——`xxx@ai-feeds.com` 收到的邮件自动转到个人 Gmail。走 CF Email Routing，MX 记录仍在 CF（未随 2026-06-02 香港中转迁走）。

**当前转发地址**（全部 → `ltsms86@gmail.com`，该 destination 已验证 2026-05-19）：

| 收件地址 | 用途 | 状态 |
|---|---|---|
| `wxmp@ai-feeds.com` | 微信公众平台等平台注册收信（2026-06-03 加） | 启用 |
| `roxor@ai-feeds.com` | 站长通用 | 启用 |
| `support@ai-feeds.com` | 用户支持 | 启用 |

> ⚠️ catch-all（未列出的地址）= **drop（丢弃，不转发）**。要新增地址必须显式加一条规则，否则发来的信直接被丢。

**加 / 删一个转发地址**：
- **推荐（手动）**：CF Dashboard → 选 `ai-feeds.com` 域 → 左侧 Email → Email Routing → Routing rules → Create address，填收件前缀 + 选 destination。`ltsms86@gmail.com` 已验证，可直接选；转到一个**没验证过的新邮箱**时 CF 会给那个邮箱发验证信，点了才生效。
- **API（claude session 用，本次即用此法）**：
  ```bash
  set -a; . .secrets/aifeeds-prod.env; set +a
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/email/routing/rules" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    --data '{"name":"forward NAME to gmail","enabled":true,"matchers":[{"type":"literal","field":"to","value":"NAME@ai-feeds.com"}],"actions":[{"type":"forward","value":["ltsms86@gmail.com"]}]}'
  ```
  > 经验：现用的 `CLOUDFLARE_API_TOKEN` 实测能管 Email Routing 规则。若哪天 token 重建后缺 Email Routing 权限导致 403，退回上面 Dashboard 手动法即可。

### 4. 运维 Token 速查（claude session 跨设备共享用）

> ⚠️ 这一节**只列 token 干啥用 / 字段名是什么 / 怎么再生**，绝不写 token 值。值在 `.secrets/aifeeds-prod.env` / `.secrets/aifeeds-staging.env`（gitignored）。
> 所有 token 都是**永不过期**的长期凭证，泄露/换设备时按下表「再生」步骤换 + 同步更新统一 `.env` 文件。

**统一 source 模式**（2026-05-16 改造后，详见 §3）：

```bash
source .secrets/aifeeds-prod.env   # 或 aifeeds-staging.env
# 之后下表所有 token 的 env var 全部就位，wrangler / curl / gh cli 直接用
```

| Token (env var 名) | 用途 | 再生步骤（compromised / 换设备） |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (CF claude-ops 部署 token) | wrangler 跑所有 CF 操作（部 worker / 部 pages / 改 secret / 跑 D1 / 改 KV / 改 R2） | CF Dashboard → 头像 → My Profile → API Tokens → 找名为「claude-ops」→ Roll/Delete → Create Token → Custom token，权限：`Workers Scripts:Edit` + `Cloudflare Pages:Edit` + `D1:Edit` + `Workers KV Storage:Edit` + `Workers R2 Storage:Edit`，资源：本账号，TTL：永不过期。Roll 后同步更新 `aifeeds-prod.env` + `aifeeds-staging.env` 的 `CLOUDFLARE_API_TOKEN` 字段 |
| `CF_OPS_API_TOKEN` + `CF_ACCOUNT_ID` + `CF_ZONE_ID` + `CF_ZONE_AIFEEDS_COM` (CF master) | 管理 CF 账号本身（创建别的子 token / 看账户级元信息）— **不带具体资源 Edit 权限**，做不了 wrangler 操作。日常 RUM / AI Gateway / WAF / Bot Mgmt 等 API 操作的子 token 都从这里创建 | CF Dashboard → 头像 → My Profile → API Tokens → 找现有 master token → Roll/Delete。Roll 后同步 `aifeeds-prod.env` 的 `CF_OPS_API_TOKEN` 字段（staging 文件不含此字段） |
| `GITHUB_TOKEN` (GitHub PAT claude-ops) | 创建/管理 GitHub 私有仓 + 跑 GH Actions workflow + worker 调 GH trending API | github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → 找「claude-ops」→ Regenerate / Delete → Generate new token (classic)，scope：`repo` + `workflow`，过期：No expiration。Roll 后同步 `aifeeds-prod.env` + `aifeeds-staging.env` |
| `INGEST_TOKEN` (prod worker `/api/ingest` + `/api/admin/*` 鉴权) | scrapers / 运维脚本 push 数据到 prod worker / 触发 admin endpoint | wrangler 改：`source .secrets/aifeeds-prod.env && printf '%s' "$INGEST_TOKEN" \| (cd worker && npx wrangler secret put INGEST_TOKEN)`（生成新值用 `openssl rand -hex 32`，**同时**改 `aifeeds-prod.env` 字段值；改这个会断所有依赖它的 scraper / 脚本，需要同步更新） |
| `INGEST_TOKEN` (staging) | 同上，给 staging | wrangler 改：`source .secrets/aifeeds-staging.env && printf '%s' "$INGEST_TOKEN" \| (cd worker && npx wrangler secret put INGEST_TOKEN --env staging)`，**同时**改 `aifeeds-staging.env` 字段值 |
| `ADMIN_USER` + `ADMIN_PASS` (admin Basic Auth **fallback**，CF Access 上线后非主路径) | 应急通道：删 `CF_ACCESS_AUD` secret 后 worker 自动回落到 Basic Auth；正常场景由 CF Access JWT 接管 | 改：`source aifeeds-prod.env && printf '%s' "$ADMIN_PASS" \| (cd worker && npx wrangler secret put ADMIN_PASS)`；同时更新 `aifeeds-prod.env` + `aifeeds-staging.env`（prod / staging 共用同值）。**CF Access 稳定 1 周后可考虑删除这对 secret + 删 fallback 代码** |
| `CF_ACCESS_AUD` (CF Access Application Audience tag，每环境独立) | admin 入口主鉴权。worker 通过 `Cf-Access-Jwt-Assertion` 头校验 JWT 的 `aud` 字段匹配此值 | CF Dashboard → Zero Trust → Access → Applications → 选 app → Additional settings → AUD tag → Revoke existing tokens（旧 token 全失效）→ 复制新 AUD → `npx wrangler secret put CF_ACCESS_AUD [--env staging]` |
| `DEV_TOKEN` (worker bot UA gate 的 BE/OPS CLI bypass header，prod / staging 各独立) | BE/OPS curl smoke 测 admin/write endpoint 时绕 PR #52 bot gate（curl/python-requests UA 默认被拦） | `openssl rand -hex 32` → 同步更新 `.secrets/aifeeds-{prod,staging}.env` 的 `DEV_TOKEN` → `source` 后 `printf '%s' "$DEV_TOKEN" \| (cd worker && npx wrangler secret put DEV_TOKEN [--env staging])` |
| `DEEPSEEK_API_KEY` | DeepSeek LLM 调用（分类 / 翻译 / AI 摘要） | https://platform.deepseek.com/api_keys → 删旧 key → 新建 → 同步 `aifeeds-prod.env` + `aifeeds-staging.env` |
| `SCRAPEBADGER_API_KEY` | X 抓取 + refresh-metrics | https://scrapebadger.com 后台 → rotate → 同步两份 .env |
| `TURNSTILE_SECRET_KEY` | 前端验证码后端校验 | CF Dashboard → Turnstile → ai-feeds.com site → Rotate secret → 同步两份 .env |
| `PUSHDEER_ADMIN_KEYS` | 告警推送（多个 key 逗号分隔） | PushDeer app → 设备页 → device key → 同步两份 .env |
| `RESEND_API_KEY` | Email 验证码 sender | https://resend.com/api-keys → Revoke + Create → 同步两份 .env |
| `PH_CLIENT_ID` + `PH_CLIENT_SECRET` | Product Hunt GraphQL OAuth | https://www.producthunt.com/v2/oauth/applications → Regenerate Secret（client_id 不变）→ 同步两份 .env |
| `SMS_PROVIDER` | SMS 通道选择，字面量 `pushdeer` 或 `tencent` | 备案前固定 `pushdeer`；备案后切 `tencent` + 加 5 个 `TENCENT_SMS_*` |
| `RSSHUB_TOKEN`（配 var `RSSHUB_BASE`） | 拉小宇宙中文播客的自托管 RSSHub（HK VPS，Codex 运维）鉴权头 `X-RSSHub-Token`；prod + staging 共用同一实例 + 同一 token | Codex 在 HK VPS `/etc/rsshub/rsshub_token` 生成 → 私密渠道给 aifeeds → 同步两份 .env → `printf '%s' "$RSSHUB_TOKEN" \| (cd worker && npx wrangler secret put RSSHUB_TOKEN [--env staging])`。`RSSHUB_BASE=https://rss.ai-feeds.com` 在 wrangler.toml `[vars]` + `[env.staging.vars]`（非 secret，明文版本控制）|
| `WEIBO_COOKIES` | 微博科技热搜源 `blog:weibo-hot-tech` 的登录 cookie；Worker 通过 `X-Weibo-Cookie` 转发给 HK RSSHub `/weibo/hot/tech`，VPS 不落盘 | 唯一文件源：`/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env` 的 `WEIBO_COOKIES`。cookie 含分号，必须写成 `WEIBO_COOKIES='...'`，否则 `source` 会截断。更新后执行：`set -a; . .secrets/aifeeds-prod.env; set +a; printf '%s' "$WEIBO_COOKIES" \| (cd worker && npx wrangler secret put WEIBO_COOKIES)`；缺失/失效会触发 PushDeer「微博 Cookie 失效」告警 |

**约定**：
- 任何**新增 secret** 加到 `.secrets/aifeeds-prod.env` + `.secrets/aifeeds-staging.env`（如 staging 也用），用 env 变量名匹配工具默认（`CLOUDFLARE_API_TOKEN` / `GITHUB_TOKEN` 等），调用方 `source` 一下即可
- **禁止**再建散落 `.env` 文件存 secret（aifeeds CLAUDE.md「身份卡」强制约定）
- `.secrets/` 已 gitignored，不会进 git；CI 跑 gitleaks 把关
- 文档里**只引用文件路径 + env var 名，不引用值**；提交 PR 时 review 务必检查无 token 字面量
- rotation 三处同步：`.secrets/aifeeds-{prod,staging}.env` + 远端 wrangler secret + 1Password / 密码管理器

### 5. Pages: `xlist-dashboard`

- **公网地址**：
  - 自定义域：`https://ai-feeds.com` / `https://www.ai-feeds.com`（主入口）
  - 默认域：`https://xlist-dashboard.pages.dev`（仍可用）
- **源码**：`dashboard/`
- **API base**：`dashboard/src/api.ts` 默认指向 `https://api.ai-feeds.com`（可用 `VITE_API_BASE` 覆盖）
- **部署命令**：`cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard`

#### 5a. 首页经典版/瀑布版 SSR 并行（2026-07-18，生产已上线、经典版默认）

- 当前状态：代码已合入 `main` `7c660e7ea31b367f66fadb6956273b3c54a76656`。生产 Worker
  version 为 `0d0e09e6-63c6-4d0d-a1c7-bce45f615ebb`；生产 Pages deployment 为
  `https://5ef13c30.xlist-dashboard.pages.dev`（source `6b981b2`；其后 `7c660e7` 只改 Worker，
  Dashboard artifact 不变）。默认匿名访问仍返回经典版，瀑布版只由显式 query/cookie opt-in。
- 经典入口：`index.html` / `main.tsx`；瀑布入口：`waterfall.html` / `waterfall-main.tsx`，两者独立下载。
- Pages Function 只覆盖 `/`、既有详情深链与 `/_home/feed`；静态资源、搜索、设置、auth、daily 与 API
  不进入 SSR runtime。
- `HOME_EXPERIENCE_ENABLED` 只有精确字符串 `true` 才启用；缺失、大小写错误或其它值都 fail-closed。
- 启用后默认仍为经典版；有效 `?view=classic|waterfall` 覆盖本次请求，之后由
  `aifeeds_view=classic|waterfall` 的 `Secure; SameSite=Lax` cookie 保持偏好。
- Pages `HOME_API` Service Binding 只调用 Worker `/api/home-feed`；两端
  `HOME_RENDERER_TOKEN` 必须同值且仅允许该 GET 路径豁免 origin gate。
- 仅无 query、无登录 cookie 的匿名根路径共享 public waterfall 快照。Cache API 对象保留 24 小时：
  `age <= 60s` 直接返回 fresh；`60s < age <= 10min` 立即返回 stale 并用 `waitUntil()` 后台刷新；
  同一 isolate/PoP 刷新 single-flight；刷新失败保留最后好快照；超过 10 分钟刷新失败则 classic fail-open。
  Cache API 是 PoP-local，外部预热不能当成全局正确性依赖。
- Vite 先保留 `waterfall.html` 的 identity 槽；构建完成后，stamper 把槽归一并对整个 `dist`
  artifact graph（路径、HTML 与哈希资源内容）做确定性 SHA-256，再写入唯一的
  `aifeeds-build-id`。Cache key 同时包含该 final-artifact identity 与请求 hostname；因此同一 commit
  的 external/same-origin 或其它 mode/env 产物也不会复用旧 HTML。独立 verifier 会归一 identity
  槽并复算整个 artifact graph，值不匹配、placeholder 残留、缺失或非法时构建失败；运行时仍直接
  classic fail-open。相同 artifact 重复构建必须得到相同 identity，回滚到同一 artifact 也回到同一 namespace。
- binding、API、模板、JSON 或 renderer 任一异常都清瀑布 cookie 并返回经典首页；
  `X-AIFeeds-Home-SSR` 标记 `disabled|classic|waterfall|waterfall-cache|waterfall-stale|feed|fallback|pass`；
  cache hit 另带 `X-AIFeeds-Home-Freshness: fresh|stale` 与有界秒数
  `X-AIFeeds-Home-Age`。前端性能事件携带有限 `ssr_state=classic|generated|fresh|stale|fallback`，
  Worker 对缺失/伪造值统一收敛为 `classic`。
- kill switch：移除 `HOME_EXPERIENCE_ENABLED` 或改为非 `true` 值。关闭后必须再验证 query/cookie
  均回经典版且 `/_home/feed` 不开放。
- 没有 D1 migration；回滚仍须按顺序关 flag、回退 Pages deployment、回退 Worker version、
  恢复 bindings/secrets，不能只停在“flag 已关”。
- 生产回滚点：Pages `a359d6ff-9b91-4a0f-a130-abf55537d5cc`；Worker
  `244711bd-28c4-4545-a6cb-a0f857916ea4`（瀑布发布前），或仅回退 cursor hotfix 时使用
  `a37ef6a6-b926-4cbe-8f0d-3cdf12e4bbd5`。香港 nginx 备份为
  `/etc/nginx/sites-available/aifeeds.conf.bak-waterfall-20260718T075759Z-2c50e77c`；安装后配置 SHA-256
  `0446c7076e8ca1dfdf1e591e74dd6a559a9599791fd2659589edba80f36c2214`。
- nginx 对无 query/cookie 的默认匿名首页继续使用经典缓存；`?view=classic|waterfall`、
  `aifeeds_view` cookie、session/auth cookie 均 `BYPASS`，禁止 cohort 之间共享 nginx body。
- staging 执行记录：
  [`reviews/waterfall-ssr-staging-change-packet.md`](reviews/waterfall-ssr-staging-change-packet.md)。
  生产发布证据：
  [`reviews/2026-07-18-waterfall-ssr-production-release.md`](reviews/2026-07-18-waterfall-ssr-production-release.md)。
  RUM 作为上线后观察，不阻塞 staging、生产 opt-in canary 或代码交付。
- 双视图 benchmark 的 `?view=` 只校验目标 cohort；实际测量写有限 `aifeeds_view` cookie 后访问
  canonical `/`，从而覆盖真实 opt-in 用户的 SWR 路径。报告逐样本记录 DOM `ssr_state`、
  SSR/freshness header 与 age；浏览器 warm 和 edge fresh 必须分开解释。
- 瀑布流视觉/混排 v2 候选保持相同 classic-default/opt-in 边界：移动端双列，PC 3–6 列，无侧栏和
  分类 Tab。Pages 的 HOME_API 请求用 `X-Home-Ranking-Version: 2` 显式协商；新 Worker 对没有该
  头的旧 Pages 只返回显式 v1/原八源；旧 Worker 会忽略该头且省略 `ranking_version`，新 Pages
  仅把该字段缺失归一为 legacy v1，同时拒绝其它非法版本。因此 Pages/Worker 并发发布和任一侧
  回滚都不会把 YouTube 交给旧 renderer。cursor version 永远优先于协商头，旧页面携带的 v1
  cursor 继续按原八源排序翻页。v2 在固定 `asOf` 下使用隐藏内容家族、来源内年龄归一热度和稳定
  keyset，并加入 live YouTube。设备曝光历史目前只上报有限枚举的 shadow decision，不删除、
  不重排 SSR 或 hydrated DOM；正式个性化过滤必须另开 feature flag 和发布计划。
- 视觉/混排 v2 staging 已在源码 `7327fba5e687a7bcf664dea3ce7ef9c333a8aeb3` 通过：
  Pages `7faca6bb-a1df-42e4-8015-e5eebb8c949d`、Worker
  `f4ee4d50-05f8-4304-88e4-697e1b1f3255`；滚动兼容矩阵、v1/v2 cursor、九源临时 fixture、
  清理后 `fixture_count=0`、五设备 `20/20` 均通过。10-run 性能门中 waterfall 相对 classic
  的 desktop/mobile cold LCP p75 均改善 `16.9%`，warm 回归仅 `2.7%`/`1.4%`，CLS p75 `0`。
  主 PR #195 已合入 `main` `2c8bbe016853d47b9e562368eaff3d9ee7c790c9`，生产 Worker
  `503a8fb9-b089-4e90-a01c-31e4853d653c`。
- 生产即时门发现无 cookie 的 `?view=waterfall` 虽能 SSR，但续页 `/_home/feed` 因 query 偏好
  未持久化而返回 404；cookie 用户不受影响。hotfix #196 只对有效且实际渲染一致的 view query
  写有限 cookie，无效值不持久化、fallback 仍清 cookie。hotfix staging Pages
  `e32effce-3437-45b2-a001-9d14769701f4` 五设备 `20/20` 后合入 `main`
  `7a6deaa9e4c61f980362e3d9d8c0a8877e7970d0`；最终生产 Pages
  `57243fcc-5dee-4998-b2b4-a35012a597e7` 五设备 `20/20`。默认首页仍为 classic，瀑布只 opt-in，
  曝光仍 shadow-only；RUM 是非阻塞上线后观察项。
- 外部合成观测：`.github/workflows/sitespeed-external.yml` 只在隔离 feature branch 新增该文件时
  自动运行，也保留手动入口；GitHub 托管 runner 对生产首页执行移动/桌面各 5 次只读导航，只上传
  14 天 artifact。workflow 固定 `contents: read`、不读取 secret、不包含部署或远端管理命令，不能替代
  真实用户 RUM，只用于并行定位网络瀑布、资源体积与实验室指标。
- 禁止在未下载/审阅远端 Pages 配置前新增 production Wrangler Pages 配置；一旦存在，该文件会成为
  Pages 项目配置事实源，可能覆盖 Dashboard 中已有 bindings/variables。

### 6. 自定义域名与 DNS

域名：`ai-feeds.com`（CF 注册 + 托管）

> ⚠️ **2026-06-02 起，前端 / www / api / fonts 改走香港 VPS 中转加速**（绕开 CF 中国无节点的慢，详见下方 §6b）。下表为当前真实状态。

| 记录 | Name | Target | Proxy | 作用 |
|------|------|--------|-------|------|
| A | `ai-feeds.com`（@） | `154.12.188.231`（香港 VPS） | 🔘 DNS only | 主站（VPS 反代 → Pages） |
| A | `www` | `154.12.188.231` | 🔘 DNS only | www（VPS 反代 → Pages） |
| A | `api` | `154.12.188.231` | 🔘 DNS only | API（VPS 反代 → Worker） |
| A | `fonts` | `154.12.188.231` | 🔘 DNS only | 字体（VPS 反代 → R2） |
| CNAME | `staging` / `staging-api` | CF Pages / Worker | ✅ Proxied | staging（未走香港） |
| AAAA | `blog` | Worker `roxor-blog` | ✅ Proxied | blog（未走香港） |
| MX×3 + TXT | `ai-feeds.com` / `mail.*` | CF Email Routing + Resend/SES | — | 邮件（未动） |

**注意**：走香港的 4 条是**灰云 A 记录（DNS only，直连 VPS）** —— 这部分流量不经 CF 边缘，**不再享受 CF WAF / 缓存 / DDoS**（由香港 VPS 自己扛）。staging / 邮件仍走 CF 橙云。完整架构 + 回滚见 §6b。

### 6a. R2 bucket: `ai-feeds-fonts`（2026-05-11 上线）

- **挂载域**：`fonts.ai-feeds.com`（R2 → Custom Domains 绑定，min-TLS 1.2）
- **CORS**：允许 `https://ai-feeds.com` / `https://www.ai-feeds.com` / `https://staging.ai-feeds.com` / `http://localhost:5173` / `http://localhost:4173` 的 GET / HEAD;Max-Age 86400。**注意 `www.` 子域必须单独列**(R2 CORS allowed_origins 是精确字符串匹配,不支持 wildcard 子域),否则 `https://www.ai-feeds.com` 访问字体会被拦,fallback 到系统默认(2026-05-19 PM 反馈 console 80+ CORS errors 即此因,修复用 `wrangler r2 bucket cors set ai-feeds-fonts --file cors.json` + CF Dashboard 手动 purge `fonts.ai-feeds.com` cache,否则 4h 内仍命中旧 cached response 没 ACAO 头)
- **内容**：HarmonyOS Sans SC Regular(400) / Medium(500) / Bold(700) 三档，每档用 `cn-font-split@5.0.0` 按 unicode-range 子集化为 ~87 个 woff2 + 一份 result.css。共 263 个文件，bucket 总大小 ~15 MB。单页实际只下 ≈ 200 KB
- **目录结构**：`hmos-regular/` + `hmos-medium/` + `hmos-bold/`，CSS 用相对路径 `url("./xxx.woff2")` 引用同目录 woff2
- **CSS 引入**：dashboard 通过 `<link rel="stylesheet" href="https://fonts.ai-feeds.com/hmos-{regular,medium,bold}/result.css">` 三次引入
- **重新生成字体子集化**（升级华为字体 / 调整子集策略时用）：
  ```bash
  # 原始 ttf 来源（华为官方需登录，社区镜像有现成）
  curl -L -o HarmonyOS_SansSC_<Weight>.ttf \
    "https://raw.githubusercontent.com/SunsetMkt/HarmonyOS_Sans_SC_Webfont_Splitted/main/HarmonyOS_Sans_SC/HarmonyOS_SansSC_<Weight>.ttf"
  # Weight ∈ {Regular, Medium, Bold}

  # cn-font-split 7.x 在 Node 25 因 koffi FFI 挂；用 5.0.0（pure napi，稳）
  npx -y cn-font-split@5.0.0 -i "$(pwd)/HarmonyOS_SansSC_Regular.ttf" -o "$(pwd)/hmos-regular"
  # Medium 输出的 css family 名带 "Medium" 后缀且 weight=400，需 sed 修：
  sed -i.bak 's|"HarmonyOS Sans SC Medium"|"HarmonyOS Sans SC"|g; s|font-weight: 400|font-weight: 500|g; ' hmos-medium/result.css
  # local() 改回精确名（保护本地 Medium 字体优先）：
  sed -i.bak 's|src:local("HarmonyOS Sans SC"),|src:local("HarmonyOS Sans SC Medium"),|g' hmos-medium/result.css

  # ⚠️ 2026-06-11:字体改 font-display: optional(品牌字体非必须,不让它阻塞/拖慢加载)。
  # cn-font-split 默认输出 swap → 慢网首屏会等 ~38 个 woff2(实测把 load 拖到 12-15s)。
  # optional = 首屏直接用系统苹方(几乎一模一样)秒出,字体后台下载缓存,回访才用品牌字;
  # 慢网则跳过下载下次再说。重新 split 后必须对三份 result.css 都跑这条 sed:
  for d in hmos-regular hmos-medium hmos-bold; do sed -i.bak 's/font-display: swap/font-display: optional/g' $d/result.css; done
  # 改完 result.css 上传后,记得清香港 VPS 缓存让它重拉:
  #   ssh -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 'rm -rf /var/cache/nginx/aifeeds/* && systemctl reload nginx'

  # 上传（wrangler 4.x 默认走 local R2 stub，必须加 --remote）
  source .secrets/aifeeds-prod.env
  find hmos-regular hmos-medium hmos-bold -name '*.woff2' | xargs -n 1 -P 8 -I {} \
    wrangler r2 object put "ai-feeds-fonts/{}" --file {} --content-type "font/woff2" --remote
  for d in hmos-regular hmos-medium hmos-bold; do
    wrangler r2 object put "ai-feeds-fonts/$d/result.css" --file $d/result.css \
      --content-type "text/css; charset=utf-8" --remote
  done
  ```
- **CORS 调整**：编辑 `cors.json`（rules → allowed.origins / methods / headers），`wrangler r2 bucket cors set ai-feeds-fonts --file cors.json`

### 6b. 香港中转加速（2026-06-02 上线）

**背景**：CF 免费版在中国无境内节点，给大陆用户分美/日节点，慢（itdog 实测全国平均 1.46s，电信晚高峰常 >10s）。RUM 时段分析显示真实用户大头按北京作息活动（挂梯子使 IP 显示美国，掩盖了真实占比）。

**方案**：香港 VPS 跑 nginx 反向代理；`ai-feeds.com` / `www` / `api` / `fonts` 的 DNS 改成灰云 A 记录直连 VPS，VPS 再反代回 CF 源。**所有用户（含海外）都走香港** —— 真·地域分流（大陆走港、海外走 CF）对 CF Pages 架构做不干净（DNS 搬离 CF 后 CF 边缘不认 host，海外反而挂），且真实海外用户少，故取此简化方案。

**实测效果**（itdog，切换前→后，全国平均）：1.46s → 0.87s（快 40%）；电信 1.52→0.52（快 3 倍）；移动 1.45→0.79（快 2 倍）；联通基本持平（买的 EB 线路偏移动/联通 CMI，电信反而最受益）。

**架构**：

```
用户 → ai-feeds.com / www / api / fonts  (灰云 A → 香港VPS 154.12.188.231)
     → nginx 反代:
        ├ 前端 → https://xlist-dashboard.pages.dev                       (Host: pages.dev)
        ├ api  → https://xlist-api.ltsms86.workers.dev                   (Host: workers.dev + X-Forwarded-Host: api.ai-feeds.com)
        └ fonts→ https://pub-552cb27a652c4fde908550439112c814.r2.dev     (Host: r2.dev)
未动（仍走 CF 橙云）：邮件 MX / Email Routing、staging / staging-api、blog
```

**VPS**：DMIT `HKG.AS3.EB.TINYv2`（CN2/CMI 优化线路，月付）。Ubuntu 24.04，**1 核 / 1G / 磁盘 20G**。IP `154.12.188.231`。SSH `ssh -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231`（备用 key `~/.ssh/aifeeds_hk`）。配置文件：反代 `/etc/nginx/sites-available/aifeeds.conf`（原始备份 `aifeeds.conf.bak-20260602-063922`）、缓存 / 限流区 `/etc/nginx/conf.d/aifeeds-perf.conf`、fail2ban `/etc/fail2ban/jail.local`。TLS 用 Let's Encrypt（certbot 自动续期）。

<!-- aifeeds-performance-log:start -->
#### 上游分段性能日志（2026-07-15，GL-a / GL-b 修订版，最近一次生产尝试已自动回滚）

**状态与根因**：本次提交版本化 performance log、logrotate、专用 systemd timer、三个安全检查器、
事务安装器和本运行手册。首次 GL-a operation `20260714011642-a33e7d4d` 在 production 缺少
`/usr/sbin/logrotate` 时已进入 `mutation_started`，自动回滚又因旧 helper 不理解“已初始化但尚未发布的
rotation-state candidate”而停在 `rollback_failed(failed_from=prepared)`。live site 仍是 base、Nginx/front/API
健康、全局 `logrotate.timer` 未启用；在旧事务生成 committed exceptional receipt 前，installer 必须持续
返回 `recovery_required`，不得创建新 operation。2026-07-12 的受限只读复核还确认：

- 生效入口是 `/etc/nginx/sites-enabled/aifeeds.conf`，精确指向
  `/etc/nginx/sites-available/aifeeds.conf`；front/API/fonts 共 7 个直接 `proxy_pass`；
- 目标 site 的 `access_log_directives=0`、`include_count=4`；四条 include 均为
  `/etc/letsencrypt/options-ssl-nginx.conf`，该文件内 access_log/proxy_pass/request-id 均为 0；
- 生产和 staging API 均尚未回显 `X-Request-Id`、`Server-Timing`、`Timing-Allow-Origin`。实现只在
  当前未发布分支，不能要求 GL 在 Worker 部署前完成响应头 join；
- VPS 20 GB 磁盘剩余约 11.8 GB；现有 access log 自 2026-06-02 起累计约 190 MB/73 万行；
  `logrotate.timer` 未启用、cron 未运行且没有 logrotate 状态文件，单放一份 logrotate 配置不会自动执行。

2026-07-15 已用 exceptional authority/receipt 完成旧事务终态对账。后续 operation
`20260715165904-2d2f27fe` 完成 site 精确七行变更、三次 front/API 200 probe 与 JSON schema 写入，但生产
`upstream_cache_status=HIT` 的 front 行把 `upstream_connect_time`、`upstream_header_time`、
`upstream_response_time` 记录为 `""`，而旧 validator 只接受数字或 `"-"`，因此安全触发自动回滚。
终态 source/rollback 均为 `rolled_back`，14/14 runtime cleanup 完成，site、nginx 与 timer 均恢复，运行时和
candidate 残留为 0。修订后的 validator 只在缓存命中类状态接受空串；非缓存 front 和 API 仍要求数字 timing。

因此 Task 3 被拆成两个可证明的 gate：

- **GL-a（production VPS/nginx 写）**：安装 JSONL、同层 upstream request-id header、64 KiB/5 秒日志缓冲、
  专用五分钟 timer；验证唯一 probe、字段 schema、精确 2xx、强制轮转后新 inode 继续收日志。GL-a 不要求
  尚未上线的 Worker 回显。
- **GL-b（G1 + G7b 后远端只读）**：在 `perf-staging.ai-feeds.com` 上验证 staging Worker 回显与
  nginx/Worker request-id join；五设备 browser 扩展属于 G8 的 10.1c。不得把 Worker join 伪装成 GL-a 已通过，
  也不得为通过 GL-a
  提前部署生产 Worker或由 nginx 伪造响应头。

VPS 上没有 `staging.ai-feeds.com` / `staging-api.ai-feeds.com` server block，它们不经过香港 VPS。
GL-b 只能在隔离 perf-staging 拓扑形成后执行。

**依赖硬门禁**：任何新 GL-a 写操作前，必须先证明 `jq` 可执行，并证明 `/usr/sbin/logrotate` 是
非 symlink、非空、`root:root 0755` 的 regular file。依赖检查位于新 journal/backup/candidate 首次写入前；
缺失或 metadata 不符统一以 rc 69 和
`ERROR dependency=logrotate path=/usr/sbin/logrotate` 停止。只启用本项目的
`aifeeds-performance-logrotate.timer`；系统全局 `logrotate.timer` 必须保持 inactive/disabled，安装依赖不得
把它作为附带动作启用。

**配置与隐私**：`deploy/nginx/aifeeds-performance-log.conf` 安装到
`/etc/nginx/conf.d/aifeeds-performance-log.conf`，只含 http-context 合法的 `map`、`log_format` 和条件日志：

```nginx
access_log /var/log/nginx/aifeeds-performance.jsonl aifeeds_performance buffer=64k flush=5s if=$aifeeds_performance_loggable;
```

host map 只允许 `ai-feeds.com`、`api.ai-feeds.com`、`fonts.ai-feeds.com` 和未来的
`perf-staging.ai-feeds.com`。安全 URI map 只保留固定 route bucket；item id、资源 key、分享 token 和
任何未知路径都归一化为 `:id`、`:asset`、`:token` 或 `/:other`。原始 User-Agent 也不落盘，只映射为
`bot/iphone/ipad/android/desktop/other`。因此日志不含客户端可控 path/UA 原文、query、Cookie、
Authorization、referer、回源密钥、手机号或邮箱。`X-Aifeeds-Perf-Probe` 只有严格匹配
`upstream-<10~16 位时间戳>-<8 位十六进制>` 才进入日志。粗粒度 client class 仍按受限运维数据处理，
文件固定为 `0640 www-data:adm`，每日轮转、`maxsize 50M`、保留 14 份；专用 timer 每五分钟检查，
root、`adm` 组运维人员与文件 owner `www-data` 服务账号也可读，其他系统账号不可读；不会启用会
影响其他服务的全局 logrotate timer。规则安装到 `/etc/aifeeds-performance-logrotate.conf`，刻意避开
全局 `/etc/logrotate.d` include，防止全局与专用 timer 使用不同 state 对同一日志并发轮转。安装前还
硬性要求 `/var/log/nginx` 至少有 5 GiB 可用空间和 10 万个可用 inode；两项数值写入 summary。

每个含直接 `proxy_pass` 的 location 必须在原有同层 headers 旁新增且仅新增：

```nginx
proxy_set_header X-Request-Id $request_id;
```

版本化工具分别证明：插入前没有该 header、proxy 总数精确为 7、四条 include 只有已复核 Certbot 文件、
server/location 没有低层 `access_log`、每个 proxy location 恰有一个合法 header，以及 candidate 相对
backup 的唯一变化就是 7 行 header。结构检查器安装为
`/usr/local/sbin/aifeeds-check-nginx-request-id`；任何一项不符都在 reload 前停止。

安装器在读取远端状态前先持有固定 root-owned `/run/aifeeds-performance-log.lock`，执行非阻塞
`flock -n 9`；
并发执行、误双击或 SSH 重试只能有一个进入，另一个以 `deployment_lock=busy` 停止。logrotate service
使用 `StateDirectory=aifeeds-performance-logrotate`，状态位于
`/var/lib/aifeeds-performance-logrotate/status`；必须实际 `systemctl start` 一次 service 并验证
`Result=success` 与非空 state，不能只看 timer 显示 active。
随后用稀疏 `truncate` 把测试 base log 提升到刚超过 50 MiB，再由同一个受 sandbox 约束的 service 实际
完成一次 maxsize rotation；必须验证 inode 改变和新的 `systemd_rotation_probe` 写入，避免只证明 state
文件可创建却没证明 `ProtectSystem`/`ReadWritePaths` 下能 rename、USR1 与 reopen。

**GL-a 部署（修订后必须重新取得单独批准）**：从 clean G0 commit 创建私有包并生成 Linux 可校验的
manifest。批准记录必须同时写明低流量执行窗口、实际执行人、独立 rollback owner，以及
`rollback_failed` 时升级的 on-call 联系人；任一空缺都不执行。不得使用固定 `/tmp` 文件名：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
G0_COMMIT="$(cat "$EVIDENCE/commit.txt")"
test "$G0_COMMIT" = "$(git rev-parse HEAD)"
printf '%s' "$G0_COMMIT" | grep -Eq '^[a-f0-9]{40}$'
test -z "$(git status --porcelain)"
cd "$REPO_ROOT"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
publish_local_file_no_replace() {
  local source=$1 destination=$2 expected_dev=$3 expected_ino=$4
  test "$(dirname "$source")" = "$(dirname "$destination")"
  python3 - "$source" "$destination" "$expected_dev" "$expected_ino" <<'PY'
import ctypes
import os
import stat
import sys

source, destination = map(os.fsencode, sys.argv[1:3])
expected_dev, expected_ino = map(int, sys.argv[3:])
before = os.lstat(source)
if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
    raise RuntimeError("local evidence source identity changed")
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    RENAME_EXCL = 0x00000004
    renamex_np = libc.renamex_np
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    result = renamex_np(source, destination, RENAME_EXCL)
elif sys.platform.startswith("linux"):
    AT_FDCWD = -100
    RENAME_NOREPLACE = 1
    renameat2 = libc.renameat2
    renameat2.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE)
else:
    raise SystemExit(f"unsupported no-replace rename platform: {sys.platform}")
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(destination))
after = os.lstat(destination)
if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
    raise RuntimeError("published local evidence identity changed")
parent_fd = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
}
remove_owned_local_tmp() {
  local path=$1 expected_dev=$2 expected_ino=$3
  python3 - "$path" "$expected_dev" "$expected_ino" <<'PY'
import os
import stat
import sys

path, expected_dev, expected_ino = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
except FileNotFoundError:
    raise SystemExit(0)
try:
    value = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("local evidence tmp is not regular")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("local evidence tmp descriptor identity changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("local evidence tmp pathname identity changed")
finally:
    os.close(descriptor)
os.unlink(path)
parent_fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
}
OPERATION_ID_FILE="$EVIDENCE/gl-a-operation-id.txt"
if [ ! -e "$OPERATION_ID_FILE" ] && [ ! -L "$OPERATION_ID_FILE" ]; then
  OPERATION_ID_TMP="$(mktemp "$EVIDENCE/.gl-a-operation-id.XXXXXX")"
  printf '%s\n' "$(date +%Y%m%d%H%M%S)-$(openssl rand -hex 4)" > "$OPERATION_ID_TMP"
  chmod 0600 "$OPERATION_ID_TMP"
  mv -f "$OPERATION_ID_TMP" "$OPERATION_ID_FILE"
fi
test -f "$OPERATION_ID_FILE"
test ! -L "$OPERATION_ID_FILE"
test "$(stat -f '%u' "$OPERATION_ID_FILE")" = "$(id -u)"
test "$(stat -f '%Lp' "$OPERATION_ID_FILE")" = 600
OPERATION_ID="$(cat "$OPERATION_ID_FILE")"
printf '%s' "$OPERATION_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
IMMUTABLE_ROLLBACK_HELPER="$EVIDENCE/gl-a-rollback-helper-${OPERATION_ID}.sh"
if [ ! -e "$IMMUTABLE_ROLLBACK_HELPER" ] && [ ! -L "$IMMUTABLE_ROLLBACK_HELPER" ]; then
  install -m 0600 deploy/nginx/rollback-aifeeds-performance-log.sh \
    "$IMMUTABLE_ROLLBACK_HELPER"
fi
test -f "$IMMUTABLE_ROLLBACK_HELPER"
test ! -L "$IMMUTABLE_ROLLBACK_HELPER"
test "$(stat -f '%u' "$IMMUTABLE_ROLLBACK_HELPER")" = "$(id -u)"
test "$(stat -f '%Lp' "$IMMUTABLE_ROLLBACK_HELPER")" = 600
cmp -s deploy/nginx/rollback-aifeeds-performance-log.sh "$IMMUTABLE_ROLLBACK_HELPER"
ROLLBACK_HELPER_SHA256="$(shasum -a 256 "$IMMUTABLE_ROLLBACK_HELPER" | awk '{print $1}')"
printf '%s' "$ROLLBACK_HELPER_SHA256" | grep -Eq '^[a-f0-9]{64}$'
UPLOAD="$(mktemp -d "$EVIDENCE/gl-a-upload.XXXXXX")"
chmod 0700 "$UPLOAD"

install -m 0600 deploy/nginx/aifeeds-performance-log.conf "$UPLOAD/"
install -m 0600 deploy/nginx/aifeeds-performance.logrotate "$UPLOAD/"
install -m 0600 deploy/nginx/check-nginx-request-id.py "$UPLOAD/"
install -m 0600 deploy/nginx/verify-nginx-request-id-diff.py "$UPLOAD/"
install -m 0600 deploy/nginx/insert-nginx-request-id.py "$UPLOAD/"
install -m 0600 deploy/nginx/install-aifeeds-performance-log.sh "$UPLOAD/"
install -m 0600 "$IMMUTABLE_ROLLBACK_HELPER" \
  "$UPLOAD/rollback-aifeeds-performance-log.sh"
install -m 0600 deploy/systemd/aifeeds-performance-logrotate.service "$UPLOAD/"
install -m 0600 deploy/systemd/aifeeds-performance-logrotate.timer "$UPLOAD/"
(
  cd "$UPLOAD"
  shasum -a 256 \
    aifeeds-performance-log.conf aifeeds-performance.logrotate \
    check-nginx-request-id.py verify-nginx-request-id-diff.py insert-nginx-request-id.py \
    install-aifeeds-performance-log.sh rollback-aifeeds-performance-log.sh \
    aifeeds-performance-logrotate.service aifeeds-performance-logrotate.timer \
    > SHA256SUMS
)

REMOTE_STAGE=''
INSTALL_OUTPUT_TMP="$(mktemp "$EVIDENCE/.gl-a-install-summary.XXXXXX")"
INSTALL_OUTPUT_FINAL="$EVIDENCE/gl-a-install-output-${OPERATION_ID}.txt"
INSTALL_OUTPUT_TMP_DEV="$(stat -f '%d' "$INSTALL_OUTPUT_TMP")"
INSTALL_OUTPUT_TMP_INO="$(stat -f '%i' "$INSTALL_OUTPUT_TMP")"
INSTALL_OUTPUT_PUBLISH_ATTEMPTED=0
LOCAL_SUMMARY_TMP="$(mktemp "$EVIDENCE/.gl-a-summary.XXXXXX")"
LOCAL_SUMMARY_FINAL="$EVIDENCE/gl-a-summary.json"
LOCAL_SUMMARY_TMP_DEV="$(stat -f '%d' "$LOCAL_SUMMARY_TMP")"
LOCAL_SUMMARY_TMP_INO="$(stat -f '%i' "$LOCAL_SUMMARY_TMP")"
LOCAL_SUMMARY_PUBLISH_ATTEMPTED=0
cleanup_remote_stage_best_effort() {
  if [ -n "$INSTALL_OUTPUT_TMP" ]; then
    if [ "$INSTALL_OUTPUT_PUBLISH_ATTEMPTED" = 1 ]; then
      printf 'install transcript publish collision; preserved owned tmp and unknown destination: %s %s\n' \
        "$INSTALL_OUTPUT_TMP" "$INSTALL_OUTPUT_FINAL" >&2
    else
      remove_owned_local_tmp "$INSTALL_OUTPUT_TMP" "$INSTALL_OUTPUT_TMP_DEV" \
        "$INSTALL_OUTPUT_TMP_INO" || printf 'preserved unowned install transcript tmp: %s\n' \
        "$INSTALL_OUTPUT_TMP" >&2
    fi
  fi
  if [ -n "$LOCAL_SUMMARY_TMP" ]; then
    if [ "$LOCAL_SUMMARY_PUBLISH_ATTEMPTED" = 1 ]; then
      printf 'forward summary publish collision; preserved owned tmp and unknown destination: %s %s\n' \
        "$LOCAL_SUMMARY_TMP" "$LOCAL_SUMMARY_FINAL" >&2
    else
      remove_owned_local_tmp "$LOCAL_SUMMARY_TMP" "$LOCAL_SUMMARY_TMP_DEV" \
        "$LOCAL_SUMMARY_TMP_INO" || printf 'preserved unowned forward summary tmp: %s\n' \
        "$LOCAL_SUMMARY_TMP" >&2
    fi
  fi
  case "$REMOTE_STAGE" in
    /run/aifeeds-performance-log.*)
      ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
        "rm -rf -- '$REMOTE_STAGE'" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup_remote_stage_best_effort EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
REMOTE_STAGE="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  'set -eu; umask 077; stage=$(mktemp -d /run/aifeeds-performance-log.XXXXXX); chmod 0700 "$stage"; printf "%s\n" "$stage"')"
case "$REMOTE_STAGE" in /run/aifeeds-performance-log.*) ;; *) exit 1 ;; esac
scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem "$UPLOAD"/* \
  root@154.12.188.231:"$REMOTE_STAGE/"
set +e
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "cd '$REMOTE_STAGE' && sha256sum -c SHA256SUMS && \
   timeout --signal=TERM --kill-after=30s 10m bash install-aifeeds-performance-log.sh \
     '$REMOTE_STAGE' '$OPERATION_ID' '$G0_COMMIT'" 2>&1 \
  | tee "$INSTALL_OUTPUT_TMP"
PIPE_RESULTS=("${PIPESTATUS[@]}")
set -e
test "${#PIPE_RESULTS[@]}" -eq 2
INSTALL_SSH_RC="${PIPE_RESULTS[0]}"
INSTALL_TEE_RC="${PIPE_RESULTS[1]}"
chmod 0600 "$INSTALL_OUTPUT_TMP"
INSTALL_OUTPUT_PUBLISH_ATTEMPTED=1
publish_local_file_no_replace "$INSTALL_OUTPUT_TMP" "$INSTALL_OUTPUT_FINAL" \
  "$INSTALL_OUTPUT_TMP_DEV" "$INSTALL_OUTPUT_TMP_INO"
INSTALL_OUTPUT_TMP=''
INSTALL_OUTPUT_PUBLISH_ATTEMPTED=0
if [ "$INSTALL_TEE_RC" -ne 0 ]; then exit "$INSTALL_TEE_RC"; fi
if [ "$INSTALL_SSH_RC" -ne 0 ]; then
  printf 'GL-a install failed; transcript preserved at %s\n' "$INSTALL_OUTPUT_FINAL" >&2
  exit "$INSTALL_SSH_RC"
fi
scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231:"$REMOTE_STAGE/gl-a-summary.json" "$LOCAL_SUMMARY_TMP"
chmod 0600 "$LOCAL_SUMMARY_TMP"
REMOTE_ROTATION_ANCHOR="/var/backups/aifeeds-performance-log/rotation-anchor-${OPERATION_ID}.json"
jq -e --arg operation_id "$OPERATION_ID" --arg g0_commit "$G0_COMMIT" \
  --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" '
  def positive_integer: type == "number" and . > 0 and . == floor;
  def rotation_anchor_identity_is_valid:
    .rotation_anchor_identity != null and
    ((.rotation_anchor_identity | keys | sort) ==
      ["dev","gid","ino","mode","path","sha256","size","state","uid"]) and
    .rotation_anchor_identity.state == "sealed" and
    .rotation_anchor_identity.path ==
      ("/var/backups/aifeeds-performance-log/rotation-anchor-" + $operation_id + ".json") and
    (.rotation_anchor_identity.sha256 | test("^[a-f0-9]{64}$")) and
    (.rotation_anchor_identity.size | positive_integer) and
    .rotation_anchor_identity.uid == 0 and .rotation_anchor_identity.gid == 0 and
    .rotation_anchor_identity.mode == "600" and
    (.rotation_anchor_identity.dev | positive_integer) and
    (.rotation_anchor_identity.ino | positive_integer);
  def runtime_inventory_is_valid:
    (.runtime_artifacts | type == "array") and (.runtime_artifacts | length) == 8 and
    ([.runtime_artifacts[].name] | sort) ==
      ["checker","diff_checker","format","inserter","log","rotate","service","timer"] and
    ([.runtime_artifacts[].final] | length) ==
      ([.runtime_artifacts[].final] | unique | length) and
    ([.runtime_artifacts[].candidate] | length) ==
      ([.runtime_artifacts[].candidate] | unique | length) and
    all(.runtime_artifacts[];
      (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
      (.candidate | test("[.]candidate-gl-a-" + $operation_id + "$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and (.mode | test("^[0-7]{3,4}$")) and
      (.uid | type == "number" and . >= 0 and . == floor) and
      (.gid | type == "number" and . >= 0 and . == floor) and
      (.dev | positive_integer) and (.ino | positive_integer)) and
    .runtime_artifacts_sealed == true;
  def rotation_snapshot_is_valid:
    .rotation_state_snapshot != null and
    ((.rotation_state_snapshot | keys | sort) ==
      ["generation","ledger","status","tail_record_sha256"]) and
    (.rotation_state_snapshot.generation | type == "number" and . >= 0 and . == floor) and
    (.rotation_state_snapshot.tail_record_sha256 | test("^[a-f0-9]{64}$")) and
    ((.rotation_state_snapshot.ledger | keys | sort) ==
      ["dev","gid","ino","mode","path","sha256","size","uid"]) and
    .rotation_state_snapshot.ledger.path == .rotation_state_identity.provenance.path and
    .rotation_state_snapshot.ledger.dev == .rotation_state_identity.provenance.dev and
    .rotation_state_snapshot.ledger.ino == .rotation_state_identity.provenance.ino and
    .rotation_state_snapshot.ledger.uid == .rotation_state_identity.provenance.uid and
    .rotation_state_snapshot.ledger.gid == .rotation_state_identity.provenance.gid and
    .rotation_state_snapshot.ledger.mode == .rotation_state_identity.provenance.mode and
    (.rotation_state_snapshot.ledger.sha256 | test("^[a-f0-9]{64}$")) and
    (.rotation_state_snapshot.ledger.size | positive_integer) and
    (.rotation_state_snapshot.status == null or
      (((.rotation_state_snapshot.status | keys | sort) ==
       ["dev","gid","ino","mode","path","sha256","uid"]) and
       .rotation_state_snapshot.status.path == "/var/lib/aifeeds-performance-logrotate/status" and
       (.rotation_state_snapshot.status.uid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.gid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.mode | test("^[0-7]{3,4}$")) and
       (.rotation_state_snapshot.status.sha256 | test("^[a-f0-9]{64}$")) and
       (.rotation_state_snapshot.status.dev | positive_integer) and
       (.rotation_state_snapshot.status.ino | positive_integer)));
  def rotation_identity_is_valid:
    .rotation_state_identity != null and
    ((.rotation_state_identity | keys | sort) == ["directory","files","provenance"]) and
    ((.rotation_state_identity.directory | keys | sort) ==
      ["candidate","dev","gid","ino","mode","path","uid"]) and
    .rotation_state_identity.directory.path == "/var/lib/aifeeds-performance-logrotate" and
    .rotation_state_identity.directory.candidate ==
      ("/var/lib/aifeeds-performance-logrotate.candidate-gl-a-" + $operation_id) and
    .rotation_state_identity.directory.uid == 0 and .rotation_state_identity.directory.gid == 0 and
    .rotation_state_identity.directory.mode == "750" and
    (.rotation_state_identity.directory.dev | positive_integer) and
    (.rotation_state_identity.directory.ino | positive_integer) and
    .rotation_state_identity.files == [] and
    ((.rotation_state_identity.provenance | keys | sort) ==
      ["dev","genesis_record_sha256","gid","ino","mode","path","uid"]) and
    .rotation_state_identity.provenance.path ==
      "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl" and
    .rotation_state_identity.provenance.uid == 0 and .rotation_state_identity.provenance.gid == 0 and
    .rotation_state_identity.provenance.mode == "600" and
    (.rotation_state_identity.provenance.dev | positive_integer) and
    (.rotation_state_identity.provenance.ino | positive_integer) and
    (.rotation_state_identity.provenance.genesis_record_sha256 | test("^[a-f0-9]{64}$")) and
    rotation_snapshot_is_valid;
  .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
  .g0_commit == $g0_commit and .rollback_helper_sha256 == $rollback_helper_sha256 and
  ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
  all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
  ((.artifact_candidates | keys) == ["checker","diff_checker","format","inserter","log","rotate","service","timer"]) and
  all(.artifact_candidates[]; type == "string" and test("[.]candidate-gl-a-" + $operation_id + "$")) and
  .rollback_candidate == ("/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-" + $operation_id) and
  (.site_backup | test("^/var/backups/aifeeds-performance-log/aifeeds[.]conf[.]bak-perf-[0-9]{14}-[a-f0-9]{8}$")) and
  (.site_backup_sha256 | test("^[a-f0-9]{64}$")) and
  ((.site_backup_identity | keys | sort) ==
    ["dev","gid","ino","mode","path","sha256","staging_gid","staging_mode","staging_uid","uid"]) and
  .site_backup_identity.path == .site_backup and
  .site_backup_identity.sha256 == .site_backup_sha256 and
  .site_backup_identity.uid == .original_site_uid and
  .site_backup_identity.gid == .original_site_gid and
  .site_backup_identity.mode == .original_site_mode and
  .site_backup_identity.staging_uid == 0 and .site_backup_identity.staging_gid == 0 and
  .site_backup_identity.staging_mode == "600" and
  (.site_backup_identity.dev | type == "number" and . > 0 and . == floor) and
  (.site_backup_identity.ino | type == "number" and . > 0 and . == floor) and
  (.installed_site_sha256 | test("^[a-f0-9]{64}$")) and
  (.transaction_journal | test("^/var/backups/aifeeds-performance-log/transaction-[0-9]{14}-[a-f0-9]{8}[.]json$")) and
  (.transaction_journal_sha256 | test("^[a-f0-9]{64}$")) and
  (.original_site_uid | type == "number") and (.original_site_gid | type == "number") and
  (.original_site_mode | test("^[0-7]{3,4}$")) and
  (.available_kib >= 5242880) and (.available_inodes >= 100000) and
  .front_status == 200 and .api_status == 200 and
  .json_schema == true and .unique_probe == true and .rotation_probe == true and
  .systemd_rotation_probe == true and
  .nginx_active == true and .timer_active == true and .worker_join == "deferred_to_GL-b" and
  runtime_inventory_is_valid and rotation_identity_is_valid and rotation_anchor_identity_is_valid' \
  "$LOCAL_SUMMARY_TMP" >/dev/null
ROTATION_ANCHOR_DEV="$(jq -er '.rotation_anchor_identity.dev' "$LOCAL_SUMMARY_TMP")"
ROTATION_ANCHOR_INO="$(jq -er '.rotation_anchor_identity.ino' "$LOCAL_SUMMARY_TMP")"
ROTATION_ANCHOR_SIZE="$(jq -er '.rotation_anchor_identity.size' "$LOCAL_SUMMARY_TMP")"
ROTATION_ANCHOR_SHA256="$(jq -er '.rotation_anchor_identity.sha256' "$LOCAL_SUMMARY_TMP")"
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "set -eu; test -f '$REMOTE_ROTATION_ANCHOR'; test ! -L '$REMOTE_ROTATION_ANCHOR'; \
   test \"\$(stat -c '%u %g %a %d %i %s' '$REMOTE_ROTATION_ANCHOR')\" = \
     '0 0 600 $ROTATION_ANCHOR_DEV $ROTATION_ANCHOR_INO $ROTATION_ANCHOR_SIZE'; \
   test \"\$(timeout 15s sha256sum '$REMOTE_ROTATION_ANCHOR' | awk '{print \$1}')\" = \
     '$ROTATION_ANCHOR_SHA256'"
LOGROTATE_RUNTIME_ENTRY="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231 "timeout 15s jq -cS '.logrotate' '$REMOTE_ROTATION_ANCHOR'")"
jq -e '
  (keys | sort) == ["dev","gid","ino","mode","path","sha256","size","uid"] and
  .path == "/usr/sbin/logrotate" and .uid == 0 and .gid == 0 and .mode == "755" and
  (.dev | type == "number" and . > 0 and . == floor) and
  (.ino | type == "number" and . > 0 and . == floor) and
  (.size | type == "number" and . > 0 and . == floor) and
  (.sha256 | test("^[a-f0-9]{64}$"))' <<< "$LOGROTATE_RUNTIME_ENTRY" >/dev/null
RECORDED_ROTATION_SNAPSHOT="$(jq -cS '.rotation_state_snapshot' "$LOCAL_SUMMARY_TMP")"
CHECKER_RUNTIME_ENTRY="$(jq -cer '[.runtime_artifacts[] | select(.name == "checker")] |
  if length == 1 then .[0] else error("checker identity") end' "$LOCAL_SUMMARY_TMP")"
CONFIG_RUNTIME_ENTRY="$(jq -cer '[.runtime_artifacts[] | select(.name == "rotate")] |
  if length == 1 then .[0] else error("config identity") end' "$LOCAL_SUMMARY_TMP")"
CURRENT_ROTATION_SNAPSHOT="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231 \
  "timeout 15s /usr/local/sbin/aifeeds-check-nginx-request-id rotation-verify \
    '$OPERATION_ID' '$REMOTE_ROTATION_ANCHOR' \
    '$ROTATION_ANCHOR_DEV' '$ROTATION_ANCHOR_INO' '$ROTATION_ANCHOR_SHA256' \
    '$(jq -er '.dev' <<< "$CHECKER_RUNTIME_ENTRY")' \
    '$(jq -er '.ino' <<< "$CHECKER_RUNTIME_ENTRY")' \
    '$(jq -er '.sha256' <<< "$CHECKER_RUNTIME_ENTRY")' \
    '$(jq -er '.dev' <<< "$CONFIG_RUNTIME_ENTRY")' \
    '$(jq -er '.ino' <<< "$CONFIG_RUNTIME_ENTRY")' \
    '$(jq -er '.sha256' <<< "$CONFIG_RUNTIME_ENTRY")' \
    '$(jq -er '.dev' <<< "$LOGROTATE_RUNTIME_ENTRY")' \
    '$(jq -er '.ino' <<< "$LOGROTATE_RUNTIME_ENTRY")' \
    '$(jq -er '.sha256' <<< "$LOGROTATE_RUNTIME_ENTRY")'")"
jq -e --argjson recorded "$RECORDED_ROTATION_SNAPSHOT" '
  .generation >= $recorded.generation and
  .ledger.path == $recorded.ledger.path and
  .ledger.dev == $recorded.ledger.dev and .ledger.ino == $recorded.ledger.ino and
  .ledger.uid == $recorded.ledger.uid and .ledger.gid == $recorded.ledger.gid and
  .ledger.mode == $recorded.ledger.mode and
  (.ledger.sha256 | test("^[a-f0-9]{64}$")) and (.ledger.size | type == "number" and . > 0) and
  (.tail_record_sha256 | test("^[a-f0-9]{64}$"))' <<< "$CURRENT_ROTATION_SNAPSHOT" >/dev/null
LOCAL_SUMMARY_PUBLISH_ATTEMPTED=1
publish_local_file_no_replace "$LOCAL_SUMMARY_TMP" "$LOCAL_SUMMARY_FINAL" \
  "$LOCAL_SUMMARY_TMP_DEV" "$LOCAL_SUMMARY_TMP_INO"
LOCAL_SUMMARY_TMP=''
LOCAL_SUMMARY_PUBLISH_ATTEMPTED=0
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "case '$REMOTE_STAGE' in /run/aifeeds-performance-log.*) rm -rf -- '$REMOTE_STAGE' ;; *) exit 1 ;; esac"
REMOTE_STAGE=''
trap - EXIT HUP INT TERM
```

本地在任何远端写之前把唯一 `OPERATION_ID=<timestamp>-<random>`、G0 commit 与该次
rollback helper 的不可变 0600 副本持久化到同一 evidence 目录；远端 transaction id 由这个已知
operation id 决定，而不是安装器写入后才随机生成。安装器内部使用 `sha256sum -c SHA256SUMS`
二次核对，并把 `operation_id`、`g0_commit`、`rollback_helper_sha256` 同时写入 journal 与 summary。
一个 evidence 目录和 operation id 只代表一次 forward attempt；一旦远端 journal 到达 `committed`、
`rolled_back` 或 `rollback_failed`，禁止删除/改写旧 evidence 后复用。新的 forward attempt 必须重新取得
对应审批、重跑 clean G0、创建新的 evidence 目录与 operation id；旧 transcript/journal/hash 永久保留复盘。
它在 root-only 0700
`/var/backups/aifeeds-performance-log` 中创建
`aifeeds.conf.bak-perf-<timestamp>-<random>`。backup 用 `cp -a` 保留原 site 的 uid/gid/mode、ACL/xattr，
机密性由不可遍历的 root-only 父目录保证；同时记录 `site_backup_sha256` 与
`installed_site_sha256`，再运行：

```bash
python3 insert-nginx-request-id.py "$CANDIDATE" 7
python3 check-nginx-request-id.py --expect-proxy-count 7 \
  --allow-include /etc/letsencrypt/options-ssl-nginx.conf "$CANDIDATE"
python3 verify-nginx-request-id-diff.py "$SITE" "$CANDIDATE" 7
```

只有 candidate 通过才安装 format/rotate/checker/timer。后续固定执行 `logrotate -d`、`nginx -t`、
reload、nginx active、front/API 精确 200；同一个唯一 probe 必须恰好命中这两个 host 的两行。curl 使用
`-fsS --connect-timeout 5 --max-time 15`，不把响应头或 `Set-Cookie` 打到终端。安装器用唯一 probe
验证 JSON schema 和 timing 字符串，再执行真实轮转：

```bash
logrotate -f -s "$FORCE_ROTATE_STATE" "$ROTATE"
rotation_probe="upstream-$(date +%s)-$(openssl rand -hex 4)"
```

必须证明 inode 已变化、USR1 后新 base log 仍收到 front/API 两行 `rotation_probe`、owner/mode 正确，
最后才 `systemctl enable --now "$TIMER_UNIT"` 并证明专用 timer active。`logrotate -d` 只算语法检查，
不能替代这次强制轮转。

任何安装后步骤失败，EXIT trap 恢复本次精确 backup、移除本次 format/rotate/checkers/systemd units。
journal/summary 还记录七个版本化 artifact 的 SHA-256；自动或人工回滚在停止 timer、恢复 site、归档日志或
删除任何 artifact 前，必须逐个证明现存文件缺失或仍等于本事务 hash。enabled-site symlink 在入口、每次
site move/reload 前后和终态都必须仍精确解析到目标 site。人工 helper 在创建 rollback journal 前发现未知
site/artifact/symlink drift 时保持 source journal、summary 与远端运行时完全不变并立即停止；只有 rollback
journal 已经开始后再失败才写 `rollback_failed`，不得继续清理造成运行时与磁盘配置分裂。
只有 site 与 backup 逐字一致、所有 artifacts/state directory 都不存在、timer inactive 且 disabled/not-found、
daemon-reload 和回滚 `nginx -t` 全部成功，才允许 reload 并复验 nginx active 与两个 200。输出必须含
`automatic_rollback=pass`；若是 `automatic_rollback=failed`，立即按事件处理，不再执行任何前向 gate。

正常路径的远端 staging 删除是硬门禁；上面的 `EXIT` trap 只负责异常退出时 best-effort 清理，不能把
清理失败伪装成 GL-a 通过。

日常查看只输出聚合，禁止展示 URI、UA 或 request id：

```bash
tail -n 1000 /var/log/nginx/aifeeds-performance.jsonl | jq -s '
  group_by(.host)
  | map({host: .[0].host, requests: length,
         statuses: (group_by(.status) | map({status: .[0].status, requests: length}))})'
```

**GL-b**：仅在 G1 已部署当前 staging Worker、G7b 已形成 perf-staging TLS/同源链路后执行。使用
`docs/reviews/c-end-perf-staging-change-packet.md` 的 9.3：响应头写入 0600 临时文件，从中提取
`X-Request-Id`，以同一个 `perf_probe` 只读最近 JSONL，证明 staging Worker 回显值与 nginx
`request_id` 一致。GL-b 是 G8 前的远端只读验证；G8 的 10.1c 再扩展到五设备 browser request ids。
GL-b 失败时停止 G8，并先按证据归因：**无 Worker header** 时直接探测
`staging-api.ai-feeds.com`；直连也缺头归 G1/Worker，直连有头而 perf-staging 缺头归 G7b 的响应头
转发。**无 nginx row**（响应已有合法 header，但唯一 probe 没有对应 JSONL 行）先检查 GL-a 的 host
map、日志文件/缓冲、timer 与当前 nginx 配置，再检查 G7 host 路由。**request-id 不一致**时对比同一
语义的两次匿名只读探测：直连请求显式传入受限诊断 ID 并要求 Worker 原样回显，perf-staging 请求则
比较响应头和同一 probe 的 nginx-generated ID，区分 G1 回显实现与 G7 的 request-id 注入/转发。禁止
盲目回滚 G1、G7 或 GL-a；先归因，只调用被定位 gate 原审批已经授权的精确 rollback，未预授权就另行
审批。GL-b 本身不授权远端写，也不把生产 Worker 纳入本次变更。

安装器在第一次 mutation 前先 `fsync` 一份 root-only、路径已由本地 operation id 精确确定的
`/var/backups/aifeeds-performance-log/transaction-<operation-id>.json`，随后只用
`initializing → prepared → backup_created → mutation_started → mutated → timer_enabled → committed` 或
`rolled_back/rollback_failed` 更新 phase。`initializing` 在 candidate/backup 之前 fsync，`prepared` 在
backup 之前 fsync，`mutation_started` 在任何 runtime candidate/final 之前 fsync。SITE candidate 与
restore candidate 均位于 `/etc/nginx/sites-available`，八个 runtime candidate 也分别位于各自 final 的
同一目录；journal 精确绑定 `artifact_candidates`/`rollback_candidate`，完整 hash、metadata 与 `st_dev`
通过后才同盘原子 rename。因此 SIGKILL 只会留下 operation-bound、可验证/可清理的安全 candidate，不会
把跨 `/run`→`/etc` copy 伪装成原子 move。下一次
运行发现非终态 journal 会以 `recovery_required` 停止，禁止覆盖半完成事务。

**C journal update CAS active（consumer activation active / harness name-count freeze frozen）**：source journal 的
F/T/P 精确为 `/var/backups/aifeeds-performance-log/transaction-<operation-id>.json`、`${F}.tmp`、
`${F}.previous-update-gl-a-<operation-id>`；rollback journal 使用同样后缀，F 为
`/var/backups/aifeeds-performance-log/rollback-transaction-<operation-id>.json`。每个新版本内嵌
`journal_update={schema:1,revision:N,self_dev:D,self_ino:I,predecessor:null|{revision:N-1,sha256,dev,ino}}`；
只有 fresh source `initializing` 和 fresh rollback `prepared` 可为 revision 0 + null predecessor。T 必须
`O_EXCL|O_NOFOLLOW` 创建，`self_dev/self_ino` 来自同一写 fd 的 `fstat`；完整 canonical JSON 写完后执行
fsync(fd)+fsync(parent)，才能成为恢复 authority。Source legacy genesis trusts the CLI-supplied external hash and is
accepted only when that hash and the complete business schema match；rollback legacy genesis has no externally trusted hash and is
rejected fail closed。legacy orphan tmp 不能自证。

恢复状态严格为 S0–S4：S0=F-only stable；S1=F(old)+T(new)、P absent，先证明 T self 与物理 T 相等、F
精确等于 T.predecessor 且业务 transition 合法，再 NOREPLACE F→P；S2=P(old)+T(new)、F absent，同样以
T 内嵌 predecessor 证明 P 后 NOREPLACE T→F；S3=P(old)+F(new)、T absent，以 F 内嵌 predecessor 证明 P 后
NOREPLACE P→C。S4=F(new)+C(cleanup tombstone), P absent。Recovery exact-validates physical C against
F.predecessor, then uses held-dirfd unlink after a final pathname/held-FD identity check, fsyncs the parent, and
returns to S0。每次 rename 后都 fsync parent。F/T/P/C 冲突、symlink、revision
跳跃/回退、semantic inverse、same-hash different-inode，以及 O_EXCL 后崩溃留下的 invalid/partial T，全部
保留原物并 fail closed；不得 rm、truncate、重 render、move 或从 pathname 反推 identity。成功重入只能留下
exact F，T/P/tombstone 零残留，第二次重入不得改变 F hash/revision/dev/ino。

自动恢复必须在读取 source phase 或任何 live mutation 前先完成 source S0–S4；人工 helper 也必须在读取/
哈希 source 前先恢复 source update，再恢复 rollback 自身 update。terminal source T 先物化，rollback T 再引用
source target hash，之后 prepared terminal-pair marker 才绑定两份 before/target；journal 的
`.previous-update-gl-a-*` 绝不能与 marker 的 `.previous-terminal-gl-a-*` 混用。本地只读 consumer 最终只接受
S0；看见 T/P/cleanup residue 只报告 `recovery_required`，不自行清理。terminal pair 发布是普通
S3→S4 cleanup 的窄例外：prepared、单边和双边窗口必须保留两侧 predecessor，只有 committed marker durable
后才能清除。

The 14-slot runtime cleanup plan is immutable and shared by automatic and manual rollback. Its canonical items,
`plan_sha256`, cursor, and `cursor_state` live in the rollback journal. Each item durably records `detaching` before
an exact NOREPLACE tombstone rename and `detached` before unlink; `runtime_removed` is legal only after all 14 slots
reach `complete` and physical runtime residue is zero. Re-entry resumes the recorded cursor. Plan drift, unknown
tombstones, and `rollback_failed.failed_from` drift preserve evidence and fail closed. Legacy `runtime_removed`
records without the cleanup object are compatibility inputs: both automatic and manual paths still execute the
current 14-slot plan and prove zero residue instead of treating the legacy phase as cleanup authority. The rebuilt
plan is marked `compatibility_mode=legacy_runtime_removed`; its progress remains wrapped by `runtime_removed` (or an
existing `rollback_failed`) until complete. Installer retries scan the exact current-operation journal namespace
before live runtime-absence checks, so durable recovery evidence returns `recovery_required`/76 instead of a bare rc=1.
The log slot is an `archive_handoff`, not a delete: if daemon reload fails at `runtime_removed`, the exact live log
inode remains bound in the failed rollback journal and no archive manifest is claimed until a later reload succeeds.

The frozen integration matrix is 135 scenarios (95 old + 40 new). The 40 C scenario names are:

- source journal: `journal-source-g-reentry`, `journal-source-s1-reentry`, `journal-source-s2-reentry`,
  `journal-source-s3-reentry`, `journal-source-s4-reentry`, `journal-source-semantic-drift`,
  `journal-source-samebytes-predecessor`, `journal-source-partial-tmp`, `journal-source-p-only`,
  `journal-source-all-three`, `journal-source-unknown-cleanup`;
- rollback journal: `journal-rollback-g-reentry`, `journal-rollback-s1-reentry`, `journal-rollback-s2-reentry`,
  `journal-rollback-s3-reentry`, `journal-rollback-s4-reentry`, `journal-rollback-semantic-drift`,
  `journal-rollback-samebytes-predecessor`, `journal-rollback-partial-tmp`, `journal-rollback-p-only`,
  `journal-rollback-all-three`, `journal-rollback-unknown-cleanup`;
- terminal pair and cleanup: `terminal-pair-zero-side-reentry`, `terminal-pair-one-side-reentry`,
  `terminal-pair-two-side-reentry`, `terminal-pair-pre-marker-reentry`, `cleanup-manual-detaching-reentry`,
  `cleanup-manual-detached-reentry`, `cleanup-automatic-detaching-reentry`,
  `cleanup-automatic-detached-reentry`, `cleanup-manual-unknown-tombstone`,
  `cleanup-automatic-unknown-tombstone`, `cleanup-manual-plan-drift`, `cleanup-automatic-plan-drift`,
  `cleanup-manual-failed-from-drift`, `cleanup-automatic-failed-from-drift`;
- legacy compatibility: `journal-source-legacy-genesis`, `journal-rollback-legacy-genesis-rejected`,
  `cleanup-manual-legacy-runtime-removed`, `cleanup-automatic-legacy-runtime-removed`.

若 SIGKILL、主机重启、
SSH/SCP 异常或本地 summary 校验失败，先取得**只读采证批准**：在远端确认恰好一份与本次 operation id
对应的 journal；将该 record 和远端 SHA-256 都写入隐藏的 0700 临时 bundle，完整校验后再用一次同父目录
rename 发布 operation-bound canonical recovery bundle，不发布两个独立文件；不得用通配符选“最新”。
`committed` journal 但本地 summary 丢失也走这条路径：先尝试从仍存在的私有 staging
取回原 summary；取不到就精确回滚，不把缺少本地证据的线上状态宣称为通过。只读采证批准后严格按
本地预先持久化的 operation id 执行，不列目录、不猜“最新”：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
OPERATION_ID_FILE="$EVIDENCE/gl-a-operation-id.txt"
test -f "$OPERATION_ID_FILE"
test ! -L "$OPERATION_ID_FILE"
test "$(stat -f '%u' "$OPERATION_ID_FILE")" = "$(id -u)"
test "$(stat -f '%Lp' "$OPERATION_ID_FILE")" = 600
OPERATION_ID="$(cat "$OPERATION_ID_FILE")"
printf '%s' "$OPERATION_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
G0_COMMIT="$(cat "$EVIDENCE/commit.txt")"
printf '%s' "$G0_COMMIT" | grep -Eq '^[a-f0-9]{40}$'
IMMUTABLE_ROLLBACK_HELPER="$EVIDENCE/gl-a-rollback-helper-${OPERATION_ID}.sh"
test -f "$IMMUTABLE_ROLLBACK_HELPER"
test ! -L "$IMMUTABLE_ROLLBACK_HELPER"
test "$(stat -f '%u' "$IMMUTABLE_ROLLBACK_HELPER")" = "$(id -u)"
test "$(stat -f '%Lp' "$IMMUTABLE_ROLLBACK_HELPER")" = 600
ROLLBACK_HELPER_SHA256="$(shasum -a 256 "$IMMUTABLE_ROLLBACK_HELPER" | awk '{print $1}')"
printf '%s' "$ROLLBACK_HELPER_SHA256" | grep -Eq '^[a-f0-9]{64}$'
REMOTE_JOURNAL="/var/backups/aifeeds-performance-log/transaction-${OPERATION_ID}.json"
REMOTE_ARCHIVE_MANIFEST="/var/backups/aifeeds-performance-log/audit-${OPERATION_ID}/archive-manifest.json"
REMOTE_ROTATION_ANCHOR="/var/backups/aifeeds-performance-log/rotation-anchor-${OPERATION_ID}.json"
AUTO_ROLLBACK_TRANSCRIPT="$EVIDENCE/gl-a-install-output-${OPERATION_ID}.txt"
RECOVERY_BUNDLE="$EVIDENCE/gl-a-recovery-bundle-${OPERATION_ID}"
test ! -e "$RECOVERY_BUNDLE"
test ! -L "$RECOVERY_BUNDLE"
RECOVERY_BUNDLE_TMP="$(mktemp -d "$EVIDENCE/.gl-a-recovery-bundle.${OPERATION_ID}.XXXXXX")"
chmod 0700 "$RECOVERY_BUNDLE_TMP"
RECOVERY_RECORD="$RECOVERY_BUNDLE_TMP/record.json"
RECOVERY_SHA="$RECOVERY_BUNDLE_TMP/record.sha256"
RECOVERY_MANIFEST="$RECOVERY_BUNDLE_TMP/archive-manifest.json"
RECOVERY_PUBLISH_ATTEMPTED=0
cleanup_recovery_capture() {
  case "$RECOVERY_BUNDLE_TMP" in
    "$EVIDENCE"/.gl-a-recovery-bundle."$OPERATION_ID".*)
      if [ "$RECOVERY_PUBLISH_ATTEMPTED" = 0 ]; then
        rm -rf -- "$RECOVERY_BUNDLE_TMP"
      else
        printf 'recovery bundle publish failed; preserved tmp and destination: %s %s\n' \
          "$RECOVERY_BUNDLE_TMP" "$RECOVERY_BUNDLE" >&2
      fi
      ;;
  esac
}
trap cleanup_recovery_capture EXIT HUP INT TERM
REMOTE_JOURNAL_SHA256="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231 \
  "set -eu; test -f '$REMOTE_JOURNAL'; test ! -L '$REMOTE_JOURNAL'; \
   test \"\$(stat -c '%U %G %a' '$REMOTE_JOURNAL')\" = 'root root 600'; \
   timeout 15s sha256sum '$REMOTE_JOURNAL' | awk '{print \$1}'")"
printf '%s' "$REMOTE_JOURNAL_SHA256" | grep -Eq '^[a-f0-9]{64}$'
scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231:"$REMOTE_JOURNAL" "$RECOVERY_RECORD"
chmod 0600 "$RECOVERY_RECORD"
test "$(shasum -a 256 "$RECOVERY_RECORD" | awk '{print $1}')" = "$REMOTE_JOURNAL_SHA256"
jq -e --arg operation_id "$OPERATION_ID" --arg g0_commit "$G0_COMMIT" \
  --arg helper_sha "$ROLLBACK_HELPER_SHA256" --arg journal "$REMOTE_JOURNAL" \
  --arg archive_manifest "$REMOTE_ARCHIVE_MANIFEST" '
  def positive_integer: type == "number" and . > 0 and . == floor;
  def runtime_inventory_is_valid:
    (.runtime_artifacts | type == "array") and
    (.runtime_artifacts | length) <= 8 and
    ([.runtime_artifacts[].name] | length == (unique | length)) and
    ([.runtime_artifacts[].final] | length == (unique | length)) and
    ([.runtime_artifacts[].candidate] | length == (unique | length)) and
    all(.runtime_artifacts[];
      (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
      (.name == "checker" or .name == "diff_checker" or .name == "format" or
       .name == "inserter" or .name == "log" or .name == "rotate" or
       .name == "service" or .name == "timer") and
      (.candidate | test("[.]candidate-gl-a-" + $operation_id + "$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and (.mode | test("^[0-7]{3,4}$")) and
      (.uid | type == "number" and . >= 0 and . == floor) and
      (.gid | type == "number" and . >= 0 and . == floor) and
      (.dev | positive_integer) and (.ino | positive_integer)) and
    (.runtime_artifacts_sealed | type == "boolean") and
    (if .runtime_artifacts_sealed then (.runtime_artifacts | length) == 8 and
      ([.runtime_artifacts[].name] | sort) ==
        ["checker","diff_checker","format","inserter","log","rotate","service","timer"]
     else true end);
  def rotation_anchor_identity_is_valid:
    if .rotation_anchor_identity == null then true
    else
      ((.rotation_anchor_identity | keys | sort) ==
        ["dev","gid","ino","mode","path","sha256","size","state","uid"]) and
      .rotation_anchor_identity.path ==
        ("/var/backups/aifeeds-performance-log/rotation-anchor-" + $operation_id + ".json") and
      .rotation_anchor_identity.uid == 0 and .rotation_anchor_identity.gid == 0 and
      .rotation_anchor_identity.mode == "600" and
      (.rotation_anchor_identity.dev | positive_integer) and
      (.rotation_anchor_identity.ino | positive_integer) and
      ((.rotation_anchor_identity.state == "allocated" and
        .rotation_anchor_identity.sha256 ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" and
        .rotation_anchor_identity.size == 0) or
       ((.rotation_anchor_identity.state == "prepared" or
         .rotation_anchor_identity.state == "sealed") and
        (.rotation_anchor_identity.sha256 | test("^[a-f0-9]{64}$")) and
        (.rotation_anchor_identity.size | positive_integer)))
    end;
  def rotation_snapshot_is_valid:
    .rotation_state_snapshot == null or
    ((.rotation_state_snapshot | keys | sort) ==
       ["generation","ledger","status","tail_record_sha256"] and
     (.rotation_state_snapshot.generation | type == "number" and . >= 0 and . == floor) and
     (.rotation_state_snapshot.tail_record_sha256 | test("^[a-f0-9]{64}$")) and
     (.rotation_state_snapshot.ledger | keys | sort) ==
       ["dev","gid","ino","mode","path","sha256","size","uid"] and
     .rotation_state_snapshot.ledger.path == .rotation_state_identity.provenance.path and
     .rotation_state_snapshot.ledger.dev == .rotation_state_identity.provenance.dev and
     .rotation_state_snapshot.ledger.ino == .rotation_state_identity.provenance.ino and
     .rotation_state_snapshot.ledger.uid == .rotation_state_identity.provenance.uid and
     .rotation_state_snapshot.ledger.gid == .rotation_state_identity.provenance.gid and
     .rotation_state_snapshot.ledger.mode == .rotation_state_identity.provenance.mode and
     (.rotation_state_snapshot.ledger.sha256 | test("^[a-f0-9]{64}$")) and
     (.rotation_state_snapshot.ledger.size | positive_integer) and
     (.rotation_state_snapshot.status == null or
      ((.rotation_state_snapshot.status | keys | sort) ==
         ["dev","gid","ino","mode","path","sha256","uid"] and
       .rotation_state_snapshot.status.path ==
         "/var/lib/aifeeds-performance-logrotate/status" and
       (.rotation_state_snapshot.status.uid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.gid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.mode | test("^[0-7]{3,4}$")) and
       (.rotation_state_snapshot.status.sha256 | test("^[a-f0-9]{64}$")) and
       (.rotation_state_snapshot.status.dev | positive_integer) and
       (.rotation_state_snapshot.status.ino | positive_integer))));
  def rotation_identity_is_valid:
    if .rotation_state_identity == null then .rotation_state_snapshot == null
    else
      ((.rotation_state_identity | keys | sort) == ["directory","files","provenance"] and
       (.rotation_state_identity.directory | keys | sort) ==
         ["candidate","dev","gid","ino","mode","path","uid"] and
       .rotation_state_identity.directory.path == "/var/lib/aifeeds-performance-logrotate" and
       .rotation_state_identity.directory.candidate ==
         ("/var/lib/aifeeds-performance-logrotate.candidate-gl-a-" + $operation_id) and
       .rotation_state_identity.directory.uid == 0 and
       .rotation_state_identity.directory.gid == 0 and
       .rotation_state_identity.directory.mode == "750" and
       (.rotation_state_identity.directory.dev | positive_integer) and
       (.rotation_state_identity.directory.ino | positive_integer) and
       .rotation_state_identity.files == [] and
       (.rotation_state_identity.provenance | keys | sort) ==
         ["dev","genesis_record_sha256","gid","ino","mode","path","uid"] and
       .rotation_state_identity.provenance.path ==
         "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl" and
       .rotation_state_identity.provenance.uid == 0 and
       .rotation_state_identity.provenance.gid == 0 and
       .rotation_state_identity.provenance.mode == "600" and
       (.rotation_state_identity.provenance.dev | positive_integer) and
       (.rotation_state_identity.provenance.ino | positive_integer) and
       (.rotation_state_identity.provenance.genesis_record_sha256 | test("^[a-f0-9]{64}$")) and
       rotation_snapshot_is_valid)
    end;
  def backup_identity_is_valid:
    .site_backup_identity == null or
    ((.site_backup_identity | keys | sort) ==
       ["dev","gid","ino","mode","path","sha256","staging_gid","staging_mode","staging_uid","uid"] and
     .site_backup_identity.path == .site_backup and
     .site_backup_identity.sha256 == .site_backup_sha256 and
     .site_backup_identity.uid == .original_site_uid and
     .site_backup_identity.gid == .original_site_gid and
     .site_backup_identity.mode == .original_site_mode and
     .site_backup_identity.staging_uid == 0 and .site_backup_identity.staging_gid == 0 and
     .site_backup_identity.staging_mode == "600" and
     (.site_backup_identity.dev | positive_integer) and
     (.site_backup_identity.ino | positive_integer));
  .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
  .g0_commit == $g0_commit and .rollback_helper_sha256 == $helper_sha and
  .transaction_journal == $journal and
  ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
  all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
  ((.artifact_candidates | keys) == ["checker","diff_checker","format","inserter","log","rotate","service","timer"]) and
  all(.artifact_candidates[]; type == "string" and test("[.]candidate-gl-a-" + $operation_id + "$")) and
  .rollback_candidate == ("/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-" + $operation_id) and
  runtime_inventory_is_valid and rotation_identity_is_valid and backup_identity_is_valid and
  rotation_anchor_identity_is_valid and
  (if .phase == "committed" then
     .rotation_anchor_identity != null and .rotation_anchor_identity.state == "sealed"
   elif .phase == "rolled_back" then
     (.rotation_anchor_identity == null or
      .rotation_anchor_identity.state == "allocated" or
      .rotation_anchor_identity.state == "prepared" or
      .rotation_anchor_identity.state == "sealed")
   else true end) and
  (.phase == "initializing" or .phase == "prepared" or .phase == "backup_created" or
   .phase == "mutation_started" or .phase == "mutated" or .phase == "timer_enabled" or
   .phase == "committed" or .phase == "rollback_failed" or
   (.phase == "rolled_back" and
    (.rollback_origin_phase == "initializing" or .rollback_origin_phase == "prepared" or
     .rollback_origin_phase == "backup_created" or .rollback_origin_phase == "mutation_started" or
     .rollback_origin_phase == "mutated" or .rollback_origin_phase == "timer_enabled" or
     .rollback_origin_phase == "committed") and
    .log_archive_manifest == $archive_manifest and
    (.log_archive_manifest_sha256 | test("^[a-f0-9]{64}$")) and
    (.log_archive_manifest_generation | type == "number" and . >= 0 and . == floor) and
    (.log_archive_manifest_entry_count | type == "number" and . >= 0 and . == floor) and
    .log_archive_manifest_generation >= (3 * .log_archive_manifest_entry_count + 1) and
    .log_archive_manifest_generation <= (4 * .log_archive_manifest_entry_count + 1) and
    (has("rollback_journal") | not)))' "$RECOVERY_RECORD" >/dev/null
RECOVERY_PHASE="$(jq -er '.phase' "$RECOVERY_RECORD")"
if [ "$RECOVERY_PHASE" = committed ]; then
  ROTATION_ANCHOR_DEV="$(jq -er '.rotation_anchor_identity.dev' "$RECOVERY_RECORD")"
  ROTATION_ANCHOR_INO="$(jq -er '.rotation_anchor_identity.ino' "$RECOVERY_RECORD")"
  ROTATION_ANCHOR_SIZE="$(jq -er '.rotation_anchor_identity.size' "$RECOVERY_RECORD")"
  ROTATION_ANCHOR_SHA256="$(jq -er '.rotation_anchor_identity.sha256' "$RECOVERY_RECORD")"
  ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
    "set -eu; test -f '$REMOTE_ROTATION_ANCHOR'; test ! -L '$REMOTE_ROTATION_ANCHOR'; \
     test \"\$(stat -c '%u %g %a %d %i %s' '$REMOTE_ROTATION_ANCHOR')\" = \
       '0 0 600 $ROTATION_ANCHOR_DEV $ROTATION_ANCHOR_INO $ROTATION_ANCHOR_SIZE'; \
     test \"\$(timeout 15s sha256sum '$REMOTE_ROTATION_ANCHOR' | awk '{print \$1}')\" = \
       '$ROTATION_ANCHOR_SHA256'"
elif [ "$RECOVERY_PHASE" = rolled_back ]; then
  ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
    "set -eu; test ! -e '$REMOTE_ROTATION_ANCHOR'; test ! -L '$REMOTE_ROTATION_ANCHOR'"
fi
if jq -e '.phase == "rolled_back"' "$RECOVERY_RECORD" >/dev/null; then
  RECORDED_MANIFEST_SHA256="$(jq -er '.log_archive_manifest_sha256' "$RECOVERY_RECORD")"
  RECORDED_MANIFEST_GENERATION="$(jq -er '.log_archive_manifest_generation' "$RECOVERY_RECORD")"
  RECORDED_MANIFEST_ENTRY_COUNT="$(jq -er '.log_archive_manifest_entry_count' "$RECOVERY_RECORD")"
  test "$(jq -er '.log_archive_manifest' "$RECOVERY_RECORD")" = "$REMOTE_ARCHIVE_MANIFEST"
  REMOTE_MANIFEST_SHA256="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
    root@154.12.188.231 \
    "set -eu; test -f '$REMOTE_ARCHIVE_MANIFEST'; test ! -L '$REMOTE_ARCHIVE_MANIFEST'; \
     test \"\$(stat -c '%U %G %a' '$REMOTE_ARCHIVE_MANIFEST')\" = 'root root 600'; \
     timeout 15s sha256sum '$REMOTE_ARCHIVE_MANIFEST' | awk '{print \$1}'")"
  test "$REMOTE_MANIFEST_SHA256" = "$RECORDED_MANIFEST_SHA256"
  scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
    root@154.12.188.231:"$REMOTE_ARCHIVE_MANIFEST" "$RECOVERY_MANIFEST"
  chmod 0600 "$RECOVERY_MANIFEST"
  test "$(shasum -a 256 "$RECOVERY_MANIFEST" | awk '{print $1}')" = "$RECORDED_MANIFEST_SHA256"
  jq -e --arg operation_id "$OPERATION_ID" \
    --argjson generation "$RECORDED_MANIFEST_GENERATION" \
    --argjson entry_count "$RECORDED_MANIFEST_ENTRY_COUNT" '
    .schema == 2 and .operation_id == $operation_id and
    ((keys | sort) ==
      ["empty_inventory","entries","generation","inventory_complete","operation_id",
       "previous_manifest_dev","previous_manifest_ino","previous_manifest_sha256","schema"]) and
    (.generation | type == "number" and . > 0 and . == floor) and
    (.previous_manifest_sha256 | test("^[a-f0-9]{64}$")) and
    (.previous_manifest_dev | type == "number" and . > 0 and . == floor) and
    (.previous_manifest_ino | type == "number" and . > 0 and . == floor) and
    .generation == $generation and (.entries | length) == $entry_count and
    .inventory_complete == true and .empty_inventory == (($entry_count == 0)) and
    .generation == (3 * (.entries | length) + 1 +
      ([.entries[] | select(has("candidate_dev"))] | length)) and
    all(.entries[]; . as $entry | ($entry.source | split("/") | last) as $name |
      .state == "archived" and
      ($entry.source | test("^/var/log/nginx/aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$")) and
      $entry.quarantine == ("/var/log/nginx/." + $name + ".quarantine-gl-a-" + $operation_id) and
      $entry.destination ==
        ("/var/backups/aifeeds-performance-log/audit-" + $operation_id + "/" + $name) and
      $entry.candidate == ($entry.destination + ".candidate-gl-a-" + $operation_id) and
      ((keys | sort) ==
        (if has("candidate_dev") then
          ["candidate","candidate_dev","candidate_ino","destination","destination_dev","destination_ino","dev","final_mtime_s","final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"]
         else
          ["candidate","destination","destination_dev","destination_ino","dev","final_mtime_s","final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"]
         end)) and
      (.final_sha256 | test("^[a-f0-9]{64}$")) and
      (.final_size | type == "number" and . >= 0 and . == floor) and
      (.final_mtime_s | type == "number") and
      (.dev | type == "number" and . > 0 and . == floor) and
      (.ino | type == "number" and . > 0 and . == floor) and
      (.destination_dev | type == "number" and . > 0 and . == floor) and
      (.destination_ino | type == "number" and . > 0 and . == floor) and
      (if has("candidate_dev") then
         (.candidate_dev | type == "number" and . > 0 and . == floor) and
         (.candidate_ino | type == "number" and . > 0 and . == floor) and
         .destination_dev == .candidate_dev and .destination_ino == .candidate_ino
       else .destination_dev == .dev and .destination_ino == .ino end))' \
    "$RECOVERY_MANIFEST" >/dev/null
  while IFS=$'\t' read -r destination destination_dev destination_ino final_sha256 final_size; do
    ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
      "set -eu; test -f '$destination'; test ! -L '$destination'; \
       test \"\$(stat -c '%U %G %a' '$destination')\" = 'root root 600'; \
       test \"\$(stat -c '%d %i' '$destination')\" = '$destination_dev $destination_ino'; \
       test \"\$(stat -c '%s' '$destination')\" = '$final_size'; \
       test \"\$(sha256sum '$destination' | awk '{print \$1}')\" = '$final_sha256'"
  done < <(jq -r '.entries[] |
    [.destination,.destination_dev,.destination_ino,.final_sha256,.final_size] | @tsv' \
    "$RECOVERY_MANIFEST")
else
  test ! -e "$RECOVERY_MANIFEST"
  test ! -L "$RECOVERY_MANIFEST"
fi
printf '%s\n' "$REMOTE_JOURNAL_SHA256" > "$RECOVERY_SHA"
chmod 0600 "$RECOVERY_SHA"
test "$(stat -f '%Lp' "$RECOVERY_RECORD")" = 600
test "$(stat -f '%Lp' "$RECOVERY_SHA")" = 600
if [ -e "$RECOVERY_MANIFEST" ] || [ -L "$RECOVERY_MANIFEST" ]; then
  test -f "$RECOVERY_MANIFEST"
  test ! -L "$RECOVERY_MANIFEST"
  test "$(stat -f '%Lp' "$RECOVERY_MANIFEST")" = 600
fi
RECOVERY_PUBLISH_ATTEMPTED=1
test ! -e "$RECOVERY_BUNDLE"
test ! -L "$RECOVERY_BUNDLE"
test "$(dirname "$RECOVERY_BUNDLE_TMP")" = "$(dirname "$RECOVERY_BUNDLE")"
python3 - "$RECOVERY_BUNDLE_TMP" "$RECOVERY_BUNDLE" <<'PY'
import ctypes
import os
import sys

source, destination = map(os.fsencode, sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    RENAME_EXCL = 0x00000004
    renamex_np = libc.renamex_np
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    result = renamex_np(source, destination, RENAME_EXCL)
elif sys.platform.startswith("linux"):
    AT_FDCWD = -100
    RENAME_NOREPLACE = 1
    renameat2 = libc.renameat2
    renameat2.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE)
else:
    raise SystemExit(f"unsupported no-replace rename platform: {sys.platform}")
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(destination))
parent_fd = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
RECOVERY_RECORD="$RECOVERY_BUNDLE/record.json"
RECOVERY_SHA="$RECOVERY_BUNDLE/record.sha256"
RECOVERY_MANIFEST="$RECOVERY_BUNDLE/archive-manifest.json"
test -d "$RECOVERY_BUNDLE"
test ! -L "$RECOVERY_BUNDLE"
test "$(stat -f '%Lp' "$RECOVERY_BUNDLE")" = 700
test "$(cat "$RECOVERY_SHA")" = "$REMOTE_JOURNAL_SHA256"
test "$(shasum -a 256 "$RECOVERY_RECORD" | awk '{print $1}')" = "$REMOTE_JOURNAL_SHA256"
if jq -e '.phase == "rolled_back"' "$RECOVERY_RECORD" >/dev/null; then
  test -f "$RECOVERY_MANIFEST"
  test ! -L "$RECOVERY_MANIFEST"
  test "$(stat -f '%Lp' "$RECOVERY_MANIFEST")" = 600
  test "$(shasum -a 256 "$RECOVERY_MANIFEST" | awk '{print $1}')" = "$RECORDED_MANIFEST_SHA256"
  jq -e --arg operation_id "$OPERATION_ID" \
    --argjson generation "$RECORDED_MANIFEST_GENERATION" \
    --argjson entry_count "$RECORDED_MANIFEST_ENTRY_COUNT" '
    .schema == 2 and .operation_id == $operation_id and
    ((keys | sort) ==
      ["empty_inventory","entries","generation","inventory_complete","operation_id",
       "previous_manifest_dev","previous_manifest_ino","previous_manifest_sha256","schema"]) and
    (.generation | type == "number" and . > 0 and . == floor) and
    (.previous_manifest_sha256 | test("^[a-f0-9]{64}$")) and
    (.previous_manifest_dev | type == "number" and . > 0 and . == floor) and
    (.previous_manifest_ino | type == "number" and . > 0 and . == floor) and
    .generation == $generation and (.entries | length) == $entry_count and
    .inventory_complete == true and .empty_inventory == ($entry_count == 0) and
    .generation == (3 * (.entries | length) + 1 +
      ([.entries[] | select(has("candidate_dev"))] | length)) and
    all(.entries[];
      .state == "archived" and
      (.destination_dev | type == "number" and . > 0 and . == floor) and
      (.destination_ino | type == "number" and . > 0 and . == floor) and
      (if has("candidate_dev") then
         .destination_dev == .candidate_dev and .destination_ino == .candidate_ino
       else .destination_dev == .dev and .destination_ino == .ino end))' \
    "$RECOVERY_MANIFEST" >/dev/null
  jq -e '(has("rollback_journal") | not)' "$RECOVERY_RECORD" >/dev/null
  test -f "$AUTO_ROLLBACK_TRANSCRIPT"
  test ! -L "$AUTO_ROLLBACK_TRANSCRIPT"
  test "$(stat -f '%u' "$AUTO_ROLLBACK_TRANSCRIPT")" = "$(id -u)"
  test "$(stat -f '%Lp' "$AUTO_ROLLBACK_TRANSCRIPT")" = 600
  grep -Fq 'automatic_rollback=pass' "$AUTO_ROLLBACK_TRANSCRIPT"
  printf 'GL-a automatic rollback terminal reconciled read-only; do not run manual rollback\n'
else
  test ! -e "$RECOVERY_MANIFEST"
  test ! -L "$RECOVERY_MANIFEST"
fi
RECOVERY_BUNDLE_TMP=''
RECOVERY_PUBLISH_ATTEMPTED=0
trap - EXIT HUP INT TERM
```

上面的 `rolled_back` 分支只做终态对账：source journal 必须不引用 manual rollback journal，并精确绑定
operation-bound archive manifest 的路径、SHA、generation 和 entry count；采证还会从该精确远端路径复制
0600 manifest 进 canonical bundle，再对本地物理副本复算 SHA、schema、operation id、generation/count 与
`generation == 3 * N + 1 + count(entries has candidate_dev)`。安装 transcript 中的
`automatic_rollback=pass` 只是追加诊断门禁，不再是
automatic terminal 的唯一证明。任一 manifest 对账失败，或非终态、`rollback_failed`、缺失本地成功
transcript，都按事件处理；不得把已完成的自动回滚再次送入人工 helper。
canonical recovery bundle 内固定包含 record 与其 SHA，`rolled_back` 时还包含已物理对账的 manifest；
发布只允许同父目录的 Darwin `renamex_np(RENAME_EXCL)` 或 Linux `renameat2(RENAME_NOREPLACE)`。若原子
NOREPLACE 成功，还必须 `fsync` destination parent directory 才算 durable；rename、parent fsync 或发布后
校验失败都保留临时 bundle 和未知 destination，禁止 `mv -f`、删除或覆盖取巧。

**精确人工/崩溃恢复回滚**：只使用版本化 `rollback-aifeeds-performance-log.sh`。它接受 base 与 candidate
两种合法 live-site hash：base 不覆盖、candidate 才恢复 backup，未知 hash 立即停止。工具在第一次写前
fsync 一个以原 transaction id 命名的可重入 rollback journal；部分 artifact/state 均按存在性撤销；成功
后原子更新原 transaction journal 为 `rolled_back`。因此 `initializing`、`prepared`、`backup_created`、
`mutation_started`、部分安装、`mutated`、`timer_enabled`、
`rollback_failed` 和本地 summary 丢失的 `committed` 都使用同一状态机。真正恢复属于 production nginx
写；installer 同时扫描原 transaction 与 rollback journal，任一非终态都保持 `recovery_required`。
只有 origin phase 为 `initializing`/`prepared` 且 live site 仍等于记录的 base 时，helper 才允许 backup
尚未创建；同一窗口留下的精确 partial backup 会在任何其他写之前移入本事务 root-only audit。较晚 phase
缺 backup、enabled-site retarget、artifact hash 漂移或未知 site hash 一律停止。终态 summary 记录 source/
rollback journal 的最终 SHA 与 `backup_present`，重入不得把 `rolled_back` 改写为 `rollback_failed`。

**可审计 exceptional recovery（仅用于已绑定旧 helper SHA 的已知缺陷）**：普通 helper 调用仍为九个
参数，并要求当前执行器 SHA 等于 transaction journals 的 `rollback_helper_sha256`。只有 defect 精确为
`initialized_rotation_candidate_prepublication` 时，才允许增加第十个 authority 文件。authority 必须位于
该次 root-only staging 目录，且为 non-symlink `root:root 0600` regular file；它严格绑定 operation/G0、
source 与 rollback journal 路径及恢复前 SHA、transaction helper SHA、当前 recovery executor SHA、
operator、独立 rollback owner、UTC 批准时间和批准证据 SHA。transaction helper 与 executor SHA 必须不同；
terminal journals 继续保留 transaction helper，不得把新版执行器冒充旧 helper。

新版 helper 在任何 journal/runtime mutation 前完成 authority、两个 journals、live base site 和自身 SHA
校验，并用 NOREPLACE + fsync 将原字节固化为
`exceptional-recovery-authority-<operation>.json`。成功完成原有 cleanup plan、terminal pair 和 committed
marker 后，再原子发布 `exceptional-recovery-receipt-<operation>.json`；receipt 绑定 authority SHA、恢复前
source/rollback SHA、transaction/executor 双 SHA，以及终态 source、rollback、marker 三个 SHA。authority
存在但 receipt 缺失、receipt 孤立、candidate 残留、哈希漂移或 journals 仍非终态时，installer 一律
`recovery_required`。同一 authority 重入只能补齐 owned candidate/缺失 receipt，不能覆盖未知 final；成功
重入的 terminal namespace 和 receipt inode/hash 均不变化。该模式不是通用 SHA 绕过，不接受其他 defect、
未知字段、错 operation、错 SHA、symlink 或宽松 metadata。

本地独立恢复契约不计入冻结的 135 场矩阵：1 个依赖预检，外加 10 个恢复场景（initialized-candidate
普通回滚、exceptional 正向/负向/installer closure，以及 authority/receipt 各四个 publication crash
重入）。2026-07-14 结果为 independent 10/10、matrix 135/135、skip 0。生产恢复仍需在 fresh clean G0、
只读复核与精确命令展示后单独批准；未批准前不得上传或调用新版 exceptional helper。

日志撤销先把 canonical log 以 `RENAME_NOREPLACE` 移到同目录、与 operation id 绑定的 quarantine，
再等待所有日志 writable FD 消失且 size/mtime 连续稳定；生产等待上限为 60 秒。超时、`/proc`
扫描权限错误或 identity 漂移都必须保留 quarantine 和 archive manifest、失败关闭；后续使用同一
operation id 重入继续，禁止直接删除 quarantine 或强杀旧 worker。
archive manifest 是 operation-bound 的持久状态机：它在移动 live log 前记录 source/quarantine/
destination/candidate、inode 与权限；quiescent 后补 final SHA/size，完成归档后才记 `archived` 和
`inventory_complete`。schema 2 从 generation 0 genesis 开始；cross-filesystem 单 entry 严格走
`journaled → quiescent → copied → archived`，same-filesystem 则从 quiescent 直接 archived。crossfs copy
完成后、final publish 前先 journal `candidate_dev`/`candidate_ino`；publish 后再记录
`destination_dev`/`destination_ino`，且它们必须等于 candidate inode。samefs destination identity 必须等于
原 source dev/ino。terminal generation 是 `3 * N + 1 + count(entries has candidate_dev)`，全 crossfs 即
`4 * N + 1`。copied candidate 或 destination 若 samebytes 但属于 different inode/unknown identity 必须
fail closed；candidate+destination 冲突、二者同时缺失、未 journal candidate、任何 candidate/cleanup/unknown
audit residue 都保留并拒绝接管。terminal destination 的 physical dev/ino 必须逐项等于 recorded destination。
每次 successor 只允许 append、seal、quiesce、copy、archive 五类单一变化。schema 2 top-level exact keys 是
`{schema,operation_id,generation,previous_manifest_sha256,previous_manifest_dev,previous_manifest_ino,inventory_complete,empty_inventory,entries}`：
generation 0 的 predecessor SHA/dev/ino 三项全为 null；每个 generation>0 successor 都必须从 predecessor 的
stable fd capture 同时持久化 raw SHA/dev/ino，禁止只凭 pathname 或 matching bytes/hash 接管。final/tmp/
operation-bound previous 只按三路径 NOREPLACE 和物理副作用对账：P+T 或 P+F 状态只能读取 T/F successor 内嵌的
predecessor triple，再证明物理 P 精确匹配；P-only、invalid/unrelated T/F、same-hash different-inode 全部原样
保留并 fail closed。

Archive manifest namespace recovery 另使用 read-only held-fingerprint dispatcher（此处 F/T/P/C 与 journal
CAS 的 cleanup namespace 不同）：F=final、T=tmp、P=previous、C=operation-bound private cleanup directory。
只接受 `∅`、`T(genesis)`、`F`、`F+T`、`P+T`、`P+F`、`F+C(payload)`、`F+C(empty)`；其余组合全部保留并
fail closed。F/T/P 和 C payload 均以 `O_NOFOLLOW` held-FD 捕获，要求 root:root/0600、`nlink=1`，指纹精确为
`{dev,ino,mtime_ns,sha256,size}`，同时拒绝 duplicate keys 与 non-finite JSON。dispatcher 只用这些 held
fingerprints 验证 successor、物理 reachability 与 immutable runtime-cleanup log handoff，并逐路径 recapture
unchanged 后才允许 publish/cleanup；`journaled` live log 只允许同 inode 尾部增长，quiescent/copied/archived
内容必须冻结。C payload/empty directory 只能通过 held parent/dirfd exact unlink/rmdir 清理。

Archive read-only preflight 在首次 capture 前置零写 sentinel，只有 topology、reachability、handoff 和最终
recapture 全部通过后才清除。sentinel 未清除时发生失败，failure trap 必须在删除 summary、写
`rollback_failed` 或改动 cleanup namespace 之前退出；重复失败不得改变 F/T/P/C 的 bytes、inode 或 namespace。
只有 manifest tmp/previous 不存在、
audit 目录 canonical 日志集合与 destinations 集合双向相等、每个 destination 的 root:root/0600、SHA/size
与记录逐项相等，且 source/quarantine/candidate 全部消失，才是 terminal。两份 terminal journal 和
summary 同时绑定该 manifest 的 SHA/generation/entry count；未知、回退、孤儿文件或物理漂移都保留并失败关闭。
这里的 runtime artifact manifest 不是独立文件：它就是 source transaction journal 内的
`runtime_artifacts` 与 `runtime_artifacts_sealed`；no independent runtime manifest path/SHA/generation/count
存在。8 candidates 的每一项都先持久化 dev、ino、sha256 和 metadata，完整 inventory sealed before any final
publication。删除时，7 immutable finals 与 all 8 candidates 分别走 exact-identity、operation-bound
tombstone；live log 不进入这组 final tombstone，而是 handed to the archive manifest。
`rotation_state_identity` 精确绑定 operation-bound directory candidate 与稳定 ledger anchor 的
path/dev/ino/mode/`genesis_record_sha256`；`rotation_state_snapshot` 再验证 generation、
`tail_record_sha256`、ledger SHA/size 和当代 status identity。root-only `rotation-wrapper` 是 timer 唯一 writer；
唯一锁域是 authority-bound ledger inode FD flock，只允许向该 ledger 追加可验证 tail。legacy
`/run/aifeeds-performance-log-rotation.lock` 参数 compatibility-only 且被忽略：它 is not an authority domain and
not a serialization domain。安装时旧 status inode/hash
不是永久 identity，manual helper 也不得从 current status path 重新 capture 或 adopt。
动态 systemd service 的 `ExecStart` 固定 operation id、anchor、checker、config、logrotate 五组 authority 参数，
顺序不可变；config triple 后紧跟 logrotate triple，每组都使用 exact path/dev/ino/SHA，禁止运行时扫描或重捕获。外部 authority 只能位于
`/var/backups/aifeeds-performance-log/rotation-anchor-<operation-id>.json`。source/rollback journal、forward/manual
summary 都镜像 exact 9-key `rotation_anchor_identity={state,path,sha256,size,uid,gid,mode,dev,ino}`，状态严格推进
`allocated → prepared → sealed`：`allocated` 绑定 O_EXCL 创建的 empty-file SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`、size=0 与 inode；`prepared` 已持久化
expected final target SHA/size，但 physical inode 此刻仍可为空；原 inode 填充并 fsync 后，`sealed` 才要求
physical path/dev/ino/SHA/size exact。canonical authority payload 使用 schema 2，只允许 exact top-level
`{schema,operation_id,directory,provenance,checker,config,logrotate}`：directory 绑定固定 state directory，provenance 绑定
ledger genesis；其 exact nested keys 分别是 directory=`{path,uid,gid,mode,dev,ino}`、
provenance=`{path,uid,gid,mode,dev,ino,genesis_record_sha256}`、checker/config=
`{path,sha256,size,uid,gid,mode,dev,ino}`。logrotate 的 exact nested keys 为
`{path,sha256,size,uid,gid,mode,dev,ino}`，固定 `/usr/sbin/logrotate`，并要求 root:root mode 0755。
automatic/manual caller 使用 sealed-anchor extractor：以 `O_NOFOLLOW` 单次打开 exact anchor，验证 canonical bytes 与
full identity，只从 held-FD bytes 提取 logrotate authority；checker 将全部资源保持为 held-FD，并在 mutation 前执行
final pathname/held-FD identity exact check。checker/config candidate identity
必须先 journal；rotation ledger 初始化、anchor 封存完成后，才最后动态渲染 service candidate。committed
终态必须是 sealed；rolled_back 若早期从未分配可为 null，否则 retain last identity evidence，按崩溃点可为
allocated、prepared 或 sealed，禁止把未完成状态伪写成 sealed，但 anchor pathname 必须 absent/deleted。人工恢复先 stop timer/service 并证明二者静止，再以固定 authority 参数调用
`rotation-recover`；不得直接运行裸 logrotate 或从当前 ledger/status/anchor 路径认领身份。
`site_backup_identity` 必须在 copy 前持久化并绑定 `O_EXCL` 分配出的 inode。pre-mutation base SITE identity
绑定 original site dev/inode；committed installed SITE identity 绑定 installer candidate dev/inode；rolled_back
base SITE identity 在 backup-copy restore 已发布时绑定 journaled rollback candidate dev/inode，otherwise 绑定 original site dev/inode；
copy 恢复不保证 original inode。
Every phase accepts only its recorded identity and must never derive identity from the current path；同内容或同 hash
不足以接管。manual recovery must never
derive or adopt unknown backup/runtime/rotation identity。Terminal physical finals/candidates and rotation cleanup
must have zero residue，不能只凭一次 `test ! -e`。pair-free source-only `rolled_back` 是窄特例：只允许从
effective `initializing`/`prepared` 转入，`rollback_journal` 与 `rollback_commit_marker` 必须同时 absent，业务
delta 必须恰好包含 `phase`、`rollback_origin_phase` 和三项
`log_archive_manifest_{sha256,generation,entry_count}`；manifest 必须是 generation 1、entry count 0 的
operation-bound empty terminal manifest。若 journal 记录了非 `absent` 的 installer candidate hash、但
candidate pathname 已 absent，则该 absence 只可由精确 operation path 上两次相同 held-FD capture 授权：
schema 2 exact keys、root:root/0600、`nlink=1`、generation 1、`inventory_complete=true`、
`empty_inventory=true`、`entries=[]`，且 candidate、manifest tmp、manifest previous 在 capture 前后均 absent。
这就是 `prelive empty manifest` 契约。

人工回滚的两个终态 journal 由 operation-bound terminal pair marker 协调，严格执行 `prepared → committed`。
prepared marker 除 before/target SHA 外，还嵌入 `source_before_authority` 与 `rollback_before_authority`；两者 exact
keys 均为 `{raw_base64,sha256,dev,ino}`。source raw 必须匹配 CLI-trusted SHA，rollback raw 必须 canonical 且
effective phase 为 `logs_archived`；两份 terminal target 必须由这些 before authority 重建，并验证为各自唯一
合法 CAS successor；对应字段仍精确命名为 `source_target_sha256` 与 `rollback_target_sha256`。prepared、单边和双边发布窗口均保留两侧 predecessor；只有 committed marker durable 后
才清理。committed marker 另绑定 `prepared_marker_sha256` 与两侧 terminal SHA；validator 从 committed bytes
还原 prepared marker、复算其 SHA，并证明 terminal SHA 等于 target SHA。prepared marker 本身不是业务
authority；committed marker 的 physical chain 还必须对账两侧物理 journal 与 summary，恢复只接受精确
before/target 状态。marker tmp/prepared、第三种 SHA 或链路不一致都阻断新事务，
禁止从“看起来 rolled_back”的任意 JSON 推断完成。
必须使用原 gate 审批已包含的精确 rollback 或重新取得批准。正常 committed summary 默认优先于
recovery record；只有 summary 缺失，或操作者显式设置 `GL_A_RECOVERY_MODE=1`，才选择已按精确
operation id 捕获的 recovery record。回滚不读取当前 checkout 的 helper，也不因紧急时工作树变脏而被
阻断；它只上传 GL-a 前已固化在原 evidence 中、SHA 与 journal/summary 一致的不可变副本：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
publish_local_file_no_replace() {
  local source=$1 destination=$2 expected_dev=$3 expected_ino=$4
  test "$(dirname "$source")" = "$(dirname "$destination")"
  python3 - "$source" "$destination" "$expected_dev" "$expected_ino" <<'PY'
import ctypes
import os
import stat
import sys

source, destination = map(os.fsencode, sys.argv[1:3])
expected_dev, expected_ino = map(int, sys.argv[3:])
before = os.lstat(source)
if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
    raise RuntimeError("local evidence source identity changed")
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    RENAME_EXCL = 0x00000004
    renamex_np = libc.renamex_np
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    result = renamex_np(source, destination, RENAME_EXCL)
elif sys.platform.startswith("linux"):
    AT_FDCWD = -100
    RENAME_NOREPLACE = 1
    renameat2 = libc.renameat2
    renameat2.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE)
else:
    raise SystemExit(f"unsupported no-replace rename platform: {sys.platform}")
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(destination))
after = os.lstat(destination)
if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
    raise RuntimeError("published local evidence identity changed")
parent_fd = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
}
remove_owned_local_tmp() {
  local path=$1 expected_dev=$2 expected_ino=$3
  python3 - "$path" "$expected_dev" "$expected_ino" <<'PY'
import os
import stat
import sys

path, expected_dev, expected_ino = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
except FileNotFoundError:
    raise SystemExit(0)
try:
    value = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("local evidence tmp is not regular")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("local evidence tmp descriptor identity changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("local evidence tmp pathname identity changed")
finally:
    os.close(descriptor)
os.unlink(path)
parent_fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
}
G0_COMMIT="$(cat "$EVIDENCE/commit.txt")"
printf '%s' "$G0_COMMIT" | grep -Eq '^[a-f0-9]{40}$'
OPERATION_ID_FILE="$EVIDENCE/gl-a-operation-id.txt"
test -f "$OPERATION_ID_FILE"
test ! -L "$OPERATION_ID_FILE"
test "$(stat -f '%u' "$OPERATION_ID_FILE")" = "$(id -u)"
test "$(stat -f '%Lp' "$OPERATION_ID_FILE")" = 600
OPERATION_ID="$(cat "$OPERATION_ID_FILE")"
printf '%s' "$OPERATION_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
EXPECTED_LOG_ARCHIVE_MANIFEST="/var/backups/aifeeds-performance-log/audit-${OPERATION_ID}/archive-manifest.json"
EXPECTED_ROLLBACK_COMMIT_MARKER="/var/backups/aifeeds-performance-log/rollback-commit-${OPERATION_ID}.json"
REMOTE_ROTATION_ANCHOR="/var/backups/aifeeds-performance-log/rotation-anchor-${OPERATION_ID}.json"
IMMUTABLE_ROLLBACK_HELPER="$EVIDENCE/gl-a-rollback-helper-${OPERATION_ID}.sh"
test -f "$IMMUTABLE_ROLLBACK_HELPER"
test ! -L "$IMMUTABLE_ROLLBACK_HELPER"
test "$(stat -f '%u' "$IMMUTABLE_ROLLBACK_HELPER")" = "$(id -u)"
test "$(stat -f '%Lp' "$IMMUTABLE_ROLLBACK_HELPER")" = 600
ROLLBACK_HELPER_SHA256="$(shasum -a 256 "$IMMUTABLE_ROLLBACK_HELPER" | awk '{print $1}')"
printf '%s' "$ROLLBACK_HELPER_SHA256" | grep -Eq '^[a-f0-9]{64}$'
RECOVERY_MODE="${GL_A_RECOVERY_MODE:-0}"
case "$RECOVERY_MODE" in 0|1) ;; *) exit 2 ;; esac
if [ "$RECOVERY_MODE" = 0 ] && [ -f "$EVIDENCE/gl-a-summary.json" ]; then
  RECORD="$EVIDENCE/gl-a-summary.json"
  IS_RECOVERY_RECORD=0
else
  RECOVERY_BUNDLE="$EVIDENCE/gl-a-recovery-bundle-${OPERATION_ID}"
  test -d "$RECOVERY_BUNDLE"
  test ! -L "$RECOVERY_BUNDLE"
  test "$(stat -f '%Lp' "$RECOVERY_BUNDLE")" = 700
  RECOVERY_RECORD="$RECOVERY_BUNDLE/record.json"
  RECOVERY_SHA="$RECOVERY_BUNDLE/record.sha256"
  RECORD="$RECOVERY_RECORD"
  IS_RECOVERY_RECORD=1
fi
test -f "$RECORD"
test ! -L "$RECORD"
test "$(stat -f '%Lp' "$RECORD")" = 600
test "$(stat -f '%u' "$RECORD")" = "$(id -u)"
SOURCE_JOURNAL="$(jq -er '.transaction_journal' "$RECORD")"
if [ "$IS_RECOVERY_RECORD" = 1 ]; then
  test -f "$RECOVERY_SHA"
  test ! -L "$RECOVERY_SHA"
  test "$(stat -f '%Lp' "$RECOVERY_SHA")" = 600
  test "$(stat -f '%u' "$RECOVERY_SHA")" = "$(id -u)"
  SOURCE_JOURNAL_SHA256="$(cat "$RECOVERY_SHA")"
  test "$(shasum -a 256 "$RECORD" | awk '{print $1}')" = "$SOURCE_JOURNAL_SHA256"
  jq -e '(.phase == "initializing" or .phase == "prepared" or .phase == "backup_created" or
    .phase == "mutation_started" or .phase == "mutated" or .phase == "timer_enabled" or
    .phase == "committed" or .phase == "rollback_failed")' "$RECORD" >/dev/null
else
  SOURCE_JOURNAL_SHA256="$(jq -er '.transaction_journal_sha256' "$RECORD")"
fi
jq -e --arg operation_id "$OPERATION_ID" --arg g0_commit "$G0_COMMIT" \
  --arg helper_sha "$ROLLBACK_HELPER_SHA256" '
  def positive_integer: type == "number" and . > 0 and . == floor;
  def rotation_anchor_identity_is_valid:
    if .rotation_anchor_identity == null then true
    else
      ((.rotation_anchor_identity | keys | sort) ==
        ["dev","gid","ino","mode","path","sha256","size","state","uid"]) and
      .rotation_anchor_identity.path ==
        ("/var/backups/aifeeds-performance-log/rotation-anchor-" + $operation_id + ".json") and
      .rotation_anchor_identity.uid == 0 and .rotation_anchor_identity.gid == 0 and
      .rotation_anchor_identity.mode == "600" and
      (.rotation_anchor_identity.dev | positive_integer) and
      (.rotation_anchor_identity.ino | positive_integer) and
      ((.rotation_anchor_identity.state == "allocated" and
        .rotation_anchor_identity.sha256 ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" and
        .rotation_anchor_identity.size == 0) or
       ((.rotation_anchor_identity.state == "prepared" or
         .rotation_anchor_identity.state == "sealed") and
        (.rotation_anchor_identity.sha256 | test("^[a-f0-9]{64}$")) and
        (.rotation_anchor_identity.size | positive_integer)))
    end;
  .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
  .g0_commit == $g0_commit and .rollback_helper_sha256 == $helper_sha and
  ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
  all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
  ((.artifact_candidates | keys) == ["checker","diff_checker","format","inserter","log","rotate","service","timer"]) and
  all(.artifact_candidates[]; type == "string" and test("[.]candidate-gl-a-" + $operation_id + "$")) and
  .rollback_candidate == ("/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-" + $operation_id) and
  rotation_anchor_identity_is_valid' \
  "$RECORD" >/dev/null
BACKUP="$(jq -er '.site_backup' "$RECORD")"
BACKUP_SHA256="$(jq -er '.site_backup_sha256' "$RECORD")"
INSTALLED_SITE_SHA256="$(jq -er '.installed_site_sha256' "$RECORD")"
SITE_UID="$(jq -er '.original_site_uid' "$RECORD")"
SITE_GID="$(jq -er '.original_site_gid' "$RECORD")"
SITE_MODE="$(jq -er '.original_site_mode' "$RECORD")"
printf '%s' "$BACKUP" \
  | grep -Eq '^/var/backups/aifeeds-performance-log/aifeeds[.]conf[.]bak-perf-[0-9]{14}-[a-f0-9]{8}$'
printf '%s' "$SOURCE_JOURNAL" \
  | grep -Eq '^/var/backups/aifeeds-performance-log/transaction-[0-9]{14}-[a-f0-9]{8}[.]json$'
printf '%s' "$BACKUP_SHA256$SOURCE_JOURNAL_SHA256" | grep -Eq '^[a-f0-9]{128}$'
case "$INSTALLED_SITE_SHA256" in
  absent) ;;
  *) printf '%s' "$INSTALLED_SITE_SHA256" | grep -Eq '^[a-f0-9]{64}$' ;;
esac
printf '%s' "$SITE_UID:$SITE_GID:$SITE_MODE" | grep -Eq '^[0-9]+:[0-9]+:[0-7]{3,4}$'
ROLLBACK_ATTEMPT_ID="$(date +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
printf '%s' "$ROLLBACK_ATTEMPT_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
ROLLBACK_SUMMARY="$EVIDENCE/gl-a-manual-rollback-summary-${OPERATION_ID}-${ROLLBACK_ATTEMPT_ID}.json"
ROLLBACK_SUMMARY_TMP="$(mktemp "$EVIDENCE/.gl-a-manual-rollback-summary-${OPERATION_ID}-${ROLLBACK_ATTEMPT_ID}.XXXXXX")"
ROLLBACK_SUMMARY_TMP_DEV="$(stat -f '%d' "$ROLLBACK_SUMMARY_TMP")"
ROLLBACK_SUMMARY_TMP_INO="$(stat -f '%i' "$ROLLBACK_SUMMARY_TMP")"
ROLLBACK_SUMMARY_PUBLISH_ATTEMPTED=0
ROLLBACK_OUTPUT_TMP="$(mktemp "$EVIDENCE/.gl-a-manual-rollback-output-${OPERATION_ID}-${ROLLBACK_ATTEMPT_ID}.XXXXXX")"
ROLLBACK_OUTPUT_FINAL="$EVIDENCE/gl-a-manual-rollback-output-${OPERATION_ID}-${ROLLBACK_ATTEMPT_ID}.txt"
ROLLBACK_OUTPUT_TMP_DEV="$(stat -f '%d' "$ROLLBACK_OUTPUT_TMP")"
ROLLBACK_OUTPUT_TMP_INO="$(stat -f '%i' "$ROLLBACK_OUTPUT_TMP")"
ROLLBACK_OUTPUT_PUBLISH_ATTEMPTED=0
REMOTE_STAGE=''
cleanup_rollback_stage_best_effort() {
  if [ -n "$ROLLBACK_SUMMARY_TMP" ]; then
    if [ "$ROLLBACK_SUMMARY_PUBLISH_ATTEMPTED" = 1 ]; then
      printf 'manual summary publish collision; preserved owned tmp and unknown destination: %s %s\n' \
        "$ROLLBACK_SUMMARY_TMP" "$ROLLBACK_SUMMARY" >&2
    else
      remove_owned_local_tmp "$ROLLBACK_SUMMARY_TMP" "$ROLLBACK_SUMMARY_TMP_DEV" \
        "$ROLLBACK_SUMMARY_TMP_INO" || printf 'preserved unowned manual summary tmp: %s\n' \
        "$ROLLBACK_SUMMARY_TMP" >&2
    fi
  fi
  if [ -n "$ROLLBACK_OUTPUT_TMP" ]; then
    if [ "$ROLLBACK_OUTPUT_PUBLISH_ATTEMPTED" = 1 ]; then
      printf 'manual transcript publish collision; preserved owned tmp and unknown destination: %s %s\n' \
        "$ROLLBACK_OUTPUT_TMP" "$ROLLBACK_OUTPUT_FINAL" >&2
    else
      remove_owned_local_tmp "$ROLLBACK_OUTPUT_TMP" "$ROLLBACK_OUTPUT_TMP_DEV" \
        "$ROLLBACK_OUTPUT_TMP_INO" || printf 'preserved unowned manual transcript tmp: %s\n' \
        "$ROLLBACK_OUTPUT_TMP" >&2
    fi
  fi
  case "$REMOTE_STAGE" in
    /run/aifeeds-performance-log.*)
      ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
        "rm -rf -- '$REMOTE_STAGE'" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup_rollback_stage_best_effort EXIT
REMOTE_STAGE="$(ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  'set -eu; umask 077; stage=$(mktemp -d /run/aifeeds-performance-log.XXXXXX); chmod 0700 "$stage"; printf "%s\n" "$stage"')"
case "$REMOTE_STAGE" in /run/aifeeds-performance-log.*) ;; *) exit 1 ;; esac
scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem "$IMMUTABLE_ROLLBACK_HELPER" \
  root@154.12.188.231:"$REMOTE_STAGE/"

REMOTE_ROLLBACK_HELPER="$REMOTE_STAGE/${IMMUTABLE_ROLLBACK_HELPER##*/}"
set +e
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "test \"\$(sha256sum '$REMOTE_ROLLBACK_HELPER' | awk '{print \$1}')\" = '$ROLLBACK_HELPER_SHA256' && \
   timeout --signal=TERM --kill-after=30s 5m bash '$REMOTE_ROLLBACK_HELPER' '$REMOTE_STAGE' \
     '$BACKUP' '$BACKUP_SHA256' '$INSTALLED_SITE_SHA256' '$SITE_UID' '$SITE_GID' '$SITE_MODE' \
     '$SOURCE_JOURNAL' '$SOURCE_JOURNAL_SHA256'" 2>&1 \
  | tee "$ROLLBACK_OUTPUT_TMP"
ROLLBACK_PIPE_RESULTS=("${PIPESTATUS[@]}")
set -e
test "${#ROLLBACK_PIPE_RESULTS[@]}" -eq 2
ROLLBACK_SSH_RC="${ROLLBACK_PIPE_RESULTS[0]}"
ROLLBACK_TEE_RC="${ROLLBACK_PIPE_RESULTS[1]}"
chmod 0600 "$ROLLBACK_OUTPUT_TMP"
ROLLBACK_OUTPUT_PUBLISH_ATTEMPTED=1
publish_local_file_no_replace "$ROLLBACK_OUTPUT_TMP" "$ROLLBACK_OUTPUT_FINAL" \
  "$ROLLBACK_OUTPUT_TMP_DEV" "$ROLLBACK_OUTPUT_TMP_INO"
test ! -e "$ROLLBACK_OUTPUT_TMP"
test -f "$ROLLBACK_OUTPUT_FINAL"
test ! -L "$ROLLBACK_OUTPUT_FINAL"
test "$(stat -f '%Lp' "$ROLLBACK_OUTPUT_FINAL")" = 600
ROLLBACK_OUTPUT_TMP=''
ROLLBACK_OUTPUT_PUBLISH_ATTEMPTED=0
if [ "$ROLLBACK_TEE_RC" -ne 0 ]; then exit "$ROLLBACK_TEE_RC"; fi
if [ "$ROLLBACK_SSH_RC" -ne 0 ]; then
  printf 'GL-a manual rollback failed; transcript preserved at %s\n' \
    "$ROLLBACK_OUTPUT_FINAL" >&2
  exit "$ROLLBACK_SSH_RC"
fi
scp "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem \
  root@154.12.188.231:"$REMOTE_STAGE/gl-a-manual-rollback-summary.json" "$ROLLBACK_SUMMARY_TMP"
chmod 0600 "$ROLLBACK_SUMMARY_TMP"
jq -e --arg source "$SOURCE_JOURNAL" --arg operation_id "$OPERATION_ID" \
  --arg g0_commit "$G0_COMMIT" --arg helper_sha "$ROLLBACK_HELPER_SHA256" \
  --arg site_backup "$BACKUP" \
  --arg log_archive_manifest "$EXPECTED_LOG_ARCHIVE_MANIFEST" \
  --arg rollback_commit_marker "$EXPECTED_ROLLBACK_COMMIT_MARKER" '
  def positive_integer: type == "number" and . > 0 and . == floor;
  def rotation_anchor_identity_is_valid:
    if .rotation_anchor_identity == null then true
    else
      ((.rotation_anchor_identity | keys | sort) ==
        ["dev","gid","ino","mode","path","sha256","size","state","uid"]) and
      .rotation_anchor_identity.path ==
        ("/var/backups/aifeeds-performance-log/rotation-anchor-" + $operation_id + ".json") and
      .rotation_anchor_identity.uid == 0 and .rotation_anchor_identity.gid == 0 and
      .rotation_anchor_identity.mode == "600" and
      (.rotation_anchor_identity.dev | positive_integer) and
      (.rotation_anchor_identity.ino | positive_integer) and
      ((.rotation_anchor_identity.state == "allocated" and
        .rotation_anchor_identity.sha256 ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" and
        .rotation_anchor_identity.size == 0) or
       ((.rotation_anchor_identity.state == "prepared" or
         .rotation_anchor_identity.state == "sealed") and
        (.rotation_anchor_identity.sha256 | test("^[a-f0-9]{64}$")) and
        (.rotation_anchor_identity.size | positive_integer)))
    end;
  def runtime_inventory_is_valid:
    (.runtime_artifacts | type == "array") and
    (.runtime_artifacts | length) <= 8 and
    ([.runtime_artifacts[].name] | length == (unique | length)) and
    ([.runtime_artifacts[].final] | length == (unique | length)) and
    ([.runtime_artifacts[].candidate] | length == (unique | length)) and
    all(.runtime_artifacts[];
      (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
      (.name == "checker" or .name == "diff_checker" or .name == "format" or
       .name == "inserter" or .name == "log" or .name == "rotate" or
       .name == "service" or .name == "timer") and
      (.candidate | test("[.]candidate-gl-a-" + $operation_id + "$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and (.mode | test("^[0-7]{3,4}$")) and
      (.uid | type == "number" and . >= 0 and . == floor) and
      (.gid | type == "number" and . >= 0 and . == floor) and
      (.dev | positive_integer) and (.ino | positive_integer)) and
    (.runtime_artifacts_sealed | type == "boolean") and
    (if .runtime_artifacts_sealed then (.runtime_artifacts | length) == 8 and
      ([.runtime_artifacts[].name] | sort) ==
        ["checker","diff_checker","format","inserter","log","rotate","service","timer"]
     else true end);
  def rotation_snapshot_is_valid:
    .rotation_state_snapshot == null or
    ((.rotation_state_snapshot | keys | sort) ==
       ["generation","ledger","status","tail_record_sha256"] and
     (.rotation_state_snapshot.generation | type == "number" and . >= 0 and . == floor) and
     (.rotation_state_snapshot.tail_record_sha256 | test("^[a-f0-9]{64}$")) and
     (.rotation_state_snapshot.ledger | keys | sort) ==
       ["dev","gid","ino","mode","path","sha256","size","uid"] and
     .rotation_state_snapshot.ledger.path == .rotation_state_identity.provenance.path and
     .rotation_state_snapshot.ledger.dev == .rotation_state_identity.provenance.dev and
     .rotation_state_snapshot.ledger.ino == .rotation_state_identity.provenance.ino and
     .rotation_state_snapshot.ledger.uid == .rotation_state_identity.provenance.uid and
     .rotation_state_snapshot.ledger.gid == .rotation_state_identity.provenance.gid and
     .rotation_state_snapshot.ledger.mode == .rotation_state_identity.provenance.mode and
     (.rotation_state_snapshot.ledger.sha256 | test("^[a-f0-9]{64}$")) and
     (.rotation_state_snapshot.ledger.size | positive_integer) and
     (.rotation_state_snapshot.status == null or
      ((.rotation_state_snapshot.status | keys | sort) ==
         ["dev","gid","ino","mode","path","sha256","uid"] and
       .rotation_state_snapshot.status.path ==
         "/var/lib/aifeeds-performance-logrotate/status" and
       (.rotation_state_snapshot.status.uid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.gid | type == "number" and . >= 0 and . == floor) and
       (.rotation_state_snapshot.status.mode | test("^[0-7]{3,4}$")) and
       (.rotation_state_snapshot.status.sha256 | test("^[a-f0-9]{64}$")) and
       (.rotation_state_snapshot.status.dev | positive_integer) and
       (.rotation_state_snapshot.status.ino | positive_integer))));
  def rotation_identity_is_valid:
    if .rotation_state_identity == null then .rotation_state_snapshot == null
    else
      ((.rotation_state_identity | keys | sort) == ["directory","files","provenance"] and
       (.rotation_state_identity.directory | keys | sort) ==
         ["candidate","dev","gid","ino","mode","path","uid"] and
       .rotation_state_identity.directory.path == "/var/lib/aifeeds-performance-logrotate" and
       .rotation_state_identity.directory.candidate ==
         ("/var/lib/aifeeds-performance-logrotate.candidate-gl-a-" + $operation_id) and
       .rotation_state_identity.directory.uid == 0 and
       .rotation_state_identity.directory.gid == 0 and
       .rotation_state_identity.directory.mode == "750" and
       (.rotation_state_identity.directory.dev | positive_integer) and
       (.rotation_state_identity.directory.ino | positive_integer) and
       .rotation_state_identity.files == [] and
       (.rotation_state_identity.provenance | keys | sort) ==
         ["dev","genesis_record_sha256","gid","ino","mode","path","uid"] and
       .rotation_state_identity.provenance.path ==
         "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl" and
       .rotation_state_identity.provenance.uid == 0 and
       .rotation_state_identity.provenance.gid == 0 and
       .rotation_state_identity.provenance.mode == "600" and
       (.rotation_state_identity.provenance.dev | positive_integer) and
       (.rotation_state_identity.provenance.ino | positive_integer) and
       (.rotation_state_identity.provenance.genesis_record_sha256 | test("^[a-f0-9]{64}$")) and
       rotation_snapshot_is_valid)
    end;
  def backup_identity_is_valid:
    .site_backup_identity == null or
    ((.site_backup_identity | keys | sort) ==
       ["dev","gid","ino","mode","path","sha256","staging_gid","staging_mode","staging_uid","uid"] and
     .site_backup_identity.path == $site_backup and
     .site_backup_identity.sha256 == .backup_sha256 and
     .site_backup_identity.staging_uid == 0 and .site_backup_identity.staging_gid == 0 and
     .site_backup_identity.staging_mode == "600" and
     (.site_backup_identity.uid | type == "number" and . >= 0 and . == floor) and
     (.site_backup_identity.gid | type == "number" and . >= 0 and . == floor) and
     (.site_backup_identity.mode | test("^[0-7]{3,4}$")) and
     (.site_backup_identity.dev | positive_integer) and
     (.site_backup_identity.ino | positive_integer));
  .schema == 1 and .gate == "GL-a-manual-rollback" and
  .operation_id == $operation_id and .g0_commit == $g0_commit and
  .rollback_helper_sha256 == $helper_sha and .site_restored == true and
  ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
  all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
  ((.artifact_candidates | keys) == ["checker","diff_checker","format","inserter","log","rotate","service","timer"]) and
  all(.artifact_candidates[]; type == "string" and test("[.]candidate-gl-a-" + $operation_id + "$")) and
  .rollback_candidate == ("/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-" + $operation_id) and
  runtime_inventory_is_valid and rotation_identity_is_valid and backup_identity_is_valid and
  rotation_anchor_identity_is_valid and
  .log_archive_manifest == $log_archive_manifest and
  (.log_archive_manifest_sha256 | test("^[a-f0-9]{64}$")) and
  (.log_archive_manifest_generation | type == "number" and . >= 0 and . == floor) and
  (.log_archive_manifest_entry_count | type == "number" and . >= 0 and . == floor) and
  .log_archive_manifest_generation >= (3 * .log_archive_manifest_entry_count + 1) and
  .log_archive_manifest_generation <= (4 * .log_archive_manifest_entry_count + 1) and
  .rollback_commit_marker == $rollback_commit_marker and
  (.rollback_commit_marker_sha256 | test("^[a-f0-9]{64}$")) and
  (.source_journal_terminal_sha256 | test("^[a-f0-9]{64}$")) and
  (.rollback_journal_sha256 | test("^[a-f0-9]{64}$")) and
  (.backup_present | type == "boolean") and
  .metadata_restored == true and .timer_inactive == true and .service_inactive == true and
  .nginx_active == true and .front_status == 200 and .api_status == 200 and
  (.backup_sha256 | test("^[a-f0-9]{64}$")) and
  (.source_journal == $source) and (.rollback_journal | test("^/var/backups/aifeeds-performance-log/rollback-transaction-"))' \
  "$ROLLBACK_SUMMARY_TMP" >/dev/null
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "set -eu; test ! -e '$REMOTE_ROTATION_ANCHOR'; test ! -L '$REMOTE_ROTATION_ANCHOR'"
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "set -eu; for path in \
    /etc/nginx/conf.d/aifeeds-performance-log.conf \
    /etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-$OPERATION_ID \
    /var/log/nginx/aifeeds-performance.jsonl \
    /var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-$OPERATION_ID \
    /usr/local/sbin/aifeeds-check-nginx-request-id \
    /usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-$OPERATION_ID \
    /usr/local/sbin/aifeeds-verify-nginx-request-id-diff \
    /usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-$OPERATION_ID \
    /usr/local/sbin/aifeeds-insert-nginx-request-id \
    /usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-$OPERATION_ID \
    /etc/aifeeds-performance-logrotate.conf \
    /etc/aifeeds-performance-logrotate.conf.candidate-gl-a-$OPERATION_ID \
    /etc/systemd/system/aifeeds-performance-logrotate.service \
    /etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-$OPERATION_ID \
    /etc/systemd/system/aifeeds-performance-logrotate.timer \
    /etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-$OPERATION_ID \
    /var/lib/aifeeds-performance-logrotate \
    /var/lib/aifeeds-performance-logrotate.candidate-gl-a-$OPERATION_ID; do \
      test ! -e \"\$path\"; test ! -L \"\$path\"; \
   done; \
   ! systemctl is-active --quiet aifeeds-performance-logrotate.timer; \
   ! systemctl is-active --quiet aifeeds-performance-logrotate.service"
ROLLBACK_SUMMARY_PUBLISH_ATTEMPTED=1
publish_local_file_no_replace "$ROLLBACK_SUMMARY_TMP" "$ROLLBACK_SUMMARY" \
  "$ROLLBACK_SUMMARY_TMP_DEV" "$ROLLBACK_SUMMARY_TMP_INO"
ROLLBACK_SUMMARY_TMP=''
ROLLBACK_SUMMARY_PUBLISH_ATTEMPTED=0
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "case '$REMOTE_STAGE' in /run/aifeeds-performance-log.*) rm -rf -- '$REMOTE_STAGE' ;; *) exit 1 ;; esac"
REMOTE_STAGE=''
trap - EXIT
```

每次人工 helper 调用都会生成新的 operation+attempt bound `attempt transcript`；final 名称同时含
operation id 与 attempt id，发布使用 no-clobber rename。远端 stdout/stderr 先写私有 tmp，立即捕获
`PIPESTATUS`，再把 tmp 设为 0600 并发布 final，之后才执行 SSH/tee 退出码门禁，因此失败重试不会覆盖
前一次 transcript。随后取回的 summary 还必须在本地 `jq` 中精确验证 operation-bound archive manifest
和 terminal-pair commit marker 的路径及各自 64 位小写十六进制 SHA-256。
本地 evidence 的 forward transcript、forward summary、manual transcript 和 manual summary 全部使用
same-parent NOREPLACE publication，并在成功 rename 后对 parent directory 执行 fsync。publish collision
必须同时保留 owned tmp 与 unknown destination，不允许覆盖或猜测接管。每个 tmp 由 `mktemp` 的 O_EXCL
allocation 创建；只有随即记录的 recorded dev/ino 才能授权 failure cleanup，当前 pathname、同内容或同 hash
都不是删除依据。

回滚只撤销 nginx performance logging/request-id 传播与专用 timer，不改 Worker、Pages、DNS、证书或数据。
root-only backup、事务 journal 与审计日志默认保留复盘；精确删除仍需另一次明确审批。
<!-- aifeeds-performance-log:end -->

<!-- aifeeds-list-projection:start -->
#### C 端 list projection、GitHub 封面门禁与 ClawHub 索引（2026-07-11，本地完成，远端未执行）

**当前状态**：`/api/items` 六类列表 SQL 已改为显式列 + source-specific compact `extra`；详情
`/api/items/:id` 和搜索仍保留各自完整契约。排序/游标辅助列全部使用 `_` 前缀，只在 Worker
内部生成 cursor，不进入 list JSON。普通列表和官方新闻的新 cursor 以 `v2|...` 开头并包含
`_untranslated_rank`；旧 cursor 仍可读。Huodongxing 缺失开始时间统一使用与 ORDER BY 相同的
`9999` key，GitHub/PH 的 `cursor+pinned` 参数顺序也已修正。Hot 列表的新 cursor 使用
`v2h|score|id|rank_now`，后续页沿用第一页的冻结时间计算衰减分，避免边界 item 因时钟前进重复出现；
未来或无法解析的发布时间按 `age_hours=0` 计算，保证 score 始终有限且由 `id` 完成稳定全序；格式、
score、id 或 `rank_now` 非法的 `v2h` cursor 直接返回 `400 invalid_cursor`，不得静默退回第一页。
旧 `score|id` cursor 仍可读。

本次只完成代码、测试、本地 SQLite JSON1/EXPLAIN 验证；**未部署 Worker、未运行 staging/prod
GitHub 回填、未对任何远端 D1 应用 migration 028**。下面每个远端写动作仍需独立审批。

**GitHub `cover_url` 覆盖门禁**：新 enrich 在 README 抓取后写
`cover_status='ok' + cover_url` 或 `cover_status='none'`，R2 rewrite 后再次计算最终 cover。
README 的全部候选明确 404/空 2xx 才算 confirmed absent；网络错误、429、5xx 与其他非 404
会抛出并保持 workflow 可重试，不能把瞬时失败固化为 `cover_status='none'`。
列表 projection 只有看到可信 `cover_status IN ('ok','none')` 才不再携带隐藏 README；旧的非空
但非法 `javascript:`/SVG/badge cover 不算完成。一次性 mode 默认 dry-run：

```bash
# staging dry-run：只报告 candidates/covers/none/remaining，零写
curl -sS -X POST \
  'https://staging-api.ai-feeds.com/api/enrich/run?mode=github-cover-backfill&dry_run=1&limit=100' \
  -H "Authorization: Bearer $INGEST_TOKEN" | jq
```

写模式必须在 staging 单独获批后才把 `dry_run=0`，按返回的 `next_cursor` 传
`after_id=<urlencoded id>` 分批继续；遇到 `errors>0` 或 `conflicts>0` 时 cursor 会归零，必须从头
重扫。`complete=true` 不是“本页不足 limit”，而是全局 remaining COUNT=0 且无 error/conflict。
候选范围严格为 GitHub feed 可见的 relevant、未删、非 sponsor、workflow-complete 行；UPDATE 用
原 `extra` compare-and-swap，drawer 的 on-demand refresh 也只 `json_set` 局部字段，避免覆盖并发
cover marker。生产回填需另一次生产数据审批；在 staging/production 各自 `complete=true` 前不得
删除隐藏 README fallback。

**migration 028 只优化已证实的 ClawHub 默认 SQL**：

- `idx_items_clawhub_feed_stars`：`category=all&sort=stars`；
- `idx_items_clawhub_category_stars`：具体 category equality + stars/id 顺序；
- 两者都是 relevant、未删、非 suspicious 的 partial expression index；
- 没有为 PH、news、X/HF、GH、HDX 新增索引。PH persisted rank 仍需单独版本化 cursor/重排设计；
  news 的时间动态 score 也不能用静态索引假装解决。

staging 获批后的顺序（当前未执行）：

```bash
cd worker
npm test -- --run src/list-query-plan.test.ts
npx wrangler d1 execute xlist-staging --env staging --remote \
  --file=migrations/028-feed-list-query-indexes.sql
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="EXPLAIN QUERY PLAN SELECT id FROM items WHERE source_type='clawhub' AND is_relevant=1 AND deleted_at IS NULL AND COALESCE(json_extract(extra,'$.is_suspicious'),0)=0 ORDER BY CAST(json_extract(metrics,'$.stars') AS INTEGER) DESC,id ASC LIMIT 31"
```

验收必须同时记录默认 all/category 的 EXPLAIN、结果/next_cursor 对比、D1 P75、Worker
`Server-Timing`、identity/gzip；要求 ClawHub 不再出现 `USE TEMP B-TREE FOR ORDER BY`，且结果和
游标无回归。projection 后实测若 PH/news/X/HF 没超过计划阈值，禁止顺手加索引。

生产 apply 仍需单独审批和已记录的 staging 证据。精确回滚 SQL：

```sql
DROP INDEX IF EXISTS idx_items_clawhub_feed_stars;
DROP INDEX IF EXISTS idx_items_clawhub_category_stars;
```

回滚后重新跑两条 EXPLAIN 与列表 cursor smoke；索引回滚不要求回滚 compact DTO。若 DTO/字段或
分页有回归，应回滚 Worker 版本，而不是删除索引来掩盖应用层问题。
<!-- aifeeds-list-projection:end -->

<!-- aifeeds-card-image-variants:start -->
#### C 端卡片图片变体与第三方图片受控链路（2026-07-11，本地完成，远端写未执行）

**选型证据**：只读生产 spike 用同一张 X 图片比较了原图与现有严格白名单 `/img`：原图
622×1199、98,244 B、TTFB 约 0.95s；`w=400` 返回 400×771 AVIF、35,092 B，但冷 TTFB
约 2.92s，warm 仍约 1.34s；`w=800` 因 `scale-down` 实际仍为 622×1199。视频 R2 Range
请求返回 `206`、1024 B。结论是 `/img` 适合活动行/HF 等存量或第三方兜底，但不应把每张首屏图的
冷转换放在用户请求上；新内容在外部资源迁 R2 时预生成 400/800 请求档的 WebP，记录**实际**输出
宽高并内容寻址存入 `/r/<source>/card/`。未对 production/staging 发出任何写请求。

**代码契约**：`worker/src/card-image-variant.ts` 只接受 HTTPS 静态图片，拒绝 GIF/SVG、音频、
视频、私网、本站所有子域和 `*.workers.dev`，并以 `redirect=error` 防止首跳外链重定向回本服务。
源 Content-Type 未知时先用同源 UA 做 HEAD 探测，无法确认静态类型就跳过；Cloudflare 转换固定
`anim:false`，不会把动画带进卡片变体。
每个 item 最多生成一个主视觉的两档变体，原图始终保留给详情、Lightbox 与旧浏览器。X 转推使用
翻转后的 `retweet_of` 主视觉；视频只可能生成 poster 变体，mp4 不进入转换。PH 跳过 logo、avatar
与视频 body；HF 兼容 `figure_image.raw_url`；博客在品牌图护栏/body hero 回落之后只处理最终采用
封面；播客音频迁移完全不变。标量封面使用 `cover_variant_source` 绑定当前 cover，避免后续 sweep
换图后误用旧变体。

前端有变体时使用 `<picture><source type="image/webp">`，变体加载失败先移除 source 再重试原图；
没有变体的 HF/活动行候选走 `/img` 的 400/800 受控 URL。`/img` host 白名单为活动行卡片新增
`cdn.huodongxing.com`、`wimg.huodongxing.com`、`nscdn.huodongxing.com`，并为 GitHub 已知图片
重定向链补充 `private-user-images.githubusercontent.com`、`objects.githubusercontent.com`、
`camo.githubusercontent.com`。首跳和最多三次后续跳转都重新验证 HTTPS 与同一严格白名单，
不允许借重定向访问私网或任意 host；每一跳按验证后的 `currentTarget` 生成独立 cache key，避免
缓存的首跳 3xx 在最终 URL 上自我重放；宽度/质量均有限分桶，
`Accept` 独立选择 AVIF/WebP 且 cache key 含格式。图片响应和 `/r` 增加
`Timing-Allow-Origin`。`video.twimg.com` 才转发 `/img` Range 且不走 `cf.image`；`/r` 的 206、
`Content-Range`、`Accept-Ranges` 与 hotlink gate 保持原契约。

视频 poster 也服从页面媒体预算：只有首屏 `eager/high` 视频立即写入 `poster`，其余视频在距离
当前滚动容器 200px 内或收到 hover、pointer、focus、play 等明确意图后才注入；PC 以各自
`.feed-body` 为观察根，移动端以文档 viewport 为根。Tweet 视频优先使用精确 400px 的已存 WebP
poster 变体（再退到不小于 400px 的最小合法档和受控 `/img?w=400`），LinkCard 始终使用受控
代理；不得为了封面提前读取 mp4。Playwright 门禁同时统计 poster 网络请求，保证屏外 lazy
poster 为零、意图只放行目标视频且不会请求 800px 档。

**存量回填门禁**：ops mode 默认 dry-run、永不由 cron 调用：

```bash
# 只读 inventory；当前未执行远端请求
curl -sS -X POST \
  'https://staging-api.ai-feeds.com/api/enrich/run?mode=card-image-variant-backfill&dry_run=1&limit=10' \
  -H "Authorization: Bearer $INGEST_TOKEN" | jq
```

写模式 `dry_run=0` 同时创建 R2 对象并 CAS 更新 D1，必须先单独取得 staging 数据写审批。它从仍
保留的 HTTPS 原链、R2 对象 `src-url` metadata 或 HF `figure_image.raw_url` 恢复上游，并携带各源
实时迁移使用的 User-Agent。标量封面与 `cover_variant_source` 失配时，即使 version=1 也重新进入；
失败会清掉旧变体并绑定本次尝试的 cover，下一次换图仍可重跑但不会无限重下。恢复不到写
`card_variant_status=source_unavailable` 终态，转换失败写 `transform_failed`，两者都写 version=1，
不会永久重下；单行 malformed JSON 计入 errors 而不会让整批 500。每批最多 25，按
`next_cursor` 继续；任何 conflict/error 都停止推进。staging 完成
后必须抽验 source 绑定、400/800 实际字节/尺寸、DPR 1/2/3 清晰度、CLS、X 视频 seek 与播客音频
seek，且典型 360–400 CSS px 卡图目标 ≤40 KiB；production 写需另一次审批。

**回滚**：先回滚 Dashboard/Worker 到前一版本；原图字段未被删除，因此卡片会自然退回原图或
受控 `/img`。变体对象是内容寻址且无业务唯一性约束，无需紧急删除。若要清理，只能在引用审计后
删除独立的 `<source>/card/` key，禁止清共享 `/r` 音视频或 `/img` cache。D1 marker/variant 字段位于
JSON，可保留；回滚代码会忽略它们。
<!-- aifeeds-card-image-variants:end -->

<!-- aifeeds-same-origin-api:start -->
#### 同源 API perf staging 与生产切换（2026-07-12，执行包已版本化，当前未部署）

**状态与权限边界**：本节只记录本地代码、构建脚本、版本化模板和未来操作步骤。精确命令、停止线
与逐项回滚见
[`docs/reviews/c-end-perf-staging-change-packet.md`](reviews/c-end-perf-staging-change-packet.md)。当前未创建
`xlist-dashboard-perf` Pages 项目，未创建 `perf-staging.ai-feeds.com` DNS/证书，未复制
[`deploy/nginx/aifeeds-api-location.conf`](../deploy/nginx/aifeeds-api-location.conf) 到 VPS，未执行
`nginx -t` / reload，也未部署 staging 或 production。下列每类外部动作都必须先取得对应的
**独立明确审批**；代码合并、构建成功或“继续计划”不构成 Pages、DNS、证书或 VPS 变更授权。

现有 `staging.ai-feeds.com` / `staging-api.ai-feeds.com` 直接经过 Cloudflare，不经过香港 VPS，
因此不能用它验证生产同源拓扑。实验必须使用隔离的 `perf-staging.ai-feeds.com`：页面壳经香港 VPS
回源专用 `xlist-dashboard-perf.pages.dev`，同一 host 的 `/api/` 经香港 VPS 回源 staging Worker。
**现有 staging 保持不变**，生产也继续使用 `https://api.ai-feeds.com`，直到各自路由存在且单独获批。

**构建矩阵与解析优先级**：`VITE_API_SAME_ORIGIN=true` 明确优先于 `VITE_API_BASE`；因此专用
perf build 即使读取 checked-in `.env.staging`，也使用相对 `/api`。host fallback 不能覆盖显式
external base，避免普通 staging/Pages artifact 被误切同源。

| 命令 / artifact | API base | 允许的承载面 |
|---|---|---|
| `npm run build` / `npm run deploy` | `https://api.ai-feeds.com` | 普通 production 与 production Pages preview |
| `npm run build:staging` / `npm run deploy:staging` | `https://staging-api.ai-feeds.com` | 现有 staging 与 staging Pages preview |
| `npm run build:perf-staging` | `''`（相对 `/api`） | 仅已具备 `/api/` route 的 `perf-staging.ai-feeds.com` |
| `npm run build:same-origin` | `''`（相对 `/api`） | 仅生产 front `/api/` route 验收后生成本地产物 |
| `npm run deploy:same-origin` | 固定 fail-closed（退出码非 0） | 不部署；只指向本节获批操作包，不能被 `SKIP_PREDEPLOY_CHECK` 绕过 |

普通 localhost 继续用相对路径交给 Vite proxy。`www.ai-feeds.com` 正常在 nginx 先跳转，不作为
应用承载面。专用 perf artifact 直接打开 `xlist-dashboard-perf.pages.dev` 时没有同源 `/api`，
预期不能作为验收面；普通 production/staging Pages preview 则始终使用上表外域 API。
HTML 的首流预取与应用 resolver 使用同一优先级：同源 build 请求相对
`/api/items?source_type=x_list&limit=12`，不会预连 `api.ai-feeds.com`；external build 才动态加入
对应 API origin 的 preconnect/dns-prefetch。

2026-07-12 只读采证确认：`perf-staging.ai-feeds.com` 还没有 DNS 记录；生产主域和同 VPS 的隔离测试域
均为 DNS-only A，故本实验也固定为 DNS-only A、TTL 120；VPS 是 nginx 1.24.0 / certbot 2.9.0，
resolver 为 `1.1.1.1`、`1.0.0.1`；staging 未配置 `ORIGIN_SECRET`，Worker gate 关闭。这些事实只用于
版本化变更单，没有创建记录、签证书或 reload。

DNS credential 另有硬门：当前统一 env 的 `CLOUDFLARE_API_TOKEN` 按本章权限真值只有
Worker/Pages/D1/KV/R2，没有 Zone/DNS；当前 env 也没有 `CF_OPS_API_TOKEN`。因此 DNS gate 是
**BLOCKED**，不得拿 deployment token 试写，也不得静默读取历史 `.bak`。必须由 credential owner 在
独立审批下提供精确 `ai-feeds.com` zone、最长 24 小时且只有 `Zone Read` + `DNS Edit` 的子 token，
以 0600 临时文件交给变更单；创建和撤销子 token 与创建/删除 DNS record 是分开的审批边界。

**版本化 nginx 模板**：通用生产 location 模板只能放在目标 public site front `server` 内、SPA `location /` 之前；
不得放进现有 staging、admin、webhook、API 或其他 virtual host。它故意包含以下占位符，仓库中
没有任何 secret：

| 占位符 | perf staging 私有渲染值 | production 私有渲染值 |
|---|---|---|
| `__WORKER_UPSTREAM_HOST__` | staging Worker 的 workers.dev host | production Worker 的 workers.dev host |
| `__PUBLIC_API_HOST__` | `staging-api.ai-feeds.com` | `api.ai-feeds.com` |
| `__ORIGIN_SECRET__` | 以 staging Worker 实际 gate 配置为准 | prod `ORIGIN_SECRET`；只在私有 VPS 会话注入 |

模板用无 URI 后缀的 `proxy_pass` 保留完整 `/api/...` 与 query；Cookie、Authorization、
`X-Forwarded-*`、回源 gate 和 `X-Request-Id` 透传到 Worker，并显式保留响应的 `Set-Cookie`、
`Server-Timing`、`X-Request-Id`。`proxy_cache off` + bypass/no-cache 防止 front 继承缓存后误存
登录、favorite、subscription、feedback 或其他个性化/mutation 响应。不得在本任务顺手增加
microcache、cookie rewrite、CORS header rewrite 或 admin/webhook 转发。

模板不是可直接安装的配置。获批后的私有 VPS 会话必须先备份实际 site 文件，用不会回显值的方式
对照现有 API location 的完整 `proxy_set_header`、body-size、timeout、buffering 与 SNI 设置；差异
逐项解释后把占位符渲染到临时文件。禁止把 `nginx -T` 全文、`X-Origin-Secret`、Cookie、
Authorization 或渲染后的配置复制到日志、PR 或本仓库。

perf-staging 不渲染这个含 secret 占位符的通用 location，而使用两份无 secret、固定 staging 身份
的完整配置：首次签证书前用
[`deploy/nginx/aifeeds-perf-staging-bootstrap.conf`](../deploy/nginx/aifeeds-perf-staging-bootstrap.conf)
只开放 HTTP-01；签发后替换为
[`deploy/nginx/aifeeds-perf-staging-server.conf`](../deploy/nginx/aifeeds-perf-staging-server.conf)。后者在
nginx 1.24 上用 `resolver` + 变量 `proxy_pass` 让 Pages/Worker hostname 每 30 秒安全重解析。Worker
upstream 使用已验证的 `staging-api.ai-feeds.com`；`xlist-api-staging.ltsms86.workers.dev` 的
`/api/*` 在 2026-07-16 现场返回 404，只是部署身份，不能用于此链路。API route 固定
`X-Forwarded-Host: staging-api.ai-feeds.com`，不发送 `X-Origin-Secret`，且页面/API 都
显式禁用 cache；SPA fallback 前另有与生产同形的 `/daily`、`/i/*`、robots/sitemap/llms Worker
route，防止 SEO 页面被 Pages 壳吞掉，裸 `/i` 则仍交给 SPA。两者都必须先 `nginx -t`，成功后才
reload。所有 public TLS upstream 都用系统 CA 验证；Pages fallback 明确清空 Cookie、Authorization
和运维敏感头，不能把 `.ai-feeds.com` session 发给 pages.dev；API body 上限为 6 MiB，覆盖现有
5 MiB feedback 图片加 multipart framing。

**外部门禁与 perf staging 顺序（均未执行）**：

1. 经 Cloudflare Pages 独立审批，创建专用项目 `xlist-dashboard-perf`，只部署已本地验证的
   `npm run build:perf-staging` artifact；绝不覆盖 `xlist-dashboard-staging`。
2. 经 DNS 与证书独立审批，把 `perf-staging.ai-feeds.com` 指向香港 VPS 并签发/安装仅该实验 host
   所需证书；记录变更前值和逐项回滚值。
3. 经 VPS/nginx 独立审批，在新的 perf-staging front server 中先放 `location ^~ /api/`，再放
   Pages SPA fallback；私有渲染模板后先运行 `nginx -t`，成功才允许 reload。
4. 仅在 DNS、证书、Pages、nginx 全部 ready 后从 `perf-staging.ai-feeds.com` 验收。任何直接 Pages
   URL、现有 staging 或本地 proxy 的成功都不能替代这一拓扑验收。

**完整验收矩阵**：desktop Chromium 1440×900、tablet Chromium 820×1180、iPhone-like Chromium
390×844、iPhone WebKit 390×844、Android Chromium 412×915 都要跑匿名与登录态。每项记录
commit、Pages deployment、nginx config backup、Worker
version、request id、状态码和浏览器网络证据，但不得记录验证码、session Cookie 或用户内容。

- 网络基线：首个 HTML 与 `/api/items` 复用 `perf-staging.ai-feeds.com` 的 HTTP/2/TLS session；
  API connect/TLS 为 0 或可解释的复用值；没有指向 staging API origin 的 CORS OPTIONS；首流预取
  与 React 请求归一化后只有一次；响应保留 `Server-Timing` 和与 nginx/Worker 可 join 的
  `X-Request-Id`。
- 匿名面：首页/feed、manifest、搜索与 suggest；列表一次失败后的正常恢复；无权限写操作仍返回
  原有状态，不因 nginx 变成 HTML/缓存响应。匿名 `/api/auth/me` 必须返回 `200 {"user":null}` 且不得
  命中共享缓存；需要登录的接口仍按原契约返回 401。
- 既有登录：带已有 Cookie 打 `/api/auth/me`，身份保持且响应 `Set-Cookie` 属性未被 nginx 改写；
  刷新、开新 tab 和 PC/移动端切换后仍登录。
- 邮件验证码：`/api/auth/email/send` → `/api/auth/login` → `/api/auth/me` → `/api/auth/logout`
  完整闭环。验证码只在受控测试账号和私有界面使用，不写验收日志。
- SMS：保持当前产品开关禁用；本批次已把 `/api/auth/sms/send` 改为只有
  `ENABLE_SMS_LOGIN === 'true'` 才继续，其他值在解析、Turnstile、DB、额度和 provider 前 fail-closed。
  验收只提交空 JSON 并断言 `403 / reason=sms_disabled`，不得填手机号/验证码，也禁止临时打开通道。
- 登录互动：subscription 读取/更新/退订、feedback 文本与允许大小的图片上传/mine/read/unread，逐项
  验证 CSRF/Cookie、状态码和刷新后持久化；不得使用真实用户内容。`favorite` 记为 **N/A**：当前仓库
  没有 `/api/favorites` route、favorites table 或收藏 UI，不能用不存在的能力伪造通过项。
- 分享：`/api/share/create`、poster、landing 与 `/s/:token` 二维码/跳转；规范公开 URL 仍由
  Worker 环境的 `SITE_BASE` / `API_BASE` 生成，不能变成 workers.dev 或 perf host。
- SPA 深链族逐一冷开与刷新：`/t/:id`、`/g/:owner/:repo`、`/ph/:slug/:date`、`/c/:slug`、
  `/e/:eventId`、`/h/:arxivId`、`/o`、`/o/:id`、`/s/:token`、`/search`、`/settings`、
  `/settings/account`、`/feedback`、`/subscribe`、`/me/subscription`。
- Worker/SEO 深链保持原路由：`/daily`、`/daily/:date`、`/i/` item pages、`/robots.txt`、
  `/sitemap.xml`、sitemap shards、`/llms.txt` 和静态 hashed assets。`^~ /api/` 不得吞掉这些路径。
- 错误/安全：401/403/404/429/5xx 不被缓存；Cookie 不串用户；CORS、字体和媒体 Range 行为与当前
  staging 约定一致。**staging 限制必须显式记为 N/A**：该 Worker 未设 `ORIGIN_SECRET`，所以 gate
  关闭，`getClientIp` 不信任 VPS 的 `X-Forwarded-For` 而回落到 Worker 看到的 VPS
  `CF-Connecting-IP`；perf-staging 不能证明 production origin gate、真实访客 IP 或 per-IP 限流。
  验收只用单个低频测试账号，生产 route 上线前必须在私有带 secret 链路另验这三项。

验收至少比较 external staging 与 perf staging 的 cold/warm `perf_api` DNS/connect/TLS/request/total、
`feed_ready`、FCP/LCP、transfer、错误率；预期因果信号是同源 API 不再支付第二次 TLS 且没有
CORS OPTIONS。只跑 curl 或 synthetic 不能替代真机/浏览器功能矩阵，也不能冒充真实 RUM。

**生产切换（另一次独立生产审批）**：

1. 先备份 production front 配置，私有渲染 prod 占位符并加入 `/api/` location；当前 dashboard
   仍是 external build，所以新增 route 此时没有用户流量。`nginx -t`、reload、匿名/auth header
   smoke 全绿后再继续。
2. `npm run deploy:same-origin` 默认永远拒绝生产发布；不得临时改 package script 或用
   `SKIP_PREDEPLOY_CHECK` 绕过。获批操作包必须写明 exact clean `main` commit、已验收 route 的
   request-id 证据、执行人与回滚人。只有该次审批覆盖的私有操作会话才执行：

   ```bash
   cd dashboard
   npm run build:same-origin
   npx wrangler pages deploy dist --project-name=xlist-dashboard --branch=main --commit-dirty=false
   ```

   部署后立即完成 items/manifest/search/auth/subscription/feedback/share/deep-link smoke，确认
   request-id join、`Set-Cookie` / `Server-Timing` 和 API-origin OPTIONS=0。
3. 单独观察至少 48 小时，按性能计划的 all-clean/engaged、PC/移动端和错误停止线判断；不得同时
   叠加微缓存、地域路由或其他基础设施实验。

**可执行回滚顺序**：应用回滚永远先于 route 删除，避免两个依赖必须在同一瞬间成功。

1. 出现回归时**保留 `/api/` route**，停止其他变更；运行现有 `cd dashboard && npm run deploy`
   重新构建/部署 external-API artifact。该 build 会恢复 `https://api.ai-feeds.com`，同时留下的
   same-origin route 对用户无害。
2. 验证首页/feed/search、`/api/auth/me`、邮件验证码、logout、subscription、feedback、
   share 与全部深链已通过外域 API 恢复；确认错误率和 request waterfall 回到基线。
3. external build 稳定后，才在另一次获批 VPS 动作中按部署时的精确 backup 或审查过的反向 diff
   删除未使用的 production `/api/` location，执行 `nginx -t` 后 reload。不要用通配符猜 backup，
   不要 purge 无关缓存。
4. 若 route 本身导致 front 故障而 Pages external artifact 尚健康，可先用部署时精确备份恢复 nginx；
   仍需验证 external API 完整功能。记录回滚时刻、原因、artifact 与 config version。

perf staging 回滚彼此独立：Pages project、DNS/证书和 VPS server block 各自使用变更单中的精确旧值，
不得借“清理实验”改现有 staging。删除任何外部资源同样需要明确审批。
<!-- aifeeds-same-origin-api:end -->

<!-- aifeeds-upstream-performance:start -->
#### Worker upstream keepalive / list microcache 实验门禁（2026-07-12，keepalive BLOCKED）

**结论先行**：当前不启用 keepalive，也不启用 microcache。Task 11 的 topology-faithful perf
staging、Task 3 分段 nginx 日志以及 Task 9 远端 projection/index 时序证据均未部署；现有
staging 不经过香港 VPS，不能提供可信 A/B。仓库中的
[`deploy/nginx/aifeeds-upstream-performance.conf`](../deploy/nginx/aifeeds-upstream-performance.conf)
含未渲染 resolver/upstream 占位符，**不得安装**，且明确 `proxy_cache off`。

2026-07-12 已获批的只读 VPS 采证确认实际为 **nginx 1.24.0**。开源 nginx 只有从 **1.27.3** 起
才支持本设计所需的 `upstream server ... resolve` 安全动态重解析；因此当前 keepalive A/B/A
状态为 **BLOCKED**，不安装 template、不跑伪 A/B，也绝不固定 Cloudflare IP。计划中的预期收益仅
20–30ms，不足以附带授权升级生产 nginx。纯函数能力门
[`deploy/nginx/nginx-capability.mjs`](../deploy/nginx/nginx-capability.mjs) 会把 1.24.0 判为
`resolver+variable-proxy_pass`，只有另行批准升级并验证至少 1.27.3 后才可重新打开本节实验。

未来若能力门重新打开，命名 upstream 只替换 Task 11 私有渲染 location 的
`proxy_pass`；真实 Worker hostname 仍分别写入 `Host` 和 `proxy_ssl_name`，origin secret、
Cookie、Authorization、request id 与其他 header 完全沿用原 location。

获批后的 perf-staging A/B 使用安全脚本（会拒绝 production、任意 host 与个性化 endpoint）：

```bash
node scripts/benchmark-aifeeds-upstream.mjs \
  --url 'https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=12' \
  --warmup 20 --requests 100 --concurrency 1
node scripts/benchmark-aifeeds-upstream.mjs \
  --url 'https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=12' \
  --warmup 20 --requests 100 --concurrency 8
```

至少做 A/B/A 三轮并跨两个 resolver TTL；100% 2xx，P50/P95 的 nginx
`upstream_connect_time` 与 `upstream_header_time` 都改善，`request_time` 不得恶化 >5%，稳定收益
至少 15ms。收益 <10ms、仅单一分位改善、轮次反转或错误率增加 >0.5pp 均不采用。之后在隔离
perf staging 观察 24 小时；生产仍需单独审批且不得与同源切换同批。

脚本会给 warmup 使用独立 probe；输出的正式 `run_id` 只随 `requests` 正式样本发送。nginx 只接受
该脚本生成的受限格式，并写入性能日志的 `perf_probe`。每个 A/B/A 输出必须单独保存，按其
`run_id = perf_probe` 过滤日志后再计算 connect/header/request 分位，禁止把 warmup、相邻轮次或
普通访客请求混在一起比较。若日志中正式 `run_id` 的数量与脚本 `requests` 对不上，先停止实验并查
转发/轮转链路，不能用残缺样本下结论。

microcache 只有 projection/index 后公开 list 的 D1+Worker P75 仍约 ≥150ms、占 API 总耗时
≥25%，且 20 秒窗口存在足够重复请求时才进入另一份设计/评审。未来即使启用，也只能是两个 exact
GET location（`/api/items`、`/api/feed-manifest`）和独立 cache zone/path；Authorization、任意
Cookie、非 GET、cursor、pinned、未知参数、非 200、`Set-Cookie` 全部 bypass/no-store，禁止
`use_stale`，禁止复用现有图片/字体 cache。cache HIT 必须隐藏填充请求的旧
`X-Request-Id`/`Server-Timing`，重新输出本次 nginx request id 与真实 cache timing，否则三段
观测会错误 join。

回滚彼此独立：keepalive 只恢复原 workers.dev `proxy_pass` 并移除 upstream include；microcache
若未来获批，只移除两个 exact location并清其独立目录。两者都不得删除 Task 11 同源 `/api/`
route、回滚 Dashboard artifact或清 `/img`、`/r`、页面壳缓存。
<!-- aifeeds-upstream-performance:end -->

> **2026-06-09 首屏提速（根因 = nginx 还在 HTTP/1.1）**：perf_nav 埋点实测大陆冷加载 `tcp:969 tls:347 ttfb:1353 load:7638`、但 `下载≈0` —— 慢在「每个资源单独冷建连」，不是下载。修：① 三个 443 server 块 `listen 443 ssl;` → `listen 443 ssl http2;`（含 `hktest.conf` 一起改，否则 0.0.0.0:443 protocol options redefined warning）；② `nginx.conf` 取消注释 `gzip_vary/gzip_proxied any/gzip_comp_level 6/gzip_types ...text/css...` —— 让 VPS 给 R2 来的字体 CSS 压缩（106KB→37KB，CF Pages 的 JS/CSS 仍是 br 透传不受影响）。TLS1.3 + BBR+fq 早已开。备份 `*.bak-20260609-100702`，回滚 = `cp` 回去 + `nginx -t && systemctl reload nginx`。验证：`curl --http2 -I https://ai-feeds.com/` 看 `HTTP/2`、字体 `content-encoding: gzip`。
>
> **2026-06-09 续（封面图 + www 规范化）**：① api server 块加 `location /img { proxy_pass …workers.dev; proxy_cache aifeeds_cache; proxy_cache_valid 200 30d; proxy_cache_key "$scheme$request_method$host$request_uri"; … }` —— 封面图(cf.image 缩到 ~7KB、`immutable` 1 周)改在香港边缘缓存,不再每张回源 worker(实测 `X-Cache-Status: MISS→HIT`)。② `www.ai-feeds.com` 拆出独立 server 块 `return 301 https://ai-feeds.com$request_uri`(复用 ai-feeds.com 证书,SAN 已含 www),front 块 server_name 去掉 www —— 统一规范域名,省用户在两域间重复冷建连。备份 `*.bak-imgwww-<ts>`。配套前端加 `perf_img` 埋点(Resource Timing 采样 /img 资源,admin「页面打开耗时」卡多一根 IMG 柱)看真机图片加载耗时。
>
> ⚠️ **2026-06-09 再续(视频流式回归 —— 上面那个 /img 缓存把视频搞挂了)**:`/img` 也代理 `video.twimg.com` 的 `.mp4`(X 视频,GFW 挡直连)。给 `/img` 开 `proxy_cache` 后,**nginx 无 slice 时遇 Range 请求会拉「整段」再缓存** —— 实测 `Range: bytes=0-1023` 返 `200` 全量 **21MB**(本该 `206` 只回 1KB)。feed `<video>` 起播每条被迫下整段(单条最大 **251MB** 4K!),把连接占满 → 封面图被饿死、perf_img P95 飙到 82s。**修复**:① perf.conf 加 `map $arg_url $img_skip_cache { "~*video\.twimg\.com" 1; default ""; }`;② `/img` location 加 `proxy_no_cache/proxy_cache_bypass $img_skip_cache` + `proxy_cache_max_range_offset 0` + **关键** `proxy_set_header Range $http_range;`(配了 proxy_cache 的 location 默认剥客户端 Range,必须显式透传)。验证:`curl -r 0-1023 …/img?url=…video.twimg…` 返 `206 + content-length 1024 + content-range`,图片仍 `200 + HIT`。备份 `*.bak-vid2-<ts>`。前端配合 feed 视频 `preload="none"`(commit `22c27da`)。**教训:proxy_cache 别裸盖到带 Range 的视频/大文件代理上。**
>
> ⚠️ **2026-07-19 `/img` 格式缓存键修复**：Worker 已按 `Accept` 协商 AVIF/WebP/原图并返回 `Vary: Accept`，但香港 Nginx 原 key 只有 `"$scheme$request_method$host$request_uri"`，会把先写入的 JPEG/PNG 回给现代浏览器。修复为 key 追加有限的 `$aifeeds_image_format` 桶；显式给 AVIF/WebP 设置 `q=` 的少见请求绕过二级缓存，避免与 Worker 权重算法产生桶污染；`$img_skip_cache` 视频规则、Range 透传和 `/r` 均不变。必须使用 checksum-gated 的 [`aifeeds-image-format-cache-apply.sh`](../deploy/nginx/aifeeds-image-format-cache-apply.sh)，只清 key 含 `/img?` 的缓存文件；精确基线、验证和回滚见 [`2026-07-19-waterfall-image-cache-change.md`](reviews/2026-07-19-waterfall-image-cache-change.md)。禁止使用下方全量清缓存命令替代本变更的定向清理。
>
> ⚠️ **2026-06-09 三续(字体 CORS —— 又是 proxy_cache 不分 Origin)**:playwright 验证发现 prod 控制台 12 条 woff2 CORS 报错 —— 字体的 `Access-Control-Allow-Origin` 被缓存成 `https://staging.ai-feeds.com`(谁先请求谁的 Origin 进了缓存,fonts location cache key 不含 Origin),导致 `ai-feeds.com` 取字体被拦、退回系统字体(非阻塞所以一直没察觉)。**修复**:fonts location 加 `proxy_hide_header Access-Control-Allow-Origin; add_header Access-Control-Allow-Origin "*" always; add_header Timing-Allow-Origin "*" always;` —— 字体是公共资源,serve 时统一回 `*`(anonymous crossorigin 够用),不靠缓存里那份。验证 `curl -H 'Origin: https://ai-feeds.com' -I …/hmos-regular/*.woff2` 应见 `access-control-allow-origin: *`。备份 `*.bak-fontcors-<ts>`。**同源教训:VPS 缓存任何带 Origin 相关响应头的资源,要么 cache key 含 Origin,要么 serve 时统一覆盖。**
>
> ⚠️ **2026-06-10 四续(字体浏览器缓存 —— load 指标偏高根因)**:CORS 修好字体能加载后,perf_nav 的 `load` 偏高。playwright 查到单页加载 **~38 个 woff2 分块(~200KB)**,且 woff2/css **完全没有 `Cache-Control` 响应头**(R2 没给、VPS 也没补)→ 浏览器每次访问全重下,load 一直高。woff2 文件名带内容哈希 = immutable。**修复**:perf.conf 加 `map $uri $font_cache_control { "~*\.woff2$" "public, max-age=31536000, immutable"; "~*\.css$" "public, max-age=3600"; default "public, max-age=86400"; }`;fonts location 加 `proxy_hide_header Cache-Control; add_header Cache-Control $font_cache_control always;`。验证 `curl -I …/*.woff2` 见 `cache-control: public, max-age=31536000, immutable`。备份 `*.bak-fontcache-<ts>`。这样回访浏览器直接命中本地缓存、跳过 ~200KB 字体下载,load 大降(且保留品牌字体,无取舍)。注:FCP(首屏可见,系统字体兜底)一直 ~1.5s 没受影响 —— load 高只是品牌字体在后台补,非阻塞。

> ⚠️ **2026-06-11 五续(回访秒开三件套:TLS 票据/0-RTT + index.html 香港 1 分钟缓存 + Service Worker)**:
> 1. **TLS 会话票据 + 0-RTT**:`/etc/letsencrypt/options-ssl-nginx.conf` 把 `ssl_session_tickets off → on`(⚠️ certbot 管理的文件,重装 certbot 可能被打回,改完留意);`aifeeds.conf` 的 front(ai-feeds.com)和 fonts server 块加 `ssl_early_data on;`(**api 域故意不开** —— 0-RTT 有重放风险,只给纯 GET 静态域开)。验证:VPS 本机 `openssl s_client -sess_out/-sess_in` 两连,见 `Reused` + `Max Early Data: 16384`。效果:回访握手省 1-2 个跨境 RTT(~300-600ms)。
> 2. **index.html / sw.js 香港缓存 1 分钟**:front server 加 `location = /` 和 `location = /sw.js`(上游 CF Pages 给 `max-age=0, must-revalidate`,nginx 视为不可缓存,每次导航白付 HK→CF 一跳)→ `proxy_ignore_headers Cache-Control Expires; proxy_cache_valid 200 1m;`。**副作用:发版后 prod 最多旧 60s**(hashed assets 跨版本保留不会 404);急的话清 VPS 缓存立即生效。深链(/t/ /g/ 等)仍走不缓存的 `location /`。
> 3. **Service Worker 壳缓存**(`dashboard/public/sw.js` + main.tsx 注册):回访导航 0 网络直接回缓存壳(实测 22ms/0 字节,FCP ~0.5s),后台拉新壳下次用(最多旧一个版本)。FEED_CACHE 同时落 localStorage 快照(每频道 15 条),冷启动先显旧内容再 silent refetch。**紧急停用(kill switch)**:全员停 = 往 `dashboard/index.html` 加 `<script>window.__SW_OFF=true</script>` 发版(SW 每次导航都后台拉新壳,一个访问周期内传达到);单机停 = localStorage 设 `aifeeds_sw_off=1`。SW 不碰 api//img/视频/字体/跨域(视频 Range 不能拦,5/9 事故同类风险)。

> ⚠️ **2026-07-06 六续(主域 SEO 路径转发 —— 每日静态日报页上线)**:`ai-feeds.com` front server 块新增一个 **regex location**,把 `/daily`、`/daily/*`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/<INDEXNOW_KEY>.txt`(key 真值在 nginx 配置 + `.secrets/aifeeds-prod.env` 的 `INDEXNOW_KEY`,IndexNow 验证文件本就公开) 转发到与 api 块**同一 worker upstream**(`xlist-api.ltsms86.workers.dev`),**照 api 块注入全套头**(`Host: workers.dev` + `X-Forwarded-Host: api.ai-feeds.com` + `X-Origin-Secret` + `X-Forwarded-Proto/For` + `proxy_ssl_name/server_name`)。正则:`location ~ ^/(daily(/.*)?|robots\.txt|sitemap\.xml|llms\.txt|<key>\.txt)$`,放在 front 块 SPA fallback `location /` **之前**(regex location 优先于 prefix location 匹配;其余路径仍走 CF Pages)。**故意不启用 proxy_cache**(流量低,避开 6-21 新旧 HTML 混喂缓存事故)。worker 侧日报页 canonical/深链一律用 env `SITE_BASE`(`https://ai-feeds.com`),不依赖 request host。备份 `aifeeds.conf.bak-20260706-seo`。**回滚**:删该 location 块 → `nginx -t && systemctl reload nginx`(worker 路由无状态,删 nginx location 即回滚,api 域 `/daily` 等仍可访问不受影响)。设计见 `docs/plans/2026-07-06-daily-static-page-seo-design.md` §4.10。
>
> 📄 **该 location 块的版本化权威副本已纳入 git**(2026-07-07,#170):`deploy/nginx/aifeeds-seo-location.conf`。VPS 上 `/etc/nginx/sites-available/aifeeds.conf` 是运行时源;改动 SEO 段先改 repo 副本 → SSH 同步进 VPS aifeeds.conf 对应块 → `nginx -t` → `systemctl reload nginx`(备份 `aifeeds.conf.bak-YYYYMMDD-seo`)。副本里 `X-Origin-Secret` / `<INDEXNOW_KEY>` 为占位符(真值见 `.secrets/aifeeds-prod.env`);标 `[TODO 待与 VPS 核对]` 处(upstream 写法 / SNI 行等)需上 VPS 跑 `nginx -T` 抓 api 块原文逐行对齐后回填。
>
> ⚠️ **2026-07-08 七续(item SSR 静态页 `/i/*` + sitemap 分片纳入同一转发 —— 全量内容静态页上线)**:六续正则扩为 `location ~ ^/(daily(/.*)?|i/.*|robots\.txt|sitemap\.xml|sitemap-[a-z0-9-]+\.xml|llms\.txt|<key>\.txt)$` —— 新增两段:① `i/.*` 转发单页 SEO 静态页 `/i/<source>/<id...>`(如 `/i/x/123`、`/i/gh/owner/repo`;**裸 `/i` 不放行**,与 worker `isSeoPath()` 的 `pathname.startsWith('/i/')` 判定一致);② `sitemap-[a-z0-9-]+\.xml` 转发 sitemap 分片(`/sitemap-daily.xml`、`/sitemap-x.xml`、`/sitemap-hf-paper-2.xml` 等,`/sitemap.xml` 本体已改 sitemap-index,见 `worker/src/seo-routes.ts` 的 `SITEMAP_SHARD_RE`)。回源头 / 不启用 proxy_cache 等约定不变。**本次改动同时把该 location 块纳入 git 版本化**(与上方 #170 的版本化副本同一文件,合并后取含 `/i/` 与分片的超集正则),权威副本落 `deploy/nginx/aifeeds-seo-location.conf`(repo 内,含完整回滚/部署步骤注释),VPS 仍是实际生效配置,改动需 SSH 同步(见文件头注释)。**三层口径核对**:nginx 正则、worker `isSeoPath()` 已同步含 `/i/*` 与 sitemap 分片;⚠️ `dashboard/public/sw.js` 的 `isSeoPath()` **尚未同步** `/i/*` 分支(仍只放行 `/daily`、`/sitemap.xml`、根级 `.txt`)——本 task 范围内未改(不在本次改动文件清单),遗留为后续修复项,影响面:SW 拦截导航请求时若命中缓存壳而非透传 `/i/*` 请求,`/i/` 页面理论上可能被 SW 拿旧壳响应(需验证实际影响并在专门 task 里补分支)。设计见 `docs/plans/2026-07-08-item-ssr-pages-design.md` §4.4/§4.6。

**切换时的前置改动**（回滚要逆操作）：
- R2 `ai-feeds-fonts` 开了 r2.dev 公共访问（`pub-…r2.dev`，字体公开资源，无安全风险）
- 移除了 api 的 Worker custom domain（`xlist-api`）+ fonts 的 R2 custom domain，DNS 才能解锁改 A 记录

**⚠️ 风险 / 长期运维**：
- **VPS 单点** —— 它挂了，前端 + api + 字体全挂（邮件不受影响）；按下方回滚秒退回 CF
- **按月续费**（DMIT），忘续 = 全站挂
- 走香港的流量**不经 CF**，WAF / 缓存 / DDoS 改由 VPS 自己扛 —— 缓存 / 限流 / 防火墙 / fail2ban 已在 VPS 上重建（见下方「🛡️ VPS 防护层」），但**真正的大流量 DDoS 单机扛不住**，真出事按回滚退回 CF
- **cookie 功能**（admin 后台 / 分享）：api 反代用 workers.dev 的 Host，cookie domain 可能受影响；nginx 已传 `X-Forwarded-Host: api.ai-feeds.com` 备用，异常时 BE 读它修
  - **✅ 已踩坑并修复（2026-06-08）**：这个「Host 被改成 workers.dev」的副作用还坑了**分享短链/二维码/落地跳转** —— `worker/src/share/handlers.ts` 的 `originsFor()` 原本靠 request host 推域名，中转后 host=workers.dev → 落 dev fallback，分享二维码写成 `https://xlist-api.ltsms86.workers.dev/s/xxx`，**扫码直连 workers.dev 没带 `X-Origin-Secret` → 撞 Origin gate → Forbidden**（用户实测截图）。修复：`originsFor` 改用各环境已配的 `SITE_BASE`/`API_BASE`（与邮件链接同一套规范公网域，**没走 X-Forwarded-Host**，直接 env 真值源），localhost 短路保留本地 dev。**教训：中转后 worker 内任何「靠 request host 拼对外 URL」都不可信，一律用 env 的规范域**。
- **数据仍回源海外**：api 是动态请求，香港只优化「大陆→香港」这段；「香港→CF Worker」那段仍走海外（已是服务器间高速链路，比大陆直连 CF 快）

**🔙 回滚（退回全走 CF，今天之前状态）**：
1. **前端**：CF DNS 删 `ai-feeds.com` / `www` 的 A 记录 → Pages 项目 `xlist-dashboard` 重新加 custom domain `ai-feeds.com` + `www`（CF 自动重建 CNAME 橙云）
2. **api**：删 A 记录 → Worker `xlist-api` 重新加 custom domain `api.ai-feeds.com`
3. **fonts**：删 A 记录 → R2 `ai-feeds-fonts` 重新加 custom domain `fonts.ai-feeds.com`
4. 邮件 / staging 不用管（没动）
- 原始 DNS 备份：`~/Downloads/ai-feeds-dns-backup-2026-06-02.json`；CF nameservers `ivy / james.ns.cloudflare.com`

**自查命令**（验证香港中转是否正常）：

```bash
curl -sI --resolve ai-feeds.com:443:154.12.188.231     https://ai-feeds.com/
curl -s  --resolve api.ai-feeds.com:443:154.12.188.231 "https://api.ai-feeds.com/api/items?limit=1"
curl -sI --resolve fonts.ai-feeds.com:443:154.12.188.231 https://fonts.ai-feeds.com/hmos-bold/009b6137cf3bcf65ce3e6e2fcb4f187c.woff2
```

**🛡️ VPS 防护层（2026-06-02 加，方案 A）**：灰云后流量不经 CF，故在 VPS 上重建以下防护（SSH 加固系统默认已达标：禁密码、仅密钥）。

| 层 | 配置 | 位置 / 备注 |
|---|------|-----------|
| 缓存 | nginx `proxy_cache`：前端 + 字体缓存、**api 不缓存**；尊重上游 Cache-Control（index.html 不缓存、哈希资源 / 字体长缓存）；`proxy_cache_use_stale` 上游抖动时吐旧版兜底 | `conf.d/aifeeds-perf.conf` 定义 `aifeeds_cache` 区；响应头 `X-Cache-Status: HIT/MISS` 可查 |
| 限流 | 每 IP `rate=50r/s` `burst=200`、`limit_conn=100`，超限 429 | `conf.d/aifeeds-perf.conf`。**故意宽松**照顾中国 CGNAT（多个真实用户共享一个公网 IP），误伤就调高 |
| 防火墙 | ufw：只放行 22 / 80 / 443，默认 deny incoming | `ufw status` |
| 自动封禁 | fail2ban：`sshd`（走 systemd journal）+ `nginx-limit-req`（走 `error.log` 文件，反复触发限流 30 次 / 分钟 → 封 1h） | `jail.local`；`ignoreip` 含管理 IP（当前 SSH 客户端 IP，明文见 VPS 上 jail.local）（已端到端验证：真实 459 条限流日志，规则 459 matched）|

> nginx / ufw / fail2ban 均已 `enable` 开机自启（重启不丢）。

**防护层运维**：
```bash
# 看谁被封 / 解封误伤的 IP
ssh -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 'fail2ban-client status nginx-limit-req'
ssh -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 'fail2ban-client set nginx-limit-req unbanip <IP>'
# 调限流（CGNAT 误伤时调高 rate/burst）：编辑 conf.d/aifeeds-perf.conf → nginx -t && systemctl reload nginx
# 清缓存：rm -rf /var/cache/nginx/aifeeds/* && systemctl reload nginx
```

> **✅ 回源密钥 + 真实访客 IP（2026-06-02 完成，prod worker Version `10b2787d`）**：
>
> - **回源密钥 gate**（`worker/src/index.ts` 入口，OPTIONS 之后 / bot gate 之前）：香港 VPS nginx 给 api 块注入 `X-Origin-Secret`（值存 `.secrets/aifeeds-prod.env` 的 `ORIGIN_SECRET`，并 `wrangler secret put ORIGIN_SECRET`）。worker 校验：**仅当 `env.ORIGIN_SECRET` 设置（=prod）时启用**，无密钥且非 `admin.ai-feeds.com`（CF Access 把门）/ `/api/webhook/resend`（Svix 签名）/ `/api/digest/return`（公开回流）/ `X-Dev-Token`（OPS 逃生）的请求一律 403 —— 堵死直连 `xlist-api.ltsms86.workers.dev` 白嫖 worker 额度 / 绕过 VPS 限流。**staging 不设 secret = gate 关闭**。
> - **真实访客 IP**（新 `worker/src/client-ip.ts` 的 `getClientIp(req, env)`，统一替换 auth/handlers、auth/email-handlers、track、digest/return-webhook、digest/handlers 共 5 处旧拷贝）：中转后 `CF-Connecting-IP` 对每个访客都成了 VPS 的 IP；带合法 `X-Origin-Secret` 时改取 `X-Forwarded-For` 第一段（nginx 注入的真实客户端）。**修复了登录 OTP per-IP 限流误伤真人的隐患**（sms/email：同 IP 1h ≥10 个不同账号、24h ≥30 条 → 中转后全站塌缩到 VPS 单 IP，会把正常用户挡在 `ip_1h_unique_*_limit` 外）。
> - **回滚**：`wrangler secret delete ORIGIN_SECRET`（prod）→ gate 代码 `if (env.ORIGIN_SECRET)` 立即跳过，秒回无闸状态 + IP 回落 CF-Connecting-IP。nginx 的注入行留着无害（worker 不校验即忽略）。
> - **自查**：`curl -sI https://xlist-api.ltsms86.workers.dev/api/items`（直连无密钥应 **403**）；`curl https://api.ai-feeds.com/api/items`（经香港应 **200**）。
> - **⚠️ 部署顺序硬要求**：改动这套时务必 ①先 nginx 注入头 → ②`wrangler secret put` → ③`wrangler deploy`。顺序颠倒（worker 先校验、nginx 还没注入）会让 prod api 瞬间全 403。

### 6c. 地域路由实验门禁（2026-07-11，仅方案，当前禁止启动）

完整预注册方案见
[`docs/plans/c-end-geo-routing-experiment.md`](plans/c-end-geo-routing-experiment.md)。该文档和本节
**没有**修改 TTL、DNS、CDN、custom domain、证书、nginx、Worker route 或生产流量；当前四个
用户域名继续全量走香港 VPS。

**当前状态：BLOCKED。** 服务端可信 `edge_country` / `edge_colo` 尚无足量稳定生产样本，
跨四 host 的稳定 arm 分配/可信归因与 Cloudflare 直达候选链路也未完成验收。前端
`mainland_hint` 只是 `Asia/Shanghai` 时区提示，**不是地理事实，严禁用作路由、实验分组或放量
依据**。只有 DNS/CDN/Worker 服务端产生并校验的粗粒度国家/colo，以及未来单独评审的服务端
网络分类，才可进入路由决策。

启动前必须同时满足：

- P0/P1/P2 逐阶段稳定至少 48 小时，最终版本形成连续 14 天基线；`all-clean`、`engaged`、
  显式 `synthetic` 可分开查询，owner/synthetic 不混入主分析；
- 拟开放地域满足固定样本门槛：P75 每个地域 × 设备 × arm 至少 200 个独立 LCP/cold-nav
  会话，P95 每个地域 × arm 至少 500 个；移动端不足不得拿 desktop 外推；
- A 为当前全量香港 control；B 仅让满足门槛的非大陆地理直达 Cloudflare，`CN`、未知地理和
  经审批冻结的受保护网络仍走香港。非大陆按亚太、北美、欧洲、其他预注册大区分别分析，
  单一国家单臂达到 200 时必须单列；全球平均不得掩盖任何地域恶化；
- 路由层提供不可由客户端伪造的 `route_arm` / `route_generation` / 粗粒度 route geo，四个
  host 同臂且分桶稳定；仅能做无法归因的 DNS round-robin 时不得启动；
- 候选 host 已覆盖 PC/移动端证书/SNI、origin gate、Cookie、登录、搜索、反馈、分享、深链、
  Service Worker、字体 CORS、图片与音视频 Range 的隔离验收；
- 实验 owner、监控与回滚人在场，四 host 的当前 DNS/CDN/custom-domain/证书/TTL 值已受控留档，
  且已取得**针对该次基础设施改动的独立明确审批**。代码合并或“继续执行计划”不构成授权。

**指标与护栏**：主指标为各地域 cold nav `responseStart-startTime` 与 LCP 的 P75/P95，辅以
`feed_ready`、FCP、`perf_api`、nginx/CDN/Worker/D1 分段。HTTP/API/前端错误率增加超过 0.5 个
百分点、LCP P75 任一地域/设备恶化超过 10%、可用率低于 99.9% 或较 control 下降超过 0.1 个
百分点、登录/分享/深链回归、证书/SNI/安全 gate/缓存串臂/Range 问题均触发停止或回滚。
RUM 看不到 DNS 失败，必须同时看显式 synthetic 与服务端可用性；synthetic 只作护栏，不计入收益。

**TTL、预热与推进**：若未来获批，实验 TTL 目标为 300 秒；降低 TTL 本身也在审批范围内，需在
首次切流至少 24 小时前完成并等待 `max(24 小时, 2 × 旧 TTL)`。两臂只预热匿名公开且已证明
缓存安全的壳/哈希资产/manifest/list，禁止预热或跨臂缓存个性化与 mutation；所有预热流量显式
标 synthetic。真实流量只能按 5%（≥2h）→25%（≥24h）→50/50 推进，每次切权重后的
`max(30 分钟, 2 × TTL)` 为 burn-in，不计入效果样本。

**回滚**：启动前的独立变更单必须包含当时真实、逐 host 的精确恢复值和 custom-domain/证书
操作顺序。触发时先把 treatment 归零或恢复全部旧值，核验 apex/www/API/fonts 与关键功能，等待
至少 `2 × TTL` 并监控 60 分钟；除非确认坏缓存，不做全局 purge。实验达标也不自动授权全量，
逐地域生产放量仍需新的明确审批。

### 7. CF 安全配置

**已开启项**：
- **SSL/TLS** 模式：Full (strict)
- **Bot Fight Mode**：On（Free tier 自带，拦截简单爬虫）
- **Security Level**：Medium
- **HTTP DDoS Managed Ruleset**：默认开启（L7 DDoS 防护）
- **L3/L4 DDoS 防护**：CF 默认开启（不可关）

**Rate Limiting**（Free tier 限 1 条）：
- 路径 `/api/*`（或 `api.ai-feeds.com/api/*`），10 秒内 30 请求触发 Block
- 原 limit=10 太紧，dashboard 初次加载并发 3 个接口容易误伤，已调至 30

**Custom Rules**（Free tier 限 5 条）：
- **Block bad bots**：UA 含 `MJ12bot|AhrefsBot|SemrushBot|DotBot`（SEO 分析爬虫，不是搜索引擎）→ Block
- 已验证不影响 SEO：Googlebot / Bingbot / Baiduspider / YandexBot 不在此名单

**Worker 层 bot/referer 防御**（2026-05-17，PR #52 加入；跟 zone 层规则互补）：
- **Bot UA 拦截**（`worker/src/index.ts` 的 `isBlockedBot` + `isBotGateExempt`，CORS 检查后、路由前）：UA 命中 AI 训练爬虫（GPTBot/ClaudeBot/Bytespider 等）/ 脚本工具（python-requests/curl/wget/scrapy）/ SEO 爬虫（AhrefsBot/SemrushBot 等，跟 zone 规则双层）/ 漏洞扫描（nikto/sqlmap/nmap 等）→ 直接 403 + `Cache-Control: private, no-store`（2026-05-17 改，原 `max-age=86400` 把 403 缓存了 24h，开发期反复试错痛苦），不查 D1。**白名单**：Googlebot/Bingbot/Baiduspider/Sogou 等搜索引擎 + Twitterbot/facebookexternalhit/Slackbot 等社交预览 bot 不进 blocklist。**豁免路径**（`isBotGateExempt`）：`/api/ingest`（自家 scrapers）+ `/api/track`（device-token 已防滥用）+ 公开只读 endpoint（`/api/items` GET / `/api/sources` GET / `/api/stats` GET / `/img` / `/r/*`）—— 后一组是 dashboard 给所有 visitor 用的，拦 curl 没意义反而误伤 OPS smoke
- **`/r/<key>` referer 白名单**（`worker/src/index.ts` 的 `isAllowedR2Referer`，R2 fetch 前）：空 referer（直接打开 / poster renderer）放行；其他 referer 必须来自 `*.ai-feeds.com` / `twitter.com|x.com|t.co|mobile.*` / `producthunt.com` / `github.com` / `*.pages.dev` / `localhost`，否则 403 防图片视频被第三方站点热链
- **AbortError 错误归一化**（`dashboard/src/api.ts`）：fetch 5s 超时触发的 AbortError 在 `/api/track` 上报时 `error_msg` 标记成 `timeout_5000ms`，方便 `/admin/dashboard` 错误分桶（之前都是 `signal is aborted without reason` 看不懂）

**BE/OPS CLI bypass — `X-Dev-Token` header**（2026-05-17 上线）：

> **背景**：PR #52 bot UA gate 把 `curl/8.x` / `python-requests` 默认 UA 全拦了，但 BE/OPS 的 prod smoke 日常就是 `curl -I /api/admin/...`，今天调 cf.image 实际效果时整个 worker 全 403 调了半天。

- **生效场景**：worker bot UA gate 检查阶段。请求带 `X-Dev-Token: $DEV_TOKEN`（值匹配 `env.DEV_TOKEN` secret）→ 跳过 UA 黑名单检查 → 直接放行到路由分发。
- **不影响**：CF Access JWT 校验（`/admin*` + `/api/admin/*`，CF 边缘那一层）—— 那需要 CF Access Service Token（另一套机制）。
- **CLI 用法**：
  ```bash
  source .secrets/aifeeds-prod.env    # 或 aifeeds-staging.env
  curl -H "X-Dev-Token: $DEV_TOKEN" https://api.ai-feeds.com/api/auth/send-otp
  # python-requests / postman / CI 同样加 header 即可
  ```
- **不需要加 header 的场景**：公开只读 endpoint（`/api/items` / `/api/sources` / `/api/stats` / `/img` / `/r/*`），因为它们已经在 `isBotGateExempt` 白名单里。CLI 测公开 endpoint 直接 curl 就行。
- **Token rotation**：`openssl rand -hex 32` → 同步更新 `.secrets/aifeeds-{prod,staging}.env` 的 `DEV_TOKEN` + `wrangler secret put DEV_TOKEN [--env staging]`。prod / staging 用**不同 token**（staging 泄露不污染 prod）。
- **被 403 后的诊断**（`X-Dev-Token` 是否生效）：response body 是 `Forbidden`（纯文本，无 cache）说明被 worker bot gate 拦，应该带 token 重试；body 是 HTML 含 `Cloudflare-Access` 说明是 CF Access 那层（admin 才会到），跟这个 token 无关。

**可选加固**（未配置，见本项目 TODO）：
- 第一优先级加一条 Skip 规则：`cf.verified_bot_category in {"Search Engine Crawler"}` → Skip all rules，保证搜索引擎 100% 不被误杀

### 7a. Admin 鉴权：Cloudflare Access（2026-05-17 上线 staging）

> ⚠️ **2026-06-02 变更（香港中转后）**：`api.ai-feeds.com` 改走香港 VPS（绕过 CF 边缘 → CF Access 在边缘层失效，`api.ai-feeds.com/admin` 会报 `Unauthorized: missing or invalid Cf-Access JWT`）。**prod admin 入口已改为 `https://admin.ai-feeds.com/admin/dashboard`** —— 单独的橙云走 CF 域名（Worker `xlist-api` 的 custom domain），保留 CF Access 邮箱登录。worker 代码没改（验的还是同一个 aud）。详见 §6b。

> **背景**：原 `/admin` + `/api/admin/*` 走 HTTP Basic Auth（`ADMIN_USER` / `ADMIN_PASS`），单因素、可爆破、密码存在 Secret 里万一泄露就完蛋。2026-05-17 起切换到 **CF Access（Zero Trust）** —— 边缘节点先拦截 + 邮箱 OTP 登录 + worker 二次校验 JWT。

**架构**：

```
浏览器 → staging-api.ai-feeds.com/admin
         ↓
       CF Access 边缘拦截（未登录 → 跳 aifeeds.cloudflareaccess.com）
         ↓ Email OTP 登录（ltsms86@gmail.com）
       浏览器拿 CF_Authorization cookie（含 JWT）
         ↓ 后续请求 CF 自动注入 Cf-Access-Jwt-Assertion 头
       worker.checkAdminAuth() → jose.jwtVerify 校验 issuer + audience + 签名 + exp
         ↓
       放行
```

**Team domain**：`aifeeds.cloudflareaccess.com`（创建时定，不可改）。

**Access Applications**（每个环境一个）：

| App name | Destinations | Policy |
|---|---|---|
| `aifeeds-admin-staging` | `staging-api.ai-feeds.com/admin*` + `staging-api.ai-feeds.com/api/admin/*` | Allow Emails = `ltsms86@gmail.com` |
| `aifeeds-admin-prod` | **`admin.ai-feeds.com`**（整个域名；2026-06-02 香港中转后从 `api.ai-feeds.com/admin*` 迁来，因 api 走香港绕过了边缘 Access） | Allow Emails = `ltsms86@gmail.com` |

**Worker 校验逻辑**（`worker/src/admin.ts`）：

- 优先：CF Access JWT（配齐 `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN` 即启用）
- Fallback：Basic Auth（仅在 CF Access 未配置时启用 —— 应急通道）
- **严格模式**：一旦启用 CF Access，JWT 校验失败直接 401，不回落 Basic Auth

**Secrets**：

| Secret | 配置方式 | 当前状态 |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | wrangler.toml `[vars]` + `[env.staging.vars]` 明文（非敏感）| ✅ prod + staging |
| `CF_ACCESS_AUD` | `wrangler secret put CF_ACCESS_AUD [--env staging]`（每环境对应一个 App 的 AUD tag） | ✅ staging / ✅ prod（app `aifeeds-admin-prod`，保护 `admin.ai-feeds.com`） |
| `ADMIN_USER` / `ADMIN_PASS` | wrangler secret（保留作 fallback） | ✅ prod + staging（CF Access 稳定 1 周后可删） |

**部署**：

```bash
# Staging（已上线）
cd worker
npx wrangler secret put CF_ACCESS_AUD --env staging
# 粘贴 staging app 的 AUD（CF Dashboard → Zero Trust → Access → Applications → aifeeds-admin-staging → Additional settings → AUD tag）
npx wrangler deploy --env staging

# Prod（待执行）
npx wrangler secret put CF_ACCESS_AUD
# 粘贴 prod app 的 AUD
npx wrangler deploy
```

**应急回滚（被 CF Access 锁外）**：

1. **删 secret 回落 Basic Auth**（最快）：
   ```bash
   npx wrangler secret delete CF_ACCESS_AUD [--env staging]
   # admin.ts 检测到 AUD 缺失，自动回落 Basic Auth 路径
   ```
2. **CF Dashboard 改 Policy**：把 Access Application 的 Policy Action 临时改 `Allow everyone`，全开
3. **wrangler rollback**：`npx wrangler rollback [--env staging]` 回到 Basic Auth 时代的 worker 版本

**为啥不裸用 Basic Auth**：单因素 + 可爆破 + 密码会泄露。CF Access = 边缘拦截 + 邮箱 OTP（"something you have"）+ JWT 签名校验（CF Access 私钥永不出 CF），攻击面缩到最小。

### 8. CF 账户其他项目（非本项目）

- Pages: `yt-dubbing-privacy` — 另一个项目，别误删

### 9. Worker: `aifeeds-d1-backup`（D1 自动备份，2026-05-14 上线）

> 设计：[`plans/2026-05-14-d1-backup-workflows-design.md`](plans/2026-05-14-d1-backup-workflows-design.md)
> 跟主业务 worker `xlist-api` **完全独立** — 别混淆。

- **源码**：`worker-backup/src/` (`index.ts` + `backup.ts`)
- **配置**：`worker-backup/wrangler.toml`
- **公网地址**：`https://aifeeds-d1-backup.0d13b65d05d5d29fe06998141f3b0f9a.workers.dev`（默认 workers.dev 子域，无自定义域）
- **部署命令**：`cd worker-backup && npm run deploy`（staging：`npm run deploy:staging`）
- **Cron**：每天 BJT 12:30 (UTC `30 4 * * *`) 自动触发
- **架构**：scheduled() / `/trigger` 触发 → CF Workflows `D1BackupWorkflow` → 调 D1 REST export API（polling pattern）→ fetch signed_url → `R2.put(daily/<BJT-date>.sql)`

**端点清单**：

| 路径 | 方法 | 用途 | 鉴权 |
|------|------|------|------|
| `/trigger` | POST | 立即触发一次备份（手动测 / cron 漏跑补） | 无（仅 workers.dev 子域可达，未来绑自定义域需加 token） |
| `/status/<instance_id>` | GET | 查 workflow instance 状态（pending / running / errored / complete） | 无 |
| `/` | GET | 帮助页 | 无 |

**资源清单**：

| 资源 | 名称 | 用途 |
|---|---|---|
| Worker | `aifeeds-d1-backup` (prod) / `aifeeds-d1-backup-staging` | Workflow 触发 + 入口 |
| R2 bucket | `aifeeds-d1-backups` (prod) / `aifeeds-d1-backups-staging` | SQL dump 落盘，路径 `daily/<BJT-date>.sql` |
| R2 lifecycle rule | `delete-daily-after-30d` | `daily/` 前缀对象 30 天后自动删，零代码维护 |
| Workflow class | `D1BackupWorkflow` | 2 个 step.do（启动 + 轮询/下载/写 R2），自带 retry |
| Secret | `D1_BACKUP_API_TOKEN` | CF API token，权限 `D1:Edit`（足够 export）。当前复用 `CF claude-ops` token 值；最小权限子 token 待办 |
| 公开 vars | `CF_ACCOUNT_ID` + `D1_DATABASE_ID` | wrangler.toml `[vars]`，非 secret |

**首次部署 / 一次性 ops 步骤**（已记录，不需要重做）：

```bash
source .secrets/aifeeds-prod.env

# 1. 创建 R2 bucket
wrangler r2 bucket create aifeeds-d1-backups
wrangler r2 bucket create aifeeds-d1-backups-staging  # 可选，仅 staging 备份用

# 2. 配 lifecycle rule（dashboard：R2 → bucket → Settings → Object lifecycle）
#   或 CLI（wrangler 4.x 支持）：
wrangler r2 bucket lifecycle add aifeeds-d1-backups \
  --id "delete-daily-after-30d" \
  --prefix "daily/" \
  --expire-days 30

# 3. 注入 API token (复用 claude-ops，未来按需换最小权限子 token)
echo "$CLOUDFLARE_API_TOKEN" | wrangler secret put D1_BACKUP_API_TOKEN
echo "$CLOUDFLARE_API_TOKEN" | wrangler secret put D1_BACKUP_API_TOKEN --env staging

# 4. 部署
cd worker-backup && npm run deploy
npm run deploy:staging  # 可选

# 5. 立即触发一次验证
curl -X POST https://aifeeds-d1-backup.0d13b65d05d5d29fe06998141f3b0f9a.workers.dev/trigger
# → 拿到 instance_id，30s-2min 后看 R2 是否有 daily/<today>.sql
wrangler r2 object list aifeeds-d1-backups --prefix daily/
```

**日常运维命令**：

```bash
# 看最近 7 天备份状态
wrangler r2 object list aifeeds-d1-backups --prefix daily/

# 看某天备份元数据（含 captured_at / bookmark）
wrangler r2 object get aifeeds-d1-backups/daily/2026-05-14.sql --pipe | head -20  # 看 SQL 头几行
# Web 控制台看 customMetadata：dashboard → R2 → bucket → object → Properties

# 手动补一次（如 cron 漏跑）
curl -X POST https://aifeeds-d1-backup.0d13b65d05d5d29fe06998141f3b0f9a.workers.dev/trigger

# 查 workflow instance 状态
curl https://aifeeds-d1-backup.0d13b65d05d5d29fe06998141f3b0f9a.workers.dev/status/<instance_id>
# 或 dashboard：Workers & Pages → aifeeds-d1-backup → Workflows tab → instance 列表

# Tail 实时日志（看 cron 触发 / Workflow step 完成）
cd worker-backup && wrangler tail
```

**从备份恢复 prod D1**（灾难恢复场景，DRY-RUN 优先）：

```bash
# 1. 下载需要恢复的 SQL 文件
wrangler r2 object get aifeeds-d1-backups/daily/2026-05-14.sql --pipe > backup.sql

# 2. ⚠️ 强烈建议先在 staging 演练（不要直接覆盖 prod）
wrangler d1 execute xlist-staging --env staging --remote --file=backup.sql

# 3. staging 验证 OK 后再 prod。注意：D1 export 是 CREATE TABLE + INSERT 全量，
#    需要先 drop 现有表（或新建空 D1，把 connection 切过去再切回）。
#    具体灾难恢复 SOP 见 ../plans/2026-05-14-d1-backup-workflows-design.md
```

**Schema 改动会影响这个备份吗**：**不会**。D1 export 是整库 dump，自动反映当前 schema + 数据。新加表 / 加列后下次 cron 跑出的 SQL 文件自然包含新结构。备份代码本身不需要改。

**月成本**：$0（在 Workers Paid $5/月 含量内 — Workflow 调用 / CPU-ms / R2 存储 / R2 PUT 都远低于免费配额，详见设计文档算账表）

**已知限制**：
- D1 export 是全量 dump，无增量备份选项（CF 不支持）
- Workflow instance state 保留 30 天（Workers Paid），失败 instance 30 天内可在 dashboard 排查
- 当前**无失败告警** — Workflow 失败只能在 CF dashboard 看，未来加 PushDeer 推送（v2）

### 10. AI Gateway: `aifeeds-deepseek`（DeepSeek 调用观测层，2026-05-16 上线）

> CF 后端迁移 阶段 1 第 1 件（[`plans/2026-05-06-cf-backend-migration-discussion.md`](plans/2026-05-06-cf-backend-migration-discussion.md) §4.6）。
> 所有 worker / scraper 的 DeepSeek 调用 base URL 切到这个 gateway，统一拿 token / cost / cache hit / 错误率观测。

- **gateway slug**：`aifeeds-deepseek`（account 级唯一）
- **dashboard URL**：CF Dashboard → AI → AI Gateway → aifeeds-deepseek
- **DeepSeek endpoint URL**（worker / scraper 改 base_url 用这个）：
  ```
  https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek
  ```
- **初始配置**（创建时的值）：
  - `cache_ttl=0` — 关全局缓存（按请求 header 局部加，避免误缓存 translation 这种每条独特的请求）
  - `collect_logs=true` — 收集 prompt / response 用于 dashboard 可视
  - `authentication=false` — 不要求 worker 端再带 gateway 自己的 token，DeepSeek API key 走原路
  - `log_management=100000 条 + DELETE_OLDEST` — free-tier 上限，老日志自动清
  - `rate_limiting` 关闭 — 限流由 worker 自己控
- **worker 接入用法**（OpenAI SDK 兼容，DeepSeek 用 OpenAI 协议）：
  ```typescript
  const client = new OpenAI({
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: 'https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek',
  });
  // is_relevant 二分类这种「同 prompt 几小时内可能重复」的请求按需加 cache header：
  // 通过 OpenAI SDK 加自定义 header（v4+）：
  await client.chat.completions.create({...}, {
    headers: { 'cf-aig-cache-ttl': '3600' }   // 1h 缓存命中直接返回
  });
  ```
- **dashboard 查看**：
  - Logs tab：每次请求的 prompt / response / token / cost / cache hit / latency
  - Analytics tab：总调用量 / 总 cost / cache hit rate / 错误率 / P50/P95 latency / 按 model 分布
- **变更命令**（用 `.secrets/aifeeds-prod.env` master token 现场建子 token，permission group `AI Gateway Write`）：
  ```bash
  source .secrets/aifeeds-prod.env
  # 用上面 §4 cf-ops.env 段的子 token 创建步骤，permission_groups = [{"id": "6c8a3737f07f46369c1ea1f22138daaf"}]
  # 然后例如调 cache_ttl 默认到 1h：
  curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/gateways/aifeeds-deepseek" \
    -H "Authorization: Bearer <sub_token>" -H "Content-Type: application/json" \
    --data '{"cache_ttl":3600}'
  # 查当前配置：
  curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/gateways/aifeeds-deepseek" \
    -H "Authorization: Bearer <sub_token>" | jq '.result'
  ```
- **月成本**：$0（Workers Paid 含 AI Gateway 免费层，日均调用量远低于免费配额）

### 11. Web Analytics（RUM，前端 PV/UV/Web Vitals）

> CF 后端迁移 阶段 1 第 2 件（[`plans/2026-05-06-cf-backend-migration-discussion.md`](plans/2026-05-06-cf-backend-migration-discussion.md) §4.4）。
> 跟 dashboard 自家 telemetry SDK 互补 — WA 管「平台聚合」（流量 / 设备 / Web Vitals 分位数 / 地理），telemetry 管「业务事件」（item_click / login_success / share 漏斗 / device↔user 关联）。

> **2026-05-16 走过的坑（记下来防再踩）**：手动通过 `POST /rum/site_info` 创建 standalone site 给每个 host 一个独立 site_tag —— 实际**收不到数据**。CF 真正在用的是 **zone-level auto-inject**：zone `ai-feeds.com` 早就启用了 Web Analytics auto-injection，CF 边缘按 `User-Agent` 判断是浏览器时自动注入 beacon snippet（curl 不带 chrome UA 看不到），数据**统一进 zone 关联的 site_tag**，跟 HTML 里 manual snippet 写的 token **无关**。后果：手动建的 2 个 standalone site 永远 0 数据，FE 手动注入 beacon snippet 也是冗余的。最后清理删了那 2 个 standalone site + FE 撤销手动注入代码。

- **真正在用的 site**：CF zone-level auto-inject（由 zone `ai-feeds.com` 关联），site_tag `5592aea179004b3ea71115e546649ff1`
  - 覆盖范围：所有 zone 下子域（`ai-feeds.com` / `www.ai-feeds.com` / `staging.ai-feeds.com` 等），统一一个 site 看
  - 24h 实测数据示例：staging 149 / prod 22 / www 21 pageviews（zone-auto 一直在工作）
- **dashboard 查看**：CF Dashboard → Analytics → Web Analytics → 找 site_tag `5592aea179004b3ea71115e546649ff1` 对应的 site
- **beacon snippet**：**不需要**前端手动注入。CF 边缘看到浏览器 UA 时自动 inject，普通 curl 看不到（实测 `curl -H "User-Agent: Mozilla/5.0 ... Chrome/..." https://www.ai-feeds.com/` 可看到注入的 `<script>`，对外暴露的 token 跟 zone 的 site_tag 不一致，CF 内部 mapping）
- **SPA 支持**：zone-auto 注入的 beacon 默认监听 `history.pushState` / `popstate`，跟 manual snippet 行为一致
- **不收集 PII**：不存 IP / 不种 cookie / 不 fingerprint
- **zone 设置开关**：CF Dashboard → ai-feeds.com zone → Analytics & Logs → Web Analytics → toggle Enable/Disable（开关 zone-auto inject）
- **月成本**：$0（CF Web Analytics 完全免费，30 天 retention）
- **首页双视图口径（尚未上线）**：隔离分支会给自家 performance telemetry 增加有限值
  `view_mode=classic|waterfall`；缺失/非法值归 classic。Cloudflare Web Analytics 仍是平台聚合视图，
  不能替代自家 cohort 对照。经典版观察窗每阶段/主 cohort 至少 48 小时且至少 100 个 LCP 样本；
  该等待不阻塞本地开发，但在当前 staging 变更包中是远端写操作的前置门。

**API 操作的踩坑笔记**（用 cf-ops.env master token 创建子 token 时）：
- `POST /accounts/:id/rum/site_info` 创建 site：**可以**用 account-owned 子 token（permission group `Account Settings Write` = `1af1fa2adc104452b74a9a3364202f20`）
- `GET /accounts/:id/rum/site_info/list` / `GET /accounts/:id/rum/site_info/:id` / `DELETE /accounts/:id/rum/site_info/:id`：**不接受**account-owned token（返 10405 `Method not allowed for this authentication scheme`），需要 **user-owned token** 或 **CF Dashboard UI 手动操作**
- 也就是说 standalone site **建得了但 list / delete 不了**。如果要清理只能去 Dashboard 手动删（路径见下）
- Dashboard 删 site 路径：CF Dashboard → Analytics → Web Analytics → 选 site → 右上角 ⋯ → Delete

**查 RUM 数据（GraphQL，account-owned 子 token 可用，permission group `Account Analytics Read` = `b89a480218d04ceb98b4fe57ca29dc1f`）**：
```bash
source .secrets/aifeeds-prod.env
# 建 sub-token 步骤见 §4 cf-ops.env 段（permission_groups 用 b89a48... 那个）
SUB=<sub_token>
SINCE=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ")
curl -sS https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $SUB" -H "Content-Type: application/json" \
  --data "{\"query\":\"query { viewer { accounts(filter: {accountTag: \\\"$CF_ACCOUNT_ID\\\"}) { rumPageloadEventsAdaptiveGroups(limit: 20, filter: {datetime_geq: \\\"$SINCE\\\"}, orderBy: [count_DESC]) { count dimensions { siteTag requestHost requestPath countryName userAgentBrowser } } } } }\"}" | jq
```

GraphQL dimension 名（schema introspection 拿的）：`siteTag` / `requestHost` / `requestPath` / `refererHost` / `refererPath` / `countryName` / `deviceType` / `userAgentBrowser` / `userAgentOS` / `date` / `datetimeMinute` / `datetimeFiveMinutes` / `datetimeFifteenMinutes` / `datetimeHalfOfHour` / `datetimeHour` / `bot` / `navigationType` / `deliveryType` / `requestScheme` / `refererScheme` / `customTagInternalSxg`

---

## 订阅推送子系统（digest，**2026-06-01 已上 prod ｜ FE+BE**）

> 邮件日报订阅。**2026-06-01 已上 prod**（BE worker + FE dashboard 均已合 main 并部署 prod）。设计文档：`~/.gstack/projects/roxorlt-aifeeds/roxor-main-design-20260528-090625.md`。worker 内部细节（cron/workflow）以 BE 实现为准。

### Worker endpoints（`xlist-api`）

| 路径 | 方法 | 鉴权 | 用途 |
|------|------|------|------|
| `/api/subscribe` | POST | 匿名 + Turnstile | 匿名订阅（默认配置）；成功回 `edit_token` |
| `/api/subscribe/configure` | POST | `edit_token`（无 turnstile） | 两步订阅第二页改偏好 |
| `/api/auth/me/subscription` | GET / PUT | session cookie | 登录态读 / 改订阅 |
| `/api/auth/me/subscription/unsubscribe` | POST | session cookie | 站内退订 |
| `/api/digest/return` | GET | email HMAC token | 邮件回流：隐式注册登录 + 302 落地深链 |
| `/unsubscribe` | GET / POST | unsubscribe_token | RFC 8058 一键退订 |
| `/api/webhook/resend` | POST | Svix 签名 | bounce/complaint → 计数 / 踢出 |
| `/api/digest/daily` | GET | `Bearer DIGEST_API_KEY` | 对外日报 JSON（受信设备 agent 定时取）；**2026-06-01 上 prod `6246e28`** |

**`/api/digest/daily` 对外 API（2026-06-01）**：实时选品（`selectTopForSource` normal + `curateSource` curated 走 DeepSeek），非历史快照。参数 `density`(normal|curated|both) / `sources`(csv 子集) / `verbose`(1 附 raw 原始字段，不缓存)。每条含 `rank`（该源热度排名）+ `cover`（ph 媒体 logo / gh owner 头像 `avatars.githubusercontent.com/{owner}` / hf 社交缩略图 / x 推文附图；clawhub 及 x 无图留 null；相对路径拼 `API_BASE`）。`AUTH_KV` 15min 缓存防 curated 频繁烧 token。bot UA 闸已豁免（handler 内 Bearer 校验）。鉴权 key = secret `DIGEST_API_KEY`（prod + staging 均已配，存 `.secrets/aifeeds-{prod,staging}.env`）。注：hf-paper 实时档可能空（选品 24h 窗按 scraped_at，hf 那批未落窗）。同 commit 修了 clawhub 邮件简介取字段 bug（`deliver.ts` `ex.ai_summary`→`summary_translated`）。

**⚠️ 邮件链接域名规则（2026-05-29 白页 bug 修复 `df8b3d5` 后）**：回流 `/api/digest/return` + 退订 `/unsubscribe` + List-Unsubscribe header 走 **API 域**（`API_BASE` = `api.ai-feeds.com` / `staging-api.ai-feeds.com`）；落地深链（`to=` 参数 + 进站）走**前端域**（`SITE_BASE` = `ai-feeds.com` / `staging.ai-feeds.com`）。基址由 `[vars] SITE_BASE / API_BASE` 按环境取。**worker 没有 apex `ai-feeds.com/api/*` 路由，邮件里 worker 端点必须用 api 域，否则落到 Pages SPA → 白页。**

### D1（`xlist` / `xlist-staging`）— migration 018

- `subscriptions`：`email`（唯一键 email+channel）/ `sources`(JSON) / `send_slot`(8/12/17) / `density`(normal|curated) / `status`(active|unsubscribed|kicked|paused) / `next_send_at` / `bounce_count`(≥2→kicked) / `worker_send_failures`(≥5→paused) / `unsubscribe_token` / `user_id`(回流回填)
- `digest_pool`：`slot_key`(YYYY-MM-DD-HH BJT) × `source` × `density` → `item_ids`(JSON) + `items_meta`；UNIQUE(slot_key,source,density) 重跑覆盖
- `digest_send_log`：每次投递记账（status: sent|no_items|failed_resend|welcome）
- `email_landings`（migration 021，2026-06-18）：邮件回流精确归因。`/api/digest/return` 验 token 后服务端已知 sub/user/email，每次邮件点击在 `handleDigestReturn` 里 `ctx.waitUntil` 落一条（`subscription_id`/`user_id`/`email`/`to_path`/`landed_at`/`day` BJT/`ip`/`ua`）。配 `digest_send_log` 算 发送→回流→回流率；join `events.user_id` 算「落地后浏览」（回流后 24h 内有 interact 行为）。admin 订阅页「📧 邮件回流」section 读取（`/api/admin/subscriptions?metric=email-returns`）。**无需前端改动**（归因点在服务端 return 端点）
- migration 跑法（同 §2 D1）：`wrangler d1 execute xlist-staging --env staging --remote --file=migrations/018-subscriptions.sql`（018 已上 prod）。**021 同法；prod 上线顺序：先跑 migration 建表，再 deploy worker**（否则查空表/INSERT 撞缺表）

### Workflows（wrangler.toml）

- `digest-node-run-workflow`：节点到点现算 5 源榜单（normal 纯分 / curated LLM 精选）+ 给选了该节点的订阅起 deliver
  - **2026-06-22 行业新闻（`news` = blog+podcast 合并）进日报 `367a5bc`**：`DIGEST_SOURCE_ORDER` 排第一 = 邮件**头条**，对**所有**订阅者强制展示（`deliver.ts` 对 news 不按勾选过滤，非可订阅源）。选品走 `selection.ts selectNewsByScore`：SQL 规则综合分（重要性40 `ai_category` / 源权威30 `source_company` 三档 / 新鲜20 `published_at` / 深度10 blog或播客文字稿档），3 天窗，窗口函数**同源去重**（每 `source_company` 先出头名），top 3，**无 LLM**（`node-run` 对 news 跳过 `curateSource`）。条目额外字段（`render.ts`/`codex-push.ts` 的 `RenderedItem`/`CodexItem`）：`intro`(图文 `excerpt_zh` / 播客 `shownotes_zh`) / `duration_sec` / `guests` / `timeline`(话题脉络,仅原生时间戳文字稿播客有)；blog/podcast 深链 `/o/<urlencode(composite-id)>`
  - **2026-06-22 标题严肃化 + 选品去噪**：① `title_zh` 生成 prompt（`feeds/classify-translate.ts enrichUser`）从直译改为「严肃行业报刊口吻重写 + 去 `[AINews]`/`[Exclusive]`/`【独家】`/emoji/期号等栏目标签」，仅 blog/podcast，其他源标题不动；`stripLabelPrefix()` 在 `classify-translate`（存储）+ `render.ts`/`deliver.ts`（渲染）双层兜底剥标签（LLM 没剥干净 / 存量老标题即时生效）。**`title_zh` 邮件头条 + 首页「新闻&播客」卡片共用同一字段，改动两处一并变严肃**。② `selectNewsByScore` WHERE 增两类噪音过滤（直接踢、非降权）：slow-news 填充帖（`not much happened`/没什么大事，按原英文标题匹配，对中文重写鲁棒）+ 纯活动门票/促销广告（限 `ai_category='other'` 内匹配门票/早鸟/促销词，保护被正确分类的真新闻）。存量刷新跑 `reenrich-feeds-titles`
  - **2026-06-24 推送跨天去重 `c0e653b`**（`selection.ts` 两个新函数）：① **订阅邮件 + Codex**（均读 `node-run` 建的 pool）选品后过 `excludeAlreadyPushed` —— 剔除「今日 BJT 0 点之前 5 天内」已进 `digest_pool`（= 已推送）的 item，确保同一订阅者每天不重复前几天推过的同一条（修高分新闻在 3 天选品窗内被天天选中重推，如「MiniMax 语音 2.8」6/22–6/24 连推三天）。账本只 node-run 写，严格 `< 今日 0 点`（同日 8/12/17 三档**不**互相去重，各档用户不重叠）。② 对外 **`daily-api`** 单独用 `excludeStalePushes`（**宽松**）：允许与最近 3 个推送档次重复（拉取方可能要近期热点），只滤第 4 档及更早的陈旧内容；**档次按 `slot_key` 计数，不能用 `generated_at`**——一次 run 给同源写 normal+curated 两行、`generated_at` 差几秒会把一次推送数成两档，`slot_key`（YYYY-MM-DD-HH，一次 run 所有行共享）才是真实档次；daily-api 无状态、自身不写账本
  - 2026-06-21 ClawHub（龙虾技能）退出订阅日报：`node-run.ts` pool 构建 + `deliver.ts` 投递都 `if (source==='clawhub') continue`；前端订阅页（`Subscription.tsx`）也去掉龙虾技能勾选项。**仅订阅日报下架** —— 首页「龙虾技能」频道 + 对外 `/api/digest/daily`（仍含 clawhub）都不受影响（DigestSource 类型保留 clawhub）
- `digest-deliver-workflow`：per-subscription 选品（无 LLM）→ 渲染 → Resend 投递 → 记账 + 重算 next_send_at
- 节点触发：scheduled handler 按 `utc.getUTCHours()` 在 UTC 0/4/9（BJT 8/12/17）触发 node-run；prod 复用现有 `*/5` cron tick 内判断节点时刻；**staging cron 全关（手动触发，同现有约定）**

### Secrets（加到 `.secrets/aifeeds-{prod,staging}.env`）

- `DIGEST_EMAIL_HMAC`（32B hex）：回流 token + 编辑令牌（`edit:` 前缀）HMAC 签名
- `NEWS_CODEX_PUSH`（flag，prod 已设 `=1`）：是否把「行业新闻」板块推进 Codex（`codex-push.ts pushSources`）。**2026-06-22 Codex 下游适配完成后已开启**（`wrangler secret put`，秒生效无需重部署，已记于 `.secrets/aifeeds-prod.env`）—— 自此 prod `daily-codex-push` payload `source_order = ['news','ph','gh','hf-paper']`，8 点节点把行业新闻头条一并推 Codex。回滚：删该 secret 或设非 `1`
- `RESEND_WEBHOOK_SECRET`（Svix）：Resend webhook 签名校验
- `INDEXNOW_KEY`（SEO IndexNow 快速收录 key，**prod / staging 各自值**，均存 `.secrets/aifeeds-{prod,staging}.env`）：未配置时 `pingIndexNow` 静默跳过；同时用于 `/<INDEXNOW_KEY>.txt` 域名归属校验文件。每日静态日报页 Phase 4 用，详见下方「每日静态日报页 Phase 4」
- `DAILY_PAGE_ENABLED`（flag，prod 已设 `=1`；**staging 未设 = 关**）：早 8 点自动生成 SEO 静态日报页的总开关（node-run Phase 4）。手动 `mode=daily-page` 不受此限。同上「每日静态日报页 Phase 4」
- 复用现有：`RESEND_API_KEY` / `TURNSTILE_*` / `PUSHDEER_*`

### 前端（dashboard）

- 路由：`/subscribe`（匿名两步订阅：先邮箱后可选精调）、`/me/subscription`（登录态管理，RequireAuth）
- 顶栏未登录引导横幅（`SubscribeBanner`，每日首访展示、可关闭）
- staging 部署：`cd dashboard && npm run deploy:staging`（Pages 项目 `xlist-dashboard-staging`）

### 上线核对（2026-06-01 已上 prod）

- [x] prod worker（BE）+ dashboard（FE）已部署；订阅页 + 横幅在 ai-feeds.com 生效
- [x] prod 订阅接口实测通（`/api/subscribe` 400、`/api/digest/return` 302 落地前端域）→ 说明 prod secret + migration 018 已就位
- [x] 后台订阅看板：BE 已做独立页 `/admin/subscriptions`（6 聚合 + 明细分页；FE 规格存档 `plans/2026-05-29-admin-subscriptions-view-spec.md`）
- [ ] Resend webhook prod 配置确认（BE）：Resend dashboard → `api.ai-feeds.com/api/webhook/resend`
- [ ] 节点 cron prod 确认（BE）：UTC 0/4/9 是否如期触发 node-run
- [ ] 真人端到端验收：订阅 → welcome → 点链接回流登录 + 落地抽屉 → 退订

### 日报推送 Codex 渲染机（daily/ingest，**2026-06-07 上线**）

> 早 8 点 `digest-node-run-workflow` 算完当天榜单后，并行把日报内容推给 Codex 渲染机做下游加工（日报图 / ZIP / 微信+小红书文案）。Codex 工作台：`https://ai-feeds.cc/aifeeds/`。设计：`docs/plans/2026-06-05-daily-codex-push-design.md`。

- **触发**：`DigestNodeRunWorkflow` Phase 3，仅 `slotHourBjt===8` **且** 总开关 `DAILY_PUSH_ENABLED==='1'`。放在 deliver spawn 之后，非阻塞（`pushDailyToCodex` 永不抛错，失败 PushDeer），不影响邮件投递。
- **内容**：当天 8 点 `digest_pool` 快照（normal 档，ph/gh/hf-paper 三源），复用 `digest/render.ts` `renderItem` 出完整条目：title=`title_zh`（论文原始标题译文，对齐前端）/ summary / cover+media（R2 链接）/ url / deep_link。`render_key` 内容指纹幂等。
- **端点**：`POST https://ai-feeds.cc/aifeeds/api/daily/ingest`，`Bearer X_CARD_SHARED_TOKEN`（复用 X-card 那个，可被 `DAILY_PUSH_ENDPOINT` env 覆盖）。
- **总开关** `DAILY_PUSH_ENABLED`：prod = `1`（已开）；staging/dev 不设。**另有硬闸**：`pushDailyToCodex` 只在 `API_BASE` 含 `//api.ai-feeds.com`（prod）才真推，staging/dev 一律返 `non_prod_blocked`（2026-06-07 staging 假数据污染 Codex 事故后加，staging 验证只能 dry）。
- **手动触发 / 重推**：`POST /api/enrich/run?mode=daily-codex-push[&date=YYYY-MM-DD][&dry=1]`（`Bearer INGEST_TOKEN`）。`dry=1` 只返 payload + `daily_push_enabled` 诊断、不真推；`date` 重推指定日的池（默认今天）。
- ⚠️ **同一天勿连推多条不同 render_key**：Codex 按日期覆盖图、文案按 render_key，多条会图文错位（2026-06-07 事故）。Codex 侧已加串行 + 最新 render_key 胜出保护，但本侧也应只推一条干净 payload。

### 每日静态日报页 Phase 4（daily static page，**2026-07-06 上线，PR #161**）

> 早 8 点 `digest-node-run-workflow` 算完当天榜单后，Phase 4 **非阻塞**生成 SEO 静态日报页（R2 快照 + `daily_pages` 索引 + IndexNow ping），失败只记日志。伺服路由（`/daily/*` `/robots.txt` `/sitemap.xml` `/llms.txt` `/<key>.txt`）见上方 §1「每日静态日报页 + SEO 伺服」。设计：`docs/plans/2026-07-06-daily-static-page-seo-design.md`。

- **触发**：`DigestNodeRunWorkflow` Phase 4，仅 `slotHourBjt===8` **且** 开关 `DAILY_PAGE_ENABLED==='1'`。独立 workflow step（`generate-daily-page`）+ try/catch，学 Phase 3 容错 —— 任何异常只 `console.error`，**绝不影响邮件投递 / Codex 推送**。
- **产物**（`digest/daily-page-run.ts generateDailyPage`）：① R2（`READMES` bucket）`daily/YYYY-MM-DD.html` 静态快照；② D1 `daily_pages` 索引行（`ON CONFLICT(date) DO UPDATE` 幂等）；③ **前一已生成日期页重渲染补链**（本日行 UPSERT 后重跑前日页，其「后一日」导航即解析到本日，保证历史页链式互链）；④ IndexNow ping（`daily/<date>` + `/daily/` + `/sitemap.xml`）。
- **选品**：`digest/daily-page.ts buildDailyPageData`，每源上限 `DAILY_PAGE_PER_SOURCE_LIMIT`（=20，`digest/config.ts`），与邮件同款评分逻辑**现算**（不读 digest_pool 快照）。当日主题（页面 title / description）复用 digest_pool `_subject` meta 行（8 点节点写入）。历史日期回填时 `anchorToDate` 把候选窗口锚到该日，避免选出「当下」的 top N。
- 🆕 **缺页 / 失败告警（2026-07-07，两道防线，`digest/daily-page-monitor.ts`）**：
  - **① Phase 4 内告警**（`runDailyPagePhase`，包住 `generateDailyPage`，仍永不抛错）：生成抛异常 → PushDeer critical「[SEO] 日报页生成失败 `<date>`」；`generateDailyPage` 返回 `skipped`（五源选品空）→ PushDeer「[SEO] 日报页跳过(选品空) `<date>`」；正常静默。复用 `notifier.ts` 的 `pushDeerAlert`。
  - **② 缺页兜底检查**（`checkDailyPageFreshness`，挂在 `scheduled()` 的 **UTC 01:00** tick，仅 `DAILY_PAGE_ENABLED==='1'` 时启用，独立 `waitUntil`）：查 D1 `daily_pages` 今天（BJT date）行的 `generated_at` 是否晚于今天 UTC 0 点（=今天自然跑真生成了）；**无行 / 陈旧行** → PushDeer「[SEO] 今日日报页未生成」。**防重**：KV key `DAILY_PAGE_MISSING_ALERTED_<BJT-date>`（TTL 25h）保证当天只告一次。
  - 语义：明早自然跑成功 → Phase 4 无告警 + 缺页检查静默；失败 → 收到告警（同时验证自然日更是否正常）。
- 🆕 **加长扩展摘要（2026-07-06 本批次 Task 4，供 SEO 抓取）**：每条内容在原「一句话总结」下追加一段每源「最优加长字段」的扩展摘要（`<p class="summary-full">`），按句 clamp 到 `DAILY_PAGE_INTRO_MAX`（=500，`digest/config.ts`）。各源取值：blog→`excerpt_zh`／podcast→`shownotes_zh`／hf-paper→`summary_zh`(回退 `ai_summary_zh`)／gh→`ai_summary`／**ph→`description_zh`(回退 `ai_summary`，`description_zh` 由上方 `ph-description-translate` mode 产出)**／x→`content_translated`(回退 `content`)。**同源前缀 collapse**：当一句话与扩展摘要取同一源字段（hf/x/gh）、扩展是一句话的逐字前缀时，只渲染更长的扩展段（占一句话位置），避免开头逐字重复；异源（blog/podcast/ph）保留两段。扩展为空 → 不渲染该段（无空 `<p>`）。JSON-LD `itemListElement` 每条追加 `description`（用更长文本，SEO 增强）。**隔离**：`render.ts` 用 `RenderOptions.extendedIntro` flag（默认 false）隔离，邮件/codex/daily-api 不传 flag → 非 news 源 intro 仍 undefined，输出逐字节不变。
- **手动触发 / 重建 / 回填**（`Bearer INGEST_TOKEN`，**不受 `DAILY_PAGE_ENABLED` 限制**，可在 staging 验证）：
  - `POST /api/enrich/run?mode=daily-page` —— 重建今日 BJT 页
  - `POST /api/enrich/run?mode=daily-page&date=YYYY-MM-DD` —— 重建指定历史日
  - `POST /api/enrich/run?mode=daily-page&backfill=1` —— 遍历 `digest_pool`（normal 档非空）全部历史日期逐日串行回填，收尾一次性批量 IndexNow ping
  - 追加 `&dry=1` —— 只算不落盘（返回 `itemCount` / 回填日期清单）
- **⚠️ 已知运维事项**：`backfill=1` 单请求逐日串行跑，**受香港中转 60s proxy read 超时限制**（2026-06-22 教训）—— 历史日期多时单请求可能被中转掐断（worker 后台仍会跑完当前日）。大批量回填改为「按单日循环」在外层分多次请求（每次 `?date=` 指定一日，或先 `?backfill=1&dry=1` 拿到日期清单再逐日实跑），避免一次请求扛全部历史。
- **开关与 secret**（均存 `.secrets/aifeeds-{prod,staging}.env`）：`DAILY_PAGE_ENABLED` prod = `1`（已开）/ staging 未设 = 关；`INDEXNOW_KEY` prod / staging 各自值，未配置时 IndexNow 静默跳过。

### C 端站内搜索（FTS5 全文检索，**2026-07-06 staging 验收通过，待用户确认 → prod**）

> 匿名可用的站内搜索：入口放大镜 → 起始页（历史/热搜/源入口）→ suggestion → 分组结果页 → 单源下钻 → 抽屉，返回键逐级回退。服务端 D1 FTS5 影子表 + 中文 bigram 预分词，索引/词表全靠 cron 增量维护，与主管线解耦（搜索故障不影响 feed）。伺服路由见上方 §1「`/api/search`」两条；D1 三表（`items_fts` / `search_terms` / `search_sync_state`）见 §2；admin 监控见 §1「`?metric=search`」。设计：`docs/plans/2026-07-06-c-search-design.md`，实施计划：`docs/plans/2026-07-06-c-search-plan.md`。

- **cron 分流**（均挂现有 `*/5` scheduled，独立 `waitUntil` 与主管线解耦，失败下轮自补）：
  - **每 tick（每 5 分钟）**：`syncSearchIndex` 增量同步 —— 取 `scraped_at`/`translated_at` 超水位的行，过入索引门槛后 delete+insert 幂等 upsert，**单轮上限 2000 行**；首轮起自动 backfill（按 rowid 分批追平，5.5 万行 ≈ 2.3-2.5h）
  - **每整点（`minute===0`）**：`rebuildSearchTerms` 全量重建 suggestion 词表（entity + hot_query）
  - **每日 03:35 UTC**：`reconcileSearchIndex` 对账 —— **只 DELETE 事后失格行**（软删 / cn_sensitive 追标 / dedup），写 `last_reconcile` + drift（`items 合规行 − items_fts 行`），`|drift|>500` 触发既有 PushDeer 告警「搜索索引滞后」
- **限流**（KV `search:rl:{device_id|clientIp}:{分钟桶}`，TTL 120s，**fail-open**）：`/api/search` **12/min per device**、`/api/search/suggest` **40/min per device**；身份优先 `X-Device-Id`，缺失走 `client-ip.ts`（HK 中转塌 IP 坑）；超限 429 `rate_limited`。CF 既有 `/api/*` 10s/30req 规则兜底
- **admin 监控**：`/admin/dashboard` 搜索区块（`/api/admin/analytics?metric=search`，`admin-dashboard.ts`）—— 一次 fetch 拿 `{overview, topQueries, perf, errors, indexLag}`：搜索 PV/UV/人均次数、热门 query top、无结果率/CTR、query_time_ms 端到端 p50/p90/p99、429/500 错误趋势、**索引滞后量**（reconcile 写入的 drift）
- **埋点**：7 个 `search_*` 事件（open / submit / suggest_click / result_click / empty / error / perf）已加入 `worker/src/track.ts` `EVENT_TYPE_WHITELIST` 与 `dashboard/src/lib/telemetry/event-types.ts` 镜像

> [!important] Runbook（搜索索引运维，终审要求必读）
> 1. **`reconcile` 只清失格行，不回填缺失行** —— 每日 03:35 UTC 的 `reconcileSearchIndex` 只 `DELETE` items 已失格但 FTS 仍残留的行，**不会**把「合规却漏进索引」的行补回去。收到「搜索索引滞后」告警（`drift>500`）或发现某内容明明在库却搜不到时，跑 `POST /api/admin/search/reindex?reset=1` **全量重建**（重置 backfill 进度 + 重新播种水位，5.5 万行约 2.3h；单请求 ~20s 时间预算，**反复调用可加速**追平）。
> 2. **prod 首次上线后主动循环追平 backfill** —— 别干等每 5 分钟 cron 一点点推进（要 2h+），部署后立即循环调 `POST /api/admin/search/reindex`（首次不带 `reset`，靠自动 backfill 游标；返回 `backfillDone:true` 即追平），并触发一次 `POST /api/admin/search/rebuild-terms` 让 suggestion 词表就位。
> 3. **staging cron 全关** —— staging 的搜索索引与词表**不由 cron 自动维护**，只能靠手动触发 `reindex` / `rebuild-terms`（且 prod/staging `/api/admin/*` 被 CF Access 边缘拦截，无服务令牌时走 `wrangler dev` remote-bindings 调用，参见 Task 7 backfill 记录）。

---

## SEO 静态页运维（每日日报页 + `/i/` 全量内容页）

> 这条线把 aifeeds 可索引面从「~39 个 URL（首页 / 归档 / 日报聚合页）」扩到「3.2 万+ 独立内容页」。三块：① **每日静态日报页** `/daily/*`（早 8 点 Phase 4 生成，生成/告警/选品细节见上「订阅推送子系统」§「每日静态日报页 Phase 4」，此处不重复）；② **`/i/:source/:id` 全量内容 SSR 页**（五源 relevant 每条一页，约 3.2 万，2026-07-08 上线）；③ **robots / sitemap-index / 分片 / llms / IndexNow** 配套。内容为分源混合全文（gh/hf/ph/x 全文正文，blog/podcast 因版权只放摘录）+ `marked` markdown→HTML + 净化（零可执行 script）。设计：日报页 `docs/plans/2026-07-06-daily-static-page-seo-design.md`；item 页 `docs/plans/2026-07-08-item-ssr-pages-design.md` + 全文渲染器 `docs/plans/2026-07-08-item-page-fulltext-plan.md`。

### 1. 路由清单（伺服 + 缓存头）

均在 `index.ts` **bot gate 之后、鉴权路由之前**由 SEO 伺服层处理（`isSeoPath` 豁免 bot UA 闸，决策 5 全放），代码 `worker/src/seo-routes.ts` + `worker/src/seo/item-routes.ts`。**绝对 URL 一律 `env.SITE_BASE`，禁取 request host**（香港中转改写 Host，2026-06-08 教训）。

| 路由 | 伺服 | 缓存头 |
|------|------|--------|
| `/daily/:date` | R2 `daily/<date>.html` 快照命中 → 200；miss → noindex 404 页；日历越界 → 302 归档 | `public, max-age=3600` |
| `/daily/` `/daily` | 从 `daily_pages` 表实时渲染归档索引（按月倒序） | `public, max-age=3600` |
| `/archive/` `/archive/:source/` `/archive/:source/:yyyy-mm/[page]` | 从 `items` + `item_pages` 实时渲染五源分层归档；源仅 `x`/`gh`/`ph`/`paper`/`news`，每页 100，空月/越界页 noindex 404；资格 gate 与内容出口一致（live/relevant/未软删/非 dedup/非 `cn_sensitive`） | `public, max-age=3600` |
| `/robots.txt` | 模板（决策 5 全放，仅 Disallow `/api/` `/admin` `/settings` `/me/` `/unsubscribe`；末行 `Sitemap:`） | `public, max-age=86400` |
| `/sitemap.xml` | **sitemap-index**（2026-07-08 改），列全部分片 | `public, max-age=3600` |
| `/sitemap-archive.xml` | 归档 index、五个 source、全部有效 month/page URL；不混入 item sitemap | `public, max-age=3600` |
| `/sitemap-<source>.xml` | 各源 `item_pages`(status=live) 实际 URL 列表，每片 ≤5 万（超则续 `-2 -3…`）；分片有 `daily` / `x` / `gh` / `ph` / `hf-paper` / `news` 共 6 类；正则 `SITEMAP_SHARD_RE`（`worker/src/seo-routes.ts`） | `public, max-age=3600` |
| `/llms.txt` | 模板（中英各一行定位 + 归档/订阅入口 + 最近 7 天日报） | `public, max-age=86400` |
| `/<INDEXNOW_KEY>.txt` | IndexNow 域名归属校验文件（key 纯文本）；未配置 / key 不匹配的其它根级 `.txt` → 404 | `public, max-age=86400` |
| `/i/:source/:id` | 五源单页；URL source 段 = `x`\|`gh`\|`ph`\|`paper`\|`news`（`paper` = D1 的 `hf-paper`）。查 `item_pages.status`：live 且 R2 有 → 200；R2 miss 但 item relevant → **实时兜底生成**后返回；status=gone → 410 + noindex；未知 / 非 relevant → 404。**裸 `/i` 不豁免**（`isSeoPath` 要求 `pathname.startsWith('/i/')`） | `public, max-age=3600` |

### 2. D1 表

- **`daily_pages`**（migration 025）：日报页索引，见上 §2 D1 表清单。
- **`item_pages`**（migration 027）：`/i/` 页索引，见上 §2 D1 表清单。关键：`status` = `live`（伺服 200 + 进 sitemap）｜ `gone`（410 + noindex + 移出 sitemap）；`source` 列用 `hf-paper` 而 URL 段用 `paper`。

### 3. Admin mode 清单 + 用法（`POST /api/enrich/run`，`Bearer INGEST_TOKEN`；staging 加 `X-Dev-Token`）

**SEO 页生成 / 回填**：

- `mode=daily-page`（今日）｜ `&date=YYYY-MM-DD`（指定历史日）｜ `&backfill=1`（遍历 digest_pool 全部历史日逐日回填）｜ 追加 `&dry=1` 只算不落盘。不受 `DAILY_PAGE_ENABLED` 限制。细节见「每日静态日报页 Phase 4」。
- **`mode=item-page-regenerate&id=<composite-id>`**（精确重生一条 `/i/` 页）：
  - 只接受 `x_list|github|product_hunt|hf_paper|blog|podcast` 六种真实 `source_type`
    前缀的 composite id，长度上限 512；不接受 URL、R2 key、ClawHub 或任意路径。
  - 复用 `generateItemPage()` 的 relevant、dedup 与支持源 gate，不会绕过内容资格，也不会
    扫描其它 item。返回 `item_id`、`skipped`、`reason`、`generated_at`。
  - 适合 GSC 指向单页、R2 单对象修复和全量重灌前 smoke；示例：
    `POST /api/enrich/run?mode=item-page-regenerate&id=x_list%3A2061451225762046411`。
- **`mode=item-page-backfill&source=<x|gh|ph|hf-paper|news>`**（`/i/` 页主力回填）：
  - `&limit=N`（每批，默认小值；**x 源 limit 必须 ≤100**，见 §4）｜ `&dry=1`（零写，返回 `scanned`/`generated`/`remaining`）
  - `&force=1`：连**已存在**的页也重渲染覆盖（升级存量薄页 → 全文版 / 换渲染器后刷存量）。不带 `force` 时走存在性游标（`NOT EXISTS item_pages`），只补缺页。
  - `&cutoff=<ISO8601>`：force 重灌的收敛锚点，见 §4 runbook（**必须逐批回传，漏传不收敛**）。
  - 出页 gate = `is_relevant=1` 且 `extra.dedup_of IS NULL` 且 `source_type∈五源`；dedup 次源、非 relevant 在扫描前即排除（不进 `scanned`、不出重复页）。

**内容质量 / 封面 / 翻译（供 SEO 页取用的上游字段，均 2026-07-06 批次，`&limit=N[&dry=1]`）**，细节见上 §1 端点清单对应行：

- `mode=blog-cover-generic-sweep` — 源级通用图（favicon/RSS 头像簇）统计剔除，置 `cover_generic_cleared_hash`（**是下面 bodyhero 回填的前置**）
- `mode=blog-cover-bodyhero-backfill` — logo 清簇后取正文已迁 R2 的 hero 图差异回填（**强依赖先跑 generic-sweep**）
- `mode=blog-cover-og-backfill` — og:image 存量回填（**勿对 jiqizhixin/qbitai 跑**，其 og 是被清 logo）
- `mode=blog-body-redecode` — RSSHub 源正文实体编码 `<p>` 泄漏清洗
- `mode=the-verge-editorial-image-cleanup` — The Verge 作者头像清理；先 `dry=1`，再循环真跑至 `remaining=0`
- `mode=ph-description-translate` — PH 英文 description → `description_zh`（日报页 / `/i/ph/` 扩展摘要取用）

### 4. `/i/` 页重灌 runbook（关键运维知识）

> 复用脚本 `force-backfill-src.sh <source> [limit]`（job tmp，含 error/stall 守卫 + cutoff 线程化）。2026-07-09 五源 force 全量重灌（薄页 → 全文版）即按此跑到各源 `remaining=0`。

1. **先精确重生目标页再开全量 campaign** —— 用 `item-page-regenerate` 重生 GSC/Ahrefs
   指向的 composite id，拉取 HTML 并解析 JSON-LD；确认目标页 200、全部字符串无孤立
   surrogate、`skipped=false` 后才进入 force loop。这个 mode 只写一个 R2 快照和一行
   `item_pages`，不能替代后续存量重灌。
2. **force 重灌必须用 cutoff loop 收敛** —— `force=1` 会重渲染已存在的行，靠 `generated_at >= cutoff` 退出候选实现单调收敛。**每批把上一批响应里的 `cutoff` 原样回传下一批**（脚本把 `:`→`%3A` URL 编码）；首批不带 cutoff（worker 取 now 为 campaign 锚点）。**漏传 cutoff → 每批重扫同一批行、`remaining` 不降、永不收敛**。中途改脚本续跑时用同一 seed cutoff，跳过已重灌行，无重复。
3. **x 大盘 `limit` 必须 ≤100** —— x 单条含引用/推文串串渲染，`limit=200` 每批渲染太重 → worker CPU 吃紧、~25% 空响应超时。gh/ph/hf 在 100 全 0 错误；x 用 200 撞超时后切回 100 全程 0 新错误。**再跑 x 大盘直接 100，勿用 200**。
4. **直连 `xlist-api.ltsms86.workers.dev` + `X-Dev-Token` 绕香港 60s** —— 经 `api.ai-feeds.com` 走香港 nginx，item-page 渲染 wall-clock 常 >60s → 客户端 504 / `curl exit28`，但 **worker 后台仍会跑完**。直连 workers.dev（附 `Authorization: Bearer $INGEST_TOKEN` + `X-Dev-Token: $DEV_TOKEN`）绕过；批 100 实测 ~32s 无 504。**若仍走香港看到 504/000，别当失败**，按响应 `remaining` 递减核对进度（或 `SELECT count(*) FROM item_pages GROUP BY source`），worker 大概率已写。
5. **长任务用 `nohup` 脱离 harness 后台更稳** —— harness 后台任务曾被杀一次（疑后台运行时上限）；`nohup` 脱离进程 + 同 cutoff 无缝续跑。
6. **`remaining` 卡固定值不降 = 疑脏 id，人工排查** —— 若 `scanned>0` 但 `generated=0` 且 `remaining` 连续不缩，脚本 stall 守卫会 break：多半是 `source_type∈五源` 但 composite id 前缀与源不匹配的脏行。人工 `SELECT` 排查，别硬刷爆 API。
7. **news 前确认 C1 dedup 门** —— news（=blog+podcast 虚拟源）跑前确认 dedup 次源（`extra.dedup_of` 非空）在扫描谓词里被排除：次源自动 `skipped`、不进 `scanned`、不出重复页、不入 sitemap（2026-07-09 实测 `podcast:gradient-dissent:…` dedup 次源 item_pages 计数 = 0）。

### 5. 香港 nginx 转发

`ai-feeds.com` 灰云直连香港 VPS（`154.12.188.231`）。front server 块一个 **regex location** 把 `/daily(/.*)?`、`/archive(/.*)?`、`/i/.*`、`robots.txt`、`sitemap.xml`、`sitemap-<source>.xml` 分片、`llms.txt`、`<INDEXNOW_KEY>.txt` 转发到与 api 块同一 worker upstream（`xlist-api.ltsms86.workers.dev`），照 api 块注入全套头（`Host: workers.dev` + `X-Forwarded-Host: api.ai-feeds.com` + `X-Origin-Secret` + `proxy_ssl_name/server_name`）。**故意不启用 proxy_cache**。完整正则 + 演进见上 §6b「六续」（daily + SEO 文件）/「七续」（扩 `/i/*` + sitemap 分片）。

- **权威副本已版本化**：`deploy/nginx/aifeeds-seo-location.conf`（repo 内，含完整回滚 / 部署步骤注释）。**VPS 仍是实际生效配置**，改这个副本后须 SSH 同步 VPS → `nginx -t` → `systemctl reload nginx` → 清缓存（`rm -rf /var/cache/nginx/aifeeds/*`）。upstream / SNI / 注入头一律照现有 `/daily` location 的 proxy 体，别自己拼。
- **回滚**：删该 location 块 + reload（worker 路由无状态；api 域 `/daily` `/i/` 等仍可直达不受影响）。

### 6. 三层路径口径必须一致（加新 SEO 路径时同步三处）

新增任何 SEO 静态路径，**下面三处的路径判定必须同时改，否则页面会被某一层截断**：

1. **nginx 正则**（`deploy/nginx/aifeeds-seo-location.conf` + VPS）—— 决定主域该路径转不转 worker
2. **worker `isSeoPath()`**（`worker/src/seo-routes.ts`）—— 决定该路径豁不豁免 bot UA 闸
3. **`dashboard/public/sw.js` 的 `isSeoPath()`** —— 决定 PWA SW 拦导航时透传还是喂缓存壳

当前三层均包含 `/daily`、`/archive`、`/i/*`、sitemap 与根级 SEO 文本路径；契约测试覆盖 production 权威副本、perf-staging 模板和 Service Worker，避免新增 SSR 路由被 SPA 壳截获。

### 6.1 内容归档与链接图验收

- item 页相关内容只取同源、live、relevant、非 dedup、非软删/涉华敏感的稳定时间邻居：
  以 `(published_at DESC, id DESC)` 为序，当前项前后各 3 条；不再让历史页永久指向
  全站最新条目。
- item 页 JSON-LD 第二级 breadcrumb 指向 SSR source archive，正文 header 同时链接 source/month
  archive；Dashboard footer、classic `<noscript>` 与日报 footer 均提供 `/archive/` 普通链接。
- 只读验收器：`node scripts/verify-item-link-graph.mjs --base-url https://ai-feeds.com`。它只抓
  sitemap 与 archive HTML，不重复抓全部 item 正文；检查每个 sitemap item 至少一个 archive
  入链、archive 目标完整、无链接指向 sitemap 外的 gone/404、无 PH canonical 重复，且
  `/archive/` 到 item 的最大深度不超过 5。

### 7. 图片

- `/i/` 页内图（gh README 图 / ph·hf 封面）走 `/r/<key>` R2 反代（与抽屉同一套 `resolveAssetUrl`，SSR 没缺任何东西）。hf 页无内嵌 R2 图，页图是 HF 官方社交缩略图（外链 og）。
- ⚠️ **staging `/i/` 页图会挂图是数据假象，非 bug** —— staging R2 是独立空桶 `xlist-readme-assets-staging`（wrangler.toml staging `READMES` binding），从没被 R2 迁移任务填过；staging D1 的 `/r/` key 是从 prod 快照灌来的悬空指针 → staging 全 404、prod 同 key 全 200。**图片是否正常一律以 prod 判定**，别在 staging 纠结挂图。

### 8. IndexNow 现状

- **每日静态日报页生成后 ping**（`daily/<date>` + `/daily/` + `/sitemap.xml`，提交给 Bing/Yandex）。fire-and-forget，非 2xx 只记日志不重试。
- **`/i/` 页目前未接 IndexNow**（3.2 万页只靠 sitemap + 自然抓取被发现）—— 遗留增强项（TODO §12 SEO 遗留低优 #1，值得做，Bing/Yandex 侧可加速收录）。
- **Google 不支持 IndexNow**，只能靠 sitemap 提交 + 自然抓取（GSC 提交见 `docs/seo-webmaster-guide.md`）。
- key = secret `INDEXNOW_KEY`（prod / staging 各自值，存 `.secrets/aifeeds-{prod,staging}.env`）；未配置时 ping 静默跳过。

### 9. 数据量

- `item_pages` prod **live ~3.2 万行**（2026-07-09 全量重灌后：gh 223 / ph 857 / hf-paper 1487 / x 29088 / news 1070，+ x gone 1）+ 日增；= 五源 relevant 非 dedup 总量，与各 sitemap 分片逐一对齐。
- 3.2 万页 × ~40KB ≈ 1.3GB（R2 免费 10GB 内）；sitemap 每片 ≤5 万，年增五源 5-7 万页超单片时自动续分片（`-2 -3…`）。D1 / R2 / worker 请求均零头，永不撞上限。
- **大 README 截断链在 prod 当前休眠**（非 bug）：gh chosen readme 最大 ~2.9 万字 < 40000 阈值（`GH_README_MAX_CHARS`），over40k=0，「在 GitHub 查看完整 README →」截断路径已单测但无 live 数据触发；未来出现超大 README 自动生效。

---

## 本地服务（MacBook）

### 1. launchd: `com.xlist-scraper.cron`（**已停用 2026-05-06**）

> **状态**：`launchctl unload` 已执行，被 worker 端 ScrapeBadger list-poll-ingest cron 取代。
> plist 文件保留作 fallback；如 SB 服务出问题可 `launchctl load` 临时恢复。
> ScrapeBadger 频率 / 月成本对照见 [`docs/scrapebadger-cost-and-frequency.md`](scrapebadger-cost-and-frequency.md)。
> 关联 `.tune`（schedule 自动调参）也已 unload，没了 `.cron` 它没意义。
>
> 还在跑的：`.longform`（处理 D1 里既存的截断推文 backlog；SB 接管后新推文直返 full_text 不需要它，但旧 item 还得它兜底）。

- **plist**：`~/Library/LaunchAgents/com.xlist-scraper.cron.plist`
- **脚本**：`~/.claude/skills/xlist-scraper/scripts/cron.sh`
- **频率**：每 5 分钟 tick（`StartInterval=300`），实际是否抓由 `schedule.py` 动态决定（见下方）
- **日志**：
  - `data/launchd-stdout.log` / `data/launchd-stderr.log`（launchd 原始输出）
  - `data/cron.log`（cron.sh 自己记的结构化日志）
- **行为**：
  1. cookie 过期检查（< 30 天弹窗提醒）
  2. 前置检查：网络（curl x.com）、电量（<20% 且未充电跳过）
  3. **动态调度 gate**：读 `data/.next-scrape-at`，未到时间则 `[SKIP:SCHED]` 退出
  4. 锁文件防重入（`data/scraper.lock`）
  5. 跑 `main.py <list_id>` → list_scraper + tweet_processor + output.push_to_cloud → `schedule.schedule_next` 写下次时间

### 1a. 动态抓取频率（`schedule.py`）

- **源码**：`~/.claude/skills/xlist-scraper/scripts/schedule.py`
- **策略**：C2 hybrid（按 prior 阈值切分热/冷）
  - **hot zone**（prior ≥ 0.15 tweets/min，约对应 BJT 20-02 + 中午的美国峰）：固定 **20min**，保证新鲜度
  - **cold zone**（prior < 0.15，约对应 BJT 13-18 的亚洲白天）：`target_new=10` 动态，blend prior + recent，上限 60min
- **回溯模拟结果**（14d train + 14d sim, 1892 tweets，参见 `scripts/simulate_schedules.py`）：
  - 之前 Fixed 30min：672 runs, 20.7% zero-yield, p95 发现延迟 29min
  - 切到 C2 hybrid：490 runs (**-27%**), 11.8% zero-yield, p95 发现延迟 56min
  - hot 时段 p50 延迟 15m → ≤10m；cold 时段被拉长到 20-60m 换成本节省
- **算法**：
  - prior：过去 30 天同 (BJT 星期, 小时) 的 tweets/分钟
  - recent（仅 cold zone 用）：最近 3 个 run_stats 区间的 new_count/分钟
  - cold zone: blended = 0.5 × prior + 0.5 × recent；interval = target_new / blended，clamp 到 [min, max]
  - hot zone: 跳过 recent，直接固定 hot_interval_sec
- **输出**：写 Unix 时间戳到 `data/.next-scrape-at`
- **触发**：每次 `main.py` 成功跑完在 `finally` 后调 `schedule_next(list_id)`
- **参数来源**：`data/schedule_params.json`（由 `tune_schedule.py` 每周覆写，见 1b）。文件不存在或损坏时回退到 `schedule.py` 顶部 `DEFAULT_PARAMS`（threshold=0.15 / hot=1200s / target=10 / min=600 / max=3600）
- **手动预览**：`XLIST_DATA_DIR=/Users/roxor/brain/30-projects/aifeeds python3 ~/.claude/skills/xlist-scraper/scripts/schedule.py <list_id>`

### 1b. 周度自动调参（`tune_schedule.py`）

- **源码**：`~/.claude/skills/xlist-scraper/scripts/tune_schedule.py`
- **plist**：`~/Library/LaunchAgents/com.xlist-scraper.tune.plist`
- **频率**：每周一 04:00 BJT（冷时段，避开 scrape）
- **目标**：根据最近 14 天的 tweets 重新计算 `hot_prior_threshold` / `hot_interval_sec` / `target_new`
- **算法**：
  - `hot_prior_threshold` = 过去 14 天 (weekday, hour) prior 分布的 60 分位（只算非零格）
  - `hot_interval_sec` = target_new / hot 格 prior 中位数 × 60s，clamp 到 [10min, 30min]
  - `target_new` 固定 10（后续可改 cost-aware）
- **三道护栏**：
  1. **最小数据量**：最近 14 天 tweets < 500 → 整体 skip，用 `DEFAULT_PARAMS` / 继承上次
  2. **变化率限制**：新 `hot_interval_sec` 相对当前不能变化超过 ±30%，超出按 30% 硬 clamp
  3. **Dry-run 拒绝**：对最近 7 天做 `simulate_schedules.py` 同款回溯，若新参数在 `runs` / `zero_rate` / `p95_delay_min` 任一项比当前参数差 >20% → 拒绝更新（保留旧参数）
- **审计日志**：每次运行（ACCEPT / REJECT / SKIP）追加一条到 `data/schedule_params_log.md`
- **日志**：`data/launchd-tune-stdout.log` / `data/launchd-tune-stderr.log`
- **手动触发**：
  - `launchctl start com.xlist-scraper.tune`（按线上路径跑，落盘）
  - `XLIST_DATA_DIR=... python3 scripts/tune_schedule.py --dry-run`（只预览不写盘）
- **回滚**：删除 `data/schedule_params.json` 即可回到硬编码 defaults。不改代码、不重启 launchd

### 1d. ~~launchd: `com.aifeeds.ph-scraper`~~（已退役，迁移到 CF 端）

> **已迁移到 CF Worker**（2026-05-11 上线 prod，2026-05-13 清理本地 fallback）。
> `launchd/com.aifeeds.ph-scraper.plist` + `scrapers/ph/*.py` 已从仓库删除（git 历史保留代码）。新的远端实现见
> 上方「CF Worker → 1.1 Product Hunt」章节。
> 完整旧实现摘要 + fallback 恢复步骤（含 commit hash）见 [`docs/archive/ph-scraper-retired.md`](archive/ph-scraper-retired.md)。

### 1c. ~~launchd: `com.aifeeds.github-scraper`~~（已退役，迁移到 CF 端）

> **已迁移到 CF Worker**（2026-05-02）。本地 launchd plist 已 unload；
> 项目里 `launchd/com.aifeeds.github-scraper.plist`、`scrapers/github/*.py`、
> `scrapers/_lib/*.py` 保留作历史参考但不再调度。新的远端实现见
> "CF Worker → 1.1 GitHub trending phase 1/2 cron" 章节。

- **退役命令**（用户已执行）：
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aifeeds.github-scraper.plist
  rm ~/Library/LaunchAgents/com.aifeeds.github-scraper.plist  # 可选
  ```



| 脚本 | 用途 | 现状 |
|------|------|------|
| `list_scraper.py` | 抓 X List（browser-use + cookies） | cron 每 30 min 自动调 |
| `tweet_processor.py` | DeepSeek 分类 + 翻译 | cron 自动调 |
| `output.py` | 导出 markdown + push_to_cloud | cron 自动调 |
| `enrich_from_syndication.py` | 补 quote_of / link_card / metrics / 翻译 | **正在被迁到 Worker cron，本地版 deprecate 中** |
| `reclassify_affected.py` | 改完 prompt 后重新跑分类 | 按需手动 |
| `cleanup_translations.py` | 修复历史翻译（黑名单扫全库） | 按需手动 |
| `sync_reclassified_to_cloud.py` | 本地 reclassify 后补推到 D1 | 按需手动 |
| `balance_check.py` | 查 DeepSeek 余额 | 按需手动 |
| `enrich_longform.py` | 长推 fetch（browser-use 抓完整正文 → POST Worker /api/longform/submit） | 按需手动；推荐每周/有积压时跑 `--limit 50` 排空 pending |
| `backfill_cloud.py` / `backfill_quote_of.py` / `backfill.py` | 历史遗留 backfill | 已基本弃用 |

### 3. 本地数据目录

```
/Users/roxor/brain/30-projects/aifeeds/data/
├── xlist.db                本地 SQLite（staging）
├── pages/                  分页抓取临时缓存（崩溃恢复）
├── ph/pages/               PH 抓取的产品页 HTML 快照（每个 product 一个，崩溃时复跑解析；定期人工清理）
├── logs/ph-cron-*.log      PH scraper cron.sh 按天结构化日志
├── ph-rescrape-*.log       手动整榜 / 单 slug 重抓的日志
├── enrich_state/*.json     本地 enrich 进度（Worker 化后将废弃）
├── scraper.lock            cron 锁文件
├── cookie-warn-stamp       cookie 过期警告节流
├── cron.log / launchd-*    日志
├── .next-scrape-at         下一次抓取 Unix 时间戳（schedule.py 写，cron.sh 读）
├── schedule_params.json    tune_schedule.py 每周覆写的动态参数（不存在则用 DEFAULT_PARAMS）
├── schedule_params_log.md  调参审计日志（每次 ACCEPT/REJECT/SKIP 追加一行）
└── exports/YYYY-MM-DD-*.md 每次抓取导出的 markdown
```

---

## Secrets 和配置

| Secret | 存在哪里 | 用途 |
|--------|----------|------|
| `INGEST_TOKEN` | CF Worker secret（`wrangler secret list` 可查） | 保护 /api/ingest 和 /api/enrich/run |
| `DEEPSEEK_API_KEY` | 本地 `~/.claude/skills/xlist-scraper/scripts/.env` + CF Worker secret（两端同一把 key） | 本地：分类 + 翻译；Worker：fill-translations 翻译。**模型选型**见 [`CLAUDE.md` § DeepSeek 模型选型](../CLAUDE.md)：默认 `deepseek-v4-flash`，复杂推理用 `deepseek-v4-pro`，文档 https://api-docs.deepseek.com/zh-cn/ |
| x.com cookies | Chrome Default profile → cookie_manager.py 解密 | 抓取登录态 |

**设置 Worker secret**：`cd worker && npx wrangler secret put INGEST_TOKEN`

**安全注入 key 到 Worker**（避免 key 出现在终端历史/AI context）：
```bash
cd worker
grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2- | npx wrangler secret put DEEPSEEK_API_KEY
```

**本地开发 Worker**：`worker/.dev.vars`（gitignored），格式 `KEY=value`，每行一对。需要包含 `INGEST_TOKEN` + `DEEPSEEK_API_KEY`（后者可用同样的 pipe 注入：`echo "DEEPSEEK_API_KEY=$(grep -m1 '^DEEPSEEK_API_KEY=' ~/.claude/skills/xlist-scraper/scripts/.env | cut -d= -f2-)" >> .dev.vars`）。

### Cloudflare 运维 token（跨 session 共享）

**位置**：项目根 `.secrets/aifeeds-prod.env`（已 gitignored，路径见 `.gitignore` `.secrets/` 一行）

**内容**：
- `CF_OPS_API_TOKEN` — account-owned master token，权限是「创建 account-owned 子 token」（**自身不带任何资源 Read / Write 权限**，连 list zones 都返回空）
- `CF_ACCOUNT_ID` — CF account ID
- `CF_ZONE_ID` — 默认 zone（当前指向 `ai-feeds.com`，zone ID `e7982a660d8def7a2ce5ec60f28282fc`）；如新增 zone 再补 `CF_ZONE_<NAME>` 变量
- `CF_ZONE_AIFEEDS_COM` — `ai-feeds.com` 的具体 zone ID（覆盖所有子域 staging-api / api / www / staging / blog / mail）

**用途**：让 Claude Code session 跨对话延续 CF 运维能力。session 用 master token 现场创建一个「最小权限 + 短 TTL」的子 token 去做实际操作（看 zone settings、列 WAF rules、查 Turnstile widgets、推 secret、改 DNS 等），避免长期暴露高权限 token。

**典型用法**（Bash）：

```bash
source .secrets/aifeeds-prod.env

# Step 1: 查 permission group ID（一次性，可缓存到下方表里）
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens/permission_groups" \
  -H "Authorization: Bearer $CF_OPS_API_TOKEN" | jq '.result[] | select(.name | test("(?i)bot|zone|waf"))'

# Step 2: 写 policy JSON 文件（注意 resource 写法见下方规则）
EXPIRES=$(date -u -v+24H +"%Y-%m-%dT%H:%M:%SZ")
cat > /tmp/cf-subtoken.json <<EOF
{
  "name": "ops-readonly-$(date +%s)",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {"id": "c8fed203ed3043cba015a93ad1616f1f"},
        {"id": "517b21aee92c4d89936c976ba6e4be55"}
      ],
      "resources": {"com.cloudflare.api.account.zone.${CF_ZONE_ID}": "*"}
    }
  ],
  "expires_on": "${EXPIRES}"
}
EOF

# Step 3: 创建子 token
SUB_TOKEN=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens" \
  -H "Authorization: Bearer $CF_OPS_API_TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/cf-subtoken.json | jq -r '.result.value')
echo "$SUB_TOKEN" > /tmp/cf-sub.token && chmod 600 /tmp/cf-sub.token

# Step 4: 用子 token 干活（示例：查 zone settings）
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/bot_management" \
  -H "Authorization: Bearer $SUB_TOKEN" | jq
```

**⚠️ 创建子 token 的 resource 写法（踩坑笔记，2026-05-07）**：

account-owned token 创建子 token 时，resource 字段对每种 scope 有不同写法。**写错就报 1001 error**：

| scope | 错误写法 ❌ | 正确写法 ✅ |
|---|---|---|
| Account-scoped permission group（如 `Account Analytics Read`） | — | `"com.cloudflare.api.account.${CF_ACCOUNT_ID}": "*"` |
| Zone-scoped permission group（如 `Zone Read`、`Bot Management Read`） | `"com.cloudflare.api.account.zone.*": "*"`（报 "must specify a zone for account owned tokens"）<br/>`"com.cloudflare.api.account.${CF_ACCOUNT_ID}.zone.*": "*"`（报 "is not a supported resource type"） | `"com.cloudflare.api.account.zone.${ZONE_ID}": "*"`（必须 nest 到具体 zone ID，不能通配） |
| 同一个 policy 混合不同 scope | — | 不行。混合 scope 需写**两个独立 policies**，每个 policies 只放 scope 一致的 permission_groups |

完整多 scope 模板见上面 Step 2 JSON 里的 `policies` 数组结构。

**已知 permission group ID**（用过的，免去重新查）：

| 名称 | ID | scope |
|---|---|---|
| Account Analytics Read | `b89a480218d04ceb98b4fe57ca29dc1f` | account |
| Zone Read | `c8fed203ed3043cba015a93ad1616f1f` | zone |
| Zone Settings Read | `517b21aee92c4d89936c976ba6e4be55` | zone |
| Zone WAF Read | `dbc512b354774852af2b5a5f4ba3d470` | zone |
| Zone Settings Write | `3030687196b94b638145a3953da2b699` | zone |
| Zone WAF Write | `fb6778dc191143babbfaa57993f1d275` | zone |
| Bot Management Read | `07bea2220b2343fa9fae15656c0d8e88` | zone |
| Bot Management Write | `3b94c49258ec4573b06d51d99b6416c0` | zone |
| Analytics Read | `9c88f9c5bce24ce7af9a958ba9c504db` | zone |
| Firewall Services Read | `4ec32dfcb35641c5bb32d5ef1ab963b4` | zone |
| Firewall Services Write | `43137f8d07884d3198dc0ee77ca6e79b` | zone |
| Turnstile Sites Read | `5d78fd7895974fd0bdbbbb079482721b` | account |
| Turnstile Sites Write | `755c05aa014b4f9ab263aa80b8167bd8` | account |
| AI Gateway Write | `6c8a3737f07f46369c1ea1f22138daaf` | account |
| Account Settings Write（覆盖 RUM / Web Analytics 端点 `/accounts/:id/rum/site_info`） | `1af1fa2adc104452b74a9a3364202f20` | account |
| Workers Observability Write | `82c075da3f4647a2a03becd0fe240f8a` | account |

**常用 endpoint 速查**（用 Step 4 的子 token）：

```bash
# 看 3 个 SEO/GEO 关键开关一次性
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/settings/security_level" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result.value'      # under_attack 模式开关
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/bot_management" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result'                    # fight_mode + ai_bots_protection
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" -H "Authorization: Bearer $SUB_TOKEN" | jq '.result.rules[] | {description, action, enabled}'  # WAF custom rules

# Analytics 流量数据（GraphQL）
SINCE=$(date -u -v-23H +"%Y-%m-%dT%H:%M:%SZ")  # ⚠️ 免费版 zone Adaptive 时间窗严格 < 24h，安全用 23h
curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $SUB_TOKEN" -H "Content-Type: application/json" \
  --data "{\"query\":\"query { viewer { zones(filter: {zoneTag: \\\"$CF_ZONE_ID\\\"}) { httpRequestsAdaptiveGroups(limit: 30, orderBy: [count_DESC], filter: {datetime_geq: \\\"$SINCE\\\", verifiedBotCategory_neq: \\\"\\\"}) { count dimensions { clientRequestHTTPHost verifiedBotCategory } } } } }\"}" | jq

# 1d Groups（最长 30 天）— 看每日总请求 / 缓存 / 威胁
curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $SUB_TOKEN" -H "Content-Type: application/json" \
  --data "{\"query\":\"query { viewer { zones(filter: {zoneTag: \\\"$CF_ZONE_ID\\\"}) { httpRequests1dGroups(limit: 30, orderBy: [date_DESC]) { dimensions { date } sum { requests cachedRequests threats pageViews } uniq { uniques } } } } }\"}" | jq
```

**免费版 Plan 已知限制**（计入查询时考虑）：
- `httpRequestsAdaptiveGroups` 单次查询时间窗严格小于 24h（用 23h 安全）
- `botScore`、`botScoreSrc` 等高级字段无访问权限（authz 错误）
- Page Rules endpoint **不接受 account-owned token**（报 1011），只能用 user-owned token 看
- Bot Fight Mode（基础版）不能被 WAF custom rule `skip` action bypass（这是 BFM 自身限制，与 token 权限无关）

**轮换 / 撤销**：
- 怀疑泄露：CF Dashboard → 头像 → My Profile → API Tokens → 找到 token → Roll（生成新值）或 Delete
- Roll 后把新值覆盖写回 `.secrets/aifeeds-prod.env`
- master token 本身权限低（只能创建子 token），泄露风险有限，但**仍建议每 6-12 个月主动 roll 一次**

**安全约定**：
- ❌ 不要在对话中明文重复贴 token（log 里会留痕）
- ❌ 不要写到 `wrangler.toml` / 任何 git-tracked 文件
- ❌ 子 token 一律带 `expires_on`，不要做永久 token
- ✅ 操作完成后子 token 自动过期，不需要手动撤

---

## 健康检查

### 远端状态

```bash
# 看 D1 总数 + 今日入库量
curl -s https://api.ai-feeds.com/api/stats | jq

# 抽查翻译质量（随机 20 条）
npx wrangler d1 execute xlist --remote --command="SELECT source_id, SUBSTR(content, 1, 80) AS content, SUBSTR(content_translated, 1, 80) AS translated, translation_quality FROM items WHERE is_relevant=1 AND content_translated IS NOT NULL ORDER BY RANDOM() LIMIT 20;"

# 看最近的 enrich 进度
cd worker && npx wrangler d1 execute xlist --remote \
  --command="SELECT mode, length(state), updated_at FROM enrich_state;"

# 实时看 Worker 日志（cron 触发、错误）
cd worker && npx wrangler tail
```

### 本地 launchd 状态

```bash
# 是否在跑
launchctl list | grep xlist-scraper

# 看最近的 cron 日志（最后 30 行）
tail -30 /Users/roxor/brain/30-projects/aifeeds/data/cron.log

# 看原始 stdout/stderr
tail -50 /Users/roxor/brain/30-projects/aifeeds/data/launchd-stderr.log
```

---

## 常见运维操作

### 部署更新

```bash
# Worker —— ⚠️ 必须 cd worker/，不能从仓库根 deploy
cd worker
rm -f ../wrangler.jsonc  # 防 wrangler 4.x bug（见下方陷阱）
npm run deploy           # 或 npx wrangler deploy

# Dashboard（前端）
cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard

# D1 schema 变更
cd worker && npm run db:init        # 推远程
cd worker && npm run db:init:local  # 推本地（wrangler dev 用）
```

#### 阶段 5 治本：workflow 幂等 marker + drain SQL 扩展 + drawer 触发（2026-05-16）

3 个抓取链 workflow (GH / X / hdx) 的 drain endpoint + Phase 1 + drawer refresh 统一改造：

1. **幂等 marker**：`triggerXxxWorkflowForItem` helper 写 `extra.workflow_triggered_at` (unix sec) → drain SQL 加 `AND (workflow_triggered_at IS NULL OR < strftime('%s','now','-30 minutes'))` 过滤 30min 内已触发的 item，避免 drain 反复试已 in-flight 的 instance。30min 后视为 stuck 可重新触发。
2. **drain SQL 扩展**：从「只扫未分类」扩到覆盖所有 stuck 类型（X：未分类/未翻译/长推没拉/quote+reply 没回填；GH：pending/未分类/README 没译/R2 没迁；hdx：detail 没拉）。
3. **drawer 触发**：`refreshSingleItem` 检测到 item stuck 时（drawer 打开时）自动 trigger workflow 补全（marker 30min 防重）。X/GH/hdx 三个分支都加。

**limit 上限**：所有 drain endpoint 上限 **400/批**（CF Worker 单次 1000 subreq 限制，1 item = 2 subreq UPDATE+create + 1 SELECT 余量 = 单 batch 安全 ~400）。drain 大 backlog 时分多批跑。

**触发链路总览**：
- 新 item 入库 → Phase 1 自动 trigger workflow（写 marker + create）
- 老 stuck → drain endpoint 扫库 + trigger（写 marker + create，marker 防重）
- 用户打开 drawer → refreshSingleItem 检测 stuck + trigger（marker 防重）

#### ⚠️ wrangler 4.x 部署陷阱（2026-05-16 踩过一次，prod 30 秒断线 + 14 个 secrets 全擦）

**陷阱**：wrangler 4.x 在某些情况下会在**仓库根目录**自动生成 `wrangler.jsonc`（指向 `cc-site/` 静态目录，name = 分支名），优先级高于 `worker/wrangler.toml`。

**后果**：从仓库根跑 `wrangler deploy` 会把 cc-site 静态站当成 worker 部署到 xlist-api，把整个 worker bindings 含 14 个 secrets 全擦掉（rollback 只还原 code 不还原 secrets，需要 OPS 手工重置全部 secrets）。

**防御**（每次部 worker 都做）：
1. **必须** `cd worker/` 进 worker 目录再部署，不要在仓库根跑 wrangler
2. 部之前先 `rm -f ../wrangler.jsonc` 清掉 rogue file（已 gitignored，但 wrangler 跑完会再生）
3. 部之后看 wrangler 输出 `Uploaded xlist-api` 而不是别的名字（如 `be-xxx-yyy`），别的名字 = 走错配置立刻 Ctrl+C
4. 永远不要用 `--name xlist-api` flag 试图覆盖，那会用别的 wrangler.toml 但保留 `xlist-api` 名字 → 更糟

**事故恢复**（万一又踩坑）：
1. `npx wrangler rollback --name xlist-api`（30 秒内回到上一版 code，但 secrets 不会还原）
2. `wrangler secret list --name xlist-api` 验证 secrets 是否还在（返回 `[]` = 全擦了）
3. 如果擦了 → 按 [§3 Secrets 节「事故恢复一键 restore」](#3-secrets统一-source-模式2026-05-16-改造) 跑那段 for 循环，从 `.secrets/aifeeds-prod.env` 12 个 worker secret 全部 restore
4. 验证：`wrangler secret list --name xlist-api` 含 12 个 secret
5. 业务侧 smoke：浏览器打开 `https://api.ai-feeds.com/admin` → CF Access 拦截 → 邮箱 OTP 登录 → 看到管理面板。⚠️ **CF Access 上线后 curl + Basic Auth 不再生效**（除非删 `CF_ACCESS_AUD` secret 回落到 fallback 模式）；curl 测试需先在 CF Dashboard 创建 Service Token 用 `CF-Access-Client-Id` + `CF-Access-Client-Secret` 头，或临时回落 Basic Auth

### 停启本地 cron

```bash
# 暂停（不再触发，但不删除 plist）
launchctl unload ~/Library/LaunchAgents/com.xlist-scraper.cron.plist

# 恢复
launchctl load ~/Library/LaunchAgents/com.xlist-scraper.cron.plist

# 立刻手动跑一次（绕过 launchd）
bash ~/.claude/skills/xlist-scraper/scripts/cron.sh
```

### 手动触发 enrich

```bash
# 远端 Worker 跑 1 批（默认 limit=20）
curl -s -X POST "https://api.ai-feeds.com/api/enrich/run?limit=20" \
  -H "Authorization: Bearer $INGEST_TOKEN" | jq
```

### 查进程 / kill 挂在后台的脚本

```bash
# 所有 xlist 相关 python 进程
ps auxww | grep -iE '(list_scraper|tweet_processor|enrich_from_syndication)' | grep -v grep

# kill
kill <PID>
```

---

## 跨 session 维护指引

**每次新增/下线服务必须改这个文档**，至少更新：

1. 「架构总览」里的 ASCII 图
2. 对应章节（远端 / 本地 / Secrets）的清单
3. 「最后更新」日期

**每次 session 开始检查**：

1. 读本文档了解当前 stack
2. 读 `docs/TODO.md` 了解待办
3. 跑一下「健康检查」命令确认 stack 健在

**变更分类**：

- **新增 Worker / cron / secret** → 必改本文档
- **改 endpoint 逻辑** → 可以不改（代码里有）
- **改部署频率 / limit** → 建议改（容易遗忘）
- **添加新的本地 python 脚本** → 如果是 cron 调的，必改；按需手动的，看心情
