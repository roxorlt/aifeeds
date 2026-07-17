# Waterfall Production Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the validated classic/waterfall prototype into a production-integrable, default-off Cloudflare Pages SSR experience without merging, pushing, staging, or production deployment during the current RUM window.

**Architecture:** The existing `index.html` and `main.tsx` remain the classic entry. A second `waterfall.html` and `waterfall-main.tsx` form an independently downloadable SSR/hydration entry. A narrowly routed Pages Function selects the experience from a bounded query/cookie only when `HOME_EXPERIENCE_ENABLED=true`, calls the API Worker through a `HOME_API` Service Binding, renders public waterfall HTML, and fails open to the classic asset on any binding, data, template, or rendering failure. The Worker exposes a token-scoped mixed-source `/api/home-feed` endpoint with stable cursor pagination and bounded per-source candidates.

**Tech Stack:** React 19, React DOM edge SSR, React Router, TypeScript, Vite multi-page output, Cloudflare Pages Functions and Service Bindings, D1, Vitest, `node:test`, Playwright, Tailwind CSS.

---

### Task 1: Shared view-mode and item-route contracts

**Files:**
- Create: `dashboard/src/home/viewMode.ts`
- Create: `dashboard/src/home/viewMode.test.mjs`
- Create: `dashboard/src/home/itemPath.ts`
- Create: `dashboard/src/home/itemPath.test.mjs`
- Modify: `dashboard/src/lib/drawer.tsx`

**Step 1: Write failing tests**

Cover:

- the feature flag is fail-closed unless the exact string `true` is present;
- valid `?view=` overrides the cookie for that request;
- invalid query/cookie values fall back to classic;
- cookie parsing uses exact tokens and serialization is bounded to `classic|waterfall`;
- root and all supported detail paths are recognized without accepting unrelated routes;
- every supported `Item` maps to the existing canonical drawer path.

**Step 2: Verify RED**

Run:

```bash
cd dashboard
node --test src/home/viewMode.test.mjs src/home/itemPath.test.mjs
```

Expected: FAIL because both modules are absent.

**Step 3: Implement minimal pure modules**

Keep both modules free of React and browser-only module initialization. Export `resolveHomeView`, `serializeHomeViewCookie`, `isHomeExperiencePath`, `homePathForItem`, and finite mode constants. Refactor `drawer.tsx` to use `homePathForItem` rather than a private duplicate.

**Step 4: Verify GREEN**

Run the focused tests and existing drawer contract tests. Expected: all pass.

**Step 5: Commit**

```bash
git add dashboard/src/home dashboard/src/lib/drawer.tsx
git commit -m "feat(home): define bounded dual-view routing"
```

### Task 2: Mixed-source home-feed endpoint

**Files:**
- Create: `worker/src/home-feed.ts`
- Create: `worker/src/home-feed.test.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/server-timing.test.ts`

**Step 1: Write failing tests**

Cover:

- limits are clamped to `12..48`;
- malformed/version-mismatched cursors return `400` before D1 work;
- cursor contains a frozen `as_of`, integer score, sort time, and id;
- SQL selects only the eight supported public sources, filters soft-deleted/deduplicated/sensitive rows, and uses explicit list projection;
- candidate rows are bounded per source before diversity scoring;
- output ordering applies a deterministic same-source rank penalty while preserving stable keyset pagination;
- missing or wrong `X-Home-Renderer-Token` is rejected;
- a correct scoped token is the only `/api/home-feed` origin-gate exemption;
- response includes `Server-Timing: d1`, `private, no-store`, and no raw hidden score fields.

**Step 2: Verify RED**

Run:

```bash
cd worker
npx vitest run src/home-feed.test.ts src/server-timing.test.ts
```

Expected: FAIL because the home-feed module and route do not exist.

**Step 3: Implement the bounded query**

Use one D1 statement:

1. build at most 48 recent candidate ids per source;
2. join candidates to the explicit mixed-source list projection;
3. compute `ROW_NUMBER()` per source;
4. subtract a fixed time penalty for repeated same-source rows;
5. paginate on score, sort time, id under a cursor-frozen `as_of`.

Do not expose detail-only fields, secrets, account state, raw queries, or personalization.

**Step 4: Wire the scoped service route**

Add optional `HOME_RENDERER_TOKEN` to `Env`. Accept the token exemption only for `GET /api/home-feed`; validate it again inside the handler. Keep public CORS and all mutation routes unchanged.

**Step 5: Verify GREEN**

Run focused Worker tests, then the complete Worker suite.

**Step 6: Commit**

```bash
git add worker/src/home-feed.ts worker/src/home-feed.test.ts worker/src/index.ts worker/src/server-timing.test.ts
git commit -m "feat(worker): add scoped mixed-source home feed"
```

### Task 3: Accessible production waterfall UI

**Files:**
- Create: `dashboard/src/home/masonry.ts`
- Create: `dashboard/src/home/masonry.test.mjs`
- Create: `dashboard/src/home/homeData.ts`
- Create: `dashboard/src/home/homeData.test.mjs`
- Create: `dashboard/src/home/HomeViewSwitch.tsx`
- Create: `dashboard/src/home/WaterfallCard.tsx`
- Create: `dashboard/src/home/WaterfallHome.tsx`
- Create: `dashboard/src/home/waterfall.css`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/types.ts`

**Step 1: Write failing pure and contract tests**

Cover:

- masonry row-span math is positive, deterministic, and never uses dense placement;
- estimated server spans and measured client spans use the same row/gap contract;
- all cards stay in one DOM sequence;
- card summaries, labels, safe internal image variants, and canonical detail paths are source-aware;
- initial JSON rejects wrong mode/shape and never evaluates script;
- fetch uses the shared API base, abort signal, bounded limit, and cursor;
- the classic switch stays absent unless the server declares availability;
- desktop renders a two-button segmented control; mobile renders a 44px compact view menu;
- switching writes the bounded cookie, emits a finite telemetry event, and performs one canonical navigation.

**Step 2: Verify RED**

Run:

```bash
cd dashboard
node --test src/home/*.test.mjs
```

Expected: FAIL because production home modules are absent.

**Step 3: Implement data and accessible masonry**

Render one ordered list/grid; never distribute DOM nodes into visual column arrays and never use `grid-auto-flow:dense`. Use small implicit rows plus estimated SSR spans, then a `ResizeObserver` to refine spans after hydration. Collapse to one normal-flow column below 768px.

**Step 4: Implement cards and interaction**

Use editorial grayscale styling consistent with AI-Feeds. Prefer ingested R2/WebP variants with explicit dimensions; omit unsafe third-party hero images from the SSR critical path. Use anchors for no-JS deep links and enhance unmodified clicks into the existing Drawer.

**Step 5: Add classic switch**

Mount `HomeViewSwitch current="classic"` in the existing AppBar. It returns `null` unless the Pages Function injects `data-home-view-available="true"`, so an unconfigured deployment exposes no dead control.

**Step 6: Verify GREEN**

Run focused tests, lint, typecheck/build, and existing unit tests.

**Step 7: Commit**

```bash
git add dashboard/src/home dashboard/src/App.tsx dashboard/src/api.ts dashboard/src/types.ts
git commit -m "feat(dashboard): add accessible opt-in waterfall home"
```

### Task 4: Separate waterfall entry and edge SSR renderer

**Files:**
- Create: `dashboard/waterfall.html`
- Create: `dashboard/src/waterfall-main.tsx`
- Create: `dashboard/src/home/WaterfallShell.tsx`
- Create: `dashboard/functions/[[path]].ts`
- Create: `dashboard/functions/home-runtime.ts`
- Create: `dashboard/functions/home-runtime.test.mjs`
- Create: `dashboard/public/_routes.json`
- Create: `dashboard/tsconfig.functions.json`
- Modify: `dashboard/vite.config.ts`
- Modify: `dashboard/package.json`

**Step 1: Write failing runtime tests**

Use dependency injection for assets, service binding, rendering, cache, and `waitUntil`. Cover:

- disabled/missing flag calls the classic fallback without API or renderer work;
- non-home routes pass through;
- classic mode fetches `index.html` and injects only bounded availability/view metadata;
- waterfall mode fetches `waterfall.html`, calls `HOME_API` with the scoped token and timeout, safely embeds JSON, and returns SSR markup;
- HTML-sensitive `<`, U+2028, and U+2029 never escape the JSON data island;
- cached public waterfall HTML never varies on arbitrary cookie contents;
- missing binding/token, non-200 API, invalid JSON, timeout, template marker loss, and renderer errors clear the waterfall cookie and fail open to classic;
- HEAD returns matching headers without a body.

**Step 2: Verify RED**

Run:

```bash
cd dashboard
node --test functions/home-runtime.test.mjs
```

Expected: FAIL because the runtime module is absent.

**Step 3: Implement the separate entry**

Add `waterfall.html` as a Vite HTML input. Its root and JSON data island contain explicit replacement sentinels. `waterfall-main.tsx` reads only the JSON element, hydrates with `hydrateRoot`, installs the existing telemetry observers before hydration, and keeps the classic `main.tsx` entry independent.

**Step 4: Implement Pages Function**

Use `HOME_EXPERIENCE_ENABLED`, `HOME_API`, and `HOME_RENDERER_TOKEN`. Render React with the edge server API, retrieve static templates through `ASSETS.fetch`, use a 30-second shared cache only for public waterfall HTML, set `X-AIFeeds-Home-SSR` diagnostics, and fail open on every exceptional path.

`_routes.json` must invoke Functions only for `/` and the existing drawer deep-link patterns; static assets, search, settings, auth, daily pages, and APIs remain static/independent.

**Step 5: Add function typecheck/build gates**

Add scripts for the Pages Function TypeScript configuration and local SSR build verification. Do not add or activate a production Wrangler configuration: Cloudflare documents that such a file becomes the Pages project configuration source of truth, so current remote bindings must first be downloaded/reviewed in the later staging change packet.

**Step 6: Verify GREEN**

Run runtime tests, function typecheck, Vite build, and assert that `dist/index.html` references only the classic entry while `dist/waterfall.html` references only the waterfall entry.

**Step 7: Commit**

```bash
git add dashboard/waterfall.html dashboard/src/waterfall-main.tsx dashboard/src/home/WaterfallShell.tsx dashboard/functions dashboard/public/_routes.json dashboard/tsconfig.functions.json dashboard/vite.config.ts dashboard/package.json dashboard/package-lock.json
git commit -m "feat(edge): add default-off Pages SSR entry"
```

### Task 5: View-scoped telemetry and kill-switch contracts

**Files:**
- Modify: `dashboard/src/lib/telemetry/vitals.ts`
- Modify: `dashboard/src/lib/telemetry/event-types.ts`
- Modify: `dashboard/src/lib/telemetry/types.ts`
- Modify: `dashboard/src/lib/telemetry/vitals-wiring.contract.test.mjs`
- Modify: `worker/src/track.ts`
- Modify: `worker/src/performance-analytics.test.ts`

**Step 1: Write failing tests**

Require:

- every performance payload gets `view_mode=classic|waterfall`;
- missing/invalid DOM values become classic;
- `home_view_switch` accepts only finite `from_view`, `to_view`, and `entry`;
- Worker strips forged arbitrary values;
- current geography enrichment and payload-size limits remain intact.

**Step 2: Verify RED**

Run focused Dashboard and Worker telemetry tests. Expected: FAIL on missing view metadata/event.

**Step 3: Implement bounded telemetry**

Add the finite view mode to `getPerformanceDeviceMeta`. Add `HOME_VIEW_SWITCH` on both allowlists and normalize its payload. Never persist URL, cookie text, query, account id, or arbitrary entry strings.

**Step 4: Verify GREEN**

Run focused and full telemetry suites.

**Step 5: Commit**

```bash
git add dashboard/src/lib/telemetry worker/src/track.ts worker/src/performance-analytics.test.ts
git commit -m "feat(telemetry): split classic and waterfall cohorts"
```

### Task 6: Cross-device E2E and performance budgets

**Files:**
- Create: `dashboard/e2e/waterfall-home.spec.ts`
- Modify: `dashboard/playwright.config.ts`
- Modify: `dashboard/src/lib/playwright-matrix.contract.test.mjs`
- Modify: `dashboard/scripts/benchmark-home-views.mjs`
- Modify: `dashboard/package.json`

**Step 1: Write failing contract tests**

Require a local edge fixture that covers desktop Chromium, mobile Chromium, mobile WebKit, reduced motion, keyboard switching, touch-sized controls, cookie persistence, SSR-before-JS, hydration with zero console errors, load more, Drawer deep links, fail-open fallback, and no horizontal overflow.

**Step 2: Verify RED**

Run the contract test. Expected: FAIL because the production waterfall spec is absent.

**Step 3: Implement fixture and E2E**

Use local fixtures only. Do not call staging or production. Add explicit assertions:

- SSR HTML has at least 12 cards before client JavaScript;
- DOM order equals visual/source order contract;
- 1440px has three columns, tablet has two, 390px has one;
- CLS is at most `0.1`;
- waterfall entry never requests the classic entry and classic never requests the waterfall entry;
- switching performs one document navigation;
- a simulated API failure returns classic and expires `aifeeds_view`.

**Step 4: Verify GREEN**

Run the new matrix, then existing `npm run test:e2e`.

**Step 5: Commit**

```bash
git add dashboard/e2e dashboard/playwright.config.ts dashboard/src/lib/playwright-matrix.contract.test.mjs dashboard/scripts/benchmark-home-views.mjs dashboard/package.json
git commit -m "test(home): enforce waterfall SSR budgets"
```

### Task 7: Release packet, full verification, and production freeze

**Files:**
- Create: `docs/reviews/waterfall-ssr-staging-change-packet.md`
- Modify: `docs/operations.md`
- Modify: `TODO.md`

**Step 1: Document the single staging authorization**

The packet must group, but not execute:

1. create/review staging Pages Service Binding `HOME_API -> xlist-api-staging`;
2. set the same random `HOME_RENDERER_TOKEN` secret on staging Pages and Worker;
3. set `HOME_EXPERIENCE_ENABLED=true` only on staging;
4. deploy staging Worker then staging Pages;
5. run the local benchmark CLI against staging classic/waterfall URLs;
6. exercise the kill switch and independent rollback.

Production remains explicitly excluded.

**Step 2: Add rollout gates**

Require:

- current classic RUM window complete;
- staging per device/view at least 10 cold runs;
- waterfall p75 LCP no worse than classic by more than 10%;
- CLS `<=0.1`;
- no classic bundle-size regression without review;
- opt-in only, classic default, runtime kill switch, previous Pages deployment id recorded.

**Step 3: Run fresh full verification**

Run:

```bash
cd dashboard
npm run lint
npm run test:unit
npm run build
npm run test:functions
npm run test:e2e

cd ../worker
npm test

cd ..
node --test scripts/ci/*.test.mjs
git diff --check origin/main..HEAD
```

Expected: every command exits `0`; generated output remains ignored.

**Step 4: Review scope**

Confirm:

- branch remains `codex/waterfall-ssr-rum-parallel`;
- no secret value, `.dev.vars`, build output, benchmark report, or absolute local path is tracked;
- no push, PR, merge, staging deploy, production deploy, D1 mutation, Cloudflare binding, or secret write occurred;
- `HOME_EXPERIENCE_ENABLED` remains fail-closed by default.

**Step 5: Commit**

```bash
git add docs/reviews/waterfall-ssr-staging-change-packet.md docs/operations.md TODO.md
git commit -m "docs: gate waterfall SSR staging rollout"
```

