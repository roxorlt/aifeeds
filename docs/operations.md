# xList Scraper 运维手册

> 维护目标：跨 session、跨设备、跨人都能快速搞清楚「谁在哪里跑什么」。
> 每次新增/下线服务都要同步改这个文档。

最后更新：2026-06-02（香港中转加速上线：前端 / api / fonts 改走香港 VPS 反代，绕开 CF 中国无节点的慢，itdog 全国平均访问 1.46s→0.87s、电信快 3 倍。详见 §6 自定义域名与 DNS + §6b 香港中转加速节）

历史：2026-05-09（ClawHub v2：抽屉内容跟 ClawHub 网页对齐。抓取从「自己解 ZIP 挑文件」改成「调 ClawHub 自家的 `skills:getReadme` 接口」，拿到啥就翻啥，不再纠结 README.md 还是 SKILL.md。新增「可疑 skill」处理：ClawHub 自家 LLM 标记的可疑项也拉回来，存 `extra.is_suspicious`，前端默认隐藏，开关切换时加 `?include_suspicious=true`。删除 `extra.skill_md`（ZIP 流程废弃）。详见下方「ClawHub」段）

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
| Deploy 硬防线 | `deploy-worker.yml` / `deploy-dashboard.yml` 内 `validate-before-deploy` job | `push: [main, staging]` | 跟 deploy job 间 `needs:`,validate fail → deploy abort + PushDeer 推手机 |

**关键脚本**:
- `scripts/ci/admin-dashboard-smoke.sh` — 静态 grep 拦 `document.write </script>` 这类已知坑;playwright 断言等 BE 给 admin-dashboard.ts 加 `data-testid` 后填(P0.5 增量)
- `scripts/ci/pushdeer-notify.sh` — 守卫 `PUSHDEER_ADMIN_KEYS` 缺时静默 skip(不让缺 secret 把 abort 路径自己 abort)

**Known issue**:`deploy-worker.yml` 的 validate tsc step 当前 `if: false`,因为 worker `main` 上有 ~20 个 tsc baseline errors(HF 接入新代码:`hf-paper-pipeline.ts` × 16 / `index.ts` × 2 / `ar5iv.ts` × 2)。BE 清零后删那一行即启用。`pr-validation.yml` 里 tsc 正常硬跑挂 UI 红叉。

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

**c 端 `authStore.hydrate` 401 不再清 user**
(`dashboard/src/lib/authStore.ts`):
- 老逻辑 `/api/auth/me` 401 立即清 user → 每次发版用户假掉登录态
- 改成所有 hydrate 错误都保留 persisted user(乐观信任 localStorage)
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
| `/api/enrich/run` | POST | 手动触发 enrich（支持多模式） | Bearer `INGEST_TOKEN` |
| `/api/longform/pending` | GET | 长推 fetch 队列（`?limit=20`，最多 50；`attempts < 3`） | Bearer `INGEST_TOKEN` |
| `/api/longform/submit` | POST | 提交本地浏览器抓回的完整长推正文 | Bearer `INGEST_TOKEN` |
| `/api/track` | POST | Dashboard telemetry 上报（dashboard SDK 用，必带 `X-Device-Id`） | 无（CORS 白名单 + did 必填） |
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
| `/admin/dashboard` | GET | 仪表盘默认页：DAU/WAU/MAU 头部 KPI、30 天 DAU 折线、行为漏斗、会话时长直方图、留存矩阵、事件类型分布（中文标签）、错误明细、重度设备表。echarts CDN，单文件 HTML（`worker/src/admin-dashboard.ts`） | CF Access JWT（Basic Auth fallback） |
| `/admin/tools` | GET | 原 SMS 限流 / user 详情 / 清除测试账号 / 今日 SMS 用量 4 张卡（`worker/src/admin.ts` 的 `TOOLS_HTML`，2026-05-17 从 `/admin` 路径迁来） | CF Access JWT（Basic Auth fallback） |
| `/api/admin/analytics?metric=<name>` | GET | 仪表盘 SQL JSON 数据源。`metric` ∈ `overview` / `dau-trend` / `retention` / `event-distribution` / `funnel` / `session-duration` / `errors` / `top-devices`（实现在 `worker/src/admin-dashboard.ts`） | CF Access JWT（Basic Auth fallback） |
| `/img` | GET | 图片反代（绕 GFW + 边缘 resize/compress + format=auto）；视频走原反代 + Range | 无（host 白名单） |
| `/r/<key>` | GET | R2 资源反代（GitHub README 图 + PH logo/screenshot/video/avatar），`key` 是 SHA-256；24h 边缘缓存。**referer 白名单**（2026-05-17）：空 referer + `*.ai-feeds.com` + `twitter.com/x.com/t.co` + `producthunt.com` + `github.com` + `*.pages.dev` + `localhost` 放行，其他 referer → 403 防热链 | 无 + referer 白名单 |

**`/img` 图片代理**（2026-04-20 上线，2026-05-16 加 cf.image 边缘转换）：
- 前端 `dashboard/src/lib/utils.ts` 的 `proxyImg()` 统一路由白名单域名到此端点
- 白名单：`pbs.twimg.com` / `abs.twimg.com` / `video.twimg.com` / `avatars.githubusercontent.com`（防被当开放代理滥用）
- CDN 边缘缓存：`cacheTtl=86400` + `Cache-Control: max-age=604800, immutable`
- 命中 GFW 封锁的 CN 用户借此恢复图片加载
- **2026-05-16 边缘 transform**（CF 迁移阶段 2）：
  - 图片走 `cf.image` option（worker fetch 内嵌触发，不受 zone "Allow external source" toggle 限制）
  - 查询参数：`?w=` resize 宽度（可选）/ `?q=` quality（默认 85）/ format=auto（按 Accept 自动 webp/avif）
  - prod 实测：avatar 28573B (460x460 jpeg) → 2532B (80x80, w=80) 省 91%；→ 18074B (400x400, w=400) 省 37%
  - ⚠️ format=auto 实测未强转 webp（仍返 jpeg），可能 CF cf.image 默认行为，后续视效果调整
  - video（`video.twimg.com`）保持原反代 + Range 转发，不走 cf.image（CF 只支持图片 transform）
  - zone toggle：OPS 2026-05-16 已 enable `image_resizing`（PATCH `/zones/{zone_id}/settings/image_resizing`）

**`/api/items` 热度排序**（2026-04-21 上线）：
- 加 `sort=hot` 参数时按 HN 风格重力衰减分数排序：
  `score = (likes + 2*retweets + 3*replies) / (age_hours + 2)^1.5`
  覆盖 30 天 `published_at` 窗口，老病毒推文可与新推文混排
- 返回项额外带 `hot_score` 浮点字段（仅 hot 模式）
- 游标格式 `score|id`（score 为浮点）；前端 `dashboard/src/components/Feed.tsx` 配合 localStorage 曝光过滤（500 条 LRU + 3 天 TTL）

**`/api/enrich/run` 查询参数**：
- `mode=backfill-quotes`（默认）/ `backfill-replies` / `reclassify-threads` / `refresh-metrics` / `refresh-tiered` / `fill-translations` / `detect-longform` / `cleanup`（手动跑：`?mode=cleanup&retention_days=30`）/ `clawhub-fetch` / `clawhub-enrich`（ClawHub phase 1/2 手动触发）
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
| `*/5 * * * *` | `scheduled()` | 按触发时分分流：UTC `17:00` `05:00` → `runGithubFetchTrending`（GH phase 1，触发 GithubPipelineWorkflow）；UTC `08:00` `20:00` → `runClawhubFetchList`（ClawHub phase 1）；UTC `10:10-10:14` → `runPhDailyFetch`（PH 一日一抓，北京 18:10）；`:00` `:30` → `runRefreshMetrics`/`runRefreshTiered`（X metrics 刷新，**不是 workflow**）；`:25` `:55` → `runListPollIngest`（X phase 1，触发 XTweetPipelineWorkflow per new tweet）；`03:35 UTC` 每天一次 → `runCleanup`（清 30 天前的 snapshots/refresh_log）。**抢占路径**（catch-all tick 在分发前先查 pending 队列）：**PH enrich** / PH r2-migrate / **ClawHub enrich** + PH 字段 fill-translations，pending 非零就走 preempt |

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
  2. **fan-out (Promise.all)**: `backfill-quote` (syndication，hasQuoteRef 时) + `backfill-reply` (syndication，hasReplyRef 时) + `check-longform` (always)
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
- **13 个表**：
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

**VPS**：DMIT `HKG.AS3.EB.TINYv2`（CN2/CMI 优化线路，月付）。IP `154.12.188.231`。SSH `ssh -i <私钥> root@154.12.188.231`。nginx 配置 `/etc/nginx/sites-available/aifeeds.conf`。TLS 用 Let's Encrypt（certbot 自动续期，8/31 到期自动续）。

**切换时的前置改动**（回滚要逆操作）：
- R2 `ai-feeds-fonts` 开了 r2.dev 公共访问（`pub-…r2.dev`，字体公开资源，无安全风险）
- 移除了 api 的 Worker custom domain（`xlist-api`）+ fonts 的 R2 custom domain，DNS 才能解锁改 A 记录

**⚠️ 风险 / 长期运维**：
- **VPS 单点** —— 它挂了，前端 + api + 字体全挂（邮件不受影响）；按下方回滚秒退回 CF
- **按月续费**（DMIT），忘续 = 全站挂
- 走香港的流量**不经 CF**，WAF / 缓存 / DDoS 由 VPS 自己扛
- **cookie 功能**（admin 后台 / 分享）：api 反代用 workers.dev 的 Host，cookie domain 可能受影响；nginx 已传 `X-Forwarded-Host: api.ai-feeds.com` 备用，异常时 BE 读它修
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
- migration 跑法（同 §2 D1）：`wrangler d1 execute xlist-staging --env staging --remote --file=migrations/018-subscriptions.sql`（**prod 待上线再跑**）

### Workflows（wrangler.toml）

- `digest-node-run-workflow`：节点到点现算 5 源榜单（normal 纯分 / curated LLM 精选）+ 给选了该节点的订阅起 deliver
- `digest-deliver-workflow`：per-subscription 选品（无 LLM）→ 渲染 → Resend 投递 → 记账 + 重算 next_send_at
- 节点触发：scheduled handler 按 `utc.getUTCHours()` 在 UTC 0/4/9（BJT 8/12/17）触发 node-run；prod 复用现有 `*/5` cron tick 内判断节点时刻；**staging cron 全关（手动触发，同现有约定）**

### Secrets（加到 `.secrets/aifeeds-{prod,staging}.env`）

- `DIGEST_EMAIL_HMAC`（32B hex）：回流 token + 编辑令牌（`edit:` 前缀）HMAC 签名
- `RESEND_WEBHOOK_SECRET`（Svix）：Resend webhook 签名校验
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
