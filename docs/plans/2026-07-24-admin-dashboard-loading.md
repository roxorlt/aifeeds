# Admin Dashboard Progressive Loading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Admin dashboard show its top KPI data quickly without allowing the remaining analytics queries to overload D1.

**Architecture:** Keep the existing per-metric endpoints and renderers. Replace the 16-way startup burst with a small browser-side scheduler: await `overview` first, then run the remaining loaders through a three-worker queue so cards continue filling progressively without saturating D1.

**Tech Stack:** Cloudflare Worker, embedded browser JavaScript, TypeScript, Vitest.

---

### Task 1: Add a testable browser scheduler contract

**Files:**
- Modify: `worker/src/performance-analytics.test.ts`
- Modify: `worker/src/admin-dashboard.ts`

**Step 1: Write the failing tests**

- Import the scheduler script constant from `admin-dashboard.ts`.
- Evaluate that isolated script in Vitest and assert that background loaders do not start until the priority loader resolves.
- Assert that the background queue never runs more than three loaders concurrently.

**Step 2: Run the focused test and verify RED**

Run: `cd worker && npm test -- src/performance-analytics.test.ts`

Expected: FAIL because the scheduler script constant does not exist yet.

**Step 3: Implement the minimal scheduler**

- Export one browser-JavaScript string containing `runDashboardLoaders`.
- Interpolate that exact string into `DASHBOARD_HTML` so tests exercise the production code.
- Await `loadOverview` before starting the background queue.
- Run all other existing loaders with a concurrency limit of three; do not change endpoint SQL or card rendering.

**Step 4: Run the focused test and verify GREEN**

Run: `cd worker && npm test -- src/performance-analytics.test.ts`

Expected: all focused tests pass.

### Task 2: Verify the Worker and dashboard artifact

**Files:**
- Modify: `TODO.md`
- Modify: `docs/operations.md`

**Step 1: Run layered verification**

Run:

```bash
cd worker
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
cd ..
bash scripts/ci/admin-dashboard-smoke.sh
git diff --check
```

Expected: Worker tests, typecheck, dry-run bundle, dashboard smoke, and whitespace check all pass.

**Step 2: Browser smoke**

- Serve the built Worker locally or on staging only if needed.
- Confirm the KPI request is issued and rendered before background analytics requests.
- Confirm every card eventually leaves its loading state and no page error appears.

**Step 3: Record the incident and result**

- Add production evidence to `TODO.md`: 16-way baseline around 10.6–12.6 seconds, isolated calls around 0.76–1.4 seconds, staged scheduler KPI around 1.5 seconds.
- Document the Admin dashboard request-budget rule in `docs/operations.md`.

**Step 4: Commit**

```bash
git add worker/src/admin-dashboard.ts worker/src/performance-analytics.test.ts \
  TODO.md docs/operations.md docs/plans/2026-07-24-admin-dashboard-loading.md
git commit -m "fix(admin): prioritize dashboard KPI loading"
```

## Execution Record

- Production baseline: page shell returned in about 0.5 seconds, while the 16 analytics requests all
  completed in two waves around 10.6–12.6 seconds.
- Control: isolated production requests completed around 0.76–1.4 seconds; a read-only three-worker
  simulation showed the KPI at about 1.5 seconds.
- TDD: the two scheduler tests failed on the missing contract, then passed after the minimal loader queue.
- Verification: Worker `1139/1139`, TypeScript, production dry-run bundle, Admin HTML smoke, and
  `git diff --check` passed.
- Local browser smoke: 16/16 analytics responses were 200, `overview` completed before any background
  request, maximum observed background concurrency was 3, and the rendered page had no remaining
  loading state or new console error.
