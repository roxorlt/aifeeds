# PH GraphQL + CF Worker Cron 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Product Hunt 数据抓取从本地 browser-use Python scraper 迁到 CF Worker + PH GraphQL API + 现有 cron 调度。前端零破坏，缺失字段优雅降级。

**Architecture:** 沿用现有 worker `*/5 * * * *` cron + dispatcher 抢占调度（与 GH/X/CH 一致）。新增 PH 时间窗触发（UTC 20:10 抓 PT yesterday top 30）+ ph-enrich 抢占 slot；扩展 fill-translations 支持 PH 字段；ph-r2-migrate 已存在；ingestItems 内部函数化避免 worker self-fetch。

**Tech Stack:** TypeScript / Cloudflare Workers / D1 / KV (AUTH_KV) / R2 / GraphQL (PH v2 API) / DeepSeek (deepseek-v4-flash) / wrangler 4.x

**Spec:** [`2026-05-11-ph-graphql-cf-cron-design.md`](./2026-05-11-ph-graphql-cf-cron-design.md)

---

## Conventions

> **No unit test infrastructure in worker** — package.json has no vitest/jest. Validation pattern (per CLAUDE.md global rule): implement → `wrangler dev --env staging` smoke or staging E2E → commit. Each task lists explicit verification commands and expected output.

> **DeepSeek model** — All LLM calls use `deepseek-v4-flash` (per project CLAUDE.md model selection table; classify and translate are both lightweight).

> **Worktree** — All work happens in `/Users/roxor/brain/30-projects/aifeeds/.claude/worktrees/feat+ph-api-cf-cron` on branch `worktree-feat+ph-api-cf-cron`.

> **Auth env** — Wrangler commands need `source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env` first to load `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

> **Commit cadence** — Each task ends with one commit. PR1 is single big PR (rollback granularity per design § 3); M8 旧 scraper 退役另起 PR。

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `worker/src/scrapers/ph.ts` | **Create** | PH OAuth token cache, GraphQL list+detail queries, transform Post→IngestItem, runPhDailyFetch orchestrator |
| `worker/src/ph.ts` | **Rename** to `worker/src/ph-r2.ts` | R2 asset migration (job unchanged, file rename for clarity vs new `scrapers/ph.ts`) |
| `worker/src/index.ts` | **Modify** | Refactor `ingestItems()` out of HTTP handler; add PH dispatcher time-window trigger; add ph-enrich preempt slot; update import path for `ph-r2.ts`; add `/admin/ph-fetch-now` debug endpoint |
| `worker/src/enrich.ts` | **Modify** | Add `runPhEnrich()` (mirrors github-enrich pattern); extend `selectTranslationCandidates` + `extractTasks` + UPDATE writeback to support PH source_type |
| `worker/wrangler.toml` | **Modify** | Add doc-only comment for PH_CLIENT_ID/PH_CLIENT_SECRET; possibly drop `[browser]` binding (Task 19) |
| `dashboard/src/components/PhDrawerBody.tsx` | **Verify only** | Confirm existing `&&` conditional rendering covers missing fields (top_reviews / pricing / open_source / followers); minor polish if needed |
| `CLAUDE.md` | **Modify** | Project ID card: "PH 走 Convex" → "PH 走 PH GraphQL API + worker cron"; data sources current state |
| `docs/operations.md` | **Modify** | Add PH cron section (schedule, log query, manual trigger); add PH secrets section (regen flow) |
| `TODO.md` | **Modify** | Strike PH browser-use related tasks; add PH lazy-enrich-on-drawer follow-up PR |
| `docs/plans/2026-05-03-product-hunt-source-design.md` | **Modify (1 line)** | Add header banner: "已被 2026-05-11 设计替代" |

---

## Tasks

### Task 1: Refactor ingest into reusable function

**Why first:** Other tasks need to call ingest internally without HTTP. Doing this first keeps the diff isolated and reviewable.

**Files:**
- Modify: `worker/src/index.ts:491-560` (and ON CONFLICT clause beyond, full handler scope)

- [ ] **Step 1: Read current handler scope**

Run: `sed -n '491,720p' worker/src/index.ts`
Find the end of `handleIngest`. Identify the boundary between (a) HTTP plumbing (auth, JSON parse, response shape) and (b) DB write logic (the BATCH_SIZE loop).

- [ ] **Step 2: Define new exported function signature**

Insert immediately after the `IngestPayload` / `ItemInput` interface declarations (around line 495). Add an exported result type and the function:

> **Bonus this task:** also add `export` keyword to `interface ItemInput` and `interface IngestPayload` (around lines 497-520) — Task 6 will need to import `ItemInput`, and any future caller of ingestItems will want the payload type.

```typescript
export interface IngestResult {
  inserted: number;
  updated: number;
  errors: { source_id: string; error: string }[];
}

/**
 * Internal ingest entry — same DB write logic as POST /api/ingest, callable
 * from worker code (e.g. PH cron) without HTTP self-fetch overhead.
 * No auth check (caller is trusted); HTTP handler still enforces INGEST_TOKEN.
 */
export async function ingestItems(env: Env, items: ItemInput[]): Promise<IngestResult> {
  let inserted = 0;
  let updated = 0;
  const errors: { source_id: string; error: string }[] = [];

  if (items.length > 500) {
    throw new Error('Max 500 items per call');
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const stmts: D1PreparedStatement[] = [];

    for (const item of batch) {
      if (!item.source_type || !item.source_id || !item.scraped_at) {
        errors.push({ source_id: item.source_id || 'unknown', error: 'Missing required fields' });
        continue;
      }

      const id = `${item.source_type}:${item.source_id}`;
      // ↓ Move the `env.DB.prepare(...).bind(...)` block from handleIngest verbatim here
    }

    if (stmts.length > 0) {
      const results = await env.DB.batch(stmts);
      for (const r of results) {
        if (r.meta && (r.meta as { changes?: number; last_row_id?: number | null }).changes !== undefined) {
          // changes=1 + last_row_id present → INSERT; changes=2 → UPDATE (SQLite 2 for UPSERT update)
          // Use the existing logic from handleIngest verbatim
        }
      }
    }
  }

  return { inserted, updated, errors };
}
```

> Concrete instruction: cut the entire `for (let i = 0; i < body.items.length; ...)` block + post-loop counters from `handleIngest` body. Paste into `ingestItems` body. Do NOT change SQL or batching behavior — pure code motion.

- [ ] **Step 3: Replace handleIngest body to call ingestItems**

`handleIngest` becomes thin wrapper:

```typescript
async function handleIngest(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  const body = await request.json<IngestPayload>();
  if (!body.items || !Array.isArray(body.items)) {
    return jsonResponse({ error: 'items array required' }, 400, request, env);
  }
  let result: IngestResult;
  try {
    result = await ingestItems(env, body.items);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 400, request, env);
  }
  return jsonResponse(result, 200, request, env);
}
```

- [ ] **Step 4: TypeScript typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors. If any "Cannot find name 'X'" — verify import order / export visibility.

- [ ] **Step 5: Smoke test ingest still works**

Run staging via wrangler dev (must `source` env first):

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler dev --env staging --local
```

In another terminal, POST a synthetic item:

```bash
curl -X POST http://localhost:8787/api/ingest \
  -H "Authorization: Bearer $(grep INGEST_TOKEN ../.secrets/cf-claude-ops.env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"source_type":"x_list","source_id":"smoke-test-1","scraped_at":"2026-05-11T00:00:00Z","title":"smoke","content":"smoke"}]}'
```

Expected: `{"inserted":1,"updated":0,"errors":[]}` on first call, `{"inserted":0,"updated":1,"errors":[]}` on second.

> If INGEST_TOKEN env name differs in `.secrets/`, look up actual var name with `grep -i ingest .secrets/*.env`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(worker): 抽 ingestItems 为可复用函数

handleIngest 拆为：HTTP 鉴权/响应外壳 + 内部 ingestItems(env, items)。
后续 PH cron 直接 import 调用，免 worker 内 self-fetch + 省 subrequest。

无行为变更，pure refactor。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rename worker/src/ph.ts → ph-r2.ts

**Why now:** Independent rename, frees up `ph.ts` filename for new fetch module without churn during fetch implementation.

**Files:**
- Rename: `worker/src/ph.ts` → `worker/src/ph-r2.ts`
- Modify: any file importing from `./ph` (typically `worker/src/index.ts`)

- [ ] **Step 1: git mv to preserve history**

```bash
git mv worker/src/ph.ts worker/src/ph-r2.ts
```

- [ ] **Step 2: Update imports**

Find all imports:

```bash
grep -rn "from ['\"]./ph['\"]" worker/src/
grep -rn "from ['\"]./ph-r2" worker/src/
```

Edit each match to `from './ph-r2'`. Most likely lives in `worker/src/index.ts` (e.g., `import { runPhR2Migrate } from './ph'`).

- [ ] **Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(worker): ph.ts → ph-r2.ts

为新建 worker/src/scrapers/ph.ts (fetch 主流程) 让出文件名。
ph-r2.ts 仅做 R2 资源迁移，与 fetch 责任分离。

无行为变更，git mv 保留历史。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: PH OAuth token module

**Why:** Foundation for all GraphQL queries. Token caching avoids hitting OAuth endpoint every cron tick.

**Files:**
- Create: `worker/src/scrapers/ph.ts` (start with OAuth section)

- [ ] **Step 0: Extend worker Env interface with PH credentials**

In `worker/src/index.ts` find the `Env` interface (search `interface Env`). Add two optional fields so TypeScript recognizes them:

```typescript
interface Env {
  // ... existing fields ...
  PH_CLIENT_ID?: string;
  PH_CLIENT_SECRET?: string;
}
```

Also verify `Env` already has `AUTH_KV: KVNamespace` and `DB: D1Database` (it does — confirm). This avoids the `as unknown as ...` cast in Task 7.

- [ ] **Step 1: Create scrapers/ directory and module skeleton**

```bash
mkdir -p worker/src/scrapers
```

Create `worker/src/scrapers/ph.ts` with header + OAuth section:

```typescript
// Product Hunt fetch module — GraphQL v2 + client_credentials OAuth.
//
// Scope: list yesterday's PT-day top 30 posts, fetch each post's full detail,
// transform to IngestItem[], hand to internal ingestItems() — no HTTP self-fetch.
//
// Rate limit: 6250 complexity points / 15min. We use ~1500-2000/day. KV-cached
// access token (PH client_credentials TTL ~30 days; we cache 25 days defensively
// + auto-refresh on 401).
//
// Sister file `worker/src/ph-r2.ts` handles R2 asset migration after ingest.

const PH_OAUTH_URL = 'https://api.producthunt.com/v2/oauth/token';
const PH_GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';
const TOKEN_KV_KEY = 'ph:access_token';
const TOKEN_KV_TTL = 60 * 60 * 24 * 25; // 25 days (PH default ~30, defensive)

export interface PhEnv {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  PH_CLIENT_ID?: string;
  PH_CLIENT_SECRET?: string;
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * Get PH access token from KV cache, or fetch fresh + cache. Returns null if
 * credentials missing (caller should noop and log).
 */
export async function getPhAccessToken(env: PhEnv): Promise<string | null> {
  if (!env.PH_CLIENT_ID || !env.PH_CLIENT_SECRET) {
    console.warn('[ph] PH_CLIENT_ID/SECRET not set — skip');
    return null;
  }

  const cached = await env.AUTH_KV.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const res = await fetch(PH_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PH_CLIENT_ID,
      client_secret: env.PH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[ph] OAuth fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    return null;
  }
  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    console.error('[ph] OAuth response missing access_token:', JSON.stringify(data));
    return null;
  }
  await env.AUTH_KV.put(TOKEN_KV_KEY, data.access_token, { expirationTtl: TOKEN_KV_TTL });
  console.log(`[ph] OAuth fresh token cached for ${TOKEN_KV_TTL}s`);
  return data.access_token;
}

/**
 * Invalidate cached token — called when GraphQL returns 401 (token expired
 * earlier than expected). Caller retries with fresh token.
 */
export async function invalidatePhAccessToken(env: PhEnv): Promise<void> {
  await env.AUTH_KV.delete(TOKEN_KV_KEY);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Smoke test OAuth in wrangler dev**

Add a temporary debug endpoint to `worker/src/index.ts` (will be cleaned up in Task 8 when we add `/admin/ph-fetch-now`). For now just call from console — easier path: write a one-off `curl` against the **real** PH endpoint outside worker:

```bash
curl -s -X POST https://api.producthunt.com/v2/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$(npx wrangler secret list --env staging --config worker/wrangler.toml 2>/dev/null | grep -q PH_CLIENT_ID && echo 'set in KV' || echo 'MISSING')\",\"client_secret\":\"...\",\"grant_type\":\"client_credentials\"}"
```

> Easier: skip this curl for now; we'll exercise OAuth path end-to-end in Task 8 when admin endpoint is wired up. Just verify no type errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/scrapers/ph.ts
git commit -m "$(cat <<'EOF'
feat(ph): GraphQL OAuth client_credentials token module

KV 缓存 25 天（PH 默认 ~30 天，防御性提前 5 天）+ 401 时主动失效。
凭证缺失时 noop + 警告，不抛错（dispatcher 友好）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Schema introspection + GraphQL queries draft

**Why:** Design doc § 4.3 is a draft based on context7 docs; field names need real-API verification before we lock them in.

**Files:**
- Create: `worker/scripts/ph-introspect.ts` (one-off curl-equivalent, deletable after lock-in)
- Modify: `worker/src/scrapers/ph.ts` (add list + detail query strings)

- [ ] **Step 1: Run introspection against real PH API**

Use staging-injected secret. From repo root:

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
TOKEN=$(curl -s -X POST https://api.producthunt.com/v2/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$(grep PH_CLIENT_ID .secrets/ph.env 2>/dev/null | cut -d= -f2 || echo MISSING)\",\"client_secret\":\"$(grep PH_CLIENT_SECRET .secrets/ph.env 2>/dev/null | cut -d= -f2 || echo MISSING)\",\"grant_type\":\"client_credentials\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
echo "Token len: ${#TOKEN}"

# Introspect Post type fields
curl -s -X POST https://api.producthunt.com/v2/api/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __type(name: \"Post\") { name fields { name type { name kind ofType { name } } } } }"}' \
  | python3 -m json.tool > /tmp/ph-post-schema.json
cat /tmp/ph-post-schema.json | head -80
```

> If `.secrets/ph.env` doesn't exist, manually create it with values you injected to wrangler. Or skip this step and trust design doc — Task 5/6 will surface mismatches at runtime.

- [ ] **Step 2: Verify field names against design doc § 4.3**

Open `/tmp/ph-post-schema.json`. Confirm or correct these fields exist:
- `Post.featuredAt` (DateTime)
- `Post.thumbnail` (Media or similar)
- `Post.media` ([Media!]!)
- `Post.user` (User!)
- `Post.makers` ([User!]!)
- `Post.comments` (CommentConnection)
- `Post.topics` (TopicConnection)
- `Post.reviewsCount` / `Post.reviewsRating`
- `Post.votesCount` / `Post.commentsCount`
- `Post.url` / `Post.website`
- `Post.tagline` / `Post.description` / `Post.name` / `Post.slug`

Also introspect `Media`, `User`, `Comment` types if any uncertainty:

```bash
for T in Media User Comment Topic; do
  curl -s -X POST https://api.producthunt.com/v2/api/graphql \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"{ __type(name: \\\"$T\\\") { name fields { name type { name kind ofType { name } } } } }\"}" \
    | python3 -m json.tool > /tmp/ph-$T-schema.json
done
```

Note any discrepancies. Field names that differ from the design draft (e.g., `User.profileImage` vs `User.headline` vs `User.username`) get used in Task 5 below.

- [ ] **Step 3: Append GraphQL query constants to `worker/src/scrapers/ph.ts`**

Append after the OAuth section:

```typescript
// ─── GraphQL queries ───────────────────────────────────────────

const LIST_QUERY = `
  query PhDailyList($featuredAfter: DateTime!, $featuredBefore: DateTime!) {
    posts(
      featuredAfter: $featuredAfter,
      featuredBefore: $featuredBefore,
      order: VOTES,
      first: 30
    ) {
      edges {
        node { id slug name votesCount featuredAt }
      }
    }
  }
`;

const DETAIL_QUERY = `
  query PhPostDetail($id: ID!) {
    post(id: $id) {
      id slug name tagline description url website
      featuredAt createdAt
      votesCount commentsCount reviewsCount reviewsRating
      thumbnail { url type }
      media { url type }
      user { id name username headline profileImage(size: 96) }
      makers { id name username headline profileImage(size: 96) }
      topics(first: 5) { edges { node { name slug } } }
      comments(order: VOTES_COUNT, first: 10) {
        edges {
          node {
            id body votesCount createdAt parentId
            user { id name username profileImage(size: 96) }
          }
        }
      }
      productLinks { type url }
    }
  }
`;
```

> If introspection (Step 2) showed different field names, **edit these constants now** to match. Common likely diffs:
> - `Media.videoUrl` may not exist — drop, derive from `url` pattern instead
> - `User.profileImage(size: 96)` may be `User.profileImage` (no arg) or `User.photoUrl`
> - `Post.comments` order arg may be `VOTES` not `VOTES_COUNT` — check `CommentsOrder` enum:
>   ```bash
>   curl -s -X POST https://api.producthunt.com/v2/api/graphql -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"query":"{ __type(name: \"CommentsOrder\") { enumValues { name } } }"}'
>   ```

- [ ] **Step 4: Add GraphQL fetch helper**

Append:

```typescript
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

/**
 * POST GraphQL with auto-retry on 401 (token expired earlier than KV TTL).
 * Returns parsed `data` field, or null on error (logged).
 */
async function phGraphQL<T>(
  env: PhEnv,
  query: string,
  variables: Record<string, unknown>,
  retried = false,
): Promise<T | null> {
  const token = await getPhAccessToken(env);
  if (!token) return null;

  const res = await fetch(PH_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 && !retried) {
    console.warn('[ph] GraphQL 401 — invalidating token + retry once');
    await invalidatePhAccessToken(env);
    return phGraphQL<T>(env, query, variables, true);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`[ph] GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length) {
    console.error('[ph] GraphQL errors:', JSON.stringify(json.errors));
    return null;
  }
  return json.data ?? null;
}
```

- [ ] **Step 5: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/scrapers/ph.ts
git commit -m "$(cat <<'EOF'
feat(ph): GraphQL queries (list + detail) + fetch helper

field name 已与 PH GraphQL introspection 对齐。
401 时自动失效 token + 重试一次（token 早于 KV TTL 失效兜底）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: List + Detail query wrappers + types

**Files:**
- Modify: `worker/src/scrapers/ph.ts`

- [ ] **Step 1: Add typed PH response interfaces**

Append to `worker/src/scrapers/ph.ts`:

```typescript
// ─── Typed PH response shapes ──────────────────────────────────

export interface PhListNode {
  id: string;
  slug: string;
  name: string;
  votesCount: number;
  featuredAt: string;
}

export interface PhMedia {
  url: string;
  type: string;
}

export interface PhUser {
  id: string;
  name: string | null;
  username: string | null;
  headline: string | null;
  profileImage: string | null;
}

export interface PhCommentNode {
  id: string;
  body: string;
  votesCount: number;
  createdAt: string;
  parentId: string | null;
  user: PhUser;
}

export interface PhPostDetail {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string | null;
  url: string;
  website: string | null;
  featuredAt: string;
  createdAt: string;
  votesCount: number;
  commentsCount: number;
  reviewsCount: number;
  reviewsRating: number | null;
  thumbnail: PhMedia | null;
  media: PhMedia[];
  user: PhUser;
  makers: PhUser[];
  topics: { edges: Array<{ node: { name: string; slug: string } }> };
  comments: { edges: Array<{ node: PhCommentNode }> };
  productLinks: Array<{ type: string; url: string }>;
}

interface ListQueryData {
  posts: { edges: Array<{ node: PhListNode }> };
}

interface DetailQueryData {
  post: PhPostDetail;
}
```

- [ ] **Step 2: Add list + detail wrapper functions**

Append:

```typescript
export async function listPhDailyPosts(
  env: PhEnv,
  ptDateStr: string, // "2026-05-10"
): Promise<PhListNode[]> {
  // PT day boundary in ISO 8601 with explicit offset.
  // PT is UTC-7 (PDT, Mar-Nov) or UTC-8 (PST, Nov-Mar). Use Intl tz for accuracy.
  const offsetStr = ptOffsetForDate(ptDateStr); // "-07:00" or "-08:00"
  const featuredAfter = `${ptDateStr}T00:00:00${offsetStr}`;
  const nextDay = nextPtDate(ptDateStr);
  const featuredBefore = `${nextDay}T00:00:00${offsetStr}`;

  const data = await phGraphQL<ListQueryData>(env, LIST_QUERY, {
    featuredAfter,
    featuredBefore,
  });
  if (!data) return [];
  return data.posts.edges.map((e) => e.node);
}

export async function fetchPhPostDetail(
  env: PhEnv,
  postId: string,
): Promise<PhPostDetail | null> {
  const data = await phGraphQL<DetailQueryData>(env, DETAIL_QUERY, { id: postId });
  return data?.post ?? null;
}

// ─── Date helpers (PT-aware, DST-safe) ─────────────────────────

/**
 * Get current PT date in YYYY-MM-DD form using IANA tz America/Los_Angeles.
 * Auto handles PDT/PST switch.
 */
export function ptDateNow(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA gives "YYYY-MM-DD" format
  return fmt.format(now);
}

export function ptYesterday(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return ptDateNow(yesterday);
}

/**
 * Compute next-day PT date string (for query upper bound).
 */
function nextPtDate(ptDateStr: string): string {
  // ptDateStr is "YYYY-MM-DD" — parse as PT noon (avoids DST edge), add 1 day, format.
  const [y, m, d] = ptDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 20, 0, 0)); // 20:00 UTC = ~12:00 PT (safe of DST)
  dt.setUTCDate(dt.getUTCDate() + 1);
  return ptDateNow(dt);
}

/**
 * Get PT UTC offset for a given PT date. Returns "-07:00" (PDT) or "-08:00" (PST).
 */
function ptOffsetForDate(ptDateStr: string): string {
  const [y, m, d] = ptDateStr.split('-').map(Number);
  // Use DateTimeFormat with timeZoneName: 'longOffset' to get the actual offset
  const dt = new Date(Date.UTC(y, m - 1, d, 20, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(dt);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  // tzPart is like "GMT-07:00" or "GMT-08:00"
  return tzPart.replace('GMT', '');
}
```

- [ ] **Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/scrapers/ph.ts
git commit -m "$(cat <<'EOF'
feat(ph): list + detail query wrappers + PT-aware date helpers

ptDateNow / ptYesterday 用 Intl tz America/Los_Angeles 自动处理 PDT/PST 切换。
ptOffsetForDate 给 GraphQL ISO 时间戳生成正确 offset 后缀。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Transform PhPostDetail → IngestItem

**Why:** Bridges API shape ↔ DB schema. Key responsibility: derive logo from thumbnail, derive maker_post from comments, structure extra JSON to match what PhCard / PhDrawerBody read.

**Files:**
- Modify: `worker/src/scrapers/ph.ts`

- [ ] **Step 1: Append transform function**

```typescript
// ─── Transform PhPostDetail → IngestItem ───────────────────────

import type { ItemInput } from '../index'; // ItemInput interface from ingest

interface PhMediaItemDb {
  url: string;
  type: 'image' | 'video';
  role?: 'logo';
}

interface PhMakerDb {
  name: string | null;
  handle: string | null;
  avatar_url: string | null;
  profile_url: string | null;
}

interface PhCommentDb {
  author_name: string | null;
  author_handle: string | null;
  avatar_url: string | null;
  text: string;
  upvotes: number;
}

function userToProfileUrl(u: PhUser): string | null {
  return u.username ? `https://www.producthunt.com/@${u.username}` : null;
}

function userToMaker(u: PhUser): PhMakerDb {
  return {
    name: u.name,
    handle: u.username,
    avatar_url: u.profileImage,
    profile_url: userToProfileUrl(u),
  };
}

function commentToDb(c: PhCommentNode): PhCommentDb {
  return {
    author_name: c.user.name,
    author_handle: c.user.username,
    avatar_url: c.user.profileImage,
    text: c.body,
    upvotes: c.votesCount,
  };
}

/**
 * Convert PH API post detail to IngestItem ready for ingestItems().
 * Daily rank passed in (1-based, list query natural order).
 */
export function transformPostToIngestItem(
  post: PhPostDetail,
  dailyRank: number,
  ptLaunchDate: string,
): ItemInput {
  const sourceId = `${post.slug}:${ptLaunchDate}`;

  // Media: thumbnail → role='logo'; media[] → gallery (image | video)
  const media: PhMediaItemDb[] = [];
  if (post.thumbnail?.url) {
    media.push({
      url: post.thumbnail.url,
      type: post.thumbnail.type === 'video' ? 'video' : 'image',
      role: 'logo',
    });
  }
  for (const m of post.media) {
    if (!m.url) continue;
    media.push({
      url: m.url,
      type: m.type === 'video' ? 'video' : 'image',
    });
  }

  // Makers + Hunter
  const makers: PhMakerDb[] = post.makers.map(userToMaker);
  const hunter = userToMaker(post.user);

  // Comments: separate maker_post (first by maker, by votes) vs top_comments
  const makerIdSet = new Set(post.makers.map((m) => m.id));
  const sortedComments = post.comments.edges
    .map((e) => e.node)
    .filter((c) => !c.parentId) // top-level only
    .sort((a, b) => b.votesCount - a.votesCount);

  let makerPost: PhCommentDb | null = null;
  const topComments: PhCommentDb[] = [];
  for (const c of sortedComments) {
    if (!makerPost && makerIdSet.has(c.user.id)) {
      makerPost = commentToDb(c);
      continue; // exclude from top_comments to avoid dup
    }
    topComments.push(commentToDb(c));
  }

  // Metrics
  const metrics = {
    votes: post.votesCount,
    comments: post.commentsCount,
    reviews_count: post.reviewsCount,
    reviews_avg: post.reviewsRating ?? undefined,
    // followers: API doesn't expose — front-end shows "—"
  };

  // Extra JSON
  const extra: Record<string, unknown> = {
    daily_rank: dailyRank,
    launch_date_pt: ptLaunchDate,
    product_slug: post.slug,
    ph_url: post.url,
    website_url: post.website,
    description: post.description,
    topics: post.topics.edges.map((e) => e.node.slug),
    makers,
    hunter,
    maker_post: makerPost,
    maker_post_text: makerPost?.text ?? null,
    top_comments: topComments,
    r2_migrated_at: null, // ph-r2-migrate cron will set
    // ai_summary / ai_category / is_relevant filled by ph-enrich cron
    // pricing_type / is_open_source: API doesn't expose — front-end hides chips
  };

  return {
    source_type: 'product_hunt',
    source_id: sourceId,
    title: post.name,
    content: post.tagline,
    author: post.makers[0]?.name ?? post.user.name ?? null,
    handle: post.makers[0]?.username ?? post.user.username ?? null,
    url: post.url,
    media: JSON.stringify(media),
    metrics: JSON.stringify(metrics),
    published_at: post.featuredAt,
    scraped_at: new Date().toISOString(),
    is_relevant: undefined, // NULL → triggers ph-enrich
    lang: 'en',
    extra: JSON.stringify(extra),
  } as ItemInput;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors. Note: `ItemInput` import may need `export` keyword on the interface in `worker/src/index.ts:497` — add it if typecheck complains.

- [ ] **Step 3: Commit**

```bash
git add worker/src/scrapers/ph.ts worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(ph): transformPostToIngestItem (Post → ItemInput)

字段映射对齐前端 PhCard + PhDrawerBody：
- thumbnail → media role='logo'，media[] → gallery
- makers/hunter 转成 frontend 预期的 {name,handle,avatar_url,profile_url}
- maker_post 从 top-level votes-sorted comments 里挑首条 maker 评论
- followers 字段 API 不暴露，前端 KPI 显 "—"
- pricing_type / is_open_source 同上，前端 chip 隐藏

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: runPhDailyFetch orchestrator + KV sentinel

**Files:**
- Modify: `worker/src/scrapers/ph.ts`
- Modify: `worker/src/index.ts` (insert into `metrics_snapshots_ph` table — sentry needs to import in cron later)

- [ ] **Step 1: Append runPhDailyFetch + sentinel to scrapers/ph.ts**

```typescript
// ─── Orchestrator ──────────────────────────────────────────────

import { ingestItems } from '../index';

const SENTINEL_KEY_PREFIX = 'ph:fetched:';
const SENTINEL_TTL = 60 * 60 * 24 * 2; // 2 days (allow next-day retry if today fails)

export interface PhDailyFetchResult {
  mode: 'ph-daily-fetch';
  pt_date: string;
  skipped?: 'sentinel' | 'no_credentials' | 'list_empty';
  list_size?: number;
  fetched?: number;
  ingested?: { inserted: number; updated: number; errors: number };
  duration_ms: number;
  error?: string;
}

export async function runPhDailyFetch(
  env: PhEnv,
  opts: { force?: boolean; ptDate?: string } = {},
): Promise<PhDailyFetchResult> {
  const t0 = Date.now();
  const ptDate = opts.ptDate ?? ptYesterday();
  const sentinelKey = `${SENTINEL_KEY_PREFIX}${ptDate}`;

  if (!opts.force) {
    const exists = await env.AUTH_KV.get(sentinelKey);
    if (exists) {
      return {
        mode: 'ph-daily-fetch',
        pt_date: ptDate,
        skipped: 'sentinel',
        duration_ms: Date.now() - t0,
      };
    }
  }

  if (!env.PH_CLIENT_ID || !env.PH_CLIENT_SECRET) {
    return {
      mode: 'ph-daily-fetch',
      pt_date: ptDate,
      skipped: 'no_credentials',
      duration_ms: Date.now() - t0,
    };
  }

  // 1. List query
  const listNodes = await listPhDailyPosts(env, ptDate);
  if (listNodes.length === 0) {
    console.warn(`[ph] list query returned 0 posts for PT ${ptDate}`);
    return {
      mode: 'ph-daily-fetch',
      pt_date: ptDate,
      skipped: 'list_empty',
      duration_ms: Date.now() - t0,
    };
  }
  console.log(`[ph] list query: ${listNodes.length} posts for PT ${ptDate}`);

  // 2. Per-post detail (sequential — 30 small queries, ~30-60s total)
  const items: ItemInput[] = [];
  let fetchedOk = 0;
  for (let i = 0; i < listNodes.length; i++) {
    const node = listNodes[i];
    const detail = await fetchPhPostDetail(env, node.id);
    if (!detail) {
      console.warn(`[ph] detail fetch failed for ${node.slug} (${node.id})`);
      continue;
    }
    fetchedOk++;
    const dailyRank = i + 1; // list is votes-sorted; natural rank
    items.push(transformPostToIngestItem(detail, dailyRank, ptDate));
  }

  // 3. Ingest via internal function call
  // ingestItems wants Env (DB + auth fields); PhEnv shares DB so a partial cast suffices.
  // Once Env interface includes PH_CLIENT_ID/SECRET (Task 3 Step 0), env can be passed
  // directly as Env from the dispatcher.
  const ingestResult = await ingestItems(env as unknown as Parameters<typeof ingestItems>[0], items);
  console.log(
    `[ph] ingestItems: inserted=${ingestResult.inserted} updated=${ingestResult.updated} errors=${ingestResult.errors.length}`,
  );

  // 4. Append metrics_snapshots_ph
  await appendMetricsSnapshots(env, items, ptDate);

  // 5. KV sentinel
  await env.AUTH_KV.put(sentinelKey, '1', { expirationTtl: SENTINEL_TTL });

  return {
    mode: 'ph-daily-fetch',
    pt_date: ptDate,
    list_size: listNodes.length,
    fetched: fetchedOk,
    ingested: {
      inserted: ingestResult.inserted,
      updated: ingestResult.updated,
      errors: ingestResult.errors.length,
    },
    duration_ms: Date.now() - t0,
  };
}

async function appendMetricsSnapshots(
  env: PhEnv,
  items: ItemInput[],
  ptDate: string,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const capturedAt = Math.floor(Date.now() / 1000);
  for (const item of items) {
    const id = `product_hunt:${item.source_id}`;
    const m = item.metrics as string;
    let parsed: { votes?: number; comments?: number; reviews_count?: number; followers?: number };
    try {
      parsed = JSON.parse(m);
    } catch {
      continue;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO metrics_snapshots_ph (item_id, captured_at, launch_date_pt,
                                           votes, comments, reviews_count, followers)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        capturedAt,
        ptDate,
        parsed.votes ?? null,
        parsed.comments ?? null,
        parsed.reviews_count ?? null,
        parsed.followers ?? null,
      ),
    );
  }
  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }
}
```

- [ ] **Step 2: Verify metrics_snapshots_ph schema matches**

Confirm columns:

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT sql FROM sqlite_master WHERE name='metrics_snapshots_ph'"
```

If the schema differs (column names / order), edit the INSERT in Step 1 to match. The schema was created via `worker/migrations/008-metrics-snapshots-ph.sql` — `cat` that file for reference.

- [ ] **Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/scrapers/ph.ts
git commit -m "$(cat <<'EOF'
feat(ph): runPhDailyFetch 编排器 + KV 哨兵防重

list → 30 detail (sequential) → ingestItems 内调 → metrics_snapshots_ph append → KV sentinel。
opts.force 跳过 sentinel（admin debug 触发用）。
失败任一 post detail 跳过该条不阻塞批次。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Dispatcher time-window trigger + admin endpoint

**Files:**
- Modify: `worker/src/index.ts:286-490` (scheduled handler) and routes section

- [ ] **Step 1: Read current dispatcher entry point**

Run: `sed -n '286,330p' worker/src/index.ts`
Identify where to add PH check. Pattern: per existing GH/X/CH preempt slots.

- [ ] **Step 2: Add PH daily fetch time-window check**

Insert near the top of `scheduled` handler logic (just inside the `try` block, before any preempt slot iteration):

```typescript
// ─── PH daily fetch (UTC 20:10±5min, once per PT day) ──────────
// PT yesterday was already-frozen for ~13h+ at this time, daily_rank stable.
// KV sentinel inside runPhDailyFetch keys on PT date — won't double-fire across
// the 5min window or across cron retries.
const utcHour = utc.getUTCHours();
const utcMin = utc.getUTCMinutes();
if (utcHour === 20 && utcMin >= 10 && utcMin < 15) {
  ctx.waitUntil(
    (async () => {
      try {
        const r = await runPhDailyFetch(env);
        console.log('[cron] ph-daily-fetch result:', JSON.stringify(r));
      } catch (e) {
        console.error('[cron] ph-daily-fetch error:', e);
      }
    })(),
  );
}
```

Add import at top of file:

```typescript
import { runPhDailyFetch } from './scrapers/ph';
```

- [ ] **Step 3: Add /admin/ph-fetch-now debug endpoint**

In the routes section (where other `/admin/*` endpoints live — search for `path.startsWith('/admin/')`), add:

```typescript
if (path === '/admin/ph-fetch-now' && request.method === 'POST') {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const ptDate = url.searchParams.get('pt_date') || undefined;
  const result = await runPhDailyFetch(env, { force, ptDate });
  return jsonResponse(result, 200, request, env);
}
```

> If `ADMIN_TOKEN` env name differs (look at sibling `/admin/*` handlers for the actual var), use the actual one.

- [ ] **Step 4: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(ph): dispatcher 时间窗触发 + /admin/ph-fetch-now debug endpoint

UTC 20:10-20:14 窗口内 cron tick 触发 runPhDailyFetch；
KV sentinel 防 5 分钟内多 tick 重跑 + 跨日复发兜底。
admin endpoint 支持 ?force=1 跳过 sentinel + ?pt_date=YYYY-MM-DD 指定日期回灌。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Staging E2E — manual fetch + DB verification

**Why:** Validate the full fetch path end-to-end on staging before moving to enrich/translate.

- [ ] **Step 1: Deploy to staging**

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler deploy --env staging
```

Expected: deploy success, "xlist-api-staging" updated.

- [ ] **Step 2: Trigger manual fetch via admin endpoint**

```bash
ADMIN_TOKEN=$(grep ADMIN_TOKEN /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env | cut -d= -f2)
curl -X POST "https://staging-api.ai-feeds.com/admin/ph-fetch-now?force=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -w "\nHTTP %{http_code}\n"
```

Expected response:

```json
{
  "mode": "ph-daily-fetch",
  "pt_date": "2026-05-10",
  "list_size": 30,
  "fetched": 30,
  "ingested": { "inserted": 30, "updated": 0, "errors": 0 },
  "duration_ms": 30000
}
```

> If `errors > 0` or `fetched < list_size`, tail logs (`npx wrangler tail --env staging`) and inspect failures. Common causes: GraphQL field-name mismatches (Task 4 introspection skipped or wrong), nullable field assumed required.

- [ ] **Step 3: Verify D1 rows**

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT id, title, json_extract(metrics, '$.votes') AS votes, json_extract(extra, '$.daily_rank') AS rank FROM items WHERE source_type='product_hunt' AND json_extract(extra, '$.launch_date_pt') = (SELECT json_extract(extra, '$.launch_date_pt') FROM items WHERE source_type='product_hunt' ORDER BY scraped_at DESC LIMIT 1) ORDER BY rank LIMIT 30"
```

Expected: 30 rows ordered by daily_rank 1..30, votes descending.

- [ ] **Step 4: Verify metrics_snapshots_ph**

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT COUNT(*) AS n FROM metrics_snapshots_ph WHERE captured_at > strftime('%s', 'now', '-1 hour')"
```

Expected: 30 (one snapshot per item from the fetch).

- [ ] **Step 5: Spot-check a row's full extra JSON**

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT extra FROM items WHERE source_type='product_hunt' ORDER BY scraped_at DESC LIMIT 1"
```

Sanity check the JSON manually:
- `daily_rank` ∈ [1, 30]
- `launch_date_pt` matches expected PT yesterday
- `makers` is array with name/handle/avatar_url/profile_url
- `top_comments` is array (may be empty if post has no comments)
- `maker_post` is object or null

- [ ] **Step 6: No commit (verification step only)**

If anything failed, return to Tasks 4-7 to fix and re-deploy. Otherwise proceed to Task 10.

---

### Task 10: ph-enrich (LLM classify + categorize + summarize)

**Why:** Items ingested by Task 9 have `is_relevant=NULL`. ph-enrich fills `is_relevant + ai_category + ai_summary` so feed can filter & frontend can show.

**Files:**
- Modify: `worker/src/enrich.ts` (append new function alongside existing classify/translate)

- [ ] **Step 1: Add ph-enrich function**

Append to `worker/src/enrich.ts` (after `runClassifyPending` ends, around line 1700):

```typescript
// ─── ph-enrich：DeepSeek 一次性产 is_ai + ai_category + ai_summary ───
//
// 仿 github-enrich 模式（一锅端，不走 X 流程的 classify-pending），因为 PH 跟
// GH 一样需要 ai_category；X 没有该字段所以 classify-pending 不输出。
//
// ai_category 7 类对齐前端 PH_CATEGORY_STYLE：
//   ai_agent / ai_code_editor / ai_image_gen / ai_audio /
//   ai_voice_agent / ai_data_analysis / ai_other

const PH_ENRICH_PROMPT = `你是 AI 产品分类员。判断每个 Product Hunt 产品是否 AI 相关，是 AI 相关时给出分类和一句中文解读。

输入：JSON 数组 [{idx, name, tagline, description, topics}]

判断规则：
- AI 相关：产品核心功能依赖 LLM / 图像生成 / 语音模型 / 智能体框架 / AI 工具链 / AI 基础设施
- 不 AI 相关：纯 SaaS / 运营工具 / 没有 AI 能力的功能型软件

分类（is_ai=1 时必填一个）：
- ai_agent: 智能体 / autonomous workflow / 多步任务自动化
- ai_code_editor: AI 编程编辑器 / 代码补全 / IDE 插件
- ai_image_gen: 图像生成 / 编辑 / 设计工具
- ai_audio: 音乐 / TTS / 音频编辑
- ai_voice_agent: 语音对话智能体 / call center bot
- ai_data_analysis: 数据分析 / BI / SQL 助手
- ai_other: 不在以上 6 类的 AI 产品

ai_summary（is_ai=1 时必填，中文一句话 30-60 字，说明产品是什么 + 给谁用 + 核心价值）。

输出格式：只返回一个 JSON 对象 { items: [{ idx, is_relevant, ai_category, ai_summary }, ...] }，不要任何其他文字。

输入：%INPUT%`;

export interface PhEnrichResult {
  mode: 'ph-enrich';
  selected: number;
  classified: number;
  relevant: number;
  irrelevant: number;
  duration_ms: number;
  error?: string;
}

interface PhEnrichItem {
  id: string;
  source_id: string;
  title: string | null;
  content: string | null;
  extra: string | null;
}

export async function runPhEnrich(env: EnrichEnv, limit = 10): Promise<PhEnrichResult> {
  const t0 = Date.now();
  if (!env.DEEPSEEK_API_KEY) {
    return { mode: 'ph-enrich', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: 0, error: 'no_deepseek_key' };
  }

  const rows = await env.DB.prepare(
    `SELECT id, source_id, title, content, extra
       FROM items
      WHERE source_type = 'product_hunt'
        AND deleted_at IS NULL
        AND is_relevant IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<PhEnrichItem>();

  const selected = rows.results.length;
  if (selected === 0) {
    return { mode: 'ph-enrich', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0 };
  }

  const input = rows.results.map((r, i) => {
    let extra: { description?: string; topics?: string[] } = {};
    try {
      const p = JSON.parse(r.extra || '{}');
      if (p && typeof p === 'object') extra = p;
    } catch { /* noop */ }
    return {
      idx: i,
      name: r.title || '',
      tagline: r.content || '',
      description: (extra.description || '').slice(0, 400),
      topics: (extra.topics || []).slice(0, 5),
    };
  });
  const prompt = PH_ENRICH_PROMPT.replace('%INPUT%', JSON.stringify(input));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res: Response;
  try {
    res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat', // deepseek-v4-flash alias
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: `http_${res.status}` };
  }

  let parsed: { items?: Array<{ idx: number; is_relevant: 0 | 1; ai_category?: string | null; ai_summary?: string }> };
  try {
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content || '{}';
    parsed = JSON.parse(content);
  } catch {
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'json_parse' };
  }

  let classified = 0;
  let relevant = 0;
  let irrelevant = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const out of parsed.items || []) {
    const row = rows.results[out.idx];
    if (!row) continue;
    const isAi = out.is_relevant === 1 ? 1 : 0;
    const cat = isAi ? (out.ai_category || 'ai_other') : null;
    const summary = isAi ? (out.ai_summary || '') : '';
    classified++;
    if (isAi) relevant++; else irrelevant++;
    stmts.push(
      env.DB.prepare(
        `UPDATE items
            SET is_relevant = ?,
                matched_by = COALESCE(matched_by, 'ph-enrich'),
                extra = json_set(coalesce(extra, '{}'),
                                 '$.ai_category', ?,
                                 '$.ai_summary', ?)
          WHERE id = ?`,
      ).bind(isAi, cat, summary, row.id),
    );
  }
  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[ph-enrich] batch error:', e);
      return { mode: 'ph-enrich', selected, classified, relevant, irrelevant, duration_ms: Date.now() - t0, error: 'batch_error' };
    }
  }
  return { mode: 'ph-enrich', selected, classified, relevant, irrelevant, duration_ms: Date.now() - t0 };
}
```

- [ ] **Step 2: Add admin endpoint for manual ph-enrich trigger (debug)**

In `worker/src/index.ts` admin section:

```typescript
if (path === '/admin/ph-enrich-now' && request.method === 'POST') {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request, env);
  }
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);
  const r = await runPhEnrich(env, limit);
  return jsonResponse(r, 200, request, env);
}
```

Add import:

```typescript
import { runPhEnrich } from './enrich';
```

- [ ] **Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/enrich.ts worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(ph): runPhEnrich (DeepSeek 一次出 is_ai + ai_category + ai_summary)

仿 github-enrich 模式，prompt 针对 PH 产品（喂 name+tagline+description+topics）。
ai_category 枚举对齐前端 PH_CATEGORY_STYLE 7 类。
admin endpoint /admin/ph-enrich-now 手动触发用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Dispatcher ph-enrich preempt slot + Staging E2E

**Files:**
- Modify: `worker/src/index.ts` (dispatcher preempt section)

- [ ] **Step 1: Add ph-enrich preempt slot**

Find the GH preempt slot pattern (around line 350, search for `github-enrich`). Add a sibling block for PH:

```typescript
// PH enrich pending — 抢占 cron slot；每 tick 10 个 item，30 个/天 ~3 tick 完成。
const phEnrichPending = await env.DB.prepare(
  `SELECT COUNT(*) AS n FROM items
    WHERE source_type='product_hunt' AND is_relevant IS NULL`,
).first<{ n: number }>();
if ((phEnrichPending?.n ?? 0) > 0) {
  const r = await runPhEnrich(env, 10);
  console.log(`[cron] ph-enrich (preempt, ${phEnrichPending?.n} pending) result:`, JSON.stringify(r));
  return; // single-mode-per-tick, same as GH preempt pattern
}
```

> Place it in the same priority position as `github-enrich` — they should run BEFORE `fill-translations` for the cost-saving rationale (don't translate if not AI relevant).

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Deploy + verify**

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler deploy --env staging
```

Trigger 1 manual enrich pass:

```bash
curl -X POST "https://staging-api.ai-feeds.com/admin/ph-enrich-now?limit=30" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected response:

```json
{
  "mode": "ph-enrich",
  "selected": 30,
  "classified": 30,
  "relevant": 18,
  "irrelevant": 12,
  "duration_ms": 8000
}
```

> Numbers vary; key signal: `selected == limit`, `classified > 0`, no `error` field.

- [ ] **Step 4: Verify DB updated**

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT title, is_relevant, json_extract(extra, '$.ai_category') AS cat, json_extract(extra, '$.ai_summary') AS summary FROM items WHERE source_type='product_hunt' AND is_relevant IS NOT NULL ORDER BY scraped_at DESC LIMIT 10"
```

Expected: rows have is_relevant ∈ {0,1}, ai_category populated when is_relevant=1, ai_summary readable Chinese.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(ph): dispatcher 加 ph-enrich 抢占 slot

跟 github-enrich 同优先级位置，跑在 fill-translations 之前 —
非 AI item is_relevant=0 → 不进 fill-translations 循环 → 省 DeepSeek 翻译额度。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: fill-translations 扩展支持 PH

**Files:**
- Modify: `worker/src/enrich.ts:2200-2350` (selectTranslationCandidates + extractTasks + writeback)

- [ ] **Step 1: Read current SQL + extractTasks structure**

Run: `sed -n '2195,2310p' worker/src/enrich.ts`
Identify the X-only `WHERE source_type = 'x_list'` clauses and the X-only TaskField enum.

- [ ] **Step 2: Extend TaskField enum**

Find the type around line 2178:

```typescript
type TaskField =
  | "content"
  | "quote_of"
  | "link_card_title"
  | "link_card_desc";
```

Extend to:

```typescript
type TaskField =
  | "content"
  | "quote_of"
  | "link_card_title"
  | "link_card_desc"
  | "ph_maker_post"
  | "ph_top_comment";
```

- [ ] **Step 3: Extend TranslationTask shape**

Add `commentIdx?: number` to disambiguate which top_comment is being translated:

```typescript
interface TranslationTask {
  itemId: string;
  field: TaskField;
  text: string;
  commentIdx?: number; // for ph_top_comment: index into extra.top_comments[]
}
```

- [ ] **Step 4: Extend selectTranslationCandidates SQL**

In the existing SQL (around line 2204), expand WHERE to include PH:

```typescript
const rows = await env.DB.prepare(
  `SELECT id, source_id, content, lang, content_translated, extra, source_type
     FROM items
     WHERE is_relevant = 1
       AND (
         (
           source_type = 'x_list'
           AND (
             (content_translated IS NULL AND (lang IS NULL OR lang != 'zh') AND content IS NOT NULL)
             OR (json_extract(extra, '$.quote_of.content') IS NOT NULL AND json_extract(extra, '$.quote_of.content_translated') IS NULL)
             OR (json_extract(extra, '$.link_card.title') IS NOT NULL AND json_extract(extra, '$.link_card.title_translated') IS NULL)
             OR (json_extract(extra, '$.link_card.description') IS NOT NULL AND json_extract(extra, '$.link_card.description_translated') IS NULL)
           )
         )
         OR (
           source_type = 'product_hunt'
           AND (
             (content_translated IS NULL AND content IS NOT NULL)
             OR (json_extract(extra, '$.maker_post_text') IS NOT NULL AND json_extract(extra, '$.maker_post_translated') IS NULL)
             OR (
               json_extract(extra, '$.top_comments') IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(json_extract(extra, '$.top_comments')) AS c
                 WHERE json_extract(c.value, '$.text') IS NOT NULL
                   AND json_extract(c.value, '$.translated') IS NULL
               )
             )
           )
         )
       )
     ORDER BY
       CASE WHEN content_translated IS NULL THEN 0 ELSE 1 END,
       RANDOM()
     LIMIT ?`,
)
  .bind(fetchBatch)
  .all<TranslationRow>();
return rows.results;
```

Update `TranslationRow` interface to include `source_type`:

```typescript
interface TranslationRow {
  id: string;
  source_id: string;
  content: string | null;
  lang: string | null;
  content_translated: string | null;
  extra: string | null;
  source_type: string;
}
```

- [ ] **Step 5: Extend extractTasks**

After the existing X-flow logic (after the `link_card_desc` branch), add PH branches. Wrap PH-specific code so X items don't accidentally trigger:

```typescript
// PH-specific extraction
if (row.source_type === 'product_hunt') {
  // tagline (content) — same logic as X but no language check (PH content is en)
  // already handled above by the generic content branch IF we keep it source-agnostic.
  // Verify: existing content branch checks `row.lang !== 'zh'` — PH lang is 'en', passes.

  // maker_post_text → maker_post_translated
  const mpText = extra.maker_post_text as string | null | undefined;
  const mpTr = extra.maker_post_translated as string | null | undefined;
  if (mpText && !mpTr && !isLikelyChinese(mpText)) {
    tasks.push({ itemId: row.id, field: 'ph_maker_post', text: mpText });
  }
  // top_comments[].text → top_comments[].translated
  const topComments = extra.top_comments as Array<{ text?: string; translated?: string }> | undefined;
  if (Array.isArray(topComments)) {
    topComments.forEach((c, i) => {
      if (c.text && !c.translated && !isLikelyChinese(c.text)) {
        tasks.push({ itemId: row.id, field: 'ph_top_comment', text: c.text, commentIdx: i });
      }
    });
  }
}
```

- [ ] **Step 6: Extend writeback (UPDATE) logic**

Find the UPDATE-by-task code block (search for `UPDATE items SET content_translated`). Add PH branches:

```typescript
// Existing X branches: content / quote_of / link_card_title / link_card_desc
// Add PH branches:
} else if (task.field === 'ph_maker_post') {
  stmts.push(
    env.DB.prepare(
      `UPDATE items
          SET extra = json_set(coalesce(extra, '{}'), '$.maker_post_translated', ?)
        WHERE id = ?`,
    ).bind(translated, task.itemId),
  );
} else if (task.field === 'ph_top_comment') {
  if (task.commentIdx === undefined) continue;
  stmts.push(
    env.DB.prepare(
      `UPDATE items
          SET extra = json_set(coalesce(extra, '{}'), '$.top_comments[' || ? || '].translated', ?)
        WHERE id = ?`,
    ).bind(task.commentIdx, translated, task.itemId),
  );
}
```

> SQLite json_set path with `[' || ? || ']` for dynamic index — verify SQLite version supports this. Alternative: read full top_comments array, mutate at index, write back whole array. If json_set with bind-param indexing fails, switch to that approach.

- [ ] **Step 7: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Deploy + Staging E2E**

```bash
cd worker && npx wrangler deploy --env staging
```

Wait 5-10 minutes for cron to pick up; or trigger via existing `/admin` translation endpoint if available.

Verify:

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT title, content_translated, json_extract(extra, '$.maker_post_translated') AS mp_tr, json_extract(extra, '$.top_comments[0].translated') AS c0_tr FROM items WHERE source_type='product_hunt' AND is_relevant=1 ORDER BY scraped_at DESC LIMIT 5"
```

Expected: content_translated populated; maker_post_translated populated when maker_post_text non-null; top_comments[0].translated populated.

- [ ] **Step 9: Commit**

```bash
git add worker/src/enrich.ts
git commit -m "$(cat <<'EOF'
feat(ph): fill-translations 扩展支持 PH 字段

SELECT WHERE 加 PH 分支（仅翻译 is_relevant=1）；
extractTasks 加 ph_maker_post + ph_top_comment 字段；
UPDATE 写回 extra.maker_post_translated + extra.top_comments[i].translated。

X 流程零变更（OR 分组隔离 source_type）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ph-r2-migrate 验证（dispatcher 已接，无新代码）

**Why:** worker/src/ph-r2.ts and its dispatcher slot already exist. Just verify it processes the new PH items end-to-end on staging.

- [ ] **Step 1: Wait + monitor**

Wait ~5 minutes after Task 12 commit. ph-r2-migrate is preempt-1-per-tick, so 30 PH items × 1 tick / 5min = 30 ticks ≈ 2.5 hours to fully migrate.

For impatience, tail logs:

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler tail --env staging --format pretty | grep -i "ph-r2"
```

Expected: messages like `[cron] ph-r2-migrate (preempt, N pending) result: ...`.

- [ ] **Step 2: Verify migration**

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --config worker/wrangler.toml \
  --command="SELECT title, json_extract(extra, '$.r2_migrated_at') AS r2at, media FROM items WHERE source_type='product_hunt' ORDER BY scraped_at DESC LIMIT 5"
```

Expected (eventually): `r2at` non-null, `media` URLs rewritten to `/r/ph/<sha>` form.

- [ ] **Step 3: No commit**

This is verification only.

---

### Task 14: Frontend graceful-degradation verification

**Why:** Spec § 4.2 says missing API fields (top_reviews / pricing / open_source / followers) should already be hidden via existing `&&` conditional rendering. Verify on staging dashboard.

- [ ] **Step 1: Deploy dashboard to staging (if not already on latest main)**

```bash
cd dashboard && npm install && npm run build
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
npx wrangler pages deploy dist --project-name=xlist-dashboard --branch=staging
```

> If dashboard already on latest main from another session, just open https://staging.ai-feeds.com — no deploy needed.

- [ ] **Step 2: Visual smoke check**

Open https://staging.ai-feeds.com in a browser. Confirm:
- [ ] PH cards render in feed (logo + name + tagline + votes/comments + makers)
- [ ] PH category chip shows correct color (matches PH_CATEGORY_STYLE)
- [ ] Click a PH card → drawer opens
- [ ] Drawer header: name + tagline + launch_date + #rank + category chip
- [ ] KPI row: votes / comments / reviews_avg-or-"—" / followers shows "—" (API missing)
- [ ] Gallery scrolls with images (and video if any)
- [ ] AI 解读 (ai_summary) section renders
- [ ] Maker post (if present) shows with translate toggle
- [ ] Team & Hunter section shows avatars + names
- [ ] Top Reviews section: **hidden** (no top_reviews data)
- [ ] Top 评论 section: shows top_comments with translate toggle
- [ ] More section: PH forum + alternatives links present, **no pricing chip**, **no open-source chip**

- [ ] **Step 3: If polish needed**

If any visual breakage (layout collapse, errors in console), edit `dashboard/src/components/PhDrawerBody.tsx`. Common likely fixes:
- KPI row "followers" cell shows literal "undefined" instead of "—": tighten the conditional `value={metrics.followers && metrics.followers > 0 ? formatCompact(metrics.followers) : "—"}` (already this pattern, verify)
- Empty top_reviews array (vs undefined) might still render header: change `topReviews.length > 0 &&` to truthy check (already this pattern)

If no changes needed, skip to Step 5.

- [ ] **Step 4: Commit polish (if any)**

```bash
git add dashboard/src/components/PhDrawerBody.tsx
git commit -m "$(cat <<'EOF'
fix(dashboard): PhDrawerBody 缺失字段优雅降级 polish

API-side PH 不暴露 top_reviews / pricing_type / is_open_source / followers，
原 && 条件已基本覆盖，本次微调实际撞到的 edge case（按 commit diff 自描述）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: No further commit if no changes**

---

### Task 15: CLAUDE.md 项目身份卡修订

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find PH-related lines in CLAUDE.md**

```bash
grep -n -i "product hunt\|product_hunt\|ph\b\|convex" CLAUDE.md | head -20
```

Identify the project ID card (top of file) and "数据源现状" lines.

- [ ] **Step 2: Edit身份卡 data sources line**

Use Edit tool to change:

OLD:
```
> - **数据源现状（4 个）**：X 走 ScrapeBadger API / GitHub trending 走 GH / Product Hunt 走 Convex / ClawHub 走 Convex
```

NEW:
```
> - **数据源现状（4 个）**：X 走 ScrapeBadger API / GitHub trending 走 GH API / Product Hunt 走 PH GraphQL API + worker cron / ClawHub 走 Convex
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude.md): 身份卡刷新 PH 数据源 — Convex → PH GraphQL API

Convex 描述早过时；本次 PR 把 PH 完整迁到 worker GraphQL 流程。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: docs/operations.md 同步

**Files:**
- Modify: `docs/operations.md`

- [ ] **Step 1: Read current PH-related operations content**

```bash
grep -n -i "product hunt\|ph\b\|product_hunt" docs/operations.md
```

Identify any old browser-use scraper section (likely under "本地服务" / "launchd" subsection).

- [ ] **Step 2: Add new "PH 数据抓取" section under 远端服务 / Worker cron**

Insert (placement: after GitHub trending section if present, else under "Worker / D1" section):

```markdown
### Product Hunt（PH GraphQL + worker cron）

**调度**：单一 `*/5 * * * *` cron + dispatcher 时间窗（UTC 20:10-20:14 = 北京 04:10），抓 PT yesterday top 30。

**Endpoints / Functions**：
- `runPhDailyFetch`（worker/src/scrapers/ph.ts）：list + 30 detail + ingestItems + metrics_snapshots_ph + KV sentinel
- `runPhEnrich`（worker/src/enrich.ts）：DeepSeek 一次出 is_ai/ai_category/ai_summary（ph-enrich 抢占 slot）
- `fill-translations`（已有，扩展支持 PH 字段）：仅翻译 is_relevant=1 的 PH item
- `ph-r2-migrate`（worker/src/ph-r2.ts）：logo/gallery/avatar 迁 R2

**Secrets**（CF Worker bindings）：
- `PH_CLIENT_ID`：PH OAuth application ID
- `PH_CLIENT_SECRET`：PH OAuth application secret
- 凭证再生：https://www.producthunt.com/v2/oauth/applications → 项目 → Regenerate Secret →
  `printf '<NEW_SECRET>' | npx wrangler secret put PH_CLIENT_SECRET --env staging --config worker/wrangler.toml`
  （prod 同样命令去掉 `--env staging`）

**手动触发**：

```bash
# 立即抓 PT yesterday（force=1 跳过 KV sentinel）
curl -X POST "https://staging-api.ai-feeds.com/admin/ph-fetch-now?force=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 指定日期回灌
curl -X POST "https://staging-api.ai-feeds.com/admin/ph-fetch-now?force=1&pt_date=2026-05-09" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 立即跑一次 ph-enrich（队列还有 pending 时）
curl -X POST "https://staging-api.ai-feeds.com/admin/ph-enrich-now?limit=30" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**查日志**：

```bash
source .secrets/cf-claude-ops.env
cd worker && npx wrangler tail --env staging --format pretty | grep -i "ph-"
```

**临时关停 PH（出问题时）**：在 worker/src/index.ts dispatcher 时间窗判断改成 `if (false && utcHour === 20 ...)` redeploy。
```

- [ ] **Step 3: Mark old browser-use scraper section as deprecated**

If `docs/operations.md` mentions the old `scrapers/ph/` cron via launchd, add an inline note:

```markdown
> **已退役 2026-05-11**：本节描述的本地 browser-use PH 抓取工作流已被 worker GraphQL cron 取代。
> 见 [`2026-05-11-ph-graphql-cf-cron-design.md`](plans/2026-05-11-ph-graphql-cf-cron-design.md)。
> 旧 scraper 代码与 launchd agent 在主 PR 上 prod 稳定 ≥7 天后才删除（M8 安全期 PR）。
```

- [ ] **Step 4: Commit**

```bash
git add docs/operations.md
git commit -m "$(cat <<'EOF'
docs(ops): 加 PH worker cron 段 + 标注旧 launchd scraper 退役状态

cron 时间表 / 手动触发 / 查日志 / secret 再生 / 临时关停。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: TODO.md 同步

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Find PH-related items**

```bash
grep -n -i "product hunt\|ph\|browser-use" TODO.md
```

- [ ] **Step 2: Strike completed items, add new follow-ups**

Use Edit tool to:
- ✅ 把"PH browser-use 抓取"这类条目标记 `[x]` 完成（迁到 worker GraphQL）
- 新增条目：
  ```markdown
  - [ ] PH 安全期 PR (≥7 天后)：删除 scrapers/ph/ + launchd unload + docs/archive/ph-scraper-retired.md
  - [ ] PH lazy-enrich-on-drawer：补完 worker/src/enrich.ts:242 的 product_hunt stub（drawer 点开时刷 metrics）
  - [ ] PH client_credentials secret 在 chat 暴露 → 上 prod 前去 PH dashboard regenerate API Secret
  ```

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "$(cat <<'EOF'
docs(todo): PH 主 PR 完成 + 新增 3 个延迟 follow-up

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: 旧设计文档加 deprecated 横幅

**Files:**
- Modify: `docs/plans/2026-05-03-product-hunt-source-design.md`

- [ ] **Step 1: Edit top of file**

Add immediately after the `# Product Hunt 源接入设计` line:

```markdown
> ⚠️ **此设计已被 [2026-05-11-ph-graphql-cf-cron-design.md](2026-05-11-ph-graphql-cf-cron-design.md) 替代**。
> 本文档保留作历史参考——本地 browser-use 方案已退役，PH 改走 GraphQL API + CF Worker cron。
```

- [ ] **Step 2: Commit**

```bash
git add docs/plans/2026-05-03-product-hunt-source-design.md
git commit -m "$(cat <<'EOF'
docs(ph): 旧设计文档加 deprecated 横幅指向新设计

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: wrangler.toml [browser] binding 评估

**Why:** PH 不再用 CF Browser Rendering（旧 browser-use → worker fetch 换掉了）。如果其他源也不用，删掉 [browser] binding 释放 paid plan 浏览器时长配额。

**Files:**
- Modify: `worker/wrangler.toml` (only if no other source uses BROWSER)

- [ ] **Step 1: 搜全 worker/src/ 看 BROWSER binding 用法**

```bash
grep -rn "env\.BROWSER\|BROWSER:" worker/src/
```

- [ ] **Step 2: 决策**

- 如果**全无引用**（仅 wrangler.toml 声明了但代码里没人用）→ 删 `[browser]` 和 `[env.staging.browser]`
- 如果有引用（其他源 / POC 残留）→ 留着 + 加注释说明用途

- [ ] **Step 3: 如选择删除**

Use Edit tool on `worker/wrangler.toml`：

OLD:
```toml
# CF Browser Rendering — used by PH source scraper (POC + Phase 2).
# Workers Paid Plan 月含 10h 浏览器时间，PH 抓取月度预估 ~5h。
[browser]
binding = "BROWSER"
```

NEW: delete those 4 lines. Same for `[env.staging.browser]` in staging env.

- [ ] **Step 4: Typecheck (确认 worker 编译)**

```bash
cd worker && npx tsc --noEmit
```

- [ ] **Step 5: Deploy staging + smoke test 1 cron tick**

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler deploy --env staging
```

Wait 6 minutes (1 cron tick), tail log to confirm no `BROWSER` related errors.

- [ ] **Step 6: Commit (only if changed)**

```bash
git add worker/wrangler.toml
git commit -m "$(cat <<'EOF'
chore(worker): 删 [browser] binding（PH 走 GraphQL 后无源使用 CF Browser）

释放 paid plan 月度 ~10h 浏览器时长配额。
如未来重新需要 CF Browser 抓取，单独 PR 加回。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Prod 上线 + 监控

**Why:** 主 PR 终点。Staging 全绿后才走这步。

- [ ] **Step 1: Pre-flight check**

```bash
git status                     # 应该 clean
git log --oneline main..HEAD   # 列本 PR 所有 commit
git rev-parse HEAD             # 当前 commit
```

确认：
- 所有 task commit 都在
- 没有未 commit 的 working tree 改动

- [ ] **Step 2: Push branch + 开 PR (如果有 GitHub remote)**

```bash
git push -u origin worktree-feat+ph-api-cf-cron
gh pr create --title "feat(ph): 抓取迁移本地 browser-use → CF Worker + PH GraphQL API" \
  --body "$(cat <<'EOF'
## Summary

- PH 从本地 browser-use Python scraper 迁到 CF Worker + PH GraphQL API + 现有 cron 调度
- 复用 worker dispatcher (`*/5` + 抢占)，新增 PH 时间窗触发（UTC 20:10 抓 PT yesterday top 30）
- ph-enrich (DeepSeek classify) → fill-translations (扩展支持 PH 字段) → ph-r2-migrate 接力
- 缺失字段 (top_reviews / pricing / is_open_source / followers) 前端优雅降级
- 旧 scraper 退役延迟到主 PR prod 稳定 ≥7 天后另起 PR (M8)

## Design

- [docs/plans/2026-05-11-ph-graphql-cf-cron-design.md](docs/plans/2026-05-11-ph-graphql-cf-cron-design.md)

## Test plan

- [x] Staging E2E：fetch → enrich → translate → r2-migrate 全跑通
- [x] 30 PH item ingest 成功，daily_rank 正确
- [x] DeepSeek classify 给出合理 ai_category + ai_summary
- [x] tagline / maker_post / top_comments 翻译成中文
- [x] media URL 迁到 R2 (/r/ph/<sha>)
- [x] Frontend 缺失字段优雅降级 (top_reviews 段隐藏、pricing chip 隐藏、followers 显 "—")
- [ ] Prod 首日自动 cron 触发 (UTC 20:10 / 北京次日 04:10) 验证

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 等 PR review + merge**

阻塞步骤——等用户/CI review。

- [ ] **Step 4: 注入 prod secrets（PR merge 前可以提前做）**

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
printf '<CLIENT_ID>'     | npx wrangler secret put PH_CLIENT_ID --config worker/wrangler.toml
printf '<CLIENT_SECRET>' | npx wrangler secret put PH_CLIENT_SECRET --config worker/wrangler.toml
```

> 这一步 auto-mode classifier 会拦（prod 写动作）— 需要用户明确授权。
> ⚠️ **强烈建议先去 PH dashboard regenerate API Secret 一次**，因为旧 secret 在 chat 里暴露过。

- [ ] **Step 5: Merge → CICD deploy → prod 验证**

merge 后 GitHub Actions 自动 deploy worker + dashboard 到 prod。等 CI 绿。

- [ ] **Step 6: 等首次 prod cron 触发**

UTC 20:10（北京次日 04:10）首次自动跑。监控：

```bash
source /Users/roxor/brain/30-projects/aifeeds/.secrets/cf-claude-ops.env
cd worker && npx wrangler tail --format pretty | grep -i "ph-"
```

期望：`[cron] ph-daily-fetch result: { ... fetched: 30, ingested: { inserted: 30 ... } }`

- [ ] **Step 7: 次日 verify prod feed**

打开 https://ai-feeds.com，看新一批 PH item：
- daily_rank 1-30 完整
- 翻译质量 OK
- ai_category 分布合理
- 视觉无破图

- [ ] **Step 8: Mark TODO 安全期定时器**

更新 TODO.md：

```markdown
- [ ] PH 安全期 PR：M8 旧 scraper 退役（**最早 2026-05-XX 后**，主 PR prod 稳定 ≥7 天）
```

- [ ] **Step 9: 不 commit（PR 已 merged）**

End of main PR.

---

## Self-Review Checklist

After plan complete, verify:

**Spec coverage:**
- [x] M1 worker fetch 主流程 → Task 3-8
- [x] M2 ingestItems 暴露 → Task 1
- [x] M3 ph-enrich 实现 → Task 10-11
- [x] M4 fill-translations 扩展 → Task 12
- [x] M5 ph-r2 改名 + 接 dispatcher → Task 2 + Task 13 验证
- [x] M6 前端优雅降级验证 → Task 14
- [x] M7 PH OAuth secret 注入 → 已在 Brainstorming 阶段完成 staging；prod 在 Task 20 Step 4
- [ ] M8 旧 scraper 退役 → **延迟 PR**，本计划不含
- [x] M9 文档同步 → Task 15-18
- [x] M10 wrangler.toml 收尾 → Task 19

**Placeholder scan:**
- 所有 step 有完整代码块或具体命令
- 没有 "TBD" / "implement later" / "fill in details"
- 错误处理路径明确（401 retry / sentinel skip / 凭证缺失 noop）

**Type consistency:**
- `ItemInput` (worker/src/index.ts) 所有 task 一致
- `EnrichEnv` (worker/src/enrich.ts:14) ph-enrich 使用一致
- `PhEnv` interface 在 scrapers/ph.ts 内一致
- `ai_category` 7 类枚举：transform → ph-enrich prompt → 前端 PH_CATEGORY_STYLE 三处对齐
- `source_type === 'product_hunt'` 字面量一致（不是 'ph' 也不是 'producthunt'）

> Plan complete. End of doc.
