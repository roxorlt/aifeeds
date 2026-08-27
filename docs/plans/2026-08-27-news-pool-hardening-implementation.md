# 行业要闻候选池加固实施计划

> 实现者必须使用 TDD；每项先写红测并确认按预期失败，再写最小实现。

## Task 1：跨天事件去重红测与修复

文件：

- `worker/src/digest/selection.test.ts`
- `worker/src/digest/selection.ts`

步骤：

1. 加入真实 GLM-5.3/PhanRouter 历史条目（无指纹）与 GLM-5.3 Flash 新条目（高置信指纹）测试，确认旧逻辑删除新条目。
2. 加入同一 GLM-5.3 Flash 媒体复述对照测试，确保修复不会放走明确重复。
3. 实现单边高置信指纹的具体对象兼容守卫。
4. 运行 selection focused tests。

## Task 2：官方来源与 radar 隔离

文件：

- `worker/src/feeds/types.ts`
- `worker/src/feeds/registry.ts`
- `worker/src/feeds/page-index.ts`
- 必要的新官方模型发现模块及测试
- `worker/src/blog.ts`
- `worker/src/digest/selection.ts`
- 对应测试文件

步骤：

1. 用 fixture 红测 Anthropic 官方 sitemap 文章过滤。
2. 用 fixture 红测 `zai-org` 官方模型列表首次发现与更新时间不重复语义。
3. 将来源的 `editorial_type` 写入 item extra。
4. 用 D1/选择测试证明 radar 不能进入正式候选。
5. 实现最小来源发现逻辑，不在测试中访问网络。

## Task 3：blog/podcast 自动自愈

文件：

- `worker/src/blog.ts`
- `worker/src/podcast.ts`
- `worker/src/feeds/dedup.ts`
- `worker/src/ops/cron-routing.ts`
- `worker/src/index.ts`
- `worker/src/ops/cron-schedule.ts`
- 对应测试文件

步骤：

1. 红测 binding/create 失败写 pending 与错误元数据。
2. 红测 30 分钟延迟、6 次上限、成功后清理、同小时幂等。
3. 为 blog/podcast 增加独立自愈 cron actions 和可观测返回值。
4. 对 exhausted 告警增加日级去重，避免重复推送。
5. 终态 helper 清理 pending 与错误。

## Task 4：综合验证与交付

1. 运行 focused tests。
2. 运行受影响模块 tests、`tsc --noEmit` 和 worker 全量 tests。
3. 检查 diff、敏感信息与未跟踪文件。
4. 独立 reviewer 做 spec compliance 和代码质量 sweep，按稳定 finding ledger 闭环。
5. 提交、推送 PR，等待 required CI；全部通过后合并 main 并验证 production deploy。
6. 在生产只读确认官方源/cron 路由生效，重建 2026-08-27 候选池，验证 GLM-5.3 Flash 可进入候选；Fable 5.1 仍以未确认状态处理。

## 2026-08-27 Architecture DESIGN GO 实施矩阵

后版本优先级：architecture v5 > v4 > v3 > v2。以下矩阵是本地实现与验证边界；不授权部署、生产检查或提交。

| Spec contract | Current code evidence | Gap | TDD target / write set |
| --- | --- | --- | --- |
| GLM variant-aware cross-day dedup | `selection.ts/.test.ts` 已含单边与双边 variant/action guards | 已实现，回归保护 | focused selection tests；不改权重/X |
| Anthropic/Z.ai official discovery | `page-index.ts`、`zai-models.ts`及fixtures | 已实现，回归保护 | feeds focused tests |
| radar/manual/formal-news consumers | `news-source-policy.ts`及selection/review/delivery/Codex tests | 已实现，回归保护 | outward consumer affected suite |
| workflow recovery CAS/manual exclusion | `feeds/dedup.ts`、blog/podcast、recovery tests | 基础已实现；需接041 cause-token canonical helper | 先写future transition causality红测，再改shared helper |
| warning outbox 039 | migration与producer/drain tests已存在 | 需接canonical queue/readiness及v3精确守恒/serializer | 041 + warning-outbox focused tests |
| 040 release/publication schema | 不存在 | 全缺 | 真实SQLite migration红测；新增040 |
| Append-only budget/slot reservation | legacy page/video固定key与UPSERT/GC | 全缺；必须no DELETE | migration + reservation module/tests |
| Worker/WebCrypto canonical boundaries | outbox有hash，page/video无共享canonical module | 全缺 | `publication-canonical.ts`先红后绿；64MiB真实buffer测试 |
| Unified release head/video modes | `daily_pages`/`daily_videos`独立且裸outward | 全缺 | publication service、daily-page/video race tests |
| Private publication namespace deny | `/r/*`只deny `cc-item-pages/` | 全缺 | index route GET/HEAD/Range/OPTIONS红测 |
| Head-bound daily/watch/media/sitemap/IndexNow | `seo-routes.ts`与daily-page-run直接信任legacy rows | 全缺 | route/page/video tests；fail-closed/no-store |
| 041 canonical subject/alias/cursor/readiness | 不存在 | 全缺 | 真实SQLite migration、401/4001 materializer、producer tests |
| O0–O7 authority/gates/cron observability | 039 gates/cron部分存在 | canonical backfill与精确结果合同缺口 | cron schedule/routing/admin/required recorder affected tests |
| Operations/rollout state | `docs/operations.md`仅含039 bridge | 缺040/041与append-only说明 | green后更新operations与本矩阵状态 |

### TDD批次

1. RED-A：040 migration constraints、atomic budget/slot replay/concurrency、canonical digest/64MiB、no-delete adapter。
2. GREEN-A：040 + publication storage/reservation/canonical module。
3. RED-B：release modes、private route、head-bound page/video/outward race。
4. GREEN-B：unified release service及daily page/video/routes接线。
5. RED-C：041 migration、cause-token exact canonical+alias、cursor/high-water、401/4001、canonical producer与观测守恒。
6. GREEN-C：041 shared helper/materializer/producer/cron接线。
7. 回归与文档：focused → affected → full → tsc → diff → gitleaks；任何skip/OOM明确阻断。

### 本地实施状态（提交前）

| Contract | 状态 | 主要证据 |
| --- | --- | --- |
| 040 append-only publication | 已实现 | 真实SQLite constraints/trigger、atomic budget/slot replay、no-delete adapter、none/reuse_current/joint_new、head CAS |
| Worker/WebCrypto v5边界 | 已实现 | pre-reservation/PUT/promotion/outward共享canonical module；64 MiB MP4完整reserve→PUT→promote→outward测试 |
| outward daily/video边界 | 已实现 | private `/r/*` deny、虚拟head-bound media、daily/watch/archive/sitemap/IndexNow、导航与freshness只认当前授权head |
| 041 canonical warning identity | 已实现 | future cause-token batch、reciprocal readiness、per-source frozen high-water；401/4001 aliases分别3/21轮有界推进 |
| O0–O7 authority/outbox observability | 已实现 | bridge reservation、canonical producer、attempt≤6 drain、retention、独立cron/admin cadence、required ≤3840-byte no-raw-ID记录 |
| 已关闭dedup/discovery/formal-news/recovery | 保持 | 不改评分权重、X规则或manual priority；受影响回归已通过 |
| 文档 | 已更新 | `docs/operations.md` 含039/040/041 rollout、rollback、gates、容量与运行合同 |

### 本地验证结果

- publication状态机：7/7（含64 MiB MP4完整reserve→PUT→promote→outward，以及head已提交/终态未完成的exact replay）。
- RAD/formal outward受影响层：24 files、357/357。
- OBS受影响层：12 files、108/108；official discovery/dedup：3 files、39/39。
- worker全量：112 files、2608/2608；无skip/deselect，随全量实际运行本地Miniflare workerd用例。
- `npx tsc --noEmit`、`git diff --check`、`gitleaks detect --source . --no-git`均退出0；gitleaks扫描约23.23 MB、未发现泄漏。
- 未提交、未stage、未联网、未访问`.env`/凭据/生产；最终提交由父任务统一处理。

## 2026-08-27 Capacity Warning Outbox（方案 B）实施矩阵

本节只补齐 architecture v4 的 publication capacity warning 缺口；migration 039 的 DDL、payload、producer、bridge、renderer 与 goldens 必须 byte-for-byte/behavior-for-behavior 保持不变。

| Frozen contract | Current code | Required red evidence | Minimal write set |
| --- | --- | --- | --- |
| 042 control/crossing/capacity-outbox 三表 | 已实现 | 真实 SQLite 验证表、CHECK、永久 crossing、30/90 天 retention | `042-publication-capacity-warning-outbox.sql` |
| reservation/activation/expansion 同事务 crossing | 已实现 | 主写失败 crossing 回滚；70/85/95 上穿；100%仅拒绝下一 positive byte | 042 triggers + audited budget transition helper |
| stable event identity/canonical payload | 已实现 | identity 不含 budget version；payload ≤2048、canonical/hash 重算、无 raw ID/secret | capacity outbox module |
| producer crossing→outbox→CAS | 已实现 | duplicate/concurrent/unknown authoritative reread；单边损坏 quarantine/error | capacity producer + SQLite/fake D1 tests |
| epoch rearm | 已实现 | expansion audit 后 epoch+1；仍高于阈值不重复；降到阈值下后再上穿产生新 epoch event | 042 control trigger/helper |
| lease/chunk/delivery/retention | 已实现 | HTTP 500/throw、callback/ack unknown、attempt 6、late owner、partial ack、30/90 天 | 共享低层 reliable-outbox primitive；039 wrappers回归 |
| independent cron/required observation | 已实现 | 每 5 分钟 produce+drain，daily retention，互不遮蔽；≤3840 bytes | routing/schedule/index/admin/cron tests |
| rollback authority | 已实现 | R/P/H off 后 pending capacity row仍投递 | capacity gate/cron integration tests |
| v4 red matrix #2/#5/#7–#9/#15/#26–#28 | 已实现 | audited activation、budget edge/concurrency/unknown、324 MiB/28 objects/year/horizon/threshold | migration/storage/capacity focused tests与文档 |

TDD 顺序固定为：042 migration/trigger RED→GREEN；producer RED→GREEN；drain/retention/cron RED→GREEN；v4剩余矩阵 RED→GREEN；最后 fresh affected/full/tsc/diff/gitleaks。任何 039 regression 立即阻断。

实现状态：042与共享primitive、独立cron和v4补测已完成。最终fresh证据：受影响层28 files/384 tests；worker全量114 files/2642 tests；`npx tsc --noEmit`、`git diff --check`及`gitleaks detect --source . --no-git`均退出0。未stage/commit/deploy。

## Post-architecture implementation fix round 1

| Stable finding | 状态 | 已交付证据 |
| --- | --- | --- |
| RAD-001 | 已关闭 | sitemap/archive完成page+video graph后才做shared joined final guard；compatibility projection在同一guard SQL内写；前日补链后page IndexNow、video IndexNow与upload success前authoritative reread，失败HTTP=0 |
| OBS-001 | 已关闭 | 041 materializer真实50/page、最多4页；逐页owner/lease/cycle/high-water cursor CAS；完成后after=0/cycle++/refresh high-water/wrapped；exact mapped alias预排除，401/4001跨cycle有界 |
| CAP-001 | 已关闭 | budget increase replay验证完整immutable audit command tuple，并接受同一audit的合法reservation descendants；后续audit/state或字段变化fail-closed |
| WFR-005 | 已关闭 | stats/eligible/exhausted、attempts 1–5及第6次cause-token共用current FEED_REGISTRY/sources/item exact identity；source_ref必须NULL，保留唯一生产podcast text-blog shape |
