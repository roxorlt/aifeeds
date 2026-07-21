# Item Cursor Compatibility Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every ordinary or feed-ranking cursor emitted from a valid D1 TEXT ordering key readable by the same Worker version, while retaining strict fail-closed cursor validation.

**Architecture:** Keep the raw D1 ordering value in the cursor because keyset pagination compares the bound cursor to the same TEXT column. Extend only the ordering-time validator with a strict SQLite datetime grammar (`YYYY-MM-DD HH:mm:ss[.fraction]`) alongside the existing RFC3339 grammar, then reuse the existing calendar-component validation. Frozen ranking clocks remain canonical `toISOString()` values.

**Tech Stack:** Cloudflare Worker, TypeScript, Vitest, D1-compatible SQLite fixtures.

---

### Task 1: Freeze the production regression

**Files:**
- Modify: `worker/src/list-query.integration.test.ts`

**Step 1: Write the failing test**

Add an ordinary X-list fixture whose `scraped_at` is `2026-07-17 02:25:50`. Assert that:

- the first response emits `v2|1|2026-07-17 02:25:50|x_list:sqlite-time`;
- feeding that exact cursor into the next request returns 200;
- the keyset query binds the unchanged SQLite datetime twice.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
cd worker
npx vitest run src/list-query.integration.test.ts -t "SQLite datetime"
```

Expected: FAIL because the second request returns `400 invalid_cursor`.

### Task 2: Accept only valid server-emitted SQLite datetime keys

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/list-query.integration.test.ts`

**Step 1: Implement the minimal validator change**

Add a strict SQLite datetime regular expression with the same captured calendar fields as the RFC3339 expression. In `isCursorSortTime`, accept a match from either grammar, retain all existing component/calendar checks, and validate SQLite values by parsing their `T...Z` equivalent.

Do not loosen `isCanonicalCursorTime`; hot/feed frozen ranking clocks must remain canonical ISO UTC.

**Step 2: Add invalid SQLite datetime cases**

Extend the fail-closed table with impossible dates, missing zero padding, timezone suffixes on the space form, and trailing text.

**Step 3: Run focused and adjacent tests**

Run:

```bash
cd worker
npx vitest run src/list-query.integration.test.ts src/list-query.test.ts src/list-query-plan.test.ts
```

Expected: all pass.

### Task 3: Verify Worker integrity and document the incident

**Files:**
- Modify: `TODO.md`
- Modify: `docs/plans/2026-07-17-item-cursor-compatibility-fix.md`

**Step 1: Record root cause and rollout checks**

Document the producer/consumer mismatch, exact accepted formats, and the requirement to replay a server-emitted cursor on staging and production. Keep the urgent PR scoped away from `docs/operations.md`: touching that file triggers the existing performance-ops suite, whose Linux fixtures currently fail independently on hard-coded `/private/tmp` and unreadable `/proc/1/fd`.

**Step 2: Run Worker gates**

Run:

```bash
cd worker
npx tsc --noEmit
npm test
npx wrangler deploy --dry-run
```

Expected: all pass.

**Step 3: Review and commit**

Check `git diff --check`, staged gitleaks, and the exact changed-file list before committing.

### Task 4: Staging and production verification

**Files:**
- No source changes expected.

**Step 1: Deploy the exact commit to staging**

Use the repository staging Worker workflow or the documented Wrangler command with the complete staging environment file.

**Step 2: Replay an emitted staging cursor**

Request the first X-list page, extract `next_cursor`, replay it unchanged, and require:

- first and second response status 200;
- non-empty, non-overlapping item IDs;
- no `invalid_cursor`;
- no new 5xx.

**Step 3: Merge through `main` and verify production**

After staging is green, merge the reviewed commit through `main`, wait for the production Worker workflow, then repeat the same read-only two-page probe against `https://api.ai-feeds.com`.

### Execution record (2026-07-17)

- Regression test first failed with page two `400 invalid_cursor`, then passed after the minimal validator change.
- Focused tests, full Worker suite (761 tests), TypeScript, Wrangler dry-run, gitleaks, and PR Worker CI passed.
- PR: `#182`; staging Worker version: `57b55b48-c5ea-4609-8964-eef12e48363e`.
- Staging pre-deploy strict SQLite cursor probe: `400 invalid_cursor`.
- Staging post-deploy probes: valid SQLite cursor `200`; impossible date `400 invalid_cursor`; a cursor emitted by the staging Worker replayed at `200` with non-empty pages and zero overlapping IDs.
- Staging had no items in the default seven-day window, so the first page used a strict synthetic boundary to expose older rows; the second page replayed the Worker-emitted cursor unchanged.
- PR `#182` merged to main as `c2aad3699d135dc4c827b7f8c6d47f7be5522a75`; Deploy Worker run `29567092210` passed validation, dry-run, dashboard smoke, and production deployment.
- The first public replay immediately after the workflow completed still returned the old `400`, while a direct origin-gated Worker replay was already `200`. After the short propagation window, the same public URL returned `200`; response headers did not prove an nginx cache hit, so this is recorded as transient propagation rather than a confirmed cache incident.
- Final production standard-URL replay passed without cache-busting parameters: page one `200` with 12 items, page two `200` with 15 items, `invalid_cursor` absent, and zero overlapping IDs.
- All tasks in this cursor compatibility plan are complete.
