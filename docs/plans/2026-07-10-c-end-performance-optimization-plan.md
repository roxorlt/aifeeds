# C 端性能优化实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 将 AI Feeds C 端从“冷壳与首屏内容双重秒级等待”改为可观测、首流不被元数据
阻塞、按 viewport 渐进加载且首屏复用单一连接的性能架构，同时保持 PC/移动端、登录、分享、
深链和详情完整性。

**Architecture:** 先补齐客户端、Worker、nginx 三段计时和流量质量口径；随后解除 metadata gate，
引入全局请求/媒体预算并建立 list 专用 DTO；再通过主域同源 API 消除第二次 TLS。SQL、图片和地域
路由只在新分段数据证明仍是主要段时实施，所有阶段独立灰度和回滚。

**Tech Stack:** React 19、TypeScript、Vite、Cloudflare Worker/D1/R2、nginx、Web Vitals、
Vitest、Node test、Playwright（Chromium/WebKit）/Chrome DevTools。

**Evidence:** `docs/reviews/2026-07-10-c-end-performance-deep-dive.md`

---

## 实施规则

- 不把本计划一次性合成一个发布。顺序为 P0 观测 → P1 关键路径 → P2 同源/查询/图片 →
  P3 地域实验；每阶段至少观察 48 小时。该观察窗口属于生产灰度后的效果验收，不阻塞
  本地代码交付、分支提交或 staging 前的准备工作。
- 每个行为改动先有失败测试；每个生产 nginx/D1 动作先 staging、备份、验证、再单独获准上线。
- 任何阶段若错误率增加 >0.5 个百分点、LCP P75 恶化 >10%、登录/分享/深链回归，立即回滚
  当前阶段，不在坏版本上叠加下一项。
- RUM 同时看 `all-clean` 与 `engaged`，不得删除无互动的真实慢用户来“优化数字”；synthetic
  只通过显式标记排除。
- 移动端线上样本不足。功能正确性先用真机/受控浏览器验证，性能收益等定向 RUM 样本足够后再下结论。

## Phase P0：建立可归因观测

### Task 1: 增加安全化 LCP、API 与首流就绪埋点

**Files:**

- Create: `dashboard/src/lib/telemetry/performance-detail.ts`
- Create: `dashboard/src/lib/telemetry/performance-detail.test.mjs`
- Modify: `dashboard/src/lib/telemetry/vitals.ts`
- Modify: `dashboard/src/lib/telemetry/event-types.ts`
- Modify: `dashboard/src/lib/telemetry/types.ts`
- Modify: `worker/src/track.ts`
- Modify: `worker/src/admin-dashboard.ts`
- Test: `worker/src/performance-analytics.test.ts`

**Step 1: Write failing pure-function tests**

测试只允许上报资源类别，不允许完整内容 URL、query 或卡片文本：

```js
assert.deepEqual(classifyResourceUrl('https://api.ai-feeds.com/r/x/a.jpg'), {
  kind: 'r2', origin_class: 'api',
});
assert.deepEqual(classifyResourceUrl('https://cdn-thumbnails.huggingface.co/a.png'), {
  kind: 'third_party_hf', origin_class: 'third_party',
});
assert.equal(safeElementDescriptor({ tagName: 'IMG', className: 'secret title' }).tag, 'img');
assert.equal('url' in safeElementDescriptor(/* ... */), false);
```

Run:

```bash
cd dashboard
node --test src/lib/telemetry/performance-detail.test.mjs
```

Expected: FAIL because the module/functions do not exist.

**Step 2: Implement the pure classifiers**

Return only:

```ts
type ResourceKind =
  | 'r2' | 'img_proxy' | 'static_asset' | 'third_party_hf'
  | 'third_party_hdx' | 'other_third_party' | 'none';

type SafeLcpDetail = {
  tag: 'img' | 'video' | 'text' | 'other';
  resource_kind: ResourceKind;
  source_type?: string;       // from closest [data-feed-source]
  media_priority?: 'high' | 'eager' | 'lazy';
};
```

Never include `textContent`, `src`, `href`, item id, author, title, URL path or query.

**Step 3: Wire Web Vitals and Resource Timing**

- Enrich `perf_lcp` from the final `LargestContentfulPaint` entry.
- Observe `fetch` resources whose pathname is one of `/api/items`, `/api/feed-manifest`,
  `/api/sources`, `/api/stats`, `/api/auth/me`.
- Emit `perf_api` with endpoint category, DNS/connect/TLS/request/response/total, transfer KB,
  initiator, same-origin flag and device meta.
- Emit `feed_ready` after the first non-empty active/visible Feed commits and one animation frame paints;
  include source type, item count, cache/prefetch/network source and `query_time_ms`.
- Dispatch a local `aifeeds:lcp-settled` event when LCP finalizes so background work can defer to it.

Do not sample `feed_ready`; keep `perf_img` sampling, but observe `/r/`, `/img?` and classified third-party
card images rather than `/img?` only.

**Step 4: Update event contracts on both sides**

Add `PERF_API` and `FEED_READY` to dashboard constants/types and Worker whitelist. Add a contract test that
parses both files and asserts the two sets cannot drift.

**Step 5: Correct admin cohorts**

Change the performance panel to expose:

- `all-clean`: owner and explicit synthetic excluded;
- `engaged`: `all-clean` plus at least one explicit click/open/filter/search/share/login interaction;
- `synthetic`: explicitly marked probes only.

Do not use “session span >5 seconds” alone to label a user engaged. At ingest, append coarse
`edge_country` and `edge_colo` from `request.cf` to performance events; do not store finer location.

**Step 6: Run tests and builds**

```bash
cd dashboard
node --test src/lib/telemetry/performance-detail.test.mjs
npm run build

cd ../worker
npm test -- --run src/performance-analytics.test.ts
npm test
```

Expected: all PASS; no payload contains raw URL/text.

**Step 7: Commit**

```bash
git add dashboard/src/lib/telemetry worker/src/track.ts worker/src/admin-dashboard.ts worker/src/performance-analytics.test.ts
git commit -m "perf: add attributable frontend timing"
```

### Task 2: 为 Worker 列表响应增加 Server-Timing

**Files:**

- Create: `worker/src/server-timing.ts`
- Create: `worker/src/server-timing.test.ts`
- Modify: `worker/src/index.ts:390-397`
- Modify: `worker/src/index.ts:2686-3459`

> **Implementation note（2026-07-11，修订最初的四段计时设计）：** Cloudflare
> 生产运行时为缓解 Spectre，`performance.now()` 与 `Date.now()` 只在 I/O 发生后推进；纯
> parse/map、`JSON.stringify` 和 `Response` 构造前后的时钟会冻结。即使把 start/end 紧贴
> `.all()`，start 仍可能继承上一次 I/O 的时间，因而混入查询前的 CPU，不能作为纯 D1
> 计时。实现不再使用 Worker JS clock，而是读取每个 D1 result 自带的
> `meta.timings.sql_duration_ms`（精确 SQL 执行时间，不含网络），仅在该字段缺失或非法时
> fallback 到 `meta.duration`，两者都不可用时安全归零。主列表 result 写 `d1`，generic X
> feed 的 thread sibling result 写可选 `thread_d1`；同一个归一值同时写入
> `query_time_ms` 与 `Server-Timing`，因此前者继续严格等于主 `d1`。
>
> 不发布 `map` / `json` / `total`，也不插入 `scheduler.wait()` 人为推进时钟，避免把 D1
> 等待错标成 CPU 阶段或为观测本身增加延迟。当前 `wrangler.toml` 只启用了
> `[observability]` 与 `[observability.logs] invocation_logs = true`，未启用
> `[observability.traces]`；因此 Worker CPU 与 invocation wall time 读取现有 Workers Logs
> invocation log（Query Builder 字段 `$workers.cpuTimeMs` / `$workers.wallTimeMs`）。若以后配置
> Tail Worker 或 Logpush，同一口径对应 Workers Trace Events 顶层的 `CPUTimeMs` /
> `WallTimeMs`。只有未来经成本评估并显式启用 tracing 后，才可改用 root span 的
> `cloudflare.cpu_time_ms` / `cloudflare.wall_time_ms`，本任务不启用 tracing。完整请求路径继续
> 由 nginx `upstream_response_time` 与浏览器 `perf_api.total` 归因；map/json CPU 只在本地
> Workers DevTools 中剖析。依据：
> [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)、
> [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/)、
> [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、
> [CPU time and Wall time for Workers invocations](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/)、
> [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)、
> [Spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)。

**Step 1: Write failing formatter tests**

```ts
expect(formatServerTiming({ d1: 223, thread_d1: 17, map: 4, json: 2, total: 231 }))
  .toBe('d1;dur=223, thread_d1;dur=17');
expect(formatServerTiming({ d1: -1, thread_d1: Number.NaN })).toBe('');
expect(d1DurationMs({
  meta: { timings: { sql_duration_ms: 7.12345 }, duration: 99 },
})).toBe(7.123);
```

Run: `cd worker && npm test -- --run src/server-timing.test.ts`

Expected: FAIL because module does not exist.

**Step 2: Extend `jsonResponse` without changing default callers**

Add an optional options argument:

```ts
type JsonResponseOptions = {
  headers?: HeadersInit;
  timings?: Record<string, number>;
};
```

`jsonResponse` serializes normally and only publishes the supplied allowlisted D1 metrics; it must not use the
Worker JS clock to derive `map`、`json` or `total`. Merge CORS safely, validate and echo an incoming
`X-Request-Id` (ASCII `[A-Za-z0-9_-]`, max 64 chars) or generate a safe id for missing/invalid values, and return
`Server-Timing`. nginx will inject the same id upstream so its access log and Worker response can be joined.
Public GET responses also set `Timing-Allow-Origin` to the allowed site origin; never expose the origin secret.

**Step 3: Instrument every list handler**

After each list query, read the SQL execution duration from its own D1 result metadata:

- `d1`: primary result `meta.timings.sql_duration_ms`, fallback `meta.duration`;
- `thread_d1`: optional generic X thread-sibling result, using the same precedence;
- missing, non-finite or negative metadata: normalize safely to `0`;
- do not publish `map`、`json` or `total` from Worker timers.

Keep `query_time_ms` for backward compatibility and set it from the exact same normalized value as `d1`.
The D1 value intentionally excludes network time. Use the currently enabled Workers invocation logs
(`$workers.cpuTimeMs` / `$workers.wallTimeMs`) for CPU / invocation wall time, then nginx and browser timing
for upstream / end-to-end totals. Root-span fields are unavailable unless tracing is separately enabled.

**Step 4: Test response headers**

Add mocked-handler tests proving:

- formatter only emits finite/non-negative `d1` / `thread_d1` and rejects injected names;
- D1 metadata prefers `sql_duration_ms`, falls back to `duration`, and safely handles invalid/missing metadata;
- all five `/api/items` list handlers use their own primary D1 result; generic thread completion uses a distinct
  `thread_d1` without changing `query_time_ms`;
- production responses never emit `map`、`json` or `total`;
- CORS and TAO remain valid;
- `query_time_ms` equals the normalized `d1` value;
- `/api/items/:id` does not accidentally receive list-only stripping.

**Step 5: Verify**

```bash
cd worker
npm test -- --run src/server-timing.test.ts
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
git diff --check
```

Expected: PASS and dry-run succeeds.

**Step 6: Commit**

```bash
git add docs/plans/2026-07-10-c-end-performance-optimization-plan.md \
  worker/src/server-timing.ts worker/src/server-timing.test.ts worker/src/index.ts
git commit -m "fix: report only measurable worker timing"
```

### Task 3: 版本化 nginx 分段日志配置

**Files:**

- Create: `deploy/nginx/aifeeds-performance-log.conf`
- Create: `deploy/nginx/aifeeds-performance.logrotate`
- Create: `deploy/nginx/check-nginx-request-id.py`
- Create: `deploy/nginx/insert-nginx-request-id.py`
- Create: `deploy/nginx/verify-nginx-request-id-diff.py`
- Create: `deploy/nginx/install-aifeeds-performance-log.sh`
- Create: `deploy/nginx/rollback-aifeeds-performance-log.sh`
- Create: `deploy/nginx/install-aifeeds-performance-log.integration.test.sh`
- Create: `deploy/nginx/test-fixtures/gl-a-installer/*`
- Create: `deploy/systemd/aifeeds-performance-logrotate.service`
- Create: `deploy/systemd/aifeeds-performance-logrotate.timer`
- Modify: `docs/operations.md`
- Modify: `docs/reviews/c-end-perf-staging-change-packet.md`

**Step 1: Inspect live block names without printing secrets**

```bash
ssh -i ~/.ssh/aifeeds-hk.pem root@154.12.188.231 "grep -R -nE 'server_name|access_log|proxy_pass|proxy_http_version' /etc/nginx/sites-enabled /etc/nginx/conf.d"
```

Expected: identify the actual front/API blocks and confirm there is no staging block on this VPS. Never send raw
`nginx -T` output into an agent/tool log: the live config contains `X-Origin-Secret`. If a human must inspect the
full config during deployment, do it in the private SSH terminal and redact secrets before saving any excerpt.

**Step 2: Add the versioned log format**

The snippet must log JSON-safe values for:

```nginx
$request_id $host $uri $status $request_time
$upstream_connect_time $upstream_header_time $upstream_response_time
$upstream_cache_status $bytes_sent $aifeeds_client_class
```

Use a route-bucket map sourced from `$uri`, never raw `$uri` or `$request_uri`: dynamic ids/assets/tokens and all
unknown paths must collapse to fixed categories. Map raw `$http_user_agent` to a fixed coarse client class and do
not persist the original string. Do not log Cookie, Authorization, `X-Origin-Secret`, phone or email. In proxied locations set
`proxy_set_header X-Request-Id $request_id`; Worker must validate/echo it per Task 2. Document log rotation and
the exact rollback file.

**Step 3: Validate as a split logging-only VPS change**

The current staging domains do not traverse this VPS, so do not claim they validate this config. After explicit
approval, GL-a backs up the live config and installs only the new log format, upstream request-id propagation and
dedicated rotation timer. A 2026-07-12 read-only check proved that neither production nor staging Worker currently
echoes `X-Request-Id`/`Server-Timing`; therefore GL-a must not require or claim Worker join. It instead requires an
exact unique `perf_probe`, JSON/timing schema validation, semantic proof that the site changed by only seven
request-id lines, and a real forced rotation whose new inode continues receiving records.

The VPS has no active cron or global logrotate timer, so a versioned dedicated five-minute systemd timer is part of
GL-a. The log uses a 64 KiB/5 second buffer, daily rotation, `maxsize 50M`, mode `0640 www-data:adm`, and 14 files.
Do not enable the global timer as an incidental side effect.

Before the first remote write, persist a unique operation id, the frozen G0 commit, and an immutable 0600 copy of
the exact rollback helper in the evidence directory. The installer must accept that operation id rather than create
one remotely and must bind `operation_id`, `g0_commit`, and `rollback_helper_sha256` into both journal and summary.
Recovery may fetch only the exact journal derived from that known id; normal summary wins over a recovery record
unless recovery mode is explicit, and rollback uploads only the hash-matching evidence copy.
The installer must fsync an `initializing` intent before creating its site candidate/backup, a `prepared` record before
creating the backup, and `mutation_started` before any runtime candidate or final write. Site and runtime candidates
must be operation-bound, created beside their final paths, verified, and atomically renamed on the same filesystem.
Journal every installed artifact hash and candidate path, re-check the enabled-site target around every site
move/reload, and stop without cleanup on unknown site, symlink, or artifact drift. Early recovery may tolerate a
missing backup only while the live site still equals the recorded base; terminal `rolled_back` evidence is immutable.

After G1 deploys the staging Worker and G7b creates the perf-staging TLS/same-origin route, GL-b performs the
read-only response-id join on `perf-staging.ai-feeds.com`; only then may G8 continue. Do not deploy the production
Worker early or add an nginx response header to fake this proof.

GL-a still requires:

- a **C journal update CAS active** contract with consumer activation active and harness name/count freeze frozen. Source and
  rollback journals each have operation-bound F, `${F}.tmp`, and `${F}.previous-update-gl-a-<operation-id>`; source F
  is `/var/backups/aifeeds-performance-log/transaction-<operation-id>.json` and rollback F is
  `/var/backups/aifeeds-performance-log/rollback-transaction-<operation-id>.json`. Every version embeds
  `journal_update={schema:1,revision:N,self_dev:D,self_ino:I,predecessor:null|{revision:N-1,sha256,dev,ino}}`;
  only fresh initializing/prepared genesis may use revision 0/null predecessor. T is created with
  `O_EXCL|O_NOFOLLOW`; its self identity comes from the same write fd, and full write plus fsync(fd)+fsync(parent)
  precedes recoverability. Source legacy genesis trusts the CLI-supplied external hash and is accepted only when that
  hash and the complete business schema match; rollback legacy genesis has no externally trusted hash and is rejected
  fail closed. A legacy orphan tmp cannot authenticate itself. S0 is F-only, S1 F+T, S2 P+T, and S3 P+F.
  S4=F(new)+C(cleanup tombstone), P absent. Recovery exact-validates physical C against F.predecessor, then uses
  held-dirfd unlink after a final pathname/held-FD identity check, fsyncs the parent, and returns to S0. S1–S4 trust
  only successor-embedded self/predecessor plus a legal semantic transition, use NOREPLACE and fsync the parent.
  Symlinks, revision jumps or regression, semantic inverse, same-hash different-inode, conflicting F/T/P/C, and invalid/partial T are preserved and
  fail closed—never removed, truncated, rerendered, or adopted by pathname. Automatic recovery settles source before
  reading phase or mutating live state; manual settles source, then rollback, before terminal-pair preparation.
  Journal `.previous-update-*` and marker `.previous-terminal-*` are distinct protocols. A read-only consumer accepts
  only S0 and reports any T/P/cleanup residue as `recovery_required`. Terminal prepared, one-side, and two-side
  publication windows retain both journal predecessors; normal cleanup resumes only after the committed marker is durable;
- an immutable 14-slot runtime cleanup plan shared by automatic and manual rollback. Its canonical items,
  `plan_sha256`, cursor, and `cursor_state` live in the rollback journal. Each item durably records `detaching` before
  an exact NOREPLACE tombstone rename and `detached` before unlink; `runtime_removed` is legal only after all 14 slots
  reach `complete` and physical runtime residue is zero. Re-entry resumes the recorded cursor. Plan drift, unknown
  tombstones, and `rollback_failed.failed_from` drift preserve evidence and fail closed. Legacy `runtime_removed`
  records without the cleanup object are compatibility inputs: both automatic and manual paths still execute the
  current 14-slot plan and prove zero residue instead of treating the legacy phase as cleanup authority. The rebuilt
  plan records `compatibility_mode=legacy_runtime_removed`, preserves any `rollback_failed` wrapper while its cursor
  advances, and installer retry detects the exact current-operation journal namespace before live absence checks.
  The log slot remains an exact `archive_handoff` until daemon reload succeeds; a reload failure keeps that inode and
  records no premature archive-manifest evidence;
- a frozen integration matrix of 135 scenarios (95 old + 40 new). The 40 C scenario names are:
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
    `cleanup-manual-legacy-runtime-removed`, `cleanup-automatic-legacy-runtime-removed`;
- an operation-bound 0600 forward installation transcript plus a no-clobber, operation+attempt bound
  manual rollback attempt transcript for every invocation. Both capture remote stdout/stderr into a private tmp, capture
  `PIPESTATUS` immediately, publish a 0600 final, and only then enforce the SSH/tee statuses;
- forward transcript, forward summary, manual transcript, and manual summary all use same-parent NOREPLACE publication,
  followed by an fsync of the parent directory. A publish collision preserves both the owned tmp and unknown destination.
  Every tmp comes from an O_EXCL `mktemp` allocation; only its immediately recorded dev/ino authorizes failure cleanup,
  never the current pathname, matching bytes, or matching hash;
- log rollback via same-directory NOREPLACE quarantine, followed by writable FD quiescence. Production waits up
  to 60s; timeout preserves the quarantine and operation-bound archive manifest, fails closed, and resumes only
  with the same operation id. The manifest is terminal only after inventory completion, exact destination SHA/size
  validation, an exact bidirectional audit-file/destination set match, and absence of every
  source/quarantine/candidate. Schema 2 generations permit only append, seal, one-entry quiesce, copy, or archive
  successors. Its exact top-level keys are
  `{schema,operation_id,generation,previous_manifest_sha256,previous_manifest_dev,previous_manifest_ino,inventory_complete,empty_inventory,entries}`.
  Generation 0 has a null predecessor triple; every later successor persists the predecessor raw SHA/dev/ino captured
  from one stable file descriptor. A cross-filesystem entry advances
  `journaled → quiescent → copied → archived`; same-filesystem skips copied. Before final publication, crossfs
  journals `candidate_dev`/`candidate_ino`; after publication it records `destination_dev`/`destination_ino`, which
  must equal the candidate inode. A samefs destination equals the source inode. Terminal generation is
  `3 * N + 1 + count(entries has candidate_dev)` (`4 * N + 1` when all entries are crossfs). A samebytes different
  inode/unknown identity fails closed. Unjournaled candidates, candidate/destination conflicts or joint absence, and
  any candidate/cleanup/unknown audit residue are never adopted. Every terminal destination physical dev/ino equals
  its recorded destination. Final/tmp/operation-bound previous publish through a three-path NOREPLACE recovery.
  P+T and P+F trust only the successor-embedded predecessor triple and then prove physical P exact. P-only,
  invalid/unrelated T/F, or same-hash different-inode state is preserved and fails closed. Both terminal journals and
  the summary bind the final manifest SHA, generation,
  and entry count. A read-only held-fingerprint dispatcher treats F=final, T=tmp, P=previous, and C=the
  operation-bound private cleanup directory. It accepts only `∅`, `T(genesis)`, `F`, `F+T`, `P+T`, `P+F`,
  `F+C(payload)`, and `F+C(empty)`. F/T/P and C payload captures use `O_NOFOLLOW`, root:root/0600, `nlink=1`, and
  exact `{dev,ino,mtime_ns,sha256,size}` fingerprints, rejecting duplicate keys and non-finite JSON. Successor,
  reachability, and immutable log-handoff checks use those fingerprints and recapture every initially present path
  unchanged before publish/cleanup; a journaled live log may only grow on the same inode, while later states are
  content-frozen. C is removed only through held parent/dirfd exact unlink/rmdir. A zero-write sentinel is set before
  the first archive capture and cleared only after all final recaptures; while set, the failure trap exits before
  summary removal, `rollback_failed`, or namespace cleanup, so repeated preflight failure cannot change F/T/P/C;
- a runtime artifact manifest that is not a standalone artifact: it is the source transaction journal fields
  `runtime_artifacts` and `runtime_artifacts_sealed`; no independent runtime manifest path/SHA/generation/count exists.
  All 8 candidates persist dev, ino, sha256, and metadata, and the complete inventory is sealed before any final
  publication. Exact-identity operation-bound tombstones clean up the 7 immutable finals and all 8 candidates; the
  live log is handed to the archive manifest instead. `rotation_state_identity` binds the exclusive operation-bound
  directory candidate plus a stable ledger anchor with path/dev/ino/mode/`genesis_record_sha256`; `rotation_state_snapshot`
  verifies generation, `tail_record_sha256`, ledger SHA/size, and the current status identity. The timer's only writer
  is a root-only `rotation-wrapper`; it serializes exclusively on the authority-bound ledger inode FD flock and appends
  a verifiable tail to that same ledger. The legacy `/run/aifeeds-performance-log-rotation.lock` argument is
  compatibility-only and ignored: it is not an authority domain and not a serialization domain. The install-time
  status inode/hash is not permanent identity, and manual recovery never recaptures or adopts
  the current status path. The dynamically rendered systemd service `ExecStart` fixes the operation id, then anchor,
  checker, config, and logrotate authority groups in that order; the config triple is immediately followed by the
  logrotate triple, and every group binds exact path/dev/ino/SHA. The external authority is exactly
  `/var/backups/aifeeds-performance-log/rotation-anchor-<operation-id>.json`, never selected by a directory scan.
  Source/rollback journals and forward/manual summaries mirror the exact 9-key
  `rotation_anchor_identity={state,path,sha256,size,uid,gid,mode,dev,ino}` state machine
  `allocated → prepared → sealed`. `allocated` binds the O_EXCL empty-file SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, size=0, and inode. `prepared` persists
  the expected final target SHA/size while the physical inode may still be empty. Only after filling and fsyncing that
  same inode may `sealed` require the physical path/dev/ino/SHA/size to be exact. The canonical authority payload uses
  schema 2 and exactly `{schema,operation_id,directory,provenance,checker,config,logrotate}` at top level:
  directory/provenance bind the state
  directory and ledger genesis. Their exact nested keys are directory=`{path,uid,gid,mode,dev,ino}`,
  provenance=`{path,uid,gid,mode,dev,ino,genesis_record_sha256}`, and
  checker/config=`{path,sha256,size,uid,gid,mode,dev,ino}`. The logrotate entry has exact nested keys
  `{path,sha256,size,uid,gid,mode,dev,ino}`, fixes `/usr/sbin/logrotate`, and requires root:root mode 0755.
  Automatic and manual callers use a sealed-anchor extractor: it opens the exact anchor once with `O_NOFOLLOW`,
  validates its canonical bytes and full identity, and extracts logrotate authority only from held-FD bytes; the
  checker opens every authorized resource as a held-FD and performs a final pathname/held-FD identity exact check
  before mutation. Checker/config candidate
  identities are journaled first; only after ledger initialization and anchor sealing is the service candidate rendered
  last. A committed terminal must be sealed. A rolled_back terminal may be null only when the anchor was never allocated;
  otherwise it retains the last identity evidence (`allocated`, `prepared`, or `sealed`) without falsely promoting the
  state, while the pathname is absent/deleted. Manual recovery must stop the
  timer/service and prove quiescence before invoking `rotation-recover` with the fixed authority; bare logrotate and
  current-path adoption are forbidden.
  `site_backup_identity` is persisted before copy and binds the `O_EXCL`
  inode. The pre-mutation base SITE identity binds the original site dev/inode; the committed installed SITE identity
  binds the installer candidate dev/inode; the rolled_back base SITE identity binds the journaled rollback candidate dev/inode
  after a backup-copy restore publication, otherwise the original site dev/inode. A copy need not preserve the
  original inode. Every phase accepts only its recorded identity
  and must never derive identity from the current path; same bytes or hash alone never authorize adoption. Manual recovery must never derive or
  adopt unknown identity. Terminal physical finals/candidates and rotation
  cleanup must have zero residue. Pair-free source-only `rolled_back` is a narrow exception: only effective
  `initializing`/`prepared` may transition, both pair fields stay absent, and the exact delta is phase, origin, plus
  archive SHA/generation/count for an operation-bound generation-1 empty terminal manifest. A recorded non-absent
  installer candidate may be physically absent only when two identical held captures prove exact schema 2,
  root:root/0600, `nlink=1`, generation 1, complete/empty inventory and zero entries, with candidate/tmp/previous
  absent before and after; this is the `prelive empty manifest` contract;
- an operation-bound terminal pair marker that advances `prepared → committed`. Prepared embeds exact
  `source_before_authority` and `rollback_before_authority` objects with
  `{raw_base64,sha256,dev,ino}`, in addition to before/target hashes. Source raw matches the CLI-trusted SHA;
  rollback raw is canonical at effective `logs_archived`; both targets are reconstructed as the sole legal CAS
  successors and remain named `source_target_sha256` and `rollback_target_sha256`. Both predecessors remain through prepared/one-side/two-side publication and are cleaned only after
  committed is durable. Committed binds `prepared_marker_sha256` and both terminal SHAs; validation reconstructs
  prepared from committed bytes, recomputes its SHA, and proves terminal SHA equals target SHA. The committed marker
  physical chain also reconciles both physical journals and the summary. Prepared is not
  business authority, and recovery accepts only exact before/target states;
- a canonical recovery bundle that validates the captured journal record and SHA inside a private directory and,
  for rolled_back, copies and locally reconciles the exact remote archive manifest path/SHA/generation/count.
  Publish uses same-parent Darwin `renamex_np(RENAME_EXCL)` or Linux `renameat2(RENAME_NOREPLACE)`; failure keeps
  the private tmp and unknown destination. After rename, `fsync` the destination parent directory before declaring
  durable publication; automatic terminal reconciliation is never inferred from transcript substring alone;

```bash
nginx -t
systemctl reload nginx
curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null https://ai-feeds.com/
curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null \
  'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1'
```

Expected: nginx config valid; GL-a unique/rotation probes pass; GL-b later proves the staging Worker response id
joins the same nginx row.

Before any upload, run all versioned helper tests and parse the transactional shell:

```bash
python3 deploy/nginx/check-nginx-request-id.test.py
python3 deploy/nginx/insert-nginx-request-id.test.py
python3 deploy/nginx/verify-nginx-request-id-diff.test.py
bash -n deploy/nginx/install-aifeeds-performance-log.sh
bash -n deploy/nginx/rollback-aifeeds-performance-log.sh
bash deploy/nginx/install-aifeeds-performance-log.integration.test.sh
```

**Step 4: Commit the versioned config and runbook**

```bash
git add deploy/nginx deploy/systemd docs/operations.md docs/reviews/c-end-perf-staging-change-packet.md
git commit -m "ops: add nginx upstream timing logs"
```

## Phase P1：解除阻塞并收紧首屏预算

> **原子发布约束：Task 4–6 只能作为同一个 P1 灰度发布。** Task 4/5 的代码先在默认关闭的
> `OPTIMISTIC_FEED_START = false` 源码开关后完成；Task 6 已限制 immediate columns、去重和后台预取后，才在
> 同一发布中开启该 flag 并停掉旧 sources/stats gate。不得单独上线 Task 4，否则 PC 会从“等
> metadata”退化成“7 个 optimistic Feed 立即齐发”。

### Task 4: 移除 metadata gate，让首频道乐观启动

**Files:**

- Create: `dashboard/src/lib/feedAvailability.ts`
- Create: `dashboard/src/lib/feedAvailability.test.mjs`
- Modify: `dashboard/src/App.tsx:151-187,258-261,725-760,960-989`
- Modify: `dashboard/src/components/Feed.tsx:321-382`

**Step 1: Write failing availability tests**

Cover:

```js
assert.equal(isInitiallyLive('x_list', { enabled: true }), true);
assert.equal(isInitiallyLive('blog,podcast', { enabled: true }), true);
assert.equal(isInitiallyLive('youtube', { enabled: true }), false);
assert.equal(isInitiallyLive('x_list', { enabled: false }), false);
assert.equal(resolveChannelLive('github', { enabled: true, metadataState: 'pending', live: new Set() }), true);
assert.equal(resolveChannelLive('youtube', { enabled: true, metadataState: 'resolved', live: new Set(['youtube']) }), true);
```

Run: `cd dashboard && node --test src/lib/feedAvailability.test.mjs`

Expected: FAIL.

**Step 2: Implement optimistic defaults**

Define one compile-time `DEFAULT_LIVE_CHANNELS` for the seven known production channels behind an exported
`OPTIMISTIC_FEED_START` constant in `feedAvailability.ts` (default `false` until Task 6). While metadata is
pending or failed, these channels are live; when metadata succeeds, reconcile additions/removals, but never
turn a currently rendered non-empty Feed back into a placeholder during the same session.

**Step 3: Decouple metadata from Feed initial load**

- The active mobile X Feed and PC immediate columns must mount on the first React commit.
- HTML `__feedPrefetch` must be consumable immediately.
- sources/stats failure must not leave an infinite skeleton.
- X title may begin as “动态” and update later; this cosmetic update cannot gate data.

**Step 4: Add source-contract test**

Assert `App.tsx` no longer derives all initial placeholders solely from empty `sources/stats`, and
`Feed.tsx` receives `placeholder=false` for optimistic live channels.

**Step 5: Verify PC and mobile manually before build**

Temporarily enable the source constant only in the local working tree/test fixture (restore it to `false` before
the Task 4 commit). With `/api/sources` and `/api/stats` blocked in DevTools:

- 390 px: X cards appear;
- 1440 px: immediate columns appear;
- YouTube remains a placeholder;
- no unhandled rejection.

Then run:

```bash
cd dashboard
node --test src/lib/feedAvailability.test.mjs src/App.motion.test.mjs
npm run build
```

**Step 6: Commit**

```bash
git add dashboard/src/lib/feedAvailability.ts dashboard/src/lib/feedAvailability.test.mjs dashboard/src/App.tsx dashboard/src/components/Feed.tsx
git commit -m "perf: remove feed metadata gate"
```

### Task 5: 用轻量 feed manifest 替代 C 端 sources + stats

**Files:**

- Create: `worker/src/feed-manifest.ts`
- Create: `worker/src/feed-manifest.test.ts`
- Modify: `worker/src/index.ts:492-530,3834-3885`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/App.tsx:258-261,725-776`

**Step 1: Write failing Worker tests**

Expected response contract:

```json
{
  "live_source_types": ["x_list", "blog", "podcast"],
  "labels": { "x_list": "动态" },
  "generated_at": "2026-07-10T00:00:00.000Z"
}
```

Assert it contains no source cursor/config/topic and is `<2 KiB` for fixtures. Use `DB.batch` or one grouped
query, not per-source correlated COUNT. Set `Cache-Control: public, max-age=60, s-maxage=300`.

Run: `cd worker && npm test -- --run src/feed-manifest.test.ts`

Expected: FAIL.

**Step 2: Implement `GET /api/feed-manifest`**

Return distinct live source types plus only user-visible labels. Keep `/api/sources` and `/api/stats` intact
for admin/compatibility; the C home page simply stops calling them.

**Step 3: Add dashboard client and background reconciliation**

Call manifest after first Feed request has started. It can reconcile placeholders and the X display name but
must not participate in `feed_ready` critical path. Until the atomic P1 release flips
`OPTIMISTIC_FEED_START`, retain the old sources/stats path as the disabled-mode fallback; do not strand the
home page between Task 5 and Task 6.

**Step 4: Verify request count**

In the integrated P1 test configuration with optimistic start enabled, the C home page should issue one small
manifest instead of sources+stats. No list request waits for it. With the source constant still false between
commits, the old metadata path remains the safe fallback.

```bash
cd worker && npm test -- --run src/feed-manifest.test.ts && npm test
cd ../dashboard && npm run build
```

**Step 5: Commit**

```bash
git add worker/src/feed-manifest.ts worker/src/feed-manifest.test.ts worker/src/index.ts dashboard/src/api.ts dashboard/src/types.ts dashboard/src/App.tsx
git commit -m "perf: add lightweight feed manifest"
```

### Task 6: 建立全局请求调度与 in-flight 去重

**Files:**

- Create: `dashboard/src/lib/feedScheduling.ts`
- Create: `dashboard/src/lib/feedScheduling.test.mjs`
- Modify: `dashboard/src/api.ts:219-258`
- Modify: `dashboard/src/App.tsx:733-755,952-990`
- Modify: `dashboard/src/components/Feed.tsx:45-127,321-410`
- Modify: `dashboard/index.html:19-40`

**Step 1: Write failing scheduler tests**

Assert:

- immediate columns = 1 below 768 px, 2 at 768–1023, 3 at ≥1024;
- duplicate identical list query returns the same Promise;
- in-flight entry is removed on both resolve and reject;
- saveData/slow-2g/2g/3g disables background prefetch;
- background queue concurrency is exactly 1;
- prefetch never starts before `aifeeds:lcp-settled`, explicit interaction, or load+8 seconds fallback.

Run: `cd dashboard && node --test src/lib/feedScheduling.test.mjs`

Expected: FAIL.

**Step 2: Add list in-flight deduplication**

Key the Map by the exact normalized `/api/items?...` path. Both Feed and `prefetchChannels` must call the same
function. Do not globally dedupe mutations, detail refresh or auth.

**Step 3: Reduce initial page size**

Set `INITIAL_LIMIT=12`, keep load-more at 30, and change the HTML prefetch path to the same limit so it is
actually consumed. Preserve cursor and thread completeness semantics.

**Step 4: Defer below-fold PC columns**

Create a `DeferredFeed` wrapper using `IntersectionObserver` with `rootMargin: '200px 0px'`:

- first grid row mounts immediately;
- lower rows render fixed-height skeleton shells without list/image requests;
- approaching viewport mounts once and never unmounts;
- no IntersectionObserver support falls back to mount for correctness.

Mobile continues to mount only the active channel.

**Step 5: Replace 2.5-second shotgun prefetch**

Start only after LCP/interaction/fallback, run one channel at a time, stop when document is hidden, and skip
slow/saveData. Do not prefetch a channel already mounted, cached or in flight.

**Step 6: Bound retry long tails and stop retrying unsafe methods**

First correct the current behavior: today the common wrapper retries every method on network failure/5xx; there
is no mutation/idempotency split. Introduce named policies with these defaults:

- idempotent GET/HEAD: critical initial list gets at most one retry; background prefetch gets zero;
- non-idempotent POST/DELETE: zero automatic retries;
- a mutation may opt into retry only when it supplies an explicit idempotency key and a dedicated policy whose
  server behavior is covered by tests.

Add fake-timer tests proving an initial list cannot silently occupy ~24 seconds through four 5-second attempts,
and a failing POST receives exactly one network attempt.

**Step 7: Verify request waterfall**

Before scroll, desktop 1440 px must have at most three list GETs; mobile at most one. There must be no duplicate
normalized list URL and no lower-row request.

```bash
cd dashboard
node --test src/lib/feedScheduling.test.mjs
npm run build
```

**Step 8: Commit**

Flip `OPTIMISTIC_FEED_START` to true only after all Task 4–6 tests and the request-waterfall
check pass. Remove the old sources/stats gate in that same commit/release, not earlier.

```bash
git add dashboard/src/lib/feedScheduling.ts dashboard/src/lib/feedScheduling.test.mjs dashboard/src/lib/feedAvailability.ts dashboard/src/api.ts dashboard/src/App.tsx dashboard/src/components/Feed.tsx dashboard/index.html
git commit -m "perf: schedule feed requests by viewport"
```

### Task 7: 将媒体优先级改为全页面预算，并延后字体

**Files:**

- Create: `dashboard/src/lib/mediaPriority.ts`
- Create: `dashboard/src/lib/mediaPriority.test.mjs`
- Create: `dashboard/src/lib/deferredFonts.ts`
- Create: `dashboard/src/lib/deferredFonts.test.mjs`
- Modify: `dashboard/src/components/Feed.tsx:950-987`
- Modify: `dashboard/src/components/ItemCard.tsx`
- Modify: `dashboard/src/components/TweetCard.tsx`
- Modify: `dashboard/src/components/LinkCard.tsx`
- Modify: `dashboard/src/components/BlogCard.tsx`
- Modify: `dashboard/src/components/PodcastCard.tsx`
- Modify: `dashboard/src/components/PhCard.tsx`
- Modify: `dashboard/src/components/GithubCard.tsx`
- Modify: `dashboard/src/components/HfPaperCard.tsx`
- Modify: `dashboard/src/components/HuodongxingCard.tsx`
- Modify: `dashboard/index.html:42-65`

**Step 1: Write failing global-budget tests**

Policy:

```ts
// Exactly one likely LCP candidate is high.
policy({ immediateColumn: 0, row: 0 }) === { loading: 'eager', fetchPriority: 'high' };
// First card in other currently visible columns may be eager, never high.
policy({ immediateColumn: 1, row: 0 }) === { loading: 'eager', fetchPriority: 'auto' };
// Every below-fold/deferred card is lazy.
policy({ immediateColumn: 3, row: 0 }) === { loading: 'lazy', fetchPriority: 'auto' };
```

Add a contract test that the rendered immediate page can produce at most one `high` policy.

**Step 2: Replace the boolean `eager` prop**

Pass an explicit `MediaLoadPolicy` from App/Feed through ItemCard to each card. Remove `idx < 3` local policy.
Add `data-feed-source` and `data-media-priority` to the actual LCP media wrapper for safe telemetry.

**Step 3: Handle multi-media X cards**

Only the first meaningful media of the single high candidate receives `high`; its LinkCard/secondary media is
`auto` or lazy. Videos remain `preload="none"` unless they are the selected visible candidate.

**Step 4: Defer font injection beyond LCP**

Move inline scheduling to the tested helper. Inject after first pointer/keyboard interaction (which finalizes
LCP) or load+10 seconds followed by idle. Do not proactively inject when saveData or effective network ≤3g.
Keep `<noscript>` fallback.

**Step 5: Verify**

```bash
cd dashboard
node --test src/lib/mediaPriority.test.mjs src/lib/deferredFonts.test.mjs src/components/motion-contracts.test.mjs
npm run build
```

Use DevTools to confirm at most one `Highest` image and zero font requests before the chosen trigger.

**Step 6: Commit**

```bash
git add dashboard/src/lib/mediaPriority.ts dashboard/src/lib/mediaPriority.test.mjs dashboard/src/lib/deferredFonts.ts dashboard/src/lib/deferredFonts.test.mjs dashboard/src/components dashboard/index.html
git commit -m "perf: enforce a global media priority budget"
```

## Phase P2：缩小列表、优化查询、复用连接

### Task 8: 建立 list DTO 契约并先消除详情字段泄漏

**Files:**

- Create: `worker/src/list-item.ts`
- Create: `worker/src/list-item.test.ts`
- Modify: `worker/src/item-row.ts`
- Modify: `worker/src/index.ts:2686-3459`
- Modify: `dashboard/src/components/GithubCard.tsx:20-109`
- Modify: `dashboard/src/components/HfPaperCard.tsx:109-155`
- Modify: `dashboard/src/components/BlogCard.tsx`
- Modify: `dashboard/src/types.ts`

**Step 1: Write failing payload contract tests**

Fixtures must prove list items never contain:

```text
github: readme_excerpt, readme_translated, recent_commits
hf_paper: deep_analysis keys other than tldr, discussion_comments
blog/podcast: body, body_markdown*, transcript_text*, shownotes*
```

They must preserve the card fields, cursor fields and a compact `extra.deep_analysis = { tldr }` for HF.
Also assert representative 30-item fixture budgets:

- GitHub serialized list ≤150 KiB identity and ≤80 KiB gzip;
- each other feed ≤150 KiB identity unless an explicit test exemption documents why.

Run: `cd worker && npm test -- --run src/list-item.test.ts`

Expected: FAIL against current mapper.

**Step 2: Define source-specific DTO allowlists**

Use a positive allowlist per source for `extra`, not an ever-growing blacklist. Keep a base item field list used
by every card. Detail `/api/items/:id` continues through the full mapper; search keeps its own response contract.

**Step 3: Add compact derived fields**

- GitHub list uses `extra.cover_url`; for legacy rows temporarily select README as an internal hidden field,
  derive the first usable image inside Worker, then delete the hidden field before serialization. A test must
  prove README never leaves the response.
- HF returns only `deep_analysis.tldr` plus card keywords/submitter/figure fields.
- blog/podcast returns `cover_image`, publisher, compact summary fields and a hard-capped fallback excerpt;
  omit the body metadata object.

**Step 4: Update cards to consume DTO fields**

Remove README regex from `GithubCard`; it reads `cover_url`. Ensure drawers still call `fetchItem(id)` and receive
full README/deep analysis/body.

**Step 5: Run regression tests**

Test one list card and one detail drawer fixture per affected source. Then:

```bash
cd worker
npm test -- --run src/list-item.test.ts
npm test
cd ../dashboard
npm run build
```

**Step 6: Commit**

```bash
git add worker/src/list-item.ts worker/src/list-item.test.ts worker/src/item-row.ts worker/src/index.ts dashboard/src/components/GithubCard.tsx dashboard/src/components/HfPaperCard.tsx dashboard/src/components/BlogCard.tsx dashboard/src/types.ts
git commit -m "perf: define compact feed list DTOs"
```

### Task 9: 从 `SELECT *` 迁到 list 专用 projection

**Files:**

- Create: `worker/src/list-query.ts`
- Create: `worker/src/list-query.test.ts`
- Modify: `worker/src/index.ts:2686-3459`
- Modify: `worker/src/github.ts`
- Test: `worker/src/list-query.integration.test.ts`

**Step 1: Write failing SQL-builder tests**

Assert every list projection selects explicit base columns and compact JSON fields, and generated SQL does not
contain bare `SELECT *`/`items.*`. Hidden cursor/order columns may be selected with `_` aliases and must be
removed before response.

**Step 2: Backfill GitHub cover before removing README from SQL projection**

- During GitHub enrich, derive/store `extra.cover_url` when README is available.
- Add a dry-run-capable bounded backfill using the existing admin operations pattern.
- Dry-run reports candidate/update/error counts and writes nothing.
- Run batches in staging and require 100% coverage or an explicit `cover_status='none'` marker.
- Until that gate passes, SQL may select README only as a hidden derivation column; it must never serialize it.

**Step 3: Implement source-aware projection**

Start with the proven heavy sources: GitHub, blog/podcast, HF and ClawHub. The projection should use
`json_object/json_extract` for compact extra, `substr` for allowed fallbacks and explicit media/metrics fields.
Do not change detail handlers.

Remove the legacy hidden README selection only after backfill coverage reaches the Step 2 gate. Production
backfill still requires separate approval.

**Step 4: Compare D1 and payload before/after**

For each source capture `query_time_ms`, Worker `Server-Timing`, identity bytes and gzip bytes at limits 12/30.
The projection is accepted only if fields/pagination match and no source regresses query P75 >10%.

**Step 5: Verify**

```bash
cd worker
npm test -- --run src/list-query.test.ts src/list-query.integration.test.ts
npm test
npx wrangler deploy --dry-run
```

**Step 6: Commit**

```bash
git add worker/src/list-query.ts worker/src/list-query.test.ts worker/src/list-query.integration.test.ts worker/src/index.ts worker/src/github.ts
git commit -m "perf: project compact rows for feed lists"
```

### Task 10: 只优化被证据确认的默认 SQL

**Files:**

- Create: `worker/migrations/028-feed-list-query-indexes.sql`
- Create: `worker/src/list-query-plan.test.ts`
- Modify: `worker/src/index.ts:2939-3459`
- Modify: `docs/operations.md`

**Step 1: Freeze current EXPLAIN fixtures**

Record the seven production-equivalent default queries and expected undesirable markers. Current baseline:

```text
all 7: USE TEMP B-TREE FOR ORDER BY
ClawHub all candidate pool: 16,119
Product Hunt candidate pool: 880 and two temp sorts
news candidate pool: 955 with dynamic FEED_RANK
X/HF/GH/HDX pools: 35–552
```

The test should fail until the selected query plans improve; do not require every small candidate pool to have
zero temp sort.

**Step 2: Fix ClawHub first**

Add separate partial expression indexes for default all-stars and category-stars paths, matching the exact
WHERE/ORDER expressions and `deleted_at IS NULL`. Ensure category queries can constrain category before stars,
while all queries can order by stars without scanning all categories.

**Step 3: Treat Product Hunt rank persistence as a separate design gate**

Do not replace the current window rank in this migration. A persisted display rank changes when a higher-ranked
item arrives later and can make open cursors duplicate/skip rows. If post-projection PH D1 P75 remains >200 ms,
write a separate design that defines all of the following before code:

- when and how every affected `launch_date_pt` is reranked after batch upsert;
- atomic ordering of item upserts, rerank, backfill and index creation;
- a versioned cursor and compatibility behavior for existing `date|daily_rank|id` cursors;
- behavior when a rank generation changes between page 1 and page 2;
- client dedupe, rollback and removal of partially backfilled ranks.

Until that design is approved, keep PH behavior intact and accept its two temp sorts; do not trade correctness for
an unmeasured query-plan win.

**Step 4: Re-measure before adding more indexes**

- If news D1 P75 remains >200 ms after projection, narrow the candidate window or materialize a rank bucket;
  its time-dependent score cannot be solved by pretending the old published index covers it.
- Add the full untranslated-rank expression index for X/HF only if their post-projection D1 P75 remains >150 ms.
- Do not add new GH/HDX indexes while their candidate pools remain small and timing is below the threshold.

**Step 5: Apply migration staging-first**

```bash
cd worker
npm test -- --run src/list-query-plan.test.ts
npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/028-feed-list-query-indexes.sql
npx wrangler d1 execute xlist-staging --env staging --remote --command "EXPLAIN QUERY PLAN ..."
```

Expected: ClawHub avoids its large temp sort; Product Hunt results/cursors remain byte-for-byte compatible with
the current behavior. Production apply requires separate approval and a recorded `DROP INDEX` rollback.

**Step 6: Commit before production apply**

```bash
git add worker/migrations/028-feed-list-query-indexes.sql worker/src/list-query-plan.test.ts worker/src/index.ts docs/operations.md
git commit -m "perf: index confirmed feed query bottlenecks"
```

### Task 11: 用 VPS perf staging 验证并将生产首屏 API 同源

**Files:**

- Create: `deploy/nginx/aifeeds-api-location.conf`
- Create: `dashboard/src/lib/apiBase.test.mjs`
- Modify: `dashboard/src/lib/apiBase.ts`
- Modify: `dashboard/index.html:19-40`
- Modify: `dashboard/package.json`
- Modify: `docs/operations.md`

**Step 1: Write failing API-base tests**

Expected mapping during the experiment:

```text
ai-feeds.com             -> https://api.ai-feeds.com until production cutover
www.ai-feeds.com         -> '' (redirect normally)
staging.ai-feeds.com     -> https://staging-api.ai-feeds.com (current topology unchanged)
perf-staging.ai-feeds.com -> '' (new VPS-backed experiment origin)
localhost                -> '' (Vite proxy)
Pages preview prod       -> https://api.ai-feeds.com
Pages preview staging    -> https://staging-api.ai-feeds.com
```

Move host/environment resolution into an injectable pure function so the test does not mutate `window`. Add an
explicit `VITE_API_SAME_ORIGIN=true` override that is evaluated before `VITE_API_BASE`. Keep the checked-in
`dashboard/.env.staging` unchanged (`VITE_API_BASE=https://staging-api.ai-feeds.com`); add a
`build:perf-staging` package script that sets `VITE_API_SAME_ORIGIN=true` while building in staging mode, plus
explicit production same-origin build/deploy scripts. A normal
staging/Pages build must continue using the external staging API. Do not add another checked-in `.env` file;
the repo ignore policy only explicitly permits `.env.staging`.

```json
"build:perf-staging": "VITE_API_SAME_ORIGIN=true tsc -b && VITE_API_SAME_ORIGIN=true vite build --mode staging",
"build:same-origin": "VITE_API_SAME_ORIGIN=true tsc -b && VITE_API_SAME_ORIGIN=true vite build",
"deploy:same-origin": "node -e \"console.error('BLOCKED: same-origin production deploy requires explicit approval; follow docs/operations.md same-origin API runbook'); process.exit(1)\""
```

Tests must cover both `sameOriginFlag=false` and `true`; host alone must never silently override a checked-in
external API build.

Run: `cd dashboard && node --test src/lib/apiBase.test.mjs`

Expected: FAIL because the new perf-staging mapping does not exist.

**Step 2: Deploy an isolated perf Pages build**

Do not overwrite the existing staging project. With explicit Cloudflare approval, create a dedicated project and
deploy the relative-API build:

```bash
cd dashboard
npm run predeploy:staging
npm run build:perf-staging
npx wrangler pages project create xlist-dashboard-perf --production-branch=main
npx wrangler pages deploy dist --project-name=xlist-dashboard-perf --branch=main --commit-dirty=true
```

Expected upstream: `https://xlist-dashboard-perf.pages.dev`. Direct access to that Pages URL is not the acceptance
surface because its relative `/api` has no route; only the VPS-backed perf domain below is.

**Step 3: Create a topology-faithful perf staging origin**

Current `staging.ai-feeds.com`/`staging-api.ai-feeds.com` go directly to Cloudflare and do not pass through the
Hong Kong VPS, so editing VPS nginx cannot make that existing domain same-origin. With explicit DNS/certificate
approval, create `perf-staging.ai-feeds.com` pointing to the VPS, terminate a certificate for it, proxy its page
shell to `xlist-dashboard-perf.pages.dev`, and proxy `/api/` to the staging Worker. Keep existing staging untouched.

**Step 4: Create the versioned nginx location**

Add `location ^~ /api/` first to the new perf-staging block, proxying to the staging Worker and injecting the same
Host/SNI/forwarded/origin-secret headers as the existing API block. After the experiment passes, the production
front block may receive its prod equivalent. The git file contains placeholders only; secrets stay on VPS.
Preserve Worker `Server-Timing`, the shared request id and `Set-Cookie`.

Do not enable broad API caching in this task. Do not route admin or webhook domains through the front block.

**Step 5: Deploy to perf staging and test the complete auth surface**

After explicit approval:

```bash
nginx -t
systemctl reload nginx
curl -sS -D - -o /dev/null 'https://perf-staging.ai-feeds.com/api/items?source_type=x_list&limit=1'
curl -sS -D - -o /dev/null 'https://perf-staging.ai-feeds.com/api/feed-manifest'
```

Browser matrix:

- anonymous home/feed/search;
- existing login cookie `/api/auth/me`;
- email-code login/logout;
- SMS endpoint remains disabled as configured; verify the disabled response rather than temporarily enabling it;
- subscription/feedback；favorite 标记 N/A（当前仓库无 route/table/UI，不在本性能计划扩产品范围）；
- share landing and every deep-link family;
- `/daily`, `/i`, sitemap and static assets unchanged.

**Step 6: Verify the isolated perf build and HTML prefetch use relative paths**

Only after perf-staging DNS/certificate/nginx is live, serve the already deployed `build:perf-staging` artifact.
Existing staging and production remain on explicit external
API until their own route exists. Ensure no build can point relative `/api` at Pages without the route; direct
Pages preview remains explicit external API.

**Step 7: Measure the expected causal win**

On a cold connection, confirm API reuses the `perf-staging.ai-feeds.com` HTTP/2/TLS session and no CORS OPTIONS
occurs. Before production cutover, repeat the same check on `ai-feeds.com` after its `/api/` route exists.
Compare `perf_api` connect/TLS/TTFB against the old API origin.

**Step 8: Verify and commit**

```bash
cd dashboard
node --test src/lib/apiBase.test.mjs
npm run build
npm run build:perf-staging
git add deploy/nginx/aifeeds-api-location.conf dashboard/src/lib/apiBase.ts dashboard/src/lib/apiBase.test.mjs dashboard/index.html dashboard/package.json docs/operations.md
git commit -m "perf: route first-party API on the site origin"
```

**Step 9: Define the executable production cutover and rollback**

Production rollout is a separate approved operation:

1. add/test the production nginx `/api/` route while the current dashboard still uses the external API;
2. keep `npm run deploy:same-origin` fail-closed; in the separately approved private deployment session run
   `npm run build:same-origin`, verify the clean commit/artifact, then execute the exact Pages deployment command
   recorded in `docs/operations.md`;
3. verify response request ids, auth cookie, list/search/feedback/share and absence of API-origin OPTIONS;
4. keep the route in place during rollback, then run existing `cd dashboard && npm run deploy` to rebuild/redeploy
   the external-API version;
5. remove the unused production `/api/` route only after the external build is confirmed healthy.

The API-base test must cover the production same-origin flag. Either dashboard build remains compatible with the
nginx route, so rollback never requires two changes in one instant.

### Task 12: 修复卡片图片尺寸链路并统一第三方图片

**Files:**

- Create: `worker/src/card-image-variant.ts`
- Create: `worker/src/card-image-variant.test.ts`
- Modify: `worker/src/x-media-r2.ts`
- Modify: `worker/src/feeds/media-r2.ts`
- Modify: `worker/src/hf-paper/media.ts`
- Modify: `worker/src/index.ts:5432-5498`
- Modify: `dashboard/src/lib/asset.ts`
- Modify: `dashboard/src/lib/utils.ts:130-190`
- Modify: affected card components

**Step 1: Run a staging-only implementation spike**

Compare two legal paths using the same 2280×1452 R2 source:

1. pre-generate/store a 400/800 px WebP/AVIF card variant during external→R2 migration;
2. a non-recursive Worker/R2 resize path if the deployed Cloudflare account supports it without self-fetch.

Reject any design that self-fetches Worker → Hong Kong → same Worker, breaks Range audio/video, or needs an open
image proxy. Record bytes, TTFB, cache hit and Worker subrequests.

**Step 2: Write failing variant tests for the chosen path**

Required behavior:

- image keys return width-specific immutable URLs;
- videos/audio never enter image transform;
- 400 px card request does not return original 2280 px bytes;
- `Accept` varies format safely;
- R2 hotlink and Range behavior remains intact;
- legacy original URL is a valid fallback.

**Step 3: Generate variants at ingestion and bounded backfill**

Store the card URL/dimensions in compact list DTO fields. Update X, blog/podcast, GH/PH/HF migration points while
preserving original assets for detail/lightbox. Backfill only sources where the original upstream URL is retained;
do not re-download unavailable originals indefinitely.

**Step 4: Route third-party candidates through the controlled path**

HF thumbnail and Huodongxing cover may no longer be direct `high` third-party requests. Add `srcset`, explicit
width/height/aspect ratio and `Timing-Allow-Origin` to controlled responses.

**Step 5: Verify bytes and visual fidelity**

At DPR 1/2/3 and card widths 360–400 px, compare screenshot sharpness; target a typical card image ≤40 KiB and
no layout shift. Verify video seek and podcast audio Range separately.

```bash
cd worker && npm test -- --run src/card-image-variant.test.ts && npm test
cd ../dashboard && npm run build
```

**Step 6: Commit**

```bash
git add worker/src/card-image-variant.ts worker/src/card-image-variant.test.ts worker/src/x-media-r2.ts worker/src/feeds/media-r2.ts worker/src/hf-paper/media.ts worker/src/index.ts dashboard/src/lib/asset.ts dashboard/src/lib/utils.ts dashboard/src/components
git commit -m "perf: serve right-sized feed media"
```

## Phase P3：边缘实验与发布验收

### Task 13: 评估 upstream keepalive 与公开列表微缓存

**Files:**

- Create: `deploy/nginx/aifeeds-upstream-performance.conf`
- Modify: `docs/operations.md`

**Step 1: Benchmark HTTP/1.1 keepalive in staging**

Use the live nginx version's supported upstream DNS strategy; do not pin Cloudflare IPs. Enable
`proxy_http_version 1.1`/cleared Connection and an upstream keepalive pool only if hostname re-resolution remains
safe. Compare 100 reused requests with the current configuration.

**2026-07-12 evidence update:** the approved read-only VPS check found open-source nginx 1.24.0. Safe dynamic
`upstream server ... resolve` requires at least 1.27.3, so this experiment is **BLOCKED** on the current host.
`deploy/nginx/aifeeds-upstream-performance.conf` must not be installed, Cloudflare IPs must not be pinned, and the
expected 20–30 ms gain does not justify an implicit production nginx upgrade. Perf staging uses resolver-backed
variable `proxy_pass` without an upstream keepalive pool. Reopen A/B/A only after a separately approved upgrade and
compatibility review.

Accept only if P50/P95 improve and no stale DNS/502 increase. Expected gain is about 20–30 ms, not seconds.

**Step 2: Gate microcache on residual Worker timing**

Only if public list D1+Worker P75 remains material after projection/indexes, add an exact-location 10–30 second
microcache for anonymous GET `/api/items` and `/api/feed-manifest`:

- key includes normalized path/query and Accept encoding;
- bypass non-GET, Authorization and any personalized endpoint;
- ignore Cookie only after a test proves response is public/non-personalized;
- normalize/remove upstream CORS headers for same-origin serving;
- never cache 4xx/5xx, auth, favorites, subscriptions, feedback or refresh mutations.

**Step 3: Test cache isolation**

Run anonymous/logged-in, two Origin values, two filters, cursor, pinned and failure responses. A test must fail if
one variant receives another's response.

**Step 4: Commit versioned config/runbook before any prod change**

```bash
git add deploy/nginx/aifeeds-upstream-performance.conf docs/operations.md
git commit -m "ops: stage safe upstream performance controls"
```

### Task 14: 建立 PC/移动端性能回归矩阵并灰度验收

**Files:**

- Create: `dashboard/e2e/home-performance.spec.ts`
- Create: `dashboard/playwright.config.ts`
- Modify: `dashboard/package.json`
- Modify: `dashboard/package-lock.json`
- Modify: `.github/workflows/pr-validation.yml`
- Create: `docs/reviews/c-end-performance-rollout-template.md`

**Step 1: Pin Playwright and its browser runtime**

```bash
cd dashboard
npm install --save-dev --save-exact @playwright/test@1.54.1
npx playwright install chromium webkit
```

Commit both package files. In `pr-validation.yml`, cache `~/.cache/ms-playwright` with a browser-set prefix plus
`dashboard/package-lock.json`, run `npx playwright install --with-deps chromium webkit` on cache miss, install both
engines' system dependencies on cache hit, and then run the performance spec. Never rely on an unpinned one-off
`npx` download.

**Step 2: Add failing browser assertions**

Projects:

- desktop Chromium 1440×900;
- tablet 820×1180;
- iPhone-like Chromium 390×844;
- iPhone WebKit 390×844（真实 Safari 引擎覆盖滚动、触摸和抽屉差异）；
- Android-like 412×915.

Tests intercept requests and assert before LCP/first interaction:

- no Feed waits for manifest;
- list GET count ≤3 desktop, ≤1 mobile;
- no duplicate normalized list URL;
- lower desktop rows do not request lists/images before scroll;
- at most one image has `fetchpriority=high`;
- no font request before defer trigger;
- offscreen lazy video posters make no request until their feed viewport or explicit user intent, and use the
  400 px stored WebP variant when available;
- a failed stored WebP card variant retries the original once, then hides only if the original also fails;
- active mobile tab renders and adjacent swipe remains functional;
- drawer full fetch still contains README/deep analysis/body, and a search-provider handoff joins the same
  in-flight detail GET.

**Step 3: Add slow-network visual/functional cases**

Throttle latency/throughput, block manifest once, fail one list once, test saveData policy and capture trace/screenshots.
Do not assert an absolute millisecond in CI; assert budgets/request order there and use controlled lab/RUM for timing.

**Step 4: Run the complete verification suite**

```bash
cd dashboard
npm run lint
npm run build
npx playwright test e2e/home-performance.spec.ts
npm run test:unit

cd ../worker
npm test
npx wrangler deploy --dry-run
```

Expected: all PASS.

**Step 5: Stage and compare**

Use the rollout template to record:

- desktop/mobile request waterfall and transfer bytes;
- cold/warm `feed_ready`, FCP, LCP and API timing;
- errors, login/share/deep-link checks;
- Worker D1/map/json and nginx connect/header/response;
- exact commit/config version and rollback.

**Step 6: Production rollout gates**

Roll out one phase at a time. Observe ≥48 hours and ≥100 LCP samples in each primary real-user cohort before
declaring success or advancing to the next production phase. This post-deploy observation runs separately from
local delivery: once G0, automated tests, cross-device functional checks and independent review pass, the local
branch may be delivered without waiting for RUM. Target:

```text
desktop all-clean LCP P75 <= 3.5s
warm SW LCP P75 <= 2.5s
feed_ready P75 <= 2.5s, warm <= 1.5s
LCP-before list transfer <= 250 KiB desktop / 100 KiB mobile
GitHub 30 list gzip <= 80 KiB
high-priority images <= 1
below-fold list requests before LCP = 0
```

**Step 7: Commit**

```bash
git add dashboard/e2e dashboard/playwright.config.ts dashboard/package.json dashboard/package-lock.json .github/workflows/pr-validation.yml docs/reviews/c-end-performance-rollout-template.md
git commit -m "test: add cross-device performance budgets"
```

### Task 15: 地域路由只作为独立 A/B 实验

**Files:**

- Create: `docs/plans/c-end-geo-routing-experiment.md`
- Modify: `docs/operations.md`

**Step 1: Wait for trustworthy geography**

Do not begin until server-side country/colo has enough real-user samples and synthetic traffic is separately marked.
Client `mainland_hint` is not a routing source of truth.

**Step 2: Write the experiment before changing DNS**

Candidate arms:

- mainland/selected networks retain Hong Kong;
- non-mainland direct Cloudflare;
- control remains current all-Hong-Kong.

Predeclare sample size, P75/P95 metrics, error/availability guardrails, DNS TTL, cache warm-up and rollback. Analyze
each geography separately; never accept a better global average that makes one region materially worse.

**Step 3: Execute only with explicit infrastructure approval**

No DNS/CDN mutation is implied by this implementation plan. If approved later, record every DNS value before
change and keep the rollback TTL short.

**Step 4: Commit the experiment design**

```bash
git add docs/plans/c-end-geo-routing-experiment.md docs/operations.md
git commit -m "docs: define geo routing performance experiment"
```

## 最终完成条件

交付分两层记录：

- **本地代码交付完成：** G0、自动化测试、PC/移动端功能检查、构建和独立复审通过，分支可提交；
  不等待生产 RUM。
- **生产效果验收完成：** 获得单独上线授权并完成灰度后，按阶段累计 ≥48 小时且主真实用户队列
  ≥100 个 LCP 样本。该门槛只决定是否确认收益和推进下一生产阶段。

本地代码交付按上方第一层判定；生产效果验收只有在以下全部成立时才算完成：

1. PC 与移动端功能矩阵无回归；
2. 列表/详情数据契约测试证明没有把抽屉全文删掉；
3. 同源 API 已验证 cookie、搜索、反馈、分享和深链；
4. 新 RUM 可把 nav、nginx、Worker、D1、DTO、媒体分段；
5. 每阶段的生产 RUM 达到样本门槛和目标，且非大陆/移动端没有被平均数掩盖；
6. 运行手册包含每项配置、migration、缓存和 DNS 的独立回滚路径。
