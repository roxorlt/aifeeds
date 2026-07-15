# C 端性能 perf-staging 变更单

状态：`PREPARED / NOT APPLIED`

本变更单把 C 端性能计划中分散的 staging 操作收敛为可审计、可停止、可逐项回滚的执行顺序。
它不授权任何外部变更；每个远端写动作仍需单独审批，且只有审批覆盖的那一步可以执行。命令不得
输出 token、Cookie、验证码、用户内容或渲染后的回源密钥。

2026-07-14 的当前 production PageSpeed 双端基线与 Fable 分析复核见
[`2026-07-14-pagespeed-insights-review.md`](./2026-07-14-pagespeed-insights-review.md)。当前移动端
LCP 约 13.0s、主线程约 8.3s，桌面端 LCP 约 3.0s；G8 不能只验证网络与图片预算，还必须保留移动端
JS/布局 CPU、viewport/anchor/a11y、媒体代理错误的停止线。单次 lab 仍不替代上线后的 RUM。

## 1. 已采证事实与固定决策

- 目标 Worker：`xlist-api-staging`，公网身份 `staging-api.ai-feeds.com`，直接 upstream
  `xlist-api-staging.ltsms86.workers.dev`。
- 目标 D1：`xlist-staging`；目标 R2：`xlist-readme-assets-staging`。
- 专用 Pages 项目：`xlist-dashboard-perf`，upstream
  `xlist-dashboard-perf.pages.dev`；不得覆盖 `xlist-dashboard-staging`。
- 实验入口：`perf-staging.ai-feeds.com`，DNS-only A 记录指向香港 VPS
  `154.12.188.231`，TTL 120。2026-07-12 只读查询确认该记录尚不存在。
- VPS 为 nginx 1.24.0 / certbot 2.9.0；启用站点来自 `/etc/nginx/sites-enabled`，解析器使用
  `1.1.1.1`、`1.0.0.1`，现有 nginx 服务正常。
- staging Worker 没有设置 `ORIGIN_SECRET`，gate 关闭。因此 perf-staging 不设置也不发送
  `X-Origin-Secret`；只有生产私有模板才允许注入生产密钥。
- 当前 `aifeeds-prod.env` 的 `CLOUDFLARE_API_TOKEN` 按运维权限契约只含 Worker/Pages/D1/KV/R2，
  **没有 Zone/DNS Read/Edit**；当前文件也没有 `CF_OPS_API_TOKEN`。因此它不得用于 G6，历史 `.bak`
  中的 master token 也不得被静默复用。G6 在另行批准并提供精确 zone、短 TTL 的 DNS 子 token 前为
  **BLOCKED**。
- 由此产生一个已知 staging 限制：Worker 不会信任 VPS 的 `X-Forwarded-For`，而会把 VPS 的
  `CF-Connecting-IP` 当客户端 IP。perf-staging 不可作为 production origin gate、真实访客 IP 或
  per-IP 限流的通过证据；只允许单账号低频验收，这三项必须在获批的生产 route 私有 smoke 重验。
- nginx 1.24.0 不满足开源 nginx 对 `upstream server ... resolve` 的安全动态解析前提。Task 13
  keepalive 为 **BLOCKED**；`deploy/nginx/aifeeds-upstream-performance.conf` 不得安装。只有另行批准
  升级到至少 1.27.3 并完成兼容性验证后，才可重新评审 A/B/A。
- perf-staging 使用 nginx 1.24 可用的变量 `proxy_pass` + `resolver ... valid=30s`，不固定
  Cloudflare IP，不启用 API cache、microcache 或 upstream keepalive。

## 2. 审批与停止线

| Gate | 动作 | 外部状态 | 通过标准 | 失败/停止 |
|---|---|---|---|---|
| G0 | 本地测试、构建、变更单复核 | 无写 | 全绿、git clean | 任一失败不进入远端 |
| GL-a | Task 3 performance log/request-id 安装 | production VPS/nginx 写 | JSONL、唯一 probe、真实轮转全绿 | 事务恢复精确备份 |
| G1 | 部署当前 Worker 到 staging | Worker 写 | 新 version 健康、smoke 2xx | 5xx/契约回归立即 rollback |
| G2 | staging 应用 migration 028 | D1 schema 写 | 两个索引存在且 EXPLAIN 命中 | apply/plan 异常即 DROP 两索引 |
| G3 | 两个 backfill dry-run | 远端只读计算 | 契约合法、errors/conflicts=0 | 非 2xx/非 JSON/游标停滞即停 |
| G4a | GitHub cover backfill | D1 写 | complete=true，抽样合法 | 任一 error/conflict 即停 |
| G4b1 | card variant 单行能力 spike | D1/R2 写 | resolvable 且转换成功 | unavailable/transform_failed 即停 |
| G4b2 | card variant bounded backfill | D1/R2 写 | complete=true，原图仍可用 | 任一 error/conflict 即停 |
| G5 | 创建/部署专用 Pages | Pages 写 | production deployment 可取 HTML | 不改普通 staging Pages |
| G6c | 创建短 TTL DNS 子 token | Cloudflare token 写 | 仅 Zone Read + DNS Edit、精确 zone | 未提供当前 master/专用 token 即 BLOCKED |
| G6 | 创建 DNS-only A 记录 | DNS 写 | 唯一精确记录，解析为 VPS IP | 多记录/已有记录立即停 |
| G7a | 安装 HTTP-01 bootstrap | VPS/nginx 写 | `nginx -t` + HTTP challenge 可达 | 恢复/移除新站点 |
| G7b | 签证书并安装 final server | ACME/VPS 写 | TLS、页面、API smoke 全绿 | 恢复 bootstrap 或移除站点 |
| GL-b | staging Worker → nginx request-id join | 远端只读 | Worker 回显与 nginx join 全绿 | 停止 G8；仅调用被定位 gate 原审批已授权的精确 rollback，否则另行审批 |
| G8 | 五设备功能/性能验收 | 测试账号写 | 矩阵全绿、有可 join 证据 | 任一 auth/cache/Range 回归即停 |

GL-a、G1、G2、G4a、G4b1、G4b2、G5、G6c、G6、G7a、G7b 和 G8 的测试账号写入是不同审批边界。dry-run 通过
不自动授权 write；staging 通过不自动授权 production。

## 3. G0：本地冻结与证据目录

从仓库根目录执行，证据目录权限固定为 0700：

```bash
set -eu
set -o pipefail
set +x
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
EVIDENCE="$(mktemp -d "/private/tmp/aifeeds-perf-staging-$(date +%Y%m%dT%H%M%S)-XXXXXX")"
export REPO_ROOT EVIDENCE
chmod 0700 "$EVIDENCE"
test ! -L "$EVIDENCE"
test "$(stat -f '%u' "$EVIDENCE")" = "$(id -u)"
test "$(stat -f '%Lp' "$EVIDENCE")" = 700
EVIDENCE_POINTER=/private/tmp/aifeeds-perf-staging-evidence-path
POINTER_TMP="$(mktemp "${EVIDENCE_POINTER}.tmp.XXXXXX")"
cleanup_pointer_tmp() { rm -f "$POINTER_TMP"; }
trap cleanup_pointer_tmp EXIT
printf '%s\n' "$EVIDENCE" > "$POINTER_TMP"
chmod 0600 "$POINTER_TMP"
test ! -L "$POINTER_TMP"
test "$(stat -f '%u' "$POINTER_TMP")" = "$(id -u)"
test "$(stat -f '%Lp' "$POINTER_TMP")" = 600
if [ -e "$EVIDENCE_POINTER" ] || [ -L "$EVIDENCE_POINTER" ]; then
  test -f "$EVIDENCE_POINTER"
  test ! -L "$EVIDENCE_POINTER"
  test "$(stat -f '%u' "$EVIDENCE_POINTER")" = "$(id -u)"
  test "$(stat -f '%Lp' "$EVIDENCE_POINTER")" = 600
  rm -f "$EVIDENCE_POINTER"
fi
mv -f "$POINTER_TMP" "$EVIDENCE_POINTER"
trap - EXIT
test ! -L "$EVIDENCE_POINTER"
test "$(stat -f '%u' "$EVIDENCE_POINTER")" = "$(id -u)"
test "$(stat -f '%Lp' "$EVIDENCE_POINTER")" = 600
git status --short --branch
test -z "$(git status --porcelain)"
git rev-parse HEAD | tee "$EVIDENCE/commit.txt"
git diff --check

cd "$REPO_ROOT/dashboard"
npm run lint
npm run test:unit
npm run build
npm run build:perf-staging
CI=1 npm run test:e2e

cd "$REPO_ROOT/worker"
npx tsc --noEmit
npm test
npx wrangler deploy --dry-run --env staging

cd "$REPO_ROOT"
node --test \
  scripts/benchmark-aifeeds-upstream.test.mjs \
  scripts/run-aifeeds-staging-backfill.test.mjs \
  deploy/nginx/*.test.mjs \
  scripts/ci/performance-validation-contract.test.mjs
python3 deploy/nginx/check-nginx-request-id.test.py
python3 deploy/nginx/insert-nginx-request-id.test.py
python3 deploy/nginx/verify-nginx-request-id-diff.test.py
python3 deploy/nginx/systemctl-not-found-compat.test.py
bash -n deploy/nginx/install-aifeeds-performance-log.sh
bash -n deploy/nginx/rollback-aifeeds-performance-log.sh
bash deploy/nginx/install-aifeeds-performance-log.integration.test.sh
```

继续前必须确认 `git status --short` 为空，HEAD 包含最新 `origin/main`。不得用
`SKIP_PREDEPLOY_CHECK=1` 绕过祖先检查。

每个后续前向 gate 都视为新 shell：必须重新启用 fail-fast，从 0600 pointer 读取并校验 evidence path，
并证明当前 clean HEAD 等于 G0 冻结 commit。任何一项不成立就重跑 G0，不沿用旧证据。紧急回滚和
定向清理不得被本地 dirty tree 阻塞，但仍须校验 evidence pointer、精确远端对象 id 与 ownership。

## 3.1 GL-a / GL-b：Task 3 nginx 分段日志

G8 的 nginx `upstream_connect_time`、`upstream_header_time`、`upstream_response_time` 与
`request_time` 证据来自全局 http-context
`deploy/nginx/aifeeds-performance-log.conf`，不是 perf-staging server 自己生成。它的 host map 已含
`perf-staging.ai-feeds.com`。

2026-07-12 的无凭据只读探测确认：production 和 staging API 均尚未回显 `X-Request-Id`、
`Server-Timing` 或 `Timing-Allow-Origin`；实现只在当前未发布分支。原先要求 GL 在 G1/G7 前完成
production Worker join 会形成顺序环，因此拆分为：

- **GL-a** 是 production VPS/nginx 写，只安装日志、同层 request-id、专用轮转 timer；通过标准是
  JSONL schema、唯一 probe、front/API 精确 200、强制轮转后新文件继续收日志。GL-a 的唯一 probe
  证明 nginx 请求与 timing 可关联，但不宣称 Worker 已回显。
- **GL-b** 是 G1 + G7b 后、G8 前的匿名远端只读验证，以唯一 `perf_probe` 证明 staging Worker 响应
  `X-Request-Id` 与 nginx 记录一致。GL-b request-id join 通过后才能进入 G8；G8 的 10.1c 再把该证明
  扩展到五设备 browser request ids。

GL-a 必须按 `docs/operations.md` 修订 runbook 使用 root-owned `/run` 私有目录、
`sha256sum -c SHA256SUMS`、精确 site backup、`verify-nginx-request-id-diff.py`、精确 7 个 proxy
结构检查、`maxsize 50M` 与 `aifeeds-performance-logrotate.timer`。轮转规则位于全局 include 之外的
`/etc/aifeeds-performance-logrotate.conf`，专用 timer 每五分钟使用独立 state 检查；安装前至少保留
5 GiB 空间和 10 万个 inode。`logrotate -d` 只检查语法；必须再
执行受控 `logrotate -f -s` 并用 rotation probe 证明 USR1 后的新 base log 可写。任何失败由事务 trap
恢复该次精确 backup。安装器必须先持有 `/run/aifeeds-performance-log.lock` 的非阻塞 flock；轮转
service 使用 `StateDirectory=aifeeds-performance-logrotate` 并实际启动验证；还必须在正式 state 下对
刚超过 50 MiB 的稀疏测试日志完成一次真实 maxsize rotation，并用新 probe 证明 sandbox 内
rename/USR1/reopen 成功。只有 site 与 backup 逐字一致、
artifacts/state 全部消失且 timer inactive/disabled，自动回滚才可标 pass；日志按审批决定保留复盘或另行删除。
含回源凭据的 site backup 只能位于 root-only 0700 `/var/backups/aifeeds-performance-log`；文件用
`cp -a` 保留原 site 的 ACL/xattr 与 uid/gid/mode，机密性由不可遍历的父目录保证；
GL-a summary 必须记录并校验 `site_backup_sha256`、`installed_site_sha256` 和原 site uid/gid/mode。人工回滚
从该 summary 读取精确值、持有同一 flock，并先证明 current site 未发生漂移；否则停止，不得覆盖后续合法变更。
GL-a 在任何远端写之前还必须把唯一 operation id 与该 G0 commit 的 rollback helper 0600 不可变副本保存到
evidence；installer 只接受这个预生成 id，并把 `operation_id`、`g0_commit`、`rollback_helper_sha256` 写进
journal/summary。异常采证只能按这个已知 id 精确抓一份 journal；人工回滚默认优先正常 summary，只有 summary
缺失或显式 recovery mode 才使用 identity/phase/SHA 都匹配的 recovery record，且只上传 evidence 中该 helper。
安装器在 site candidate/backup 前先 `fsync initializing`，在 backup 前再 `fsync prepared`，并在任何
runtime candidate/final 写入前 `fsync mutation_started`；SITE 与八个 runtime candidate 都位于各自 final
同目录，journal 的 `artifact_candidates` 精确绑定路径，校验 hash/metadata 后才同盘原子 rename。七个版本化
artifact 的 SHA 写入所有 journal/summary；因此崩溃只会留下可识别、可清理的本事务 candidate。人工恢复仅允许
`initializing/prepared` + live base 在 backup 缺失时继续，partial backup 移入 root-only audit。installer/helper
在每次 site move/reload 前后和终态复核 enabled symlink 精确 target；普通 site preflight 在创建 rollback
journal 前失败时保持 zero-write，既有 `rolled_back` 永不被重写。archive read-only preflight 另在首次
capture 前置零写 sentinel；只有 topology、reachability、handoff 与最终 recapture 全部通过后才清除。
sentinel 尚未清除时发生失败，failure trap 必须在删除 summary、写 `rollback_failed` 或改动 cleanup namespace
之前退出；重复失败不得改变 F/T/P/C 的 bytes、inode 或 namespace。
安装器还会在每个 reload、probe、轮转、timer 之后
重新核对 live site 的 candidate hash 与语义 diff。自动回滚只允许 current site 等于本事务 baseline 或
candidate；未知 hash 立即转 `rollback_failed`，不得覆盖 Certbot/人工并发修改。回滚日志移动到该事务的
root-only audit 目录，canonical log 路径必须消失；非终态 journal 会阻断下一次安装并要求显式恢复。
**C journal update CAS active（consumer activation active / harness name-count freeze frozen）**：source 与 rollback
journal 各使用 operation-bound F、`${F}.tmp` 和 `${F}.previous-update-gl-a-<operation-id>`；source F 为
`/var/backups/aifeeds-performance-log/transaction-<operation-id>.json`，rollback F 为
`/var/backups/aifeeds-performance-log/rollback-transaction-<operation-id>.json`。每版内嵌
`journal_update={schema:1,revision:N,self_dev:D,self_ino:I,predecessor:null|{revision:N-1,sha256,dev,ino}}`；
只有 fresh initializing/prepared genesis 允许 revision 0/null predecessor。T 由 `O_EXCL|O_NOFOLLOW` 创建，
self identity 来自同一写 fd，完整写、fsync(fd)+fsync(parent) 后才可恢复。Source legacy genesis trusts the
CLI-supplied external hash and is accepted only when that hash and the complete business schema match；rollback legacy
genesis has no externally trusted hash and is rejected fail closed。legacy orphan tmp 不能自证。
S0=F-only；S1=F+T；S2=P+T；S3=P+F。S4=F(new)+C(cleanup tombstone), P absent。Recovery exact-validates
physical C against F.predecessor, then uses held-dirfd unlink after a final pathname/held-FD identity check, fsyncs
the parent, and returns to S0。S1–S4 只信 successor 内嵌 self/predecessor 和合法业务 transition，使用
NOREPLACE 并 fsync parent；symlink、revision 跳跃/回退、semantic inverse、same-hash different-inode、
F/T/P/C 冲突或 invalid/partial T 全部原样保留 fail closed，禁止 rm/truncate/re-render/pathname adoption。自动恢复
在读 source phase 或任何 live mutation 前 settle source；manual 先 settle source，再 settle rollback，最后才建立
terminal pair。journal `.previous-update-*` 不得与 marker `.previous-terminal-*` 混用。本地只读 consumer 只接受
S0；其他 residue 仅报 `recovery_required`。terminal prepared、单边和双边发布窗口必须保留两侧 predecessor，
只有 committed marker durable 后才能执行普通 cleanup。

The 14-slot runtime cleanup plan is immutable and shared by automatic and manual rollback. Its canonical items,
`plan_sha256`, cursor, and `cursor_state` live in the rollback journal. Each item durably records `detaching` before
an exact NOREPLACE tombstone rename and `detached` before unlink; `runtime_removed` is legal only after all 14 slots
reach `complete` and physical runtime residue is zero. Re-entry resumes the recorded cursor. Plan drift, unknown
tombstones, and `rollback_failed.failed_from` drift preserve evidence and fail closed. Legacy `runtime_removed`
records without the cleanup object are compatibility inputs: both automatic and manual paths still execute the
current 14-slot plan and prove zero residue instead of treating the legacy phase as cleanup authority. The rebuilt
plan records `compatibility_mode=legacy_runtime_removed`, preserves any `rollback_failed` wrapper while advancing,
and same-operation installer retry returns `recovery_required` before live runtime-absence checks. The log slot stays
an exact `archive_handoff` until daemon reload succeeds; reload failure retains that inode without claiming archive
manifest evidence.

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

### 3.1.1 2026-07-14 旧 GL-a 异常恢复重入

首次执行清单 SHA `69694fc5143521955861d1d8dc933479213d9a692bc231c91f2b8b85185afcb9`
在任何业务 mutation 之前安全失败。生产 `systemctl is-enabled
aifeeds-performance-logrotate.timer` 对不存在 unit 返回 `rc=4`、stdout 精确为 `not-found\n`、stderr 为空；
冻结的旧 rollback helper 只接受 rc 1，因而在 `quiesce_rotation_control_plane` 停止。站点、source/rollback
journal 与 operation candidates 均未改变；只有获批的 exceptional authority 被持久化。

旧 operation 不允许换成新 helper 绕过已经持久化的 authority。获批重入使用 root-only `/run` 目录内的
临时 `systemctl` PATH 适配器，并遵守以下固定边界：

- 只在 argv 精确等于 `is-enabled aifeeds-performance-logrotate.timer`，真实程序返回 rc 4、stdout
  精确等于 `not-found\n` 且 stderr 为空时，把进程返回码映射为 1；输出字节不变；
- 其他 argv 直接 `execve` 到固定 `/usr/bin/systemctl`，不捕获、不翻译；
- 执行器在调用 helper 前固定适配器、`/usr/bin/systemctl`、`/usr/bin/python3` 链接及解释器真实目标的
  owner/mode/SHA；任何漂移即停止；
- PATH 改动只作用于这一次旧 helper 子进程；post-check 使用正常 PATH；适配器不安装到 `/usr/local`、
  `/etc` 或 systemd，不常驻；
- 旧 recovery executor/helper、既有 authority、source/rollback journal 的 SHA 继续逐项复核。适配器只能
  让旧 helper 识别真实的“unit 不存在”，不能改变它的 CAS、站点、候选、receipt 或终态校验。

本地新 helper 同时原生接受 `1:disabled`、`1:not-found` 和生产实测的 `4:not-found`，仍拒绝
`4:failed`。它只用于旧 operation 清理完成后的下一次新 GL-a，不替代上述旧 helper 重入。

前向安装必须保留 operation-bound transcript；每次人工回滚则生成新的 operation+attempt bound
manual rollback attempt transcript，final 文件不得覆盖既有 attempt。两者都把远端 stdout/stderr 合并写入私有 tmp，
立即捕获 `PIPESTATUS`，将 tmp 设为 0600 并原子发布 final 后，才检查 SSH 与 tee 的独立退出码；失败证据
不得随远端 staging 清理而丢失。
本地 evidence 的 forward transcript、forward summary、manual transcript 和 manual summary 全部走
same-parent NOREPLACE publication；成功后必须 fsync parent directory。publish collision 同时保留 owned tmp
与 unknown destination，禁止覆盖。tmp 只由 `mktemp` 的 O_EXCL allocation 创建，只有即时记录的
recorded dev/ino 可以授权 failure cleanup；pathname、同内容或同 hash 不能用于重新认领或删除。
日志撤销
先把 canonical inode NOREPLACE 隔离到同目录 quarantine，再等待所有 writable FD 消失并连续稳定；
生产 deadline 为 60 秒，超时保留 quarantine/manifest 并失败关闭，同 operation id 重入继续。
operation-bound archive manifest 必须持久记录每个 source/quarantine/destination/candidate、inode/权限及
quiescent 后的 SHA/size；crossfs schema 2 严格推进
`journaled → quiescent → copied → archived`，samefs 跳过 copied。crossfs final publish 前先 journal
`candidate_dev`/`candidate_ino`，publish 后再记录 `destination_dev`/`destination_ino`，且 destination 必须等于
candidate inode；samefs destination 必须等于 source inode。terminal generation 为
`3 * N + 1 + count(entries has candidate_dev)`（全 crossfs 是 `4 * N + 1`）。samebytes different inode/unknown
identity 必须 fail closed；未 journal candidate、candidate+destination 冲突或同时缺失，以及任何
candidate/cleanup/unknown audit residue 都拒绝接管。terminal destination 的 physical dev/ino 必须等于
recorded destination。schema 2 generation 只允许 append/seal/quiesce/copy/archive 五类 successor；top-level
exact keys 为
`{schema,operation_id,generation,previous_manifest_sha256,previous_manifest_dev,previous_manifest_ino,inventory_complete,empty_inventory,entries}`。
generation 0 predecessor triple 全 null；以后每版从 stable fd capture 持久 predecessor raw SHA/dev/ino 三元组。
final/tmp/operation-bound previous 用三路径 NOREPLACE 接管；P+T/P+F 只信 T/F successor 内嵌 triple 并验证物理 P，
P-only、invalid/unrelated T/F 或 same-hash different-inode 原样保留、fail closed。只有 inventory complete、audit
canonical 文件集合与 destinations 双向相等且 source/quarantine/candidate 消失才是 terminal。terminal
journals/summary 必须镜像 manifest SHA/generation/entry count；stale/regressive/unknown/orphan 状态全部保留失败。
Archive manifest namespace recovery 由 read-only held-fingerprint dispatcher 决策（其 F/T/P/C 与 journal CAS
cleanup namespace 不同）：F=final、T=tmp、P=previous、C=operation-bound private cleanup directory。只接受
`∅`、`T(genesis)`、`F`、`F+T`、`P+T`、`P+F`、`F+C(payload)`、`F+C(empty)`；其他组合全部保留并 fail
closed。F/T/P 与 C payload 均用 `O_NOFOLLOW` held-FD 捕获，要求 root:root/0600、`nlink=1`，指纹精确为
`{dev,ino,mtime_ns,sha256,size}`，并拒绝 duplicate keys/non-finite JSON。dispatcher 以 held fingerprints 验证
successor、physical reachability 与 immutable runtime-cleanup log handoff，逐路径 recapture unchanged 后才允许
publish/cleanup；`journaled` live log 只允许同 inode 尾部增长，quiescent/copied/archived 内容冻结。C
payload/empty directory 仅通过 held parent/dirfd exact unlink/rmdir 清理。
这里的 runtime artifact manifest 不是独立文件，而是 source transaction journal 字段
`runtime_artifacts` 与 `runtime_artifacts_sealed`；no independent runtime manifest path/SHA/generation/count
存在。8 candidates 各自先持久化 dev、ino、sha256 和 metadata，完整 inventory sealed before any final
publication。7 immutable finals 与 all 8 candidates 只通过 exact-identity operation-bound tombstone 清理；
live log handed to the archive manifest，不进入 immutable-final tombstone。`rotation_state_identity` 绑定
operation-bound directory candidate 与稳定 ledger anchor 的 path/dev/ino/mode/`genesis_record_sha256`；
`rotation_state_snapshot` 验证 generation、`tail_record_sha256`、ledger SHA/size 与当代 status identity。
timer 只能调用 root-only `rotation-wrapper`；唯一锁域是 authority-bound ledger inode FD flock，并只向该 ledger
追加可验证 tail。legacy `/run/aifeeds-performance-log-rotation.lock` 参数 compatibility-only 且被忽略：它
is not an authority domain and not a serialization domain；
安装时旧 status inode/hash 不是永久 identity，manual helper 禁止从 current status path 重新 capture/adopt。
动态 service `ExecStart` 固定 operation id、anchor、checker、config、logrotate 五组 authority 参数，顺序不可变；
config triple 后必须紧跟 logrotate triple，每组都绑定 exact path/dev/ino/SHA。外部 authority 只能是
`/var/backups/aifeeds-performance-log/rotation-anchor-<operation-id>.json`，不得扫描选择。各 journal/summary 镜像
exact 9-key `rotation_anchor_identity={state,path,sha256,size,uid,gid,mode,dev,ino}`，严格推进
`allocated → prepared → sealed`：`allocated` 记录 O_EXCL empty-file SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`、size=0、dev/ino；`prepared` 先记录
expected final target SHA/size（physical inode 仍可 empty）；写入原 inode 并 fsync 后，`sealed` 才要求 physical
path/dev/ino/SHA/size exact。canonical authority payload 使用 schema 2，exact top-level keys 为
`{schema,operation_id,directory,provenance,checker,config,logrotate}`；directory/provenance 绑定 state directory 与 ledger
genesis；exact nested keys 为 directory=`{path,uid,gid,mode,dev,ino}`、
provenance=`{path,uid,gid,mode,dev,ino,genesis_record_sha256}`、checker/config=
`{path,sha256,size,uid,gid,mode,dev,ino}`。logrotate 使用 exact nested keys
`{path,sha256,size,uid,gid,mode,dev,ino}`，固定 `/usr/sbin/logrotate`，且必须为 root:root mode 0755。
automatic/manual caller 使用 sealed-anchor extractor：以 `O_NOFOLLOW` 单次打开 exact anchor，验证 canonical bytes 与
full identity，只从 held-FD bytes 提取 logrotate authority；checker 把全部资源保持为 held-FD，并在 mutation 前执行
final pathname/held-FD identity exact check。checker/config candidate identity 必须先 journal；
ledger 初始化与 anchor 封存后才最后渲染 service candidate。committed terminal 必须 sealed；rolled_back 早期
未分配可 null，否则 retain last identity evidence（allocated、prepared 或 sealed，禁止伪写升级）且 pathname
必须 absent/deleted。人工恢复先 stop timer/service
并确认静止，再以固定 authority 调用 `rotation-recover`，不得运行裸 logrotate 或按 current path 重新认领。
`site_backup_identity` 在 copy 前持久化并绑定
`O_EXCL` inode。pre-mutation base SITE identity 绑定 original site dev/inode；committed installed SITE identity
绑定 installer candidate dev/inode；rolled_back base SITE identity 绑定 journaled rollback candidate dev/inode，
otherwise 绑定 original site dev/inode；因为 backup copy 不保证 original inode。Every phase accepts only its recorded identity and must never derive identity
from the current path；同内容或同 hash 不足以接管。manual recovery must never derive or adopt unknown identity。Terminal physical finals/candidates
and rotation cleanup must have zero residue。pair-free source-only `rolled_back` 是窄特例：只允许 effective
`initializing`/`prepared`→`rolled_back`，`rollback_journal`/`rollback_commit_marker` 必须同时 absent，业务
delta 恰为 `phase`、`rollback_origin_phase` 与三项
`log_archive_manifest_{sha256,generation,entry_count}`；manifest 必须是 generation 1、entry count 0 的
operation-bound empty terminal manifest。若已记录非 `absent` installer candidate hash 但 pathname absent，
只有同一路径两次相同 held-FD capture（schema 2 exact keys、root:root/0600、`nlink=1`、generation 1、
inventory/empty true、entries 空）且 candidate/tmp/previous 前后均 absent 才能授权该缺失；这就是
`prelive empty manifest` 契约。

人工 source/rollback 终态由 terminal pair marker 执行 `prepared → committed`。prepared marker 嵌入 exact
`source_before_authority`/`rollback_before_authority={raw_base64,sha256,dev,ino}`，source raw 匹配 CLI-trusted SHA，
rollback raw canonical 且 effective phase 为 `logs_archived`；两侧 target 必须从 before authority 重建为唯一合法
CAS successor，并仍以 `source_target_sha256`/`rollback_target_sha256` 精确命名。prepared、单边和双边发布窗口保留两侧 predecessor，committed marker durable 后才清理。
committed marker 绑定 `prepared_marker_sha256` 与两侧 terminal SHA；validator 从 committed bytes 还原 prepared
marker、复算 SHA，并证明 terminal SHA 等于 target SHA；committed marker 的 physical chain 同时对账两侧
物理 journal 与 summary。prepared marker 不是业务 authority；恢复只接受精确
before/target，tmp/prepared 或第三种 SHA 全部失败关闭。
异常采证的 record 与 SHA 必须先在隐藏 0700 目录内完整校验；rolled_back 还要精确复制远端 archive manifest
进 bundle 并本地复算 path/SHA/generation/count。canonical recovery bundle 仅用同父目录 Darwin
`renamex_np(RENAME_EXCL)` 或 Linux `renameat2(RENAME_NOREPLACE)` 发布，失败保留 tmp/unknown destination；
成功 rename 后还要 `fsync` destination parent directory 才是 durable publish。人工回滚只消费完整 bundle，
绝不消费两个独立路径或只凭 transcript substring 判断 automatic terminal。

### 3.1.2 2026-07-15 缓存 HIT timing 契约回滚

获批 operation `20260715165904-2d2f27fe` 完成精确七行 site 变更与三轮 front/API 200 probe，但 production
缓存 HIT 的 front JSON 行把三个 `upstream_*_time` 字段序列化为 `""`；旧 `probe_is_valid` 只允许数字或
`"-"`，三轮均在该字段谓词失败并自动回滚。归档行的 host、route bucket、status、request-id 形状与 API
数字 timing 均合法。回滚后 source/rollback 均为 `rolled_back`，14/14 runtime cleanup complete，原 site SHA、
nginx active、timer inactive/disabled，runtime/candidate residue 为 0。

修订契约只在 `HIT/STALE/UPDATING/REVALIDATED` 分支接受数字、`"-"` 或 `""`；非缓存 front 与 API 仍必须
满足数字 timing 正则。新代码必须以生产形状的 jq 回归测试完成 red/green、重跑完整 G0 并生成新的
operation/manifest/exact-command SHA；本次审批不得复用。

GL-a 不授权 Pages、DNS、证书、staging Worker/D1/R2 或业务 rollout；GL-b 不产生远端写入，也不授权
G8 测试账号写入。
GL-a 最终审批还必须绑定低流量窗口、执行人、rollback owner 和 `rollback_failed` on-call 升级联系人；
缺任一项即保持 NO-GO。

## 4. G1：staging Worker 部署

这是 staging Worker 整包替换。获批后先记录旧版本，再部署当前干净 commit：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-g1.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_raw() { rm -rf "$RAW_DIR"; }
trap cleanup_raw EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$REPO_ROOT"
bash scripts/predeploy-check.sh
cd "$REPO_ROOT/worker"
npx wrangler secret list --env staging --format json \
  > "$EVIDENCE/worker-staging-secret-names.json"
jq -e '[.[].name] as $names |
  ($names | index("INGEST_TOKEN")) != null and ($names | index("DEV_TOKEN")) != null' \
  "$EVIDENCE/worker-staging-secret-names.json" >/dev/null
npx wrangler deployments status --env staging --json \
  > "$EVIDENCE/worker-before.json"
OLD_WORKER_VERSION="$(jq -er \
  'select((.versions | length) == 1 and .versions[0].percentage == 100) | .versions[0].version_id' \
  "$EVIDENCE/worker-before.json")"
printf '%s\n' "$OLD_WORKER_VERSION" > "$EVIDENCE/worker-old-version-id.txt"
npx wrangler deploy --env staging | tee "$EVIDENCE/worker-deploy.txt"
curl -fsS -D "$EVIDENCE/worker-smoke.headers" -o "$RAW_DIR/worker-smoke.json" \
  'https://staging-api.ai-feeds.com/api/items?source_type=x_list&limit=1'
jq -e '.items | type == "array"' "$RAW_DIR/worker-smoke.json" >/dev/null
BODY_SHA256="$(shasum -a 256 "$RAW_DIR/worker-smoke.json" | awk '{print $1}')"
BODY_BYTES="$(wc -c < "$RAW_DIR/worker-smoke.json" | tr -d ' ')"
jq -nc --arg sha256 "$BODY_SHA256" --argjson bytes "$BODY_BYTES" \
  --argjson item_count "$(jq '.items | length' "$RAW_DIR/worker-smoke.json")" \
  --argjson has_more "$(jq '.has_more == true' "$RAW_DIR/worker-smoke.json")" \
  '{sha256:$sha256,bytes:$bytes,item_count:$item_count,has_more:$has_more}' \
  > "$EVIDENCE/worker-smoke.signature.json"
cleanup_raw
trap - EXIT HUP INT TERM
```

不得保存环境文件内容。记录 deploy 输出中的新 version id；回滚使用 G1 前机器校验并记录的**精确旧
version id**：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT/worker"
OLD_WORKER_VERSION="$(cat "$EVIDENCE/worker-old-version-id.txt")"
npx wrangler rollback "$OLD_WORKER_VERSION" --env staging \
  --message 'rollback c-end performance staging validation' --yes
```

回滚后重复 items、detail、search 与 `Server-Timing` smoke。

## 5. G2：migration 028

先证明两个目标名都不存在，避免 `IF NOT EXISTS` 把旧同名/异定义索引伪装成 apply 成功；再保存
apply 前两条 EXPLAIN 与真实列表 canonical hash。staging 的 `WORKFLOW_COMPLETED_FILTER=true`，所以
EXPLAIN 必须包含 `workflow_completed_at IS NOT NULL`：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-g2.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_raw() { rm -rf "$RAW_DIR"; }
trap cleanup_raw EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$REPO_ROOT/worker"

feed_signature() {
  body=$1
  output=$2
  canonical="$RAW_DIR/canonical-$(openssl rand -hex 8).json"
  jq -cS '{ids:[.items[].id],next_cursor,has_more}' "$body" > "$canonical"
  digest="$(shasum -a 256 "$canonical" | awk '{print $1}')"
  jq -nc --arg sha256 "$digest" \
    --argjson item_count "$(jq '.items | length' "$body")" \
    --argjson has_more "$(jq '.has_more == true' "$body")" \
    --argjson cursor_present "$(jq '.next_cursor != null' "$body")" \
    '{canonical_sha256:$sha256,item_count:$item_count,has_more:$has_more,cursor_present:$cursor_present}' \
    > "$output"
  rm -f "$canonical"
}

INDEX_SQL="SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN (
  'idx_items_clawhub_feed_stars','idx_items_clawhub_category_stars') ORDER BY name"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$INDEX_SQL" > "$EVIDENCE/d1-target-indexes-before.json"
jq -e 'type == "array" and length == 1 and .[0].success == true and
  (.[0].results | length == 0)' "$EVIDENCE/d1-target-indexes-before.json" >/dev/null

ALL_EXPLAIN="EXPLAIN QUERY PLAN SELECT id FROM items
  WHERE source_type='clawhub' AND is_relevant=1 AND deleted_at IS NULL
    AND json_extract(extra,'$.workflow_completed_at') IS NOT NULL
    AND COALESCE(json_extract(extra,'$.is_suspicious'),0)=0
  ORDER BY CAST(json_extract(metrics,'$.stars') AS INTEGER) DESC,id ASC LIMIT 31"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$ALL_EXPLAIN" > "$EVIDENCE/clawhub-all-plan-before.json"

ALL_URL='https://staging-api.ai-feeds.com/api/items?source_type=clawhub&category=all&sort=stars&limit=30'
curl --compressed -fsS -D "$EVIDENCE/clawhub-all-before.headers" \
  -o "$RAW_DIR/clawhub-all-before.json" "$ALL_URL"
feed_signature "$RAW_DIR/clawhub-all-before.json" "$EVIDENCE/clawhub-all-before.signature.json"
CLAW_CATEGORY="$(jq -er '[.items[].extra.category // empty] | first' \
  "$RAW_DIR/clawhub-all-before.json")"
case "$CLAW_CATEGORY" in ''|*[!a-z0-9_-]*) exit 1 ;; esac
CLAW_CATEGORY_ENC="$(jq -nr --arg value "$CLAW_CATEGORY" '$value|@uri')"
CAT_URL="https://staging-api.ai-feeds.com/api/items?source_type=clawhub&category=$CLAW_CATEGORY_ENC&sort=stars&limit=30"
curl --compressed -fsS -D "$EVIDENCE/clawhub-category-before.headers" \
  -o "$RAW_DIR/clawhub-category-before.json" "$CAT_URL"
feed_signature "$RAW_DIR/clawhub-category-before.json" \
  "$EVIDENCE/clawhub-category-before.signature.json"

CAT_EXPLAIN="EXPLAIN QUERY PLAN SELECT id FROM items
  WHERE source_type='clawhub' AND is_relevant=1 AND deleted_at IS NULL
    AND json_extract(extra,'$.workflow_completed_at') IS NOT NULL
    AND COALESCE(json_extract(extra,'$.is_suspicious'),0)=0
    AND json_extract(extra,'$.category')='$CLAW_CATEGORY'
  ORDER BY CAST(json_extract(metrics,'$.stars') AS INTEGER) DESC,id ASC LIMIT 31"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$CAT_EXPLAIN" > "$EVIDENCE/clawhub-category-plan-before.json"

capture_encodings() {
  label=$1
  url=$2
  identity_body="$RAW_DIR/$label.identity.json"
  gzip_body="$RAW_DIR/$label.gzip"
  decoded_body="$RAW_DIR/$label.gzip-decoded.json"
  curl -fsS -H 'Accept-Encoding: identity' -D "$EVIDENCE/$label.identity.headers" \
    -o "$identity_body" "$url"
  curl --raw -fsS -H 'Accept-Encoding: gzip' -D "$EVIDENCE/$label.gzip.headers" \
    -o "$gzip_body" "$url"
  if tr '[:upper:]' '[:lower:]' < "$EVIDENCE/$label.identity.headers" \
    | grep -q '^content-encoding:'; then
    return 1
  fi
  tr '[:upper:]' '[:lower:]' < "$EVIDENCE/$label.gzip.headers" \
    | grep -q '^content-encoding: gzip'
  gzip -t "$gzip_body"
  gzip -dc "$gzip_body" > "$decoded_body"
  feed_signature "$identity_body" "$EVIDENCE/$label.identity.signature.json"
  feed_signature "$decoded_body" "$EVIDENCE/$label.gzip.signature.json"
  cmp "$EVIDENCE/$label.identity.signature.json" "$EVIDENCE/$label.gzip.signature.json"
  printf 'identity_bytes=%s\ngzip_bytes=%s\n' \
    "$(wc -c < "$identity_body" | tr -d ' ')" \
    "$(wc -c < "$gzip_body" | tr -d ' ')" > "$EVIDENCE/$label.bytes.txt"
  printf 'identity_sha256=%s\ngzip_sha256=%s\n' \
    "$(shasum -a 256 "$identity_body" | awk '{print $1}')" \
    "$(shasum -a 256 "$gzip_body" | awk '{print $1}')" > "$EVIDENCE/$label.sha256.txt"
}

sample_clawhub() {
  label=$1
  url=$2
  timings="$EVIDENCE/$label.timings.tsv"
  : > "$timings"
  i=1
  while [ "$i" -le 20 ]; do
    headers="$EVIDENCE/$label-$i.headers"
    total="$(curl --compressed -fsS -D "$headers" -o /dev/null \
      -w '%{time_total}' "$url")"
    d1="$(tr '[:upper:]' '[:lower:]' < "$headers" \
      | sed -nE 's/^server-timing:.*d1;dur=([0-9.]+).*/\1/p' \
      | tail -n 1)"
    test -n "$d1"
    printf '%s\t%s\n' "$total" "$d1" >> "$timings"
    i=$((i + 1))
  done
  test "$(wc -l < "$timings" | tr -d ' ')" = 20
  cut -f1 "$timings" | sort -n | sed -n '15p' > "$EVIDENCE/$label.total-p75.txt"
  cut -f2 "$timings" | sort -n | sed -n '15p' > "$EVIDENCE/$label.d1-p75.txt"
}

capture_encodings clawhub-all-before "$ALL_URL"
capture_encodings clawhub-category-before "$CAT_URL"
sample_clawhub clawhub-all-before "$ALL_URL"
sample_clawhub clawhub-category-before "$CAT_URL"

npx wrangler d1 execute xlist-staging --env staging --remote \
  --file=migrations/028-feed-list-query-indexes.sql | tee "$EVIDENCE/migration-028.txt"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$INDEX_SQL" > "$EVIDENCE/d1-target-indexes-after.json"
jq -e '.[0].success == true and (.[0].results | length == 2) and
  all(.[0].results[]; (.sql // "") | contains("CREATE INDEX"))' \
  "$EVIDENCE/d1-target-indexes-after.json" >/dev/null

npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$ALL_EXPLAIN" > "$EVIDENCE/clawhub-all-plan-after.json"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$CAT_EXPLAIN" > "$EVIDENCE/clawhub-category-plan-after.json"
jq -e '.[0].results | (map(.detail // "") | join("\n")) as $plan |
  ($plan | contains("idx_items_clawhub_feed_stars")) and
  (($plan | test("USE TEMP B-TREE FOR ORDER BY";"i")) | not)' \
  "$EVIDENCE/clawhub-all-plan-after.json" >/dev/null
jq -e '.[0].results | (map(.detail // "") | join("\n")) as $plan |
  ($plan | contains("idx_items_clawhub_category_stars")) and
  (($plan | test("USE TEMP B-TREE FOR ORDER BY";"i")) | not)' \
  "$EVIDENCE/clawhub-category-plan-after.json" >/dev/null

capture_encodings clawhub-all-after "$ALL_URL"
capture_encodings clawhub-category-after "$CAT_URL"
sample_clawhub clawhub-all-after "$ALL_URL"
sample_clawhub clawhub-category-after "$CAT_URL"

curl --compressed -fsS -D "$EVIDENCE/clawhub-all-after.headers" \
  -o "$RAW_DIR/clawhub-all-after.json" "$ALL_URL"
curl --compressed -fsS -D "$EVIDENCE/clawhub-category-after.headers" \
  -o "$RAW_DIR/clawhub-category-after.json" "$CAT_URL"
feed_signature "$RAW_DIR/clawhub-all-after.json" "$EVIDENCE/clawhub-all-after.signature.json"
feed_signature "$RAW_DIR/clawhub-category-after.json" \
  "$EVIDENCE/clawhub-category-after.signature.json"
cmp "$EVIDENCE/clawhub-all-before.signature.json" "$EVIDENCE/clawhub-all-after.signature.json"
cmp "$EVIDENCE/clawhub-category-before.signature.json" "$EVIDENCE/clawhub-category-after.signature.json"
ALL_D1_BEFORE="$(cat "$EVIDENCE/clawhub-all-before.d1-p75.txt")"
ALL_D1_AFTER="$(cat "$EVIDENCE/clawhub-all-after.d1-p75.txt")"
CAT_D1_BEFORE="$(cat "$EVIDENCE/clawhub-category-before.d1-p75.txt")"
CAT_D1_AFTER="$(cat "$EVIDENCE/clawhub-category-after.d1-p75.txt")"
ALL_TOTAL_BEFORE="$(cat "$EVIDENCE/clawhub-all-before.total-p75.txt")"
ALL_TOTAL_AFTER="$(cat "$EVIDENCE/clawhub-all-after.total-p75.txt")"
CAT_TOTAL_BEFORE="$(cat "$EVIDENCE/clawhub-category-before.total-p75.txt")"
CAT_TOTAL_AFTER="$(cat "$EVIDENCE/clawhub-category-after.total-p75.txt")"
awk -v before="$ALL_D1_BEFORE" -v after="$ALL_D1_AFTER" \
  'BEGIN { exit !(after <= before * 1.10) }'
awk -v before="$CAT_D1_BEFORE" -v after="$CAT_D1_AFTER" \
  'BEGIN { exit !(after <= before * 1.10) }'
awk -v before="$ALL_TOTAL_BEFORE" -v after="$ALL_TOTAL_AFTER" \
  'BEGIN { exit !(after <= before * 1.10) }'
awk -v before="$CAT_TOTAL_BEFORE" -v after="$CAT_TOTAL_AFTER" \
  'BEGIN { exit !(after <= before * 1.10) }'
cleanup_raw
trap - EXIT HUP INT TERM
```

after plan 必须分别命中新索引且不含 `USE TEMP B-TREE FOR ORDER BY`；两份脱敏 signature 必须逐字
相同。live response body 只进入本轮 0700 临时目录并由 trap 删除；evidence 只保留 canonical SHA-256、
计数/布尔、字节、body hash、headers 和 timing。响应临时 body 仅用于比较 identity/gzip、D1 P75 与
`Server-Timing`。不得顺手增加
PH/news/X/HF 索引。

精确回滚只删除 migration 028 的两个索引：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT/worker"
npx wrangler d1 execute xlist-staging --env staging --remote --command="
DROP INDEX IF EXISTS idx_items_clawhub_feed_stars;
DROP INDEX IF EXISTS idx_items_clawhub_category_stars;
"
```

回滚后重新记录 `PRAGMA index_list`、两条 EXPLAIN 和 cursor smoke。

## 6. G3/G4：受控 backfill

只使用版本化 runner。它固定 staging host，默认 dry-run，只有显式 `--write` 才能写；token 仅从
环境读取，日志不包含 token。每种 mode 先 dry-run，再为 write 单独审批：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT"
node scripts/run-aifeeds-staging-backfill.mjs \
  --mode github-cover-backfill \
  --max-batches 100 \
  > "$EVIDENCE/github-cover-dry.jsonl" \
  2> "$EVIDENCE/github-cover-dry.stderr.jsonl"
jq -e -c . "$EVIDENCE/github-cover-dry.jsonl" >/dev/null
jq -s -e '([.[] | select(.event == "backfill_finished")] | last | .status) as $status
  | $status == "inventory_complete" or $status == "complete"' \
  "$EVIDENCE/github-cover-dry.jsonl" >/dev/null

node scripts/run-aifeeds-staging-backfill.mjs \
  --mode card-image-variant-backfill \
  --max-batches 100 \
  > "$EVIDENCE/card-variant-dry.jsonl" \
  2> "$EVIDENCE/card-variant-dry.stderr.jsonl"
jq -e -c . "$EVIDENCE/card-variant-dry.jsonl" >/dev/null
jq -s -e '([.[] | select(.event == "backfill_finished")] | last | .status) as $status
  | $status == "inventory_complete" or $status == "complete"' \
  "$EVIDENCE/card-variant-dry.jsonl" >/dev/null
```

G4a 只写 D1 cover marker/URL，不创建 R2 对象。获批后执行并保存独立 stdout/stderr：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT"
node scripts/run-aifeeds-staging-backfill.mjs \
  --mode github-cover-backfill --write \
  --max-batches 100 \
  > "$EVIDENCE/github-cover-write.jsonl" \
  2> "$EVIDENCE/github-cover-write.stderr.jsonl"
jq -e -c . "$EVIDENCE/github-cover-write.jsonl" >/dev/null
jq -s -e '([.[] | select(.event == "backfill_finished")] | last | .status) == "complete"' \
  "$EVIDENCE/github-cover-write.jsonl" >/dev/null
```

G4b1 是另一项审批：card dry-run 不调用真实图片转换，因此先只写 1 行验证 staging R2/cf.image
能力。任一 `resolvable!=1`、`updated!=1`、`source_unavailable>0` 或 `transform_failed>0` 都停止，
不得进入 bulk。先用与 Worker 相同的 predicate 锁定该 1 行，不能把 nullable `next_cursor` 猜成
已处理 item id：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-g4b1.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_raw() { rm -rf "$RAW_DIR"; }
trap cleanup_raw EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$REPO_ROOT/worker"
CARD_SPIKE_SQL="SELECT id FROM items
  WHERE source_type IN ('x_list','product_hunt','hf_paper','github','blog','podcast')
    AND is_relevant=1 AND deleted_at IS NULL
    AND CASE
      WHEN extra IS NULL OR json_valid(extra)=0 THEN 1
      WHEN COALESCE(json_extract(extra,'$.card_variant_version'),0)<1 THEN 1
      WHEN source_type='github'
        AND json_type(extra,'$.cover_url')='text'
        AND length(trim(json_extract(extra,'$.cover_url')))>0
        AND COALESCE(json_extract(extra,'$.cover_variant_source'),'')
            <> json_extract(extra,'$.cover_url') THEN 1
      WHEN source_type IN ('blog','podcast')
        AND json_type(extra,'$.cover_image')='text'
        AND length(trim(json_extract(extra,'$.cover_image')))>0
        AND COALESCE(json_extract(extra,'$.cover_variant_source'),'')
            <> json_extract(extra,'$.cover_image') THEN 1
      ELSE 0
    END=1
  ORDER BY id LIMIT 1"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$CARD_SPIKE_SQL" > "$RAW_DIR/card-variant-spike-candidate.json"
SPIKE_ITEM_ID="$(jq -er 'select(.[0].success == true) | .[0].results[0].id' \
  "$RAW_DIR/card-variant-spike-candidate.json")"
case "$SPIKE_ITEM_ID" in ''|*[!A-Za-z0-9_:/.-]*) exit 1 ;; esac
cd "$REPO_ROOT"
node scripts/run-aifeeds-staging-backfill.mjs \
  --mode card-image-variant-backfill --write \
  --limit 1 --max-batches 1 \
  > "$EVIDENCE/card-variant-spike.jsonl" \
  2> "$EVIDENCE/card-variant-spike.stderr.jsonl"
jq -s -e '
  ([.[] | select(.event == "backfill_batch")][0]) as $batch |
  $batch.resolvable == 1 and $batch.updated == 1 and
  $batch.source_unavailable == 0 and $batch.transform_failed == 0 and
  $batch.errors == 0 and $batch.conflicts == 0
' "$EVIDENCE/card-variant-spike.jsonl" >/dev/null
SPIKE_ITEM_ENC="$(jq -nr --arg value "$SPIKE_ITEM_ID" '$value|@uri')"
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  -o "$RAW_DIR/card-variant-spike-item.json" \
  "https://staging-api.ai-feeds.com/api/items/$SPIKE_ITEM_ENC"
SPIKE_SOURCE_TYPE="$(jq -er '.item.source_type' "$RAW_DIR/card-variant-spike-item.json")"
case "$SPIKE_SOURCE_TYPE" in
  x_list) EXPECTED_PREFIX=x ;;
  product_hunt) EXPECTED_PREFIX=ph ;;
  hf_paper) EXPECTED_PREFIX=hf ;;
  github) EXPECTED_PREFIX=gh ;;
  blog) EXPECTED_PREFIX=blog ;;
  podcast) EXPECTED_PREFIX=podcast ;;
  *) exit 1 ;;
esac
jq -e --arg expected_prefix "$EXPECTED_PREFIX" '
  .item as $item |
  (if $item.source_type == "github" then
     select($item.extra.cover_variant_source == $item.extra.cover_url) |
     $item.extra.cover_variants
   elif ($item.source_type == "blog" or $item.source_type == "podcast") then
     select($item.extra.cover_variant_source == $item.extra.cover_image) |
     $item.extra.cover_image_variants
   elif $item.source_type == "x_list" then
     ($item.extra // {}) as $extra |
     (if ($extra.is_retweet == true and ($extra.retweet_of.media | type) == "array")
      then $extra.retweet_of.media else ($item.media // []) end) as $media |
     (if $media[0].type == "image" then $media[0].card_variants
      elif ($media[0].type == "video" and ($media[0].poster | type) == "string")
      then $media[0].poster_variants
      else ([$media[]? | select(.type == "image")][0].card_variants) end)
   elif $item.source_type == "product_hunt" then
     ([$item.media[]? | select(.type == "image" and .role != "logo")][0].card_variants)
   elif $item.source_type == "hf_paper" then
     ([$item.media[]? | select(.type == "image")][0].card_variants)
   else null end) as $variants |
  $variants | select(type == "array") |
  map(select(
    (.url | type) == "string" and
    (.url | test("^/r/" + $expected_prefix + "/card/[a-f0-9]{64}-w(400|800)[.]webp$")) and
    (.width == 400 or .width == 800) and .width == (.width | floor) and
    (.height | type) == "number" and .height > 0 and .height == (.height | floor) and
    .format == "webp" and
    (.bytes | type) == "number" and .bytes > 0 and .bytes <= 524288 and
    .bytes == (.bytes | floor)
  )) | sort_by(.width) |
  select(map(.width) == [400, 800])
' "$RAW_DIR/card-variant-spike-item.json" > "$RAW_DIR/card-variant-spike-variants.json"

: > "$RAW_DIR/card-variant-spike-assets.jsonl"
while IFS= read -r VARIANT; do
  VARIANT_URL="$(printf '%s' "$VARIANT" | jq -er '.url')"
  VARIANT_WIDTH="$(printf '%s' "$VARIANT" | jq -er '.width')"
  VARIANT_HEIGHT="$(printf '%s' "$VARIANT" | jq -er '.height')"
  DECLARED_BYTES="$(printf '%s' "$VARIANT" | jq -er '.bytes')"
  printf '%s' "$VARIANT_URL" \
    | grep -Eq "^/r/$EXPECTED_PREFIX/card/[a-f0-9]{64}-w(400|800)[.]webp$"
  case "$VARIANT_WIDTH" in 400|800) ;; *) exit 1 ;; esac
  ASSET_FILE="$RAW_DIR/card-variant-$VARIANT_WIDTH.webp"
  HEADER_FILE="$RAW_DIR/card-variant-$VARIANT_WIDTH.headers"
  curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
    -D "$HEADER_FILE" -o "$ASSET_FILE" \
    "https://staging-api.ai-feeds.com$VARIANT_URL"
  CONTENT_TYPE="$(tr -d '\r' < "$HEADER_FILE" \
    | awk -F': ' 'tolower($1)=="content-type" {print tolower($2); exit}')"
  CONTENT_LENGTH="$(tr -d '\r' < "$HEADER_FILE" \
    | awk -F': ' 'tolower($1)=="content-length" {print $2; exit}')"
  test "$CONTENT_TYPE" = image/webp
  printf '%s' "$CONTENT_LENGTH" | grep -Eq '^[0-9]+$'
  ACTUAL_BYTES="$(wc -c < "$ASSET_FILE" | tr -d ' ')"
  test "$ACTUAL_BYTES" = "$CONTENT_LENGTH"
  test "$ACTUAL_BYTES" = "$DECLARED_BYTES"
  ACTUAL_WIDTH="$(sips -g pixelWidth "$ASSET_FILE" | awk '/pixelWidth:/ {print $2; exit}')"
  ACTUAL_HEIGHT="$(sips -g pixelHeight "$ASSET_FILE" | awk '/pixelHeight:/ {print $2; exit}')"
  test "$ACTUAL_WIDTH" = "$VARIANT_WIDTH"
  test "$ACTUAL_HEIGHT" = "$VARIANT_HEIGHT"
  ASSET_SHA256="$(shasum -a 256 "$ASSET_FILE" | awk '{print $1}')"
  URL_SHA256="$(printf '%s' "$VARIANT_URL" \
    | sed -E "s#^/r/$EXPECTED_PREFIX/card/([a-f0-9]{64})-w(400|800)[.]webp$#\\1#")"
  printf '%s' "$URL_SHA256" | grep -Eq '^[a-f0-9]{64}$'
  test "$ASSET_SHA256" = "$URL_SHA256"
  jq -nc --argjson width "$ACTUAL_WIDTH" --argjson height "$ACTUAL_HEIGHT" \
    --argjson bytes "$ACTUAL_BYTES" --arg sha256 "$ASSET_SHA256" \
    '{width:$width,height:$height,bytes:$bytes,content_type:"image/webp",sha256:$sha256}' \
    >> "$RAW_DIR/card-variant-spike-assets.jsonl"
done < <(jq -c '.[]' "$RAW_DIR/card-variant-spike-variants.json")
jq -s -e '
  sort_by(.width) |
  select(map(.width) == [400, 800] and
    all(.[]; .height > 0 and .bytes > 0 and .bytes <= 524288 and
      .content_type == "image/webp" and (.sha256 | test("^[a-f0-9]{64}$"))))
' "$RAW_DIR/card-variant-spike-assets.jsonl" \
  > "$EVIDENCE/card-variant-spike-assets.signature.json"
DETAIL_SHA256="$(shasum -a 256 "$RAW_DIR/card-variant-spike-item.json" | awk '{print $1}')"
DETAIL_BYTES="$(wc -c < "$RAW_DIR/card-variant-spike-item.json" | tr -d ' ')"
jq -nc --arg sha256 "$DETAIL_SHA256" --argjson bytes "$DETAIL_BYTES" \
  '{sha256:$sha256,bytes:$bytes,card_variant_present:true,card_variant_widths:[400,800]}' \
  > "$EVIDENCE/card-variant-spike-item.signature.json"
printf '%s\n' "$SPIKE_ITEM_ID" > "$EVIDENCE/card-variant-spike-item-id.txt"
cleanup_raw
trap - EXIT HUP INT TERM
```

只有 spike 证据通过且 G4b2 另行获批，才从精确 cursor 继续 bounded write：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT"
SPIKE_ITEM_ID="$(cat "$EVIDENCE/card-variant-spike-item-id.txt")"

node scripts/run-aifeeds-staging-backfill.mjs \
  --mode card-image-variant-backfill --write \
  --after-id "$SPIKE_ITEM_ID" \
  --max-batches 100 \
  > "$EVIDENCE/card-variant-write.jsonl" \
  2> "$EVIDENCE/card-variant-write.stderr.jsonl"
jq -e -c . "$EVIDENCE/card-variant-write.jsonl" >/dev/null
jq -s -e '([.[] | select(.event == "backfill_finished")] | last | .status) == "complete"' \
  "$EVIDENCE/card-variant-write.jsonl" >/dev/null
```

runner 必须在 HTTP 非 2xx、非 JSON、契约异常、`errors>0`、`conflicts>0` 或 cursor 不前进时非零
退出。达到 max-batches 会安全返回 `bounded_pause` 和可恢复 `next_cursor`，不自动扩大批次；由审批
owner 复核 JSONL 后以显式 `--after-id` 开下一段。dry-run 不会减少 global remaining：最后一页以
`inventory_complete` 收敛，不要求 `complete=true`；write 则必须最终 `complete=true`。GitHub 写完
抽样确认 cover marker/URL 合法且 drawer README 仍完整。G4b1 必须从该 item 的精确卡图字段提取
400/800 两个绑定 variant，逐一 GET 并核对 WebP、Content-Length、metadata bytes、实际像素与 SHA；
只有这份 signature 通过才可进入 bulk。card variant 写完再由 G8 确认五端图片 decode、DPR 选择、
CLS、失败回退原图，以及 X 视频与播客音频 Range=206。

这两项是加性/可忽略数据：原图和详情正文不删除，旧 Worker 会忽略新 marker。紧急回滚先回滚
Worker；内容寻址 R2 对象保留。任何对象清理都必须先做引用审计并另行审批，禁止批量删除共享
`/r`、音视频或 `/img` cache。

## 7. G5：专用 Pages 项目

获批后使用 staging 账号环境，创建项目（若只读 list 发现已存在则停止并核对 owner，不重复创建）：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT/dashboard"
npm run build:perf-staging
WRANGLER="$REPO_ROOT/worker/node_modules/.bin/wrangler"
test -x "$WRANGLER"
"$WRANGLER" pages project list --json > "$EVIDENCE/pages-projects-before.json"
jq -e '[.[] | select(."Project Name" == "xlist-dashboard-perf")] | length == 0' \
  "$EVIDENCE/pages-projects-before.json" >/dev/null
"$WRANGLER" pages project create xlist-dashboard-perf --production-branch=main \
  > "$EVIDENCE/pages-project-create.stdout" \
  2> "$EVIDENCE/pages-project-create.stderr"
"$WRANGLER" pages project list --json > "$EVIDENCE/pages-projects-after.json"
jq -e '[.[] | select(."Project Name" == "xlist-dashboard-perf")] as $matches |
  ($matches | length == 1) and
  ($matches[0]."Project Domains" | contains("xlist-dashboard-perf.pages.dev"))' \
  "$EVIDENCE/pages-projects-after.json" >/dev/null
"$WRANGLER" pages deploy dist \
  --project-name=xlist-dashboard-perf \
  --branch=main \
  --commit-dirty=false \
  > "$EVIDENCE/pages-deploy.stdout" \
  2> "$EVIDENCE/pages-deploy.stderr"
curl -fsS -D "$EVIDENCE/pages.headers" -o /dev/null \
  https://xlist-dashboard-perf.pages.dev/
```

直接 Pages URL 没有相对 `/api` route，不是功能验收面。回滚时优先把 nginx/DNS 实验入口撤掉；
保留孤立 Pages 项目和历史 deployment 便于审计，不在事故处理中删除项目。

## 8. G6：DNS-only A 记录

**G6c credential gate 当前 BLOCKED**：现有 deployment token 没有 DNS 权限，当前 prod env 又没有可创建
子 token 的 master。不得读取历史 `.bak`、扩大 deployment token 或用 Dashboard session 绕过。另行批准的
credential owner 必须创建一个最长 24 小时、资源只含 `CF_ZONE_AIFEEDS_COM`、权限只有 `Zone Read` +
`DNS Edit` 的子 token，把值只写入 owner 自建的 0700 随机目录
`/private/tmp/aifeeds-perf-staging-dns.<random>/token`（file 0600），再私下提供完整路径作为
`AIFEEDS_DNS_TOKEN_FILE`；不得把 token 或路径写进会归档的 evidence，也不得使用固定共享 token
文件或 symlink。私密记录保留 child token id 供实验结束后撤销。创建、
撤销各自是 Cloudflare token 写，不包含在 G6 DNS 写审批中。若 token 过期，回滚前必须重新走 G6c；
绝不能回退到 `$CLOUDFLARE_API_TOKEN`。

G6 获批且 G6c 已完成后，只允许精确名字 `perf-staging.ai-feeds.com`：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
DNS_LOCK_DIR="$EVIDENCE/.dns-operation.lock"
if ! mkdir "$DNS_LOCK_DIR"; then
  echo 'another DNS create/rollback process or a stale crash lock exists' >&2
  exit 75
fi
chmod 700 "$DNS_LOCK_DIR"
printf '%s\n' "pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DNS_LOCK_DIR/owner.txt"
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-g6.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_runtime() {
  rm -rf "$RAW_DIR"
  rm -f "$DNS_LOCK_DIR/owner.txt"
  rmdir "$DNS_LOCK_DIR"
}
on_exit() {
  rc=$?
  trap - EXIT
  if ! cleanup_runtime; then
    echo 'DNS local lock cleanup failed' >&2
    exit 70
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export AIFEEDS_PROD_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env
test -r "$AIFEEDS_PROD_ENV"
set -a
. "$AIFEEDS_PROD_ENV"
set +a
DNS_TOKEN_FILE="${AIFEEDS_DNS_TOKEN_FILE:?credential owner must provide the random token path}"
printf '%s' "$DNS_TOKEN_FILE" \
  | grep -Eq '^/private/tmp/aifeeds-perf-staging-dns\.[A-Za-z0-9]{6,32}/token$'
DNS_TOKEN_DIR="$(dirname "$DNS_TOKEN_FILE")"
test -d "$DNS_TOKEN_DIR"
test ! -L "$DNS_TOKEN_DIR"
test "$(stat -f '%Lp' "$DNS_TOKEN_DIR")" = 700
test "$(stat -f '%u' "$DNS_TOKEN_DIR")" = "$(id -u)"
test -f "$DNS_TOKEN_FILE"
test ! -L "$DNS_TOKEN_FILE"
test "$(stat -f '%Lp' "$DNS_TOKEN_FILE")" = 600
test "$(stat -f '%u' "$DNS_TOKEN_FILE")" = "$(id -u)"
TOKEN_STAT="$(stat -f '%d:%i:%u:%Lp' "$DNS_TOKEN_FILE")"
exec 3< "$DNS_TOKEN_FILE"
test "$(stat -f '%d:%i:%u:%Lp' /dev/fd/3)" = "$TOKEN_STAT"
CF_DNS_API_TOKEN="$(cat <&3)"
exec 3<&-
test "${#CF_DNS_API_TOKEN}" -ge 20
DNS_NAME=perf-staging.ai-feeds.com
DNS_IP=154.12.188.231
OPERATION_FILE="$EVIDENCE/dns-operation-id.txt"
PREPARED_FILE="$EVIDENCE/dns-create-prepared.txt"
ATTEMPTED_FILE="$EVIDENCE/dns-create-attempted.txt"
RECORD_ID_FILE="$EVIDENCE/dns-record-id.txt"

query_records() {
  output=$1
  curl -fsS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/dns_records?name=$DNS_NAME" \
    > "$output"
  jq -e '.success == true and (.result | type == "array")' "$output" >/dev/null
}

query_records "$RAW_DIR/dns-initial.json"
if [ -f "$OPERATION_FILE" ]; then
  test ! -L "$OPERATION_FILE"
  test "$(stat -f '%Lp' "$OPERATION_FILE")" = 600
  test "$(stat -f '%u' "$OPERATION_FILE")" = "$(id -u)"
  DNS_OPERATION_ID="$(cat "$OPERATION_FILE")"
  printf '%s' "$DNS_OPERATION_ID" | grep -Eq '^aifeeds-perf-[a-f0-9]{32}$'
else
  jq -e '.result | length == 0' "$RAW_DIR/dns-initial.json" >/dev/null
  DNS_OPERATION_ID="aifeeds-perf-$(openssl rand -hex 16)"
  operation_tmp="$(mktemp "$EVIDENCE/.dns-operation.XXXXXX")"
  printf '%s\n' "$DNS_OPERATION_ID" > "$operation_tmp"
  chmod 600 "$operation_tmp"
  mv "$operation_tmp" "$OPERATION_FILE"
fi

operation_record_id() {
  input=$1
  jq -er --arg name "$DNS_NAME" --arg content "$DNS_IP" --arg comment "$DNS_OPERATION_ID" '
    [.result[] | select(
      .type == "A" and .name == $name and .content == $content and .ttl == 120 and
      .proxied == false and .comment == $comment
    )] | select(length == 1) | .[0].id
  ' "$input" 2>/dev/null || true
}

persist_record_id() {
  value=$1
  if [ -f "$RECORD_ID_FILE" ]; then
    test ! -L "$RECORD_ID_FILE"
    test "$(stat -f '%Lp' "$RECORD_ID_FILE")" = 600
    test "$(stat -f '%u' "$RECORD_ID_FILE")" = "$(id -u)"
    test "$(cat "$RECORD_ID_FILE")" = "$value"
    return
  fi
  record_tmp="$(mktemp "$EVIDENCE/.dns-record-id.XXXXXX")"
  printf '%s\n' "$value" > "$record_tmp"
  chmod 600 "$record_tmp"
  mv "$record_tmp" "$RECORD_ID_FILE"
}

DNS_RECORD_ID=""
CREATE_RESPONSE_ID=""
INITIAL_OWN_ID="$(operation_record_id "$RAW_DIR/dns-initial.json")"
if [ -n "$INITIAL_OWN_ID" ]; then
  persist_record_id "$INITIAL_OWN_ID"
  if [ "$(jq '.result | length' "$RAW_DIR/dns-initial.json")" -ne 1 ]; then
    echo 'DNS name contains this operation record plus a concurrent record; rollback by saved id' >&2
    exit 1
  fi
  DNS_RECORD_ID="$INITIAL_OWN_ID"
elif [ "$(jq '.result | length' "$RAW_DIR/dns-initial.json")" -ne 0 ]; then
  echo 'DNS name is occupied by a record not owned by this operation' >&2
  exit 1
elif [ ! -f "$ATTEMPTED_FILE" ]; then
  jq -nc --arg name "$DNS_NAME" --arg content "$DNS_IP" --arg comment "$DNS_OPERATION_ID" \
    '{type:"A",name:$name,content:$content,ttl:120,proxied:false,comment:$comment}' \
    > "$RAW_DIR/dns-create-body.json"
  PREPARED_VALUE="operation=$DNS_OPERATION_ID name=$DNS_NAME ip=$DNS_IP ttl=120 proxied=false"
  if [ -f "$PREPARED_FILE" ]; then
    test ! -L "$PREPARED_FILE"
    test "$(stat -f '%Lp' "$PREPARED_FILE")" = 600
    test "$(stat -f '%u' "$PREPARED_FILE")" = "$(id -u)"
    grep -Fqx "$PREPARED_VALUE" "$PREPARED_FILE"
  else
    prepared_tmp="$(mktemp "$EVIDENCE/.dns-prepared.XXXXXX")"
    printf '%s\n' "$PREPARED_VALUE" > "$prepared_tmp"
    chmod 600 "$prepared_tmp"
    mv "$prepared_tmp" "$PREPARED_FILE"
  fi
  if CREATE_HTTP="$(
    attempted_tmp="$(mktemp "$EVIDENCE/.dns-attempted.XXXXXX")" &&
    printf '%s\n' "$PREPARED_VALUE" > "$attempted_tmp" &&
    chmod 600 "$attempted_tmp" &&
    mv "$attempted_tmp" "$ATTEMPTED_FILE" &&
    exec curl -sS --connect-timeout 10 --max-time 30 -X POST \
      -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data @"$RAW_DIR/dns-create-body.json" \
      -o "$RAW_DIR/dns-create-result.json" -w '%{http_code}' \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/dns_records"
  )"; then
    :
  else
    CREATE_HTTP=000
  fi
  printf '%s\n' "$CREATE_HTTP" > "$EVIDENCE/dns-create-http.txt"
  CREATE_RESPONSE_ID="$(jq -er --arg name "$DNS_NAME" --arg content "$DNS_IP" \
    --arg comment "$DNS_OPERATION_ID" '
      select(.success == true and .result.type == "A" and .result.name == $name and
      .result.content == $content and .result.ttl == 120 and .result.proxied == false and
      .result.comment == $comment) | .result.id
    ' "$RAW_DIR/dns-create-result.json" 2>/dev/null || true)"
else
  test ! -L "$ATTEMPTED_FILE"
  test "$(stat -f '%Lp' "$ATTEMPTED_FILE")" = 600
  test "$(stat -f '%u' "$ATTEMPTED_FILE")" = "$(id -u)"
  grep -Fqx "operation=$DNS_OPERATION_ID name=$DNS_NAME ip=$DNS_IP ttl=120 proxied=false" \
    "$ATTEMPTED_FILE"
  test -f "$PREPARED_FILE"
  cmp "$PREPARED_FILE" "$ATTEMPTED_FILE"
fi

query_attempt=1
while [ -z "$DNS_RECORD_ID" ] && [ "$query_attempt" -le 12 ]; do
  if query_records "$RAW_DIR/dns-reconcile.json"; then
    RECONCILED_OWN_ID="$(operation_record_id "$RAW_DIR/dns-reconcile.json")"
    if [ -n "$RECONCILED_OWN_ID" ]; then
      persist_record_id "$RECONCILED_OWN_ID"
      if [ "$(jq '.result | length' "$RAW_DIR/dns-reconcile.json")" -ne 1 ]; then
        echo 'DNS reconciliation found a concurrent record; rollback this operation by saved id' >&2
        exit 1
      fi
      DNS_RECORD_ID="$RECONCILED_OWN_ID"
      break
    fi
    if [ "$(jq '.result | length' "$RAW_DIR/dns-reconcile.json")" -ne 0 ]; then
      echo 'DNS reconciliation found a foreign or mismatched record' >&2
      exit 1
    fi
  fi
  query_attempt=$((query_attempt + 1))
  sleep 5
done
if [ -z "$DNS_RECORD_ID" ]; then
  echo 'DNS create may have been sent and remains ambiguous; rerun recovery without another POST' >&2
  exit 1
fi
if [ -n "$CREATE_RESPONSE_ID" ]; then test "$CREATE_RESPONSE_ID" = "$DNS_RECORD_ID"; fi
persist_record_id "$DNS_RECORD_ID"
jq -nc --arg id "$DNS_RECORD_ID" --arg operation "$DNS_OPERATION_ID" \
  --arg name "$DNS_NAME" --arg content "$DNS_IP" \
  '{record_id:$id,operation:$operation,type:"A",name:$name,content:$content,ttl:120,proxied:false}' \
  > "$EVIDENCE/dns-after.signature.json"

attempt=1
while [ "$attempt" -le 24 ]; do
  dig @1.1.1.1 +short A "$DNS_NAME" > "$EVIDENCE/dns-resolve.txt"
  awk 'NF' "$EVIDENCE/dns-resolve.txt" | sort -u > "$EVIDENCE/dns-resolve.normalized.txt"
  if [ "$(wc -l < "$EVIDENCE/dns-resolve.normalized.txt" | tr -d ' ')" = 1 ] \
    && grep -Fqx "$DNS_IP" "$EVIDENCE/dns-resolve.normalized.txt"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done
awk 'NF' "$EVIDENCE/dns-resolve.txt" | sort -u > "$EVIDENCE/dns-resolve.normalized.txt"
test "$(wc -l < "$EVIDENCE/dns-resolve.normalized.txt" | tr -d ' ')" = 1
grep -Fqx "$DNS_IP" "$EVIDENCE/dns-resolve.normalized.txt"
dig @1.1.1.1 +short AAAA "$DNS_NAME" > "$EVIDENCE/dns-resolve-aaaa.txt"
test -z "$(awk 'NF' "$EVIDENCE/dns-resolve-aaaa.txt")"
cleanup_runtime
trap - EXIT HUP INT TERM
unset CF_DNS_API_TOKEN
```

`prepared` 已存在但 `attempted` 不存在，表示进程尚未进入与 marker 同一子 shell 的 `exec curl`，重跑
可继续首次 POST；`attempted` 一旦存在就只做 GET reconciliation，绝不自动再 POST。若 12 次查询仍为
零记录，保留 operation/prepared/attempted；若 SIGKILL 留下 crash lock，也一并保留，由 credential owner
查 Cloudflare audit log。只有另一次明确批准的 abandon/retry 才能归档旧 operation 并生成新 comment，
不能静默删 marker。

回滚必须使用本次结果中的精确 record id，不能按名称批量删除：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
DNS_LOCK_DIR="$EVIDENCE/.dns-operation.lock"
if ! mkdir "$DNS_LOCK_DIR"; then
  echo 'another DNS create/rollback process or a stale crash lock exists' >&2
  exit 75
fi
chmod 700 "$DNS_LOCK_DIR"
printf '%s\n' "pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DNS_LOCK_DIR/owner.txt"
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-g6-rollback.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_runtime() {
  rm -rf "$RAW_DIR"
  rm -f "$DNS_LOCK_DIR/owner.txt"
  rmdir "$DNS_LOCK_DIR"
}
on_exit() {
  rc=$?
  trap - EXIT
  if ! cleanup_runtime; then
    echo 'DNS local lock cleanup failed' >&2
    exit 70
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export AIFEEDS_PROD_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env
test -r "$AIFEEDS_PROD_ENV"
set -a
. "$AIFEEDS_PROD_ENV"
set +a
DNS_TOKEN_FILE="${AIFEEDS_DNS_TOKEN_FILE:?credential owner must provide the random token path}"
printf '%s' "$DNS_TOKEN_FILE" \
  | grep -Eq '^/private/tmp/aifeeds-perf-staging-dns\.[A-Za-z0-9]{6,32}/token$'
DNS_TOKEN_DIR="$(dirname "$DNS_TOKEN_FILE")"
test -d "$DNS_TOKEN_DIR"
test ! -L "$DNS_TOKEN_DIR"
test "$(stat -f '%Lp' "$DNS_TOKEN_DIR")" = 700
test "$(stat -f '%u' "$DNS_TOKEN_DIR")" = "$(id -u)"
test -f "$DNS_TOKEN_FILE"
test ! -L "$DNS_TOKEN_FILE"
test "$(stat -f '%Lp' "$DNS_TOKEN_FILE")" = 600
test "$(stat -f '%u' "$DNS_TOKEN_FILE")" = "$(id -u)"
TOKEN_STAT="$(stat -f '%d:%i:%u:%Lp' "$DNS_TOKEN_FILE")"
exec 3< "$DNS_TOKEN_FILE"
test "$(stat -f '%d:%i:%u:%Lp' /dev/fd/3)" = "$TOKEN_STAT"
CF_DNS_API_TOKEN="$(cat <&3)"
exec 3<&-
test "${#CF_DNS_API_TOKEN}" -ge 20
DNS_NAME=perf-staging.ai-feeds.com
DNS_IP=154.12.188.231
DNS_OPERATION_ID="$(cat "$EVIDENCE/dns-operation-id.txt")"
printf '%s' "$DNS_OPERATION_ID" | grep -Eq '^aifeeds-perf-[a-f0-9]{32}$'
DNS_RECORD_ID="$(cat "$EVIDENCE/dns-record-id.txt")"
printf '%s' "$DNS_RECORD_ID" | grep -Eq '^[A-Za-z0-9_-]{16,64}$'

RECORD_HTTP="$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/dns_records/$DNS_RECORD_ID" \
  -o "$RAW_DIR/dns-record.json" -w '%{http_code}')"
case "$RECORD_HTTP" in
  200)
    jq -e --arg id "$DNS_RECORD_ID" --arg name "$DNS_NAME" --arg content "$DNS_IP" \
      --arg comment "$DNS_OPERATION_ID" '
        .success == true and .result.id == $id and .result.type == "A" and
        .result.name == $name and .result.content == $content and .result.ttl == 120 and
        .result.proxied == false and .result.comment == $comment
      ' "$RAW_DIR/dns-record.json" >/dev/null
    if DELETE_HTTP="$(curl -sS --connect-timeout 10 --max-time 30 -X DELETE \
      -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
      -H 'Content-Type: application/json' \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/dns_records/$DNS_RECORD_ID" \
      -o "$RAW_DIR/dns-delete-result.json" -w '%{http_code}')"; then :; else DELETE_HTTP=000; fi
    ;;
  404) DELETE_HTTP=already_absent ;;
  *) exit 1 ;;
esac
printf '%s\n' "$DELETE_HTTP" > "$EVIDENCE/dns-delete-http.txt"
curl -fsS --connect-timeout 10 --max-time 30 \
  -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_AIFEEDS_COM/dns_records?name=$DNS_NAME" \
  > "$RAW_DIR/dns-after-delete.json"
jq -e --arg comment "$DNS_OPERATION_ID" '
  .success == true and ([.result[] | select(.comment == $comment)] | length == 0)
' "$RAW_DIR/dns-after-delete.json" >/dev/null
jq -nc --arg operation "$DNS_OPERATION_ID" \
  '{operation:$operation,owned_record_count:0}' > "$EVIDENCE/dns-delete.signature.json"
cleanup_runtime
trap - EXIT HUP INT TERM
unset CF_DNS_API_TOKEN
```

## 9. G7：HTTP-01、证书与 final nginx

前置：GL-a 必须已经安装并验证；否则即使 TLS/页面/API smoke 成功，也不进入 G8。

两个仓库模板均无 secret：

- `deploy/nginx/aifeeds-perf-staging-bootstrap.conf`：仅 port 80 HTTP-01，其他请求 503；
- `deploy/nginx/aifeeds-perf-staging-server.conf`：完整 TLS、Pages SPA，以及 staging `/api/` 和
  `/daily`、`/i/*`、robots/sitemap/llms SEO Worker routes；使用变量 upstream 安全重解析，不发送
  `X-Origin-Secret`，不开 cache/keepalive。裸 `/i` 仍由 SPA 处理。

G7a 每次审批都在 VPS `/run` 新建 root-owned 0700 staging dir，只上传 bootstrap；本地与远端
SHA-256 必须一致。远端全事务持有 flock，并按 template hash/link target 恢复中断状态；任何未知文件、
hash 或 target 都停止，不覆盖。HUP/INT/TERM、`nginx -t` 或 reload 失败只撤销本次新建的 file/link；
若调用前已有 hash/target 匹配的 bootstrap，则原样保留并重新验证/reload：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
cd "$REPO_ROOT"
VPS=root@154.12.188.231
SSH_KEY=~/.ssh/aifeeds-hk.pem
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
BOOTSTRAP_TEMPLATE=deploy/nginx/aifeeds-perf-staging-bootstrap.conf
BOOTSTRAP_SHA256="$(shasum -a 256 "$BOOTSTRAP_TEMPLATE" | awk '{print $1}')"
printf '%s  %s\n' "$BOOTSTRAP_SHA256" "$(basename "$BOOTSTRAP_TEMPLATE")" \
  > "$EVIDENCE/nginx-bootstrap-local.sha256"
REMOTE_STAGE="$(ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s bash -c 'set -eu; umask 077; d=\$(mktemp -d /run/aifeeds-perf-staging.XXXXXX); chmod 700 \"\$d\"; printf \"%s\\n\" \"\$d\"'")"
printf '%s' "$REMOTE_STAGE" | grep -Eq '^/run/aifeeds-perf-staging\.[A-Za-z0-9]{6}$'
cleanup_stage() {
  ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
    "timeout 30s bash -c \"case '$REMOTE_STAGE' in /run/aifeeds-perf-staging.*) rm -rf -- '$REMOTE_STAGE' ;; *) exit 1 ;; esac\""
}
on_stage_exit() {
  rc=$?
  trap - EXIT
  if ! cleanup_stage; then
    echo 'REMOTE_STAGE_CLEANUP_FAILED' >&2
    exit 70
  fi
  exit "$rc"
}
trap on_stage_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
scp "${SSH_OPTS[@]}" -i "$SSH_KEY" "$BOOTSTRAP_TEMPLATE" "$VPS:$REMOTE_STAGE/"
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s chmod 600 '$REMOTE_STAGE/$(basename "$BOOTSTRAP_TEMPLATE")'"
REMOTE_SHA_LINE="$(ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s bash -c 'set -eu; f=\$1; test -f \"\$f\"; test ! -L \"\$f\"; \
   test \"\$(stat -c \"%u:%a\" \"\$f\")\" = 0:600; sha256sum \"\$f\"' \
   _ '$REMOTE_STAGE/$(basename "$BOOTSTRAP_TEMPLATE")'")"
REMOTE_SHA256="${REMOTE_SHA_LINE%% *}"
test "$REMOTE_SHA256" = "$BOOTSTRAP_SHA256"
printf '%s\n' "$REMOTE_SHA256" > "$EVIDENCE/nginx-bootstrap-remote.sha256"

ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  timeout --signal=TERM --kill-after=30s 5m bash -s -- "$REMOTE_STAGE" "$BOOTSTRAP_SHA256" \
  > "$EVIDENCE/nginx-bootstrap.stdout" 2> "$EVIDENCE/nginx-bootstrap.stderr" <<'REMOTE'
set -eu
set -o pipefail
umask 077
STAGE=$1
EXPECTED_SHA256=$2
case "$STAGE" in /run/aifeeds-perf-staging.*) ;; *) exit 1 ;; esac
STAGED="$STAGE/aifeeds-perf-staging-bootstrap.conf"
BOOTSTRAP_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.bootstrap.conf
FINAL_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.conf
LINK=/etc/nginx/sites-enabled/perf-staging.ai-feeds.com.conf
WEBROOT=/var/www/aifeeds-certbot
exec 9>/run/lock/aifeeds-perf-staging-nginx.lock
flock -n 9
test "$(stat -c '%u:%a' "$STAGE")" = 0:700
test -f "$STAGED"
test ! -L "$STAGED"
test "$(stat -c '%u:%a' "$STAGED")" = 0:600
test "$(sha256sum "$STAGED" | awk '{print $1}')" = "$EXPECTED_SHA256"
test ! -e "$FINAL_SITE"
test ! -L "$FINAL_SITE"

rollback_needed=0
SITE_CREATED=0
LINK_CREATED=0
TXN_DIR=""
on_exit() {
  rc=$?
  trap - EXIT
  if [ -n "$TXN_DIR" ]; then rm -rf "$TXN_DIR"; fi
  if [ "$rollback_needed" = 1 ] && [ "$rc" -ne 0 ]; then
    rollback_failed=0
    set +e
    if [ "$LINK_CREATED" = 1 ]; then
      if [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" = "$BOOTSTRAP_SITE" ]; then
        rm -f "$LINK" || rollback_failed=1
      elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
        rollback_failed=1
      fi
    fi
    if [ "$SITE_CREATED" = 1 ]; then
      rm -f "$BOOTSTRAP_SITE" || rollback_failed=1
    fi
    nginx -t >/dev/null 2>&1
    rollback_nginx_status=$?
    if [ "$rollback_nginx_status" = 0 ]; then
      systemctl reload nginx >/dev/null 2>&1 || rollback_failed=1
    else
      rollback_failed=1
    fi
    set -e
    if [ "$rollback_failed" -ne 0 ]; then
      echo 'ROLLBACK_FAILED: bootstrap pre-state did not validate and reload' >&2
      exit 70
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
TXN_DIR="$(mktemp -d /run/aifeeds-perf-nginx.XXXXXX)"
chmod 700 "$TXN_DIR"

nginx -t
test -s /etc/ssl/certs/ca-certificates.crt
test -s /etc/letsencrypt/options-ssl-nginx.conf
test -s /etc/letsencrypt/ssl-dhparams.pem
LINK_EXISTS=0
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  test -L "$LINK"
  test "$(readlink -f "$LINK")" = "$BOOTSTRAP_SITE"
  LINK_EXISTS=1
fi
if [ -e "$BOOTSTRAP_SITE" ] || [ -L "$BOOTSTRAP_SITE" ]; then
  test -f "$BOOTSTRAP_SITE"
  test ! -L "$BOOTSTRAP_SITE"
  test "$(stat -c '%u' "$BOOTSTRAP_SITE")" = 0
  test "$(sha256sum "$BOOTSTRAP_SITE" | awk '{print $1}')" = "$EXPECTED_SHA256"
else
  rollback_needed=1
  SITE_CREATED=1
  install -o root -g root -m 0644 "$STAGED" "$BOOTSTRAP_SITE"
fi
rollback_needed=1
if [ "$LINK_EXISTS" = 0 ]; then
  NEXT_LINK="$TXN_DIR/bootstrap-link.next"
  ln -s "$BOOTSTRAP_SITE" "$NEXT_LINK"
  LINK_CREATED=1
  mv -Tf "$NEXT_LINK" "$LINK"
fi
install -d -o root -g root -m 0755 "$WEBROOT/.well-known/acme-challenge"
nginx -t
systemctl reload nginx
rollback_needed=0
rm -rf "$TXN_DIR"
REMOTE
if ! cleanup_stage; then echo 'REMOTE_STAGE_CLEANUP_FAILED' >&2; exit 70; fi
trap - EXIT HUP INT TERM
```

从公网实际验证唯一 challenge 文件，逐字匹配后删除；仅看到 port 80 状态码不算通过：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
CHALLENGE_NAME="probe-$(openssl rand -hex 12)"
CHALLENGE_VALUE="$(openssl rand -hex 32)"
REMOTE_PROBE="/var/www/aifeeds-certbot/.well-known/acme-challenge/$CHALLENGE_NAME"
cleanup_probe() {
  ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
    "timeout 30s rm -f -- '$REMOTE_PROBE'"
}
on_probe_exit() {
  rc=$?
  trap - EXIT
  if ! cleanup_probe; then
    echo 'REMOTE_PROBE_CLEANUP_FAILED' >&2
    exit 70
  fi
  exit "$rc"
}
trap on_probe_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  "timeout 30s bash -c \"umask 022; printf '%s' '$CHALLENGE_VALUE' > '$REMOTE_PROBE'\""
ACTUAL_CHALLENGE="$(curl -fsS --connect-timeout 10 --max-time 30 \
  "http://perf-staging.ai-feeds.com/.well-known/acme-challenge/$CHALLENGE_NAME")"
test "$ACTUAL_CHALLENGE" = "$CHALLENGE_VALUE"
if ! cleanup_probe; then echo 'REMOTE_PROBE_CLEANUP_FAILED' >&2; exit 70; fi
trap - EXIT HUP INT TERM
```

只使用 webroot，不让 certbot 自动改 nginx。G7b 是另一项审批；新 shell 先验证既有 certbot account、
SSL include、DH 参数和系统 CA，再签证书。任何前置失败都保持 bootstrap：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  timeout --signal=TERM --kill-after=30s 10m bash -s <<'REMOTE'
  set -eu
  exec 9>/run/lock/aifeeds-perf-staging-nginx.lock
  flock -n 9
  certbot show_account >/dev/null
  test -s /etc/ssl/certs/ca-certificates.crt
  test -s /etc/letsencrypt/options-ssl-nginx.conf
  test -s /etc/letsencrypt/ssl-dhparams.pem
  timeout --signal=TERM --kill-after=30s 8m certbot certonly --webroot \
    -w /var/www/aifeeds-certbot \
    -d perf-staging.ai-feeds.com \
    --non-interactive --agree-tos --no-eff-email
  test -s /etc/letsencrypt/live/perf-staging.ai-feeds.com/fullchain.pem
  test -s /etc/letsencrypt/live/perf-staging.ai-feeds.com/privkey.pem
REMOTE
```

安装 final 到未启用文件，再原子切换 symlink。任何语法、reload 或 smoke 失败都会自动恢复
bootstrap 并再次验证；不会把无效配置留在 enabled 链路：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
cd "$REPO_ROOT"
VPS=root@154.12.188.231
SSH_KEY=~/.ssh/aifeeds-hk.pem
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
FINAL_TEMPLATE=deploy/nginx/aifeeds-perf-staging-server.conf
FINAL_SHA256="$(shasum -a 256 "$FINAL_TEMPLATE" | awk '{print $1}')"
BOOTSTRAP_SHA256="$(cat "$EVIDENCE/nginx-bootstrap-remote.sha256")"
printf '%s' "$BOOTSTRAP_SHA256" | grep -Eq '^[a-f0-9]{64}$'
printf '%s  %s\n' "$FINAL_SHA256" "$(basename "$FINAL_TEMPLATE")" \
  > "$EVIDENCE/nginx-final-local.sha256"
REMOTE_STAGE="$(ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s bash -c 'set -eu; umask 077; d=\$(mktemp -d /run/aifeeds-perf-staging.XXXXXX); chmod 700 \"\$d\"; printf \"%s\\n\" \"\$d\"'")"
printf '%s' "$REMOTE_STAGE" | grep -Eq '^/run/aifeeds-perf-staging\.[A-Za-z0-9]{6}$'
cleanup_stage() {
  ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
    "timeout 30s bash -c \"case '$REMOTE_STAGE' in /run/aifeeds-perf-staging.*) rm -rf -- '$REMOTE_STAGE' ;; *) exit 1 ;; esac\""
}
on_stage_exit() {
  rc=$?
  trap - EXIT
  if ! cleanup_stage; then
    echo 'REMOTE_STAGE_CLEANUP_FAILED' >&2
    exit 70
  fi
  exit "$rc"
}
trap on_stage_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
scp "${SSH_OPTS[@]}" -i "$SSH_KEY" "$FINAL_TEMPLATE" "$VPS:$REMOTE_STAGE/"
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s chmod 600 '$REMOTE_STAGE/$(basename "$FINAL_TEMPLATE")'"
REMOTE_SHA_LINE="$(ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  "timeout 30s bash -c 'set -eu; f=\$1; test -f \"\$f\"; test ! -L \"\$f\"; \
   test \"\$(stat -c \"%u:%a\" \"\$f\")\" = 0:600; sha256sum \"\$f\"' \
   _ '$REMOTE_STAGE/$(basename "$FINAL_TEMPLATE")'")"
REMOTE_SHA256="${REMOTE_SHA_LINE%% *}"
test "$REMOTE_SHA256" = "$FINAL_SHA256"
printf '%s\n' "$REMOTE_SHA256" > "$EVIDENCE/nginx-final-remote.sha256"

ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "$VPS" \
  timeout --signal=TERM --kill-after=30s 5m bash -s -- \
  "$REMOTE_STAGE" "$FINAL_SHA256" "$BOOTSTRAP_SHA256" \
  > "$EVIDENCE/nginx-final.stdout" 2> "$EVIDENCE/nginx-final.stderr" <<'REMOTE'
set -eu
set -o pipefail
umask 077
STAGE=$1
EXPECTED_SHA256=$2
EXPECTED_BOOTSTRAP_SHA256=$3
case "$STAGE" in /run/aifeeds-perf-staging.*) ;; *) exit 1 ;; esac
STAGED="$STAGE/aifeeds-perf-staging-server.conf"
BOOTSTRAP_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.bootstrap.conf
FINAL_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.conf
LINK=/etc/nginx/sites-enabled/perf-staging.ai-feeds.com.conf
BROWSER_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36"
exec 9>/run/lock/aifeeds-perf-staging-nginx.lock
flock -n 9
test "$(stat -c '%u:%a' "$STAGE")" = 0:700
test -f "$STAGED"
test ! -L "$STAGED"
test "$(stat -c '%u:%a' "$STAGED")" = 0:600
test "$(sha256sum "$STAGED" | awk '{print $1}')" = "$EXPECTED_SHA256"
test -f "$BOOTSTRAP_SITE"
test ! -L "$BOOTSTRAP_SITE"
test "$(stat -c '%u' "$BOOTSTRAP_SITE")" = 0
test "$(sha256sum "$BOOTSTRAP_SITE" | awk '{print $1}')" = "$EXPECTED_BOOTSTRAP_SHA256"
test -L "$LINK"
CURRENT_TARGET="$(readlink -f "$LINK")"
test "$CURRENT_TARGET" = "$BOOTSTRAP_SITE" -o "$CURRENT_TARGET" = "$FINAL_SITE"
SMOKE_DIR=""

activate_site() {
  target=$1
  next_link="$SMOKE_DIR/site-link.next"
  rm -f "$next_link"
  ln -s "$target" "$next_link"
  mv -Tf "$next_link" "$LINK"
}
rollback_needed=0
on_exit() {
  rc=$?
  trap - EXIT
  if [ "$rollback_needed" = 1 ] && [ "$rc" -ne 0 ]; then
    rollback_failed=0
    set +e
    activate_site "$BOOTSTRAP_SITE"
    rollback_failed=$?
    rm -f "$FINAL_SITE" || rollback_failed=1
    nginx -t >/dev/null 2>&1 || rollback_failed=1
    if [ "$rollback_failed" = 0 ]; then
      systemctl reload nginx >/dev/null 2>&1 || rollback_failed=1
    fi
    set -e
    if [ "$rollback_failed" -ne 0 ]; then
      echo 'ROLLBACK_FAILED: final site did not restore bootstrap and reload' >&2
      exit 70
    fi
  fi
  if [ -n "$SMOKE_DIR" ]; then rm -rf "$SMOKE_DIR"; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
SMOKE_DIR="$(mktemp -d /run/aifeeds-perf-smoke.XXXXXX)"
chmod 700 "$SMOKE_DIR"

test -s /etc/letsencrypt/live/perf-staging.ai-feeds.com/fullchain.pem
test -s /etc/letsencrypt/live/perf-staging.ai-feeds.com/privkey.pem
if [ -e "$FINAL_SITE" ] || [ -L "$FINAL_SITE" ]; then
  test -f "$FINAL_SITE"
  test ! -L "$FINAL_SITE"
  test "$(stat -c '%u' "$FINAL_SITE")" = 0
  test "$(sha256sum "$FINAL_SITE" | awk '{print $1}')" = "$EXPECTED_SHA256"
else
  install -o root -g root -m 0644 "$STAGED" "$FINAL_SITE"
fi
rollback_needed=1
activate_site "$FINAL_SITE"
nginx -t
systemctl reload nginx
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  -D "$SMOKE_DIR/home.headers" -o /dev/null https://perf-staging.ai-feeds.com/
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  -D "$SMOKE_DIR/api.headers" \
  "https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=1" \
  | jq -e '.items | type == "array"' >/dev/null
grep -Eiq '^server-timing:.*d1;dur=' "$SMOKE_DIR/api.headers"
grep -Eiq '^x-request-id: [A-Za-z0-9._:-]{8,128}' "$SMOKE_DIR/api.headers"
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  https://perf-staging.ai-feeds.com/robots.txt | grep -Fq 'User-agent: *'
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  https://perf-staging.ai-feeds.com/sitemap.xml | grep -Fq '<sitemapindex'
rollback_needed=0
rm -rf "$SMOKE_DIR"
REMOTE
if ! cleanup_stage; then echo 'REMOTE_STAGE_CLEANUP_FAILED' >&2; exit 70; fi
trap - EXIT HUP INT TERM
```

立即回滚新站点时，先禁用 link 并验证/reload；失败则恢复刚才的精确 target：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
BOOTSTRAP_SHA256="$(cat "$EVIDENCE/nginx-bootstrap-remote.sha256")"
printf '%s' "$BOOTSTRAP_SHA256" | grep -Eq '^[a-f0-9]{64}$'
if [ -f "$EVIDENCE/nginx-final-remote.sha256" ]; then
  FINAL_SHA256="$(cat "$EVIDENCE/nginx-final-remote.sha256")"
  printf '%s' "$FINAL_SHA256" | grep -Eq '^[a-f0-9]{64}$'
else
  FINAL_SHA256=absent
fi
ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
  timeout --signal=TERM --kill-after=30s 5m bash -s -- \
  "$BOOTSTRAP_SHA256" "$FINAL_SHA256" \
  > "$EVIDENCE/nginx-rollback.stdout" 2> "$EVIDENCE/nginx-rollback.stderr" <<'REMOTE'
  set -eu
  set -o pipefail
  umask 077
  EXPECTED_BOOTSTRAP_SHA256=$1
  EXPECTED_FINAL_SHA256=$2
  set -eu
  BOOTSTRAP_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.bootstrap.conf
  FINAL_SITE=/etc/nginx/sites-available/perf-staging.ai-feeds.com.conf
  LINK=/etc/nginx/sites-enabled/perf-staging.ai-feeds.com.conf
  TXN_DIR=""
  CURRENT_TARGET=""
  restore_needed=0
  exec 9>/run/lock/aifeeds-perf-staging-nginx.lock
  flock -n 9
  on_exit() {
    rc=$?
    trap - EXIT
    if [ "$restore_needed" = 1 ] && [ -n "$CURRENT_TARGET" ] && [ "$rc" -ne 0 ]; then
      rollback_failed=0
      set +e
      ln -s "$CURRENT_TARGET" "$TXN_DIR/restore-link" || rollback_failed=1
      mv -Tf "$TXN_DIR/restore-link" "$LINK" || rollback_failed=1
      nginx -t >/dev/null 2>&1 || rollback_failed=1
      if [ "$rollback_failed" = 0 ]; then
        systemctl reload nginx >/dev/null 2>&1 || rollback_failed=1
      fi
      set -e
      if [ "$rollback_failed" -ne 0 ]; then
        echo 'ROLLBACK_FAILED: disabled site target could not be restored and reloaded' >&2
        exit 70
      fi
    fi
    if [ -n "$TXN_DIR" ]; then rm -rf "$TXN_DIR"; fi
    exit "$rc"
  }
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  TXN_DIR="$(mktemp -d /run/aifeeds-perf-rollback.XXXXXX)"
  chmod 700 "$TXN_DIR"
  if [ ! -e "$LINK" ] && [ ! -L "$LINK" ] \
    && [ ! -e "$FINAL_SITE" ] && [ ! -L "$FINAL_SITE" ] \
    && [ ! -e "$BOOTSTRAP_SITE" ] && [ ! -L "$BOOTSTRAP_SITE" ]; then
    rm -rf "$TXN_DIR"
    exit 0
  fi
  if [ -e "$BOOTSTRAP_SITE" ] || [ -L "$BOOTSTRAP_SITE" ]; then
    test -f "$BOOTSTRAP_SITE"
    test ! -L "$BOOTSTRAP_SITE"
    test "$(stat -c '%u' "$BOOTSTRAP_SITE")" = 0
    test "$(sha256sum "$BOOTSTRAP_SITE" | awk '{print $1}')" = "$EXPECTED_BOOTSTRAP_SHA256"
  fi
  if [ -e "$FINAL_SITE" ] || [ -L "$FINAL_SITE" ]; then
    test "$EXPECTED_FINAL_SHA256" != absent
    test -f "$FINAL_SITE"
    test ! -L "$FINAL_SITE"
    test "$(stat -c '%u' "$FINAL_SITE")" = 0
    test "$(sha256sum "$FINAL_SITE" | awk '{print $1}')" = "$EXPECTED_FINAL_SHA256"
  fi
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    test -L "$LINK"
    CURRENT_TARGET="$(readlink -f "$LINK")"
    test "$CURRENT_TARGET" = "$FINAL_SITE" -o "$CURRENT_TARGET" = "$BOOTSTRAP_SITE"
    if [ "$CURRENT_TARGET" = "$FINAL_SITE" ]; then test "$EXPECTED_FINAL_SHA256" != absent; fi
  fi
  if [ -n "$CURRENT_TARGET" ]; then
    restore_needed=1
    rm -f "$LINK"
  fi
  nginx -t
  systemctl reload nginx
  restore_needed=0
  rm -f "$FINAL_SITE" "$BOOTSTRAP_SITE"
  rm -rf "$TXN_DIR"
REMOTE
```

证书和 webroot 可暂留用于审计；删除证书、DNS 或 Pages 是各自独立动作，不和 nginx 回滚绑在一个
命令中。

### 9.3 GL-b：staging Worker → nginx request-id join

G1 和 G7b 都通过后、G8 测试账号写入前，先用匿名同源 API 做一次只读 join。GL-b 不复用生产 API：
生产 Worker 尚未发布本分支，不能作为 staging-first 的前置条件。响应头只写 0600 临时文件，远端
JSONL 只通过管道进入 `jq`，不落本地原始日志：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-gl-b.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_raw() { rm -rf "$RAW_DIR"; }
trap cleanup_raw EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

DIRECT_RID="diag-$(openssl rand -hex 8)"
printf '%s' "$DIRECT_RID" | grep -Eq '^diag-[a-f0-9]{16}$'
: > "$RAW_DIR/direct-headers"
set +e
DIRECT_STATUS="$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "X-Request-Id: $DIRECT_RID" \
  -D "$RAW_DIR/direct-headers" -o /dev/null -w '%{http_code}' \
  'https://staging-api.ai-feeds.com/api/items?source_type=x_list&limit=1')"
DIRECT_CURL_RC=$?
set -e
DIRECT_ECHO="$(tr -d '\r' < "$RAW_DIR/direct-headers" 2>/dev/null \
  | awk -F': ' 'tolower($1)=="x-request-id" {print $2; exit}')"
DIRECT_HEADER_PRESENT=false
DIRECT_ECHO_MATCHES=false
if printf '%s' "$DIRECT_ECHO" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$'; then
  DIRECT_HEADER_PRESENT=true
  if [ "$DIRECT_ECHO" = "$DIRECT_RID" ]; then DIRECT_ECHO_MATCHES=true; fi
fi

PROBE="upstream-$(date +%s)-$(openssl rand -hex 4)"
printf '%s' "$PROBE" | grep -Eq '^upstream-[0-9]{10,16}-[a-f0-9]{8}$'
: > "$RAW_DIR/perf-headers"
set +e
PERF_STATUS="$(curl -sS --connect-timeout 10 --max-time 30 \
  -H "X-Aifeeds-Perf-Probe: $PROBE" \
  -D "$RAW_DIR/perf-headers" -o /dev/null -w '%{http_code}' \
  'https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=1')"
PERF_CURL_RC=$?
set -e
PERF_RID="$(tr -d '\r' < "$RAW_DIR/perf-headers" 2>/dev/null \
  | awk -F': ' 'tolower($1)=="x-request-id" {print $2; exit}')"
PERF_HEADER_PRESENT=false
if printf '%s' "$PERF_RID" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$'; then
  PERF_HEADER_PRESENT=true
fi

printf '%s\n' \
  '{"probe_row_count":0,"nginx_request_id_present":false,"request_id_join":false,"nginx_status_ok":false,"timing_fields_valid":false}' \
  > "$RAW_DIR/log-summary.json"
LOG_FETCH_OK=false
LAST_LOG_FETCH_RC=1
LOG_FETCH_ATTEMPTS=0
attempt=1
while [ "$attempt" -le 12 ]; do
  LOG_FETCH_ATTEMPTS=$attempt
  set +e
  ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
    'timeout 15s tail -n 2000 /var/log/nginx/aifeeds-performance.jsonl' \
    | jq -s --arg probe "$PROBE" --arg rid "$PERF_RID" '
      [ .[] | select(.host == "perf-staging.ai-feeds.com" and .perf_probe == $probe) ] as $rows |
      def timing_shape:
        type == "string" and test("^[0-9]+([.][0-9]+)?((, ?| ?: ?)[0-9]+([.][0-9]+)?)*$");
      {probe_row_count:($rows | length),
       nginx_request_id_present:(($rows | length) == 1 and
         ($rows[0].request_id | type) == "string" and
         ($rows[0].request_id | test("^[A-Za-z0-9._:-]{8,128}$"))),
       request_id_join:(($rows | length) == 1 and $rid != "" and $rows[0].request_id == $rid),
       nginx_status_ok:(($rows | length) == 1 and $rows[0].status == "200"),
       timing_fields_valid:(($rows | length) == 1 and all($rows[];
         (.request_time | timing_shape) and
         (.upstream_connect_time | timing_shape) and
         (.upstream_header_time | timing_shape) and
         (.upstream_response_time | timing_shape)))}
    ' > "$RAW_DIR/log-summary-attempt.json"
  LOG_FETCH_RC=$?
  set -e
  LAST_LOG_FETCH_RC=$LOG_FETCH_RC
  if [ "$LOG_FETCH_RC" = 0 ] \
    && jq -e 'type == "object" and has("probe_row_count")' "$RAW_DIR/log-summary-attempt.json" >/dev/null; then
    mv -f "$RAW_DIR/log-summary-attempt.json" "$RAW_DIR/log-summary.json"
    LOG_FETCH_OK=true
    if jq -e '.probe_row_count == 1' "$RAW_DIR/log-summary.json" >/dev/null; then break; fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
rm -f "$RAW_DIR/log-summary-attempt.json"
jq -nc \
  --arg direct_status "$DIRECT_STATUS" --arg perf_status "$PERF_STATUS" \
  --argjson direct_curl_rc "$DIRECT_CURL_RC" --argjson perf_curl_rc "$PERF_CURL_RC" \
  --argjson direct_header_present "$DIRECT_HEADER_PRESENT" \
  --argjson direct_echo_matches "$DIRECT_ECHO_MATCHES" \
  --argjson perf_header_present "$PERF_HEADER_PRESENT" \
  --argjson nginx_log_fetch_ok "$LOG_FETCH_OK" \
  --argjson last_log_fetch_rc "$LAST_LOG_FETCH_RC" \
  --argjson log_fetch_attempts "$LOG_FETCH_ATTEMPTS" \
  --slurpfile log "$RAW_DIR/log-summary.json" '
    {schema:1,gate:"GL-b",direct_status:$direct_status,perf_status:$perf_status,
     direct_transport_ok:($direct_curl_rc == 0),perf_transport_ok:($perf_curl_rc == 0),
     direct_worker_header_present:$direct_header_present,direct_worker_echo_matches:$direct_echo_matches,
     perf_worker_header_present:$perf_header_present,nginx_log_fetch_ok:$nginx_log_fetch_ok,
     last_log_fetch_rc:$last_log_fetch_rc,log_fetch_attempts:$log_fetch_attempts} + $log[0]' \
  > "$RAW_DIR/summary.json"
install -m 0600 "$RAW_DIR/summary.json" "$EVIDENCE/gl-b-request-id-join.json"
jq -e '.direct_transport_ok == true and .direct_status == "200" and
  .direct_worker_header_present == true and .direct_worker_echo_matches == true and
  .perf_transport_ok == true and .perf_status == "200" and .perf_worker_header_present == true and
  .nginx_log_fetch_ok == true and .probe_row_count == 1 and
  .nginx_request_id_present == true and .request_id_join == true and
  .nginx_status_ok == true and .timing_fields_valid == true' \
  "$EVIDENCE/gl-b-request-id-join.json" >/dev/null
cleanup_raw
trap - EXIT HUP INT TERM
```

GL-b 失败就停止 G8，并按三类证据归因：

- **无 Worker header**：直接探测 `staging-api.ai-feeds.com`。只有 `direct_transport_ok=true`、状态精确
  200 且仍没有 `X-Request-Id` 时才定位为 G1/Worker；网络/DNS/边缘错误先归对应链路。直连有头、
  perf-staging 精确 200 但没头时定位为 G7b 的响应头转发。
- **无 nginx row**：只有 `nginx_log_fetch_ok=true` 且响应有合法 header，但唯一 `perf_probe` 没有对应
  JSONL 行时，才先核对 GL-a 的
  host map、日志文件/缓冲、timer 与当前 nginx 配置，再核对 G7 host 路由。
- **request-id 不一致**：用上面两次等价的匿名只读探测判断。直连探测显式传入受限诊断 ID 并要求
  Worker 原样回显；perf-staging 探测则比较 Worker 响应头与同一 `perf_probe` 的 nginx-generated ID，
  从而区分 G1 回显实现和 G7 request-id 注入/转发。

禁止盲目回滚 G1、G7 或 GL-a；先归因，只能调用被证据定位 gate 在其原审批中已授权的精确 rollback，
没有预授权就另行审批。GL-b 自身是只读 gate，不授权任何写回滚。不得修改生产 Worker、伪造响应头或把
缺失 join 标成 N/A。成功和失败都会保留一份不含 request-id 原值的 0600 结构化 summary。

## 10. G8：功能、性能与退出条件

在 `perf-staging.ai-feeds.com` 跑 rollout template 的五设备矩阵。至少验证匿名 home/feed/search、
existing cookie、邮件登录/logout、SMS disabled 响应、subscription/feedback、share、全部 SPA
深链、`/daily`/`/i`/sitemap/静态资源、视频和音频 Range。测试数据只用专用账号，完成后按测试账号
owner 审核过的清单逐项清理；不得以 SQL 猜测方式批量删除。

### 10.1 专用账号 seed（不发真实邮件）

G8 另行获批后，用全新随机 email/device，先机器证明所有可关联表为零。只在 D1 写一条 5 分钟
验证码 hash，经 perf 域走真实 login；不调用 `/api/auth/email/send`，避免 Resend、供应商日志和
无法回减的日/月 KV cap。验证码、session body 和 Cookie 不进入 evidence；Cookie jar 独立 0600
保存在 `/private/tmp`：

```bash
set -eu
set -o pipefail
set +x
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT/worker"
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'

TEST_SUFFIX="$(openssl rand -hex 10)"
TEST_EMAIL="perf-$TEST_SUFFIX@example.com"
TEST_DID="perf-$(openssl rand -hex 12)"
printf '%s' "$TEST_EMAIL" | grep -Eq '^perf-[a-f0-9]{20}@example\.com$'
printf '%s' "$TEST_DID" | grep -Eq '^perf-[a-f0-9]{24}$'

PRECHECK_SQL="SELECT
  (SELECT COUNT(*) FROM identities WHERE identity_value='$TEST_EMAIL') +
  (SELECT COUNT(*) FROM subscriptions WHERE email='$TEST_EMAIL') +
  (SELECT COUNT(*) FROM email_send_log WHERE email='$TEST_EMAIL' OR device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM sessions WHERE device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM events WHERE device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM share_relations WHERE to_did='$TEST_DID') +
  (SELECT COUNT(*) FROM dub_wishlist WHERE device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM sms_send_log WHERE device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM email_landings WHERE email='$TEST_EMAIL') AS n"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$PRECHECK_SQL" > "$EVIDENCE/test-account-precheck.json"
jq -e '.[0].success == true and .[0].results[0].n == 0' \
  "$EVIDENCE/test-account-precheck.json" >/dev/null

TEST_CODE="$(node -e "const {randomInt}=require('node:crypto');process.stdout.write(String(randomInt(1000000)).padStart(6,'0'))")"
TEST_CODE_HASH="$(printf '%s' "xlist-email-v1|$TEST_CODE" | shasum -a 256 | awk '{print $1}')"
NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
EXPIRES_MS=$((NOW_MS + 300000))
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="INSERT INTO email_send_log
    (email,ip,device_id,ua,sent_at,result,code_hash,code_expires_at,code_attempts)
    VALUES('$TEST_EMAIL','127.0.0.1','$TEST_DID','perf-staging',$NOW_MS,
      'success','$TEST_CODE_HASH',$EXPIRES_MS,0)" >/dev/null

COOKIE_JAR="/private/tmp/aifeeds-perf-staging-$TEST_SUFFIX.cookies"
LOGIN_PAYLOAD="/private/tmp/aifeeds-perf-staging-$TEST_SUFFIX.login.json"
LOGIN_RESPONSE="/private/tmp/aifeeds-perf-staging-$TEST_SUFFIX.login-response.json"
touch "$COOKIE_JAR"
chmod 0600 "$COOKIE_JAR"
cleanup_login_failure() {
  rm -f "$COOKIE_JAR" "$LOGIN_PAYLOAD" "$LOGIN_RESPONSE"
  npx wrangler d1 execute xlist-staging --env staging --remote --command="
    DELETE FROM sessions WHERE device_id='$TEST_DID'
      OR user_id IN (SELECT user_id FROM identities
        WHERE provider='email' AND identity_value='$TEST_EMAIL');
    DELETE FROM events WHERE device_id='$TEST_DID';
    DELETE FROM users WHERE id IN (SELECT user_id FROM identities
      WHERE provider='email' AND identity_value='$TEST_EMAIL');
    DELETE FROM identities WHERE provider='email' AND identity_value='$TEST_EMAIL';
    DELETE FROM email_send_log WHERE email='$TEST_EMAIL' OR device_id='$TEST_DID';
  " >/dev/null 2>&1 || printf '%s\n' 'manual seed cleanup required' >&2
}
trap cleanup_login_failure EXIT
jq -nc --arg identifier "$TEST_EMAIL" --arg code "$TEST_CODE" \
  '{identifier:$identifier,code:$code}' > "$LOGIN_PAYLOAD"
curl -fsS -A "$BROWSER_UA" -X POST 'https://perf-staging.ai-feeds.com/api/auth/login' \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -H "X-Device-Id: $TEST_DID" \
  -c "$COOKIE_JAR" --data @"$LOGIN_PAYLOAD" > "$LOGIN_RESPONSE"
jq -e '.user.id and .session.expires_at' "$LOGIN_RESPONSE" >/dev/null
grep -q 'xlist_sid_stg' "$COOKIE_JAR"
TEST_UID="$(jq -er '.user.id' "$LOGIN_RESPONSE")"
printf '%s' "$TEST_UID" | grep -Eq '^[A-Za-z0-9_-]{14}$'
jq -nc --arg email "$TEST_EMAIL" --arg did "$TEST_DID" \
  --arg uid "$TEST_UID" --arg cookie_jar "$COOKIE_JAR" \
  '{email:$email,device_id:$did,user_id:$uid,cookie_jar:$cookie_jar}' \
  > "$EVIDENCE/test-account-ownership.json"
rm -f "$LOGIN_PAYLOAD" "$LOGIN_RESPONSE"
trap - EXIT
unset TEST_CODE TEST_CODE_HASH
```

不得用 `/api/auth/delete` 清测试账号：它只匿名化，不删除关联数据。Subscription 不走匿名
`/api/subscribe`，而按 ownership 精确 seed 后测登录态 GET/PUT/unsubscribe，避免 welcome 邮件与
VPS-IP rate-limit KV。Share 只用该账号新 token 和 blog/podcast item，poster 加 `?nocache=1`；
禁止访问别人的 token。Feedback 先测文本；若测图片，只用本次专用反馈并记录精确 R2 key。

### 10.1a 有状态 API smoke

以下仍属于 G8 测试账号写审批。Subscription 用定向 seed，随后真实走 GET/PUT/unsubscribe；feedback
用一条文本和一张仓库内小 PNG；share 只选 blog/podcast item，避免刷新共享 GH/X/PH/HF 数据。
响应只保存合成账号的非 session 结果：

```bash
set -eu
set -o pipefail
set +x
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
TEST_EMAIL="$(jq -er '.email' "$EVIDENCE/test-account-ownership.json")"
TEST_DID="$(jq -er '.device_id' "$EVIDENCE/test-account-ownership.json")"
TEST_UID="$(jq -er '.user_id' "$EVIDENCE/test-account-ownership.json")"
COOKIE_JAR="$(jq -er '.cookie_jar' "$EVIDENCE/test-account-ownership.json")"
test -s "$COOKIE_JAR"
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
cd "$REPO_ROOT/worker"

NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
NEXT_SEND_MS=$((NOW_MS + 86400000))
UNSUB_TOKEN="$(openssl rand -hex 32)"
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="INSERT INTO subscriptions
    (user_id,email,channel,sources,send_slot,density,status,next_send_at,
     bounce_count,worker_send_failures,unsubscribe_token,created_at,updated_at)
    VALUES('$TEST_UID','$TEST_EMAIL','email','[\"news\"]',12,'normal','active',
      $NEXT_SEND_MS,0,0,'$UNSUB_TOKEN',$NOW_MS,$NOW_MS)" >/dev/null
unset UNSUB_TOKEN

curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/me' \
  | jq -e '.user.id != null' >/dev/null
curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/me/subscription' \
  > "$EVIDENCE/test-subscription-get.json"
jq -e '.subscription.status == "active" and .subscription.sources == ["news"] and
  .subscription.send_slot == 12 and .subscription.density == "normal"' \
  "$EVIDENCE/test-subscription-get.json" >/dev/null
curl -fsS -A "$BROWSER_UA" -X PUT -b "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -H 'Content-Type: application/json' \
  --data '{"sources":["news","x"],"send_slot":17,"density":"curated"}' \
  'https://perf-staging.ai-feeds.com/api/auth/me/subscription' \
  | jq -e '.ok == true' >/dev/null
curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/me/subscription' \
  > "$EVIDENCE/test-subscription-updated.json"
jq -e '.subscription.status == "active" and .subscription.sources == ["news","x"] and
  .subscription.send_slot == 17 and .subscription.density == "curated"' \
  "$EVIDENCE/test-subscription-updated.json" >/dev/null
curl -fsS -A "$BROWSER_UA" -X POST -b "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/me/subscription/unsubscribe' \
  | jq -e '.ok == true' >/dev/null
curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/me/subscription' \
  | jq -e '.subscription.status == "unsubscribed"' >/dev/null

curl -fsS -A "$BROWSER_UA" -X POST -b "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -F 'content=perf-staging text feedback' \
  'https://perf-staging.ai-feeds.com/api/feedback' \
  > "$EVIDENCE/test-feedback-text.json"
jq -e '.ok == true and .id != null' "$EVIDENCE/test-feedback-text.json" >/dev/null
curl -fsS -A "$BROWSER_UA" -X POST -b "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -F 'content=perf-staging image feedback' \
  -F "image=@$REPO_ROOT/dashboard/public/avatars-sm/avatar-01.png;type=image/png" \
  'https://perf-staging.ai-feeds.com/api/feedback' \
  > "$EVIDENCE/test-feedback-image.json"
jq -e '.ok == true and .id != null' "$EVIDENCE/test-feedback-image.json" >/dev/null
curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/feedback/mine' \
  | jq -e '.ok == true and (.items | length) >= 2' >/dev/null

ITEM_ID="$(curl -fsS -A "$BROWSER_UA" \
  'https://perf-staging.ai-feeds.com/api/items?source_type=blog,podcast&limit=1' \
  | jq -er '.items[0].id')"
case "$ITEM_ID" in ''|*[!A-Za-z0-9_:/.-]*) exit 1 ;; esac
SHARE_PAYLOAD="$(mktemp /private/tmp/aifeeds-perf-staging-share-payload.XXXXXX)"
SHARE_RESPONSE="$(mktemp /private/tmp/aifeeds-perf-staging-share-response.XXXXXX)"
SHARE_HEADERS="$(mktemp /private/tmp/aifeeds-perf-staging-share-headers.XXXXXX)"
cleanup_share_private() { rm -f "$SHARE_PAYLOAD" "$SHARE_RESPONSE" "$SHARE_HEADERS"; }
trap cleanup_share_private EXIT
chmod 0600 "$SHARE_PAYLOAD" "$SHARE_RESPONSE" "$SHARE_HEADERS"
jq -nc --arg item_id "$ITEM_ID" '{item_id:$item_id}' > "$SHARE_PAYLOAD"
curl -fsS -A "$BROWSER_UA" -X POST -b "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -H 'Content-Type: application/json' --data @"$SHARE_PAYLOAD" \
  'https://perf-staging.ai-feeds.com/api/share/create' > "$SHARE_RESPONSE"
SHARE_TOKEN="$(jq -er '.token' "$SHARE_RESPONSE")"
printf '%s' "$SHARE_TOKEN" | grep -Eq '^[A-Za-z0-9_-]{8}$'
SHARE_URL="$(jq -er '.share_url' "$SHARE_RESPONSE")"
POSTER_URL="$(jq -er '.poster_url' "$SHARE_RESPONSE")"
test "$SHARE_URL" = "https://staging-api.ai-feeds.com/s/$SHARE_TOKEN"
test "$POSTER_URL" = "https://staging-api.ai-feeds.com/api/share/poster/$SHARE_TOKEN"
curl -fsS -A "$BROWSER_UA" -b "$COOKIE_JAR" \
  -D "$SHARE_HEADERS" -o "$SHARE_RESPONSE" \
  "https://perf-staging.ai-feeds.com/api/share/poster/$SHARE_TOKEN?nocache=1"
tr '[:upper:]' '[:lower:]' < "$SHARE_HEADERS" | grep -q '^content-type: image/png'
test "$(wc -c < "$SHARE_RESPONSE" | tr -d ' ')" -gt 1000
REDIRECT_HTTP="$(curl -sS -A "$BROWSER_UA" -H "X-Device-Id: $TEST_DID" \
  -D "$SHARE_HEADERS" -o /dev/null -w '%{http_code}' "$SHARE_URL")"
test "$REDIRECT_HTTP" = 302
REDIRECT_LOCATION="$(tr -d '\r' < "$SHARE_HEADERS" | sed -nE 's/^[Ll]ocation: (.*)$/\1/p' | tail -n 1)"
printf '%s' "$REDIRECT_LOCATION" | grep -Eq '^https://staging\.ai-feeds\.com/(t|g|ph|c|e|h|o)/'
printf '%s' "$REDIRECT_LOCATION" | grep -Fq "token=$SHARE_TOKEN"
jq -nc --arg token "$SHARE_TOKEN" '{token:$token}' > "$SHARE_PAYLOAD"
curl -fsS -A "$BROWSER_UA" -X POST \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  -H 'Content-Type: application/json' \
  -H "X-Device-Id: $TEST_DID" \
  --data @"$SHARE_PAYLOAD" \
  'https://perf-staging.ai-feeds.com/api/share/landing' \
  | jq -e '.ok == true' >/dev/null
cleanup_share_private
trap - EXIT

SMS_HTTP="$(curl -sS -A "$BROWSER_UA" -X POST -H 'Content-Type: application/json' --data '{}' \
  'https://perf-staging.ai-feeds.com/api/auth/sms/send' \
  -o "$EVIDENCE/test-sms-disabled.json" -w '%{http_code}')"
test "$SMS_HTTP" = 403
jq -e '.reason == "sms_disabled"' "$EVIDENCE/test-sms-disabled.json" >/dev/null
```

### 10.1b 真实五设备 browser matrix

本 gate 不复用会 mock `/api/**` 的本地 `home-performance.spec.ts`，而运行无 mock 的
`perf-staging-remote.spec.ts`。它固定唯一远端 host，覆盖 desktop/tablet/iPhone Chromium、iPhone
WebKit、Android Chromium；验证同源 API、HTTP/2 连接复用、OPTIONS=0、request-id/Server-Timing、
PC/移动布局、真实触摸横滑、search/SEO/SPA/error，以及同一专用 session 在五项目中的 `/auth/me`。
remote 模式强制关闭 trace/HAR/storageState/screenshot，避免 Cookie 或真实内容进入 evidence；只附加 allowlist timing 和
request-id。它只在页面原生 fetch 发往 perf origin `/api/**` 时注入格式受限的
`X-Aifeeds-Perf-Probe`（APIRequest fixture 显式加同一 header）；导航、R2、字体和第三方媒体不携带该
header。页面从 `/?codex_perf_probe=1` 启动，使 telemetry 与 nginx API 日志进入 synthetic cohort。
匿名性能用全新 context 的 cold 首航，先证明 `aifeeds-shell-*` CacheStorage 内已有 `/`，再 reload；
warm 必须同时满足 Navigation Timing `workerStart>0`、controller 存在且 navigation transferSize=0。
首屏 list 必须精确命中响应式 source 集合：desktop=`x_list + blog,podcast + product_hunt`、
tablet=`x_list + blog,podcast`、mobile=`x_list`，不能把 1/2/3 只当上限；任何 LCP 前启动的下方行请求
都失败。媒体竞争以 Playwright request start（包含采集时仍在下载的请求）计数；可见卡图必须全部
decode，可见 video poster 的真实请求也必须完成；400/800 请求不得失败或悬空。卡图 `/r/` 固定来自
`staging-api.ai-feeds.com`，不可误按页面 `perf-staging.ai-feeds.com` origin 统计。所有 expected source
还必须各自收到 2xx 并呈现对应 Feed，不能用失败响应的 Resource Timing 冒充成功。
移动 swipe 后 blog/podcast 的 96/72px 封面必须关联 w400 请求，且 w800=0；DPR 2/3 不应成为浪费
带宽的理由。

PageSpeed 质量回归同样属于 G8 硬门禁：viewport 必须允许缩放；DOM 中不得存在空 href 或可见无名
button；视频元素不得使用 `/img`，图片 `/img` target 不得是视频；Product Hunt imgix avatar 必须带
16–96px 的有界宽高且 desktop 必须观察到实际样本；cold/warm 期间任何 `/img` 403 都失败。官方
`@axe-core/playwright` 固定版本在五设备逐一执行 `color-contrast` 与 `nested-interactive`，evidence 只保留
rule id/node count，不记录节点文本或 HTML。staging Worker `/media` 还必须用版本化的公开视频样本发
`Range: bytes=0-1023`，断言 206、`Content-Length: 1024`、`Content-Range`、`Accept-Ranges: bytes`、
`Content-Type: video/mp4` 与 `Cache-Control: no-store`；生产 Worker/nginx 上线后重复同一 smoke。
匿名 `/api/auth/me` 必须返回
`200 {"user":null}`、带 `Cache-Control: private, no-store` 且不得为 CF cache HIT；这不会改变需登录接口
的 401 契约。

Chromium 先等 expected Feed、图片和 video poster 稳定，再用非输入的 `aifeeds:lcp-settled` 事件冻结并
drain LCP observer，不发送会截断 LCP 或触发字体的真实键盘输入。随后用非受信任 synthetic pointerdown
启动既有 deferred font gate，等待三个 stylesheet、`document.fonts.ready`、可见媒体与布局稳定，最后才用
`aifeeds:cls-settled` drain/freeze CLS；因此字体切换产生的位移不会漏记。Chromium 的 CLS 必须 ≤0.1；
WebKit 若不支持 LCP/layout-shift，
竞争预算显式改用 feed-ready cutoff，CLS 记录 `unsupported`，绝不伪造 0。`feed_ready` 读取应用 commit+RAF 同点的
`aifeeds:feed-ready` mark。Cookie 值只从 0600 Netscape jar 在 Node 进程内解析，命令行只传文件路径
和非 secret UID/DID。

单次 lab 不冒充 RUM P75，但仍设灾难性回归硬顶：cold feed-ready ≤5s / LCP ≤7s，warm
feed-ready ≤3s / LCP ≤5s；浏览器不支持 LCP 时显式记 unsupported，并仍用 feed-ready cutoff 执行
请求/媒体预算。这是生产目标约 2× 的 smoke
ceiling，不替代 rollout template 的 cold LCP P75 ≤3.5s、warm ≤2.5s 与 48 小时样本门槛：

```bash
set -eu
set -o pipefail
set +x
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
TEST_UID="$(jq -er '.user_id' "$EVIDENCE/test-account-ownership.json")"
TEST_DID="$(jq -er '.device_id' "$EVIDENCE/test-account-ownership.json")"
COOKIE_JAR="$(jq -er '.cookie_jar' "$EVIDENCE/test-account-ownership.json")"
printf '%s' "$TEST_UID" | grep -Eq '^[A-Za-z0-9_-]{14}$'
printf '%s' "$TEST_DID" | grep -Eq '^perf-[a-f0-9]{24}$'
case "$COOKIE_JAR" in /private/tmp/aifeeds-perf-staging-*.cookies) ;; *) exit 1 ;; esac
test -f "$COOKIE_JAR"
test "$(stat -f '%Lp' "$COOKIE_JAR")" = 600
E2E_PERF_PROBE="upstream-$(date +%s)-$(openssl rand -hex 4)"
printf '%s' "$E2E_PERF_PROBE" | grep -Eq '^upstream-[0-9]{10,16}-[a-f0-9]{8}$'
printf '%s\n' "$E2E_PERF_PROBE" > "$EVIDENCE/playwright-perf-probe.txt"

cd "$REPO_ROOT/dashboard"
set +e
PLAYWRIGHT_NO_COPY_PROMPT=1 \
  E2E_COOKIE_JAR="$COOKIE_JAR" E2E_EXPECTED_UID="$TEST_UID" E2E_EXPECTED_DID="$TEST_DID" \
  E2E_PERF_PROBE="$E2E_PERF_PROBE" \
  E2E_OUTPUT_DIR="$EVIDENCE/playwright" \
  npm run test:e2e:perf-staging \
  > "$EVIDENCE/playwright-perf-staging.stdout" \
  2> "$EVIDENCE/playwright-perf-staging.stderr"
PLAYWRIGHT_STATUS=$?
set -e
test -z "$(find "$EVIDENCE/playwright" \
  \( -name trace.zip -o -name '*.har' -o -iname '*storage*state*' \
     -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.webp' -o -iname '*.webm' \
     -o -iname '*.html' -o -iname '*.md' \) \
  -print -quit)"
test "$PLAYWRIGHT_STATUS" = 0
```

五设备 matrix 使用同一专用 identity 和一次性 context，但不打印 Cookie/storage state。命令返回时所有
browser/context 已关闭；之后再进入 10.2，由清理 gate 验证 logout 或已被浏览器撤销的 session。

### 10.1c GL-b 的五设备扩展：nginx → Worker request-id / perf-probe join

Playwright 成功后，使用同一个受限 probe 发一个无 Cookie 的同源 API GET，再只读 VPS 性能日志。
远端原始 JSONL 不落本地磁盘、不写入 evidence；`jq` 只输出行数、join boolean 和该条请求的四段
timing。至少五条 browser API 记录命中 probe，专用 GET 的 Worker 回显 request id 必须与 nginx
`request_id` 相同，且所有 timing 字段都满足受限数值/`-` 形状：

```bash
set -eu
set -o pipefail
set +x
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
E2E_PERF_PROBE="$(cat "$EVIDENCE/playwright-perf-probe.txt")"
printf '%s' "$E2E_PERF_PROBE" | grep -Eq '^upstream-[0-9]{10,16}-[a-f0-9]{8}$'
RAW_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/aifeeds-perf-join.XXXXXX")"
chmod 700 "$RAW_DIR"
cleanup_raw() { rm -rf "$RAW_DIR"; }
trap cleanup_raw EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
JOIN_DIR="$EVIDENCE/playwright/join"
test -d "$JOIN_DIR"
test ! -L "$JOIN_DIR"
test "$(stat -f '%Lp' "$JOIN_DIR")" = 700
test "$(stat -f '%u' "$JOIN_DIR")" = "$(id -u)"
for project in desktop-chromium tablet-chromium iphone-chromium iphone-webkit android-chromium; do
  file="$JOIN_DIR/$project.json"
  test -f "$file"
  test ! -L "$file"
  test "$(stat -f '%Lp' "$file")" = 600
  test "$(stat -f '%u' "$file")" = "$(id -u)"
done
jq -s -e '
  length == 5 and
  ([.[].project] | unique | length) == 5 and
  all(.[];
    .schema == 1 and
    (.project | test("^(desktop-chromium|tablet-chromium|iphone-chromium|iphone-webkit|android-chromium)$")) and
    (.request_id | test("^[A-Za-z0-9._:-]{8,128}$")))
' "$JOIN_DIR"/*.json > "$RAW_DIR/browser-request-ids.json"
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
curl -fsS --connect-timeout 10 --max-time 30 -A "$BROWSER_UA" \
  -H "X-Aifeeds-Perf-Probe: $E2E_PERF_PROBE" \
  -D "$RAW_DIR/join.headers" -o /dev/null \
  'https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=1'
JOIN_REQUEST_ID="$(tr -d '\r' < "$RAW_DIR/join.headers" \
  | awk -F': ' 'tolower($1)=="x-request-id" {print $2; exit}')"
printf '%s' "$JOIN_REQUEST_ID" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$'

attempt=1
while [ "$attempt" -le 12 ]; do
  if ssh "${SSH_OPTS[@]}" -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 \
    'timeout 15s tail -n 20000 /var/log/nginx/aifeeds-performance.jsonl' \
    | jq -s --slurpfile browser "$RAW_DIR/browser-request-ids.json" \
      --arg probe "$E2E_PERF_PROBE" --arg rid "$JOIN_REQUEST_ID" '
      [ .[] | select(.host == "perf-staging.ai-feeds.com" and .perf_probe == $probe) ] as $rows |
      ($browser[0]) as $browser_rows |
      ([ $rows[] | select(.request_id == $rid) ] | first // null) as $joined |
      def timing_shape:
        type == "string" and test("^(-|[0-9]+([.][0-9]+)?)(, ?(-|[0-9]+([.][0-9]+)?))*$");
      {
        matching_rows: ($rows | length),
        browser_project_count: ($browser_rows | length),
        browser_request_ids_joined: all($browser_rows[];
          . as $browser_row | any($rows[]; .request_id == $browser_row.request_id)),
        request_id_join: ($joined != null),
        timing_fields_valid: all($rows[];
          (.request_time | timing_shape) and
          (.upstream_connect_time | timing_shape) and
          (.upstream_header_time | timing_shape) and
          (.upstream_response_time | timing_shape)),
        joined_timing: (if $joined == null then null else {
          request: $joined.request_time,
          connect: $joined.upstream_connect_time,
          header: $joined.upstream_header_time,
          response: $joined.upstream_response_time
        } end)
      }
    ' > "$RAW_DIR/join-summary.json" \
    && jq -e '.matching_rows >= 6 and .browser_project_count == 5 and
      .browser_request_ids_joined == true and .request_id_join == true and
      .timing_fields_valid == true and .joined_timing != null' \
      "$RAW_DIR/join-summary.json" >/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
jq -e '.matching_rows >= 6 and .browser_project_count == 5 and
  .browser_request_ids_joined == true and .request_id_join == true and
  .timing_fields_valid == true and .joined_timing != null' \
  "$RAW_DIR/join-summary.json" >/dev/null
install -m 0600 "$RAW_DIR/join-summary.json" "$EVIDENCE/nginx-worker-join-summary.json"
cleanup_raw
trap - EXIT HUP INT TERM
```

### 10.2 定向清理

停止浏览器/context 并等待本轮 `waitUntil` 收敛后，先验证 email 仍唯一属于记录的 UID，再保存本轮
feedback/reply 图片 key。按 FK 安全顺序幂等清 D1；绝不全表 DELETE：

```bash
set -eu
set -o pipefail
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/load-aifeeds-perf-evidence.sh"
export AIFEEDS_STAGING_ENV=/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env
test -r "$AIFEEDS_STAGING_ENV"
set -a
. "$AIFEEDS_STAGING_ENV"
set +a
cd "$REPO_ROOT/worker"

TEST_EMAIL="$(jq -er '.email' "$EVIDENCE/test-account-ownership.json")"
TEST_DID="$(jq -er '.device_id' "$EVIDENCE/test-account-ownership.json")"
TEST_UID="$(jq -er '.user_id' "$EVIDENCE/test-account-ownership.json")"
COOKIE_JAR="$(jq -er '.cookie_jar' "$EVIDENCE/test-account-ownership.json")"
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
printf '%s' "$TEST_EMAIL" | grep -Eq '^perf-[a-f0-9]{20}@example\.com$'
printf '%s' "$TEST_DID" | grep -Eq '^perf-[a-f0-9]{24}$'
printf '%s' "$TEST_UID" | grep -Eq '^[A-Za-z0-9_-]{14}$'
case "$COOKIE_JAR" in /private/tmp/aifeeds-perf-staging-*.cookies) ;; *) exit 1 ;; esac

LOGOUT_HTTP="$(curl -sS -A "$BROWSER_UA" -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -H 'Origin: https://perf-staging.ai-feeds.com' \
  'https://perf-staging.ai-feeds.com/api/auth/logout' \
  -o "$EVIDENCE/test-account-logout.json" -w '%{http_code}')"
case "$LOGOUT_HTTP" in
  200) jq -e '.ok == true' "$EVIDENCE/test-account-logout.json" >/dev/null ;;
  401) jq -e '.error == "not authenticated"' "$EVIDENCE/test-account-logout.json" >/dev/null ;;
  *) exit 1 ;;
esac

npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="SELECT user_id FROM identities
    WHERE provider='email' AND identity_value='$TEST_EMAIL' AND unbound_at IS NULL" \
  > "$EVIDENCE/test-account-owner-before-cleanup.json"
jq -e --arg uid "$TEST_UID" '.[0].success == true and
  (.[0].results | length == 1) and .[0].results[0].user_id == $uid' \
  "$EVIDENCE/test-account-owner-before-cleanup.json" >/dev/null
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="SELECT COUNT(*) AS n FROM share_relations
    WHERE (to_uid='$TEST_UID' OR to_did='$TEST_DID') AND from_uid<>'$TEST_UID'" \
  > "$EVIDENCE/test-account-foreign-share-count.json"
jq -e '.[0].results[0].n == 0' "$EVIDENCE/test-account-foreign-share-count.json" >/dev/null

npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="SELECT DISTINCT image_key FROM feedback WHERE user_id='$TEST_UID' AND image_key IS NOT NULL
    UNION SELECT DISTINCT r.image_key FROM feedback_replies r
      JOIN feedback f ON f.id=r.feedback_id
      WHERE f.user_id='$TEST_UID' AND r.image_key IS NOT NULL" \
  > "$EVIDENCE/test-account-feedback-image-keys.json"

CLEANUP_SQL="
DELETE FROM feedback_replies
 WHERE feedback_id IN (SELECT id FROM feedback WHERE user_id='$TEST_UID');
DELETE FROM feedback WHERE user_id='$TEST_UID';
DELETE FROM email_landings
 WHERE user_id='$TEST_UID' OR email='$TEST_EMAIL'
    OR subscription_id IN (SELECT id FROM subscriptions WHERE email='$TEST_EMAIL');
DELETE FROM digest_send_log
 WHERE subscription_id IN (SELECT id FROM subscriptions WHERE email='$TEST_EMAIL');
DELETE FROM subscriptions WHERE email='$TEST_EMAIL';
DELETE FROM share_relations WHERE from_uid='$TEST_UID';
DELETE FROM dub_wishlist WHERE user_id='$TEST_UID' OR device_id='$TEST_DID';
DELETE FROM events WHERE user_id='$TEST_UID' OR device_id='$TEST_DID';
DELETE FROM sms_send_log WHERE device_id='$TEST_DID';
DELETE FROM email_send_log WHERE email='$TEST_EMAIL' OR device_id='$TEST_DID';
DELETE FROM sessions WHERE user_id='$TEST_UID' OR device_id='$TEST_DID';
DELETE FROM identities WHERE user_id='$TEST_UID';
DELETE FROM users WHERE id='$TEST_UID';
"
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="$CLEANUP_SQL" > "$EVIDENCE/test-account-cleanup.txt"

FINAL_SQL="SELECT
  (SELECT COUNT(*) FROM users WHERE id='$TEST_UID') +
  (SELECT COUNT(*) FROM identities WHERE user_id='$TEST_UID') +
  (SELECT COUNT(*) FROM sessions WHERE user_id='$TEST_UID' OR device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM subscriptions WHERE email='$TEST_EMAIL') +
  (SELECT COUNT(*) FROM feedback WHERE user_id='$TEST_UID') +
  (SELECT COUNT(*) FROM share_relations WHERE from_uid='$TEST_UID' OR to_uid='$TEST_UID' OR to_did='$TEST_DID') +
  (SELECT COUNT(*) FROM events WHERE user_id='$TEST_UID' OR device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM dub_wishlist WHERE user_id='$TEST_UID' OR device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM email_send_log WHERE email='$TEST_EMAIL' OR device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM sms_send_log WHERE device_id='$TEST_DID') +
  (SELECT COUNT(*) FROM email_landings WHERE user_id='$TEST_UID' OR email='$TEST_EMAIL') AS n"
npx wrangler d1 execute xlist-staging --env staging --remote --json \
  --command="$FINAL_SQL" > "$EVIDENCE/test-account-final-count.json"
jq -e '.[0].success == true and .[0].results[0].n == 0' \
  "$EVIDENCE/test-account-final-count.json" >/dev/null

jq -r '.[0].results[]?.image_key // empty' "$EVIDENCE/test-account-feedback-image-keys.json" \
| while IFS= read -r key; do
    printf '%s' "$key" | grep -Eq '^feedback/[a-f0-9]{64}\.(jpg|png|webp|gif)$'
    REF_SQL="SELECT
      (SELECT COUNT(*) FROM feedback WHERE image_key='$key') +
      (SELECT COUNT(*) FROM feedback_replies WHERE image_key='$key') AS n"
    npx wrangler d1 execute xlist-staging --env staging --remote --json \
      --command="$REF_SQL" > "$EVIDENCE/test-account-r2-ref.json"
    jq -e '.[0].results[0].n == 0' "$EVIDENCE/test-account-r2-ref.json" >/dev/null
    npx wrangler r2 object delete "xlist-readme-assets-staging/$key" --remote --force
  done
rm -f "$COOKIE_JAR"
```

访问日志、Web Analytics 与真实第三方邮件/供应商日志不可自动清除；本流程通过不发真实邮件、不走
匿名 subscribe、不触碰他人 token 来避免后者。搜索/impression/item-refresh KV 只能等 TTL，不得
伪称已清零。

SMS 禁用态只用空 JSON 请求 `/api/auth/sms/send`，断言 `403` 与 `reason=sms_disabled`。新 guard 在
解析、Turnstile、DB、额度与 provider 前短路，因此不得填真实/假手机号，也不得为验收打开 flag。

`favorite` 明确记为 N/A：当前仓库没有 `/api/favorites` route、favorites table 或收藏 UI，不能把
不存在的功能写成验收通过，也不能为了本性能计划临时扩展产品范围。

网络证据必须证明：HTML 与 API 复用同一 origin 的 HTTP/2/TLS；没有
`staging-api.ai-feeds.com` CORS OPTIONS；响应保留 `Set-Cookie`、`Server-Timing`、
`X-Request-Id`；以受控 `perf_probe` 在 Task 3 JSONL 中完成 nginx/Worker join，并记录
connect/header/response/request 分段；错误响应不缓存。keepalive A/B/A 不执行，因为其能力门禁为
BLOCKED。microcache 继续关闭。

origin gate、真实访客 IP 与 per-IP 限流在 perf-staging 标记 N/A，不得伪造通过；原因和生产重验
要求见第 1 节。为避免所有请求在 staging 被聚合为 VPS IP，本轮不得做并发 OTP/登录压测。

perf-staging 通过只允许进入一次独立的 production 变更评审，不自动部署生产。生产每个 phase 仍需
≥48 小时、每个主要 cohort ≥100 LCP 样本；地域实验还需要可信 14 天地域基线和预登记 7 天样本门。
