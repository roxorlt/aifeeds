# Admin Analytics Bot Filter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop declared crawler traffic from entering browser telemetry and make DAU, returning-user, performance, and error panels use one consistent human-traffic definition.

**Architecture:** Add one shared traffic-classification module with a runtime declared-crawler classifier and a broader SQLite non-human expression. Telemetry ingest returns a successful no-op for declared crawlers so browser queues do not retry; admin SQL additionally excludes unmarked browser automation so historical charts become correct without deleting production data. Explicit `traffic_kind=synthetic` performance probes remain available in the synthetic cohort even when they use browser automation.

**Tech Stack:** Cloudflare Workers, TypeScript, D1/SQLite, Vitest.

---

### Task 1: Reproduce crawler ingestion and metric drift

**Files:**
- Modify: `worker/src/performance-analytics.test.ts`

**Step 1: Write the failing ingest test**

Add a `handleTrack` request whose UA contains `meta-externalagent/1.1`, make the fake DB throw if `prepare` or `batch` is reached, and assert a `200` JSON no-op response.

**Step 2: Write the failing metric consistency test**

Use an in-memory SQLite `events` table with one returning human, one new human, and one Meta crawler that has impressions, a session longer than five seconds, and a `403` API error. Query `overview`, `returning`, `errors`, and `error-trend` through `handleAdminAnalytics`; assert both DAU surfaces return two humans and no crawler 403 appears.

**Step 3: Extend the performance cohort test**

Add `ua` to the fixture schema. Assert a Meta UA with an engagement event is excluded from `all_clean`/`engaged`, while an explicitly marked synthetic browser remains in `synthetic`.

**Step 4: Run tests to verify RED**

Run: `cd worker && npx vitest run src/performance-analytics.test.ts`

Expected: FAIL because crawler telemetry is written and existing admin queries include it.

### Task 2: Add the shared runtime and SQL classifier

**Files:**
- Create: `worker/src/analytics-traffic.ts`
- Modify: `worker/src/track.ts`
- Modify: `worker/src/admin-dashboard.ts`

**Step 1: Implement the minimal classifier**

Add a pure `isAnalyticsCrawlerUserAgent(ua)` helper for ingest no-op, plus `analyticsCrawlerUaSql(column)` and `analyticsNonHumanUaSql(column)` expressions. The broader admin expression includes HeadlessChrome/Playwright/Puppeteer, while ingest does not drop automation; this preserves explicit synthetic RUM and excludes unmarked SEO automation from human metrics.

**Step 2: Stop future crawler ingestion**

In `handleTrack`, after the request-size guard and before JSON parsing or D1 access, return `{accepted:0,rejected:0,filtered:'crawler'}` with HTTP 200 for classified crawler UAs.

**Step 3: Unify historical metric filters**

Use the shared SQL expression inside `REAL_USER_DEVICE_CTE`, the `all_clean`/`engaged` performance cohorts, `metricErrors`, and `metricErrorTrend`. Keep the explicit synthetic cohort unchanged.

**Step 4: Run focused tests to verify GREEN**

Run: `cd worker && npx vitest run src/performance-analytics.test.ts`

Expected: PASS.

### Task 3: Document the production incident and rollout boundary

**Files:**
- Modify: `TODO.md`
- Modify: `docs/operations.md`

**Step 1: Record the root cause and data policy**

Document that Meta crawler rendering of legacy `/t/:id` routes polluted DAU and error metrics because the old five-second/interaction heuristic treated rendered bots as humans while returning metrics separately filtered UA. State that historical rows are retained but excluded at query time.

**Step 2: Record validation and release status**

Add the focused/full test commands and make clear that no staging or production deployment occurred in this task.

### Task 4: Verify the branch

**Files:**
- Review all changed files.

**Step 1: Run focused tests**

Run: `cd worker && npx vitest run src/performance-analytics.test.ts`

**Step 2: Run Worker regression tests**

Run: `cd worker && npm test`

**Step 3: Run TypeScript validation**

Run: `cd worker && npx tsc --noEmit`

**Step 4: Run production read-only counterfactual SQL**

Compare today's current dashboard counts with the shared crawler-exclusion expression using `wrangler d1 execute --remote`; perform no writes.

**Step 5: Review the diff**

Run: `git diff --check && git status --short --branch && git diff --stat && git diff -- worker/src/analytics-traffic.ts worker/src/track.ts worker/src/admin-dashboard.ts worker/src/performance-analytics.test.ts TODO.md docs/operations.md`

Expected: only scoped code/tests/docs, no secrets, generated files, or unrelated changes.

### Execution record (2026-07-23)

- RED reproduced three independent failures: declared crawler telemetry reached D1, Hero DAU included a
  Meta renderer, and the clean performance cohort included crawler traffic. A second RED fixture confirmed
  that unmarked HeadlessChrome also entered human metrics.
- GREEN verification passed: focused analytics tests `21/21`, Worker full suite `1137/1137`, TypeScript
  `tsc --noEmit`, and `git diff --check`.
- Production read-only counterfactual: the legacy eligible-device count had reached 542; the new classifier
  retained 1 human device and filtered 541 non-human devices. The retained device was a 7-day returner, not
  a new acquisition. No production rows were changed.
- The filtered 7-day error view removes the current Meta `item_detail 403` spike. Its remaining 400 spike is
  confined to 2026-07-17 and matches the already-fixed `/api/items` SQLite cursor incident (PR #182).
- Release completed through PR #209. Staging Worker version
  `6e6dfa70-be43-4f7e-835f-9a5cf5bb12bb` passed crawler no-op and zero-row D1 verification; merge
  commit `94946fc` passed Deploy Worker run #228 and reached production. Production repeated the no-op /
  zero-row smoke. Final read-only recomputation returned DAU 2 (new 1, 7-day returner 1), 549 filtered
  non-human devices, and zero human errors for the day. No historical production rows were deleted.
