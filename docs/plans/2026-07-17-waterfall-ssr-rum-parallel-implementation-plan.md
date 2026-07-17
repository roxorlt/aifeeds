# Waterfall SSR RUM-Parallel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a non-production SSR dual-view prototype, a repeatable cross-device comparison tool, and a Node 24-compatible CI update without changing the live Dashboard runtime.

**Architecture:** A local Node HTTP server pre-renders either the classic or waterfall homepage from safe fixture data according to an explicit query or cookie. View changes persist a bounded cookie and navigate once so the next HTML and its declared mode agree. A separate Playwright CLI compares the two URLs under desktop/mobile cold and warm conditions; workflow contract tests pin every JavaScript action to a Node 24 major.

**Tech Stack:** Node.js ESM and `node:test`, semantic HTML/CSS, minimal browser JavaScript, Playwright, GitHub Actions YAML.

---

### Task 1: View-mode resolver

**Files:**
- Create: `dashboard/prototypes/waterfall-ssr/view-mode.mjs`
- Create: `dashboard/prototypes/waterfall-ssr/view-mode.test.mjs`

**Step 1: Write failing tests**

Cover query-over-cookie precedence, invalid values falling back to classic, exact cookie token parsing, and bounded cookie serialization.

**Step 2: Verify RED**

Run: `node --test prototypes/waterfall-ssr/view-mode.test.mjs` from `dashboard/`.

Expected: FAIL because `view-mode.mjs` does not exist.

**Step 3: Implement the minimal resolver**

Export `resolveViewMode(url, cookieHeader)`, `serializeViewCookie(mode)` and the finite mode list. Do not accept arbitrary strings.

**Step 4: Verify GREEN**

Run the same command; expected all tests PASS.

### Task 2: SSR document renderer and local server

**Files:**
- Create: `dashboard/prototypes/waterfall-ssr/fixtures.mjs`
- Create: `dashboard/prototypes/waterfall-ssr/render.mjs`
- Create: `dashboard/prototypes/waterfall-ssr/render.test.mjs`
- Create: `dashboard/prototypes/waterfall-ssr/server.mjs`
- Modify: `dashboard/package.json`

**Step 1: Write failing renderer tests**

Assert that both modes emit meaningful cards before scripts, declare exactly one `data-view-mode`, include a JSON initial-data block with escaped `<`, preserve image dimensions, and expose accessible PC/mobile switch controls.

**Step 2: Verify RED**

Run: `node --test prototypes/waterfall-ssr/render.test.mjs`.

Expected: FAIL because the renderer is absent.

**Step 3: Implement fixture rendering**

Create representative X, GitHub, Product Hunt, paper, news and event cards. Render classic source columns and a unified waterfall using the same item array. Escape HTML and embedded JSON independently.

**Step 4: Implement the local HTTP shell**

Bind only to `127.0.0.1`, serve `/`, `/styles.css` and `/client.mjs`, apply the mode resolver, and add `prototype:waterfall` to package scripts. No external network calls.

**Step 5: Verify GREEN**

Run renderer tests and request both `/?view=classic` and `/?view=waterfall`; expected 200 and matching SSR markers.

### Task 3: Responsive visual treatment and switch behavior

**Files:**
- Create: `dashboard/prototypes/waterfall-ssr/styles.css`
- Create: `dashboard/prototypes/waterfall-ssr/client.mjs`
- Create: `dashboard/prototypes/waterfall-ssr/prototype-contract.test.mjs`

**Step 1: Write failing contract tests**

Require three PC waterfall columns, two tablet columns, one mobile column, 44px mobile controls, focus-visible styles, reduced-motion handling, no external assets, and cookie-backed same-URL navigation.

**Step 2: Verify RED**

Run: `node --test prototypes/waterfall-ssr/prototype-contract.test.mjs`.

Expected: FAIL because CSS/client files are absent.

**Step 3: Implement the UI**

Use the existing neutral design language. The desktop segmented control is always visible; mobile uses a compact `details` menu. Switching writes cookie/localStorage, announces the change, and navigates to `/` once.

**Step 4: Verify GREEN**

Run all prototype tests; expected PASS.

### Task 4: Cross-device home-view benchmark

**Files:**
- Create: `dashboard/scripts/benchmark-home-views.mjs`
- Create: `dashboard/scripts/benchmark-home-views.test.mjs`
- Modify: `dashboard/package.json`
- Modify: `.gitignore`

**Step 1: Write failing unit tests**

Cover production-host rejection, allowed local/staging URLs, nearest-rank percentile summaries, bounded CLI run counts, and deterministic Markdown output for classic/waterfall device rows.

**Step 2: Verify RED**

Run: `node --test scripts/benchmark-home-views.test.mjs`.

Expected: FAIL because the benchmark module is absent.

**Step 3: Implement measurement**

Use Playwright Chromium with desktop and mobile contexts. Measure cold and warm runs, collect navigation timing, paint/LCP/CLS observers, request count and transfer size, then write JSON and Markdown under `dashboard/output/home-view-benchmarks/`. Refuse production URLs.

**Step 4: Verify locally**

Start the prototype server, run one cold/warm sample per view/device, and confirm both reports are written. Then run the unit tests.

### Task 5: GitHub Actions Node 24 migration

**Files:**
- Modify: `.github/workflows/deploy-dashboard.yml`
- Modify: `.github/workflows/deploy-worker.yml`
- Modify: `.github/workflows/pr-validation.yml`
- Modify: `.github/workflows/secret-scan.yml`
- Create: `scripts/ci/actions-node24-contract.test.mjs`

**Step 1: Write a failing workflow contract**

Require `actions/checkout@v5`, `actions/setup-node@v5`, `actions/cache@v5`, `actions/upload-artifact@v6`, and `dorny/paths-filter@v4`; reject their Node 20 majors.

**Step 2: Verify RED**

Run: `node --test scripts/ci/actions-node24-contract.test.mjs`.

Expected: FAIL against the current v4/v3 workflow references.

**Step 3: Update workflow majors**

Change only action majors; keep application Node `22`, workflow triggers, permissions, cache keys and deployment commands unchanged.

**Step 4: Verify GREEN**

Run the contract test and parse all workflow YAML files using the available tooling or a conservative text check.

### Task 6: Full verification and documentation

**Files:**
- Modify: `TODO.md`
- Modify: `docs/plans/2026-07-17-waterfall-ssr-dual-mode-design.md` only if implementation evidence changes a decision

**Step 1: Run focused tests**

Run all new prototype, benchmark and CI contract tests.

**Step 2: Run Dashboard gates**

Run `npm run lint`, `npm run test:unit`, `npm run build`, and the existing PC/mobile performance E2E.

**Step 3: Run browser smoke**

Verify classic and waterfall SSR markers, PC 1440px, mobile 390px, keyboard switching, cookie persistence and reduced-motion. Save screenshots only under ignored output.

**Step 4: Review scope**

Confirm `App.tsx`, Worker runtime, nginx and production deployment files are unchanged except the intended CI workflow definitions. Confirm no secrets, generated reports or absolute local paths are tracked.

**Step 5: Commit in reviewable units**

Commit design, prototype/benchmark, and CI migration separately. Do not push, open a PR, deploy staging or deploy production without a new explicit user request. Record that merging this branch would trigger Dashboard CI and therefore remains held until the current RUM observation window closes.
