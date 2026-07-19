# Waterfall Polish And Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine the waterfall cards into a production-quality content-community UI while restoring mobile app-bar behavior, reliable device view persistence, and fast responsive cover loading.

**Architecture:** Keep the existing independent SSR waterfall entry and cookie-based server selection. Extract small pure helpers for media rank and app-bar scroll progress, bypass the Service Worker shell for homepage navigations, and layer the approved visual system onto the existing ordered masonry DOM. Treat the Hong Kong Nginx image cache correction as a separately reviewed production operation.

**Tech Stack:** React 19, TypeScript, Vite SSR, CSS Grid masonry spans, Node test runner, Playwright Chromium/WebKit, Cloudflare Pages Functions, Nginx proxy cache.

---

### Task 1: Lock homepage persistence and app-bar behavior with failing tests

**Files:**
- Modify: `dashboard/src/archiveLinks.contract.test.mjs`
- Modify: `dashboard/src/home/home-ui.contract.test.mjs`
- Create: `dashboard/src/home/waterfallHeader.test.mjs`
- Create: `dashboard/src/home/waterfallHeader.ts`

**Step 1: Write the failing tests**

Add contracts asserting that `public/sw.js` bypasses homepage navigation before the generic navigation handler, the waterfall Shell owns a header ref and uses the shared scroll root, and reduced motion keeps the header visible. Add pure tests for:

```js
assert.equal(nextWaterfallHeaderRatio({ y: 0, delta: 20, ratio: 0 }), 0);
assert.equal(nextWaterfallHeaderRatio({ y: 120, delta: 27, ratio: 0 }), 0.5);
assert.equal(nextWaterfallHeaderRatio({ y: 120, delta: -54, ratio: 1 }), 0);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
node --test src/archiveLinks.contract.test.mjs src/home/home-ui.contract.test.mjs src/home/waterfallHeader.test.mjs
```

Expected: FAIL because the Service Worker still intercepts `/`, and the waterfall header helper/wiring does not exist.

**Step 3: Implement the minimum behavior**

Create a pure `nextWaterfallHeaderRatio` helper with a 50px top zone and 54px header travel. Wire `WaterfallShell` to `getScrollY` and `addScrollRootListener`, update transform in one RAF, restore state on cleanup, and keep reduced-motion users at ratio zero. Change `sw.js` so `url.pathname === "/"` returns before `respondWith(shellFirst(...))`, then increment the cache version.

**Step 4: Run tests to verify they pass**

Run the same focused command. Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add dashboard/public/sw.js dashboard/src/home/WaterfallShell.tsx dashboard/src/home/waterfallHeader.ts dashboard/src/home/waterfallHeader.test.mjs dashboard/src/archiveLinks.contract.test.mjs dashboard/src/home/home-ui.contract.test.mjs
git commit -m "fix: persist waterfall view and restore mobile app bar"
```

### Task 2: Assign image priority by actual cover rank

**Files:**
- Create: `dashboard/src/home/waterfallMedia.ts`
- Create: `dashboard/src/home/waterfallMedia.test.mjs`
- Modify: `dashboard/src/home/WaterfallHome.tsx`
- Modify: `dashboard/src/home/WaterfallCard.tsx`
- Modify: `dashboard/src/home/home-ui.contract.test.mjs`
- Modify: `dashboard/waterfall.html`

**Step 1: Write the failing tests**

Test that media ranks skip cards without an image and produce at most one high-priority image:

```js
assert.deepEqual(rankWaterfallMedia([false, false, true, true, false, true]), [
  null, null, 0, 1, null, 2,
]);
assert.deepEqual(waterfallMediaPolicy(0), { loading: "eager", fetchPriority: "high" });
assert.deepEqual(waterfallMediaPolicy(1), { loading: "eager", fetchPriority: "auto" });
assert.deepEqual(waterfallMediaPolicy(2), { loading: "lazy", fetchPriority: "auto" });
```

Add a template contract for `preconnect` and `dns-prefetch` to `https://api.ai-feeds.com`.

**Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
node --test src/home/waterfallMedia.test.mjs src/home/home-ui.contract.test.mjs
```

Expected: FAIL because media-rank helpers and API connection hints are absent.

**Step 3: Implement the minimum behavior**

Compute media ranks once in `WaterfallHome`, pass `mediaRank` into each card, and derive `loading`/`fetchPriority` from that rank. Add API connection hints to `waterfall.html`. Preserve explicit width, height and async decoding.

**Step 4: Run tests to verify they pass**

Run the focused tests. Expected: all pass.

**Step 5: Commit**

```bash
git add dashboard/waterfall.html dashboard/src/home/WaterfallHome.tsx dashboard/src/home/WaterfallCard.tsx dashboard/src/home/waterfallMedia.ts dashboard/src/home/waterfallMedia.test.mjs dashboard/src/home/home-ui.contract.test.mjs
git commit -m "perf: prioritize the first real waterfall covers"
```

### Task 3: Add responsive persisted cover candidates

**Files:**
- Modify: `dashboard/src/home/homeData.ts`
- Modify: `dashboard/src/home/homeData.test.mjs`
- Modify: `dashboard/src/home/WaterfallCard.tsx`
- Modify: `dashboard/src/home/home-ui.contract.test.mjs`

**Step 1: Write the failing tests**

Add model tests showing that stored 400/800 WebP variants become ordered candidates and raw/proxy-only images remain a single safe source. Add a UI contract requiring `srcSet` and:

```text
(max-width: 767px) calc((100vw - 32px) / 2),
(max-width: 1279px) calc((100vw - 56px) / 4),
248px
```

**Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
node --test src/home/homeData.test.mjs src/home/home-ui.contract.test.mjs
```

Expected: FAIL because the card image model has no responsive candidate list.

**Step 3: Implement the minimum behavior**

Expose finite 400/800 candidates only when persisted R2 variants exist, render `srcSet` conditionally, and keep `src` as the safe fallback.

**Step 4: Run tests to verify they pass**

Run the focused tests. Expected: all pass.

**Step 5: Commit**

```bash
git add dashboard/src/home/homeData.ts dashboard/src/home/homeData.test.mjs dashboard/src/home/WaterfallCard.tsx dashboard/src/home/home-ui.contract.test.mjs
git commit -m "perf: serve responsive waterfall cover variants"
```

### Task 4: Implement the approved content-community card system

**Files:**
- Modify: `dashboard/src/home/WaterfallCard.tsx`
- Modify: `dashboard/src/home/waterfall.css`
- Modify: `dashboard/src/home/home-ui.contract.test.mjs`
- Modify: `dashboard/e2e/waterfall-home.spec.ts`

**Step 1: Write the failing tests**

Update contracts and Playwright expectations for 12px card radius, media/no-media modifier classes, a restrained image-card summary, visible focus, and transform-only hover. Keep the existing independent-card, fixed-column and maximum-gap assertions.

**Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
node --test src/home/home-ui.contract.test.mjs
```

Expected: FAIL against the current flat 10px bordered cards.

**Step 3: Implement the approved visual system**

Add finite modifier classes from the card model. Implement a warm neutral canvas, crisp white cards, 12px radius, subtle layered border/shadow, cover overflow treatment, stronger title typography, compact identity, quiet metrics, keyboard focus and a 2px transform-only desktop hover. Hide or shorten summaries on image-led cards without removing essential accessible text.

**Step 4: Run the focused tests**

Run:

```bash
cd dashboard
node --test src/home/home-ui.contract.test.mjs src/home/waterfallCardModel.test.mjs
```

Expected: all pass.

**Step 5: Commit**

```bash
git add dashboard/src/home/WaterfallCard.tsx dashboard/src/home/waterfall.css dashboard/src/home/home-ui.contract.test.mjs dashboard/e2e/waterfall-home.spec.ts
git commit -m "feat: polish waterfall content cards"
```

### Task 5: Verify both responsive products

**Files:**
- Modify if required: `dashboard/e2e/waterfall-home.spec.ts`
- Create: `docs/reviews/2026-07-19-waterfall-polish-verification.md`

**Step 1: Run unit, lint and build gates**

```bash
cd dashboard
npm run test:unit
npm run lint
npm run build:ssr
```

Expected: zero test failures, zero lint errors and build exit code 0.

**Step 2: Run the five-device local SSR/browser gate**

```bash
cd dashboard
npm run test:e2e:waterfall
```

Expected: Chromium desktop/tablet/mobile and WebKit mobile projects pass; no console error, horizontal overflow, CLS regression or masonry-gap regression.

**Step 3: Inspect screenshots at representative sizes**

Capture and inspect at 390×844 and 1440×1000. Verify cover dominance, text hierarchy, top-bar scroll behavior, view persistence after reload, and card density.

**Step 4: Record evidence**

Write commands, results, screenshots and any limitations into the review document.

**Step 5: Commit**

```bash
git add dashboard/e2e/waterfall-home.spec.ts docs/reviews/2026-07-19-waterfall-polish-verification.md
git commit -m "test: verify polished waterfall across devices"
```

### Task 6: Prepare and execute the production image cache correction

**Files:**
- Modify: `docs/operations.md`
- Create: `docs/reviews/2026-07-19-waterfall-image-cache-change.md`

**Step 1: Capture the current production configuration and checksums**

Read `/etc/nginx/sites-available/aifeeds.conf` and `/etc/nginx/conf.d/aifeeds-perf.conf`, record SHA-256 values, and copy a timestamped backup on the VPS only after production execution is authorized.

**Step 2: Prepare a normalized format map**

Add a finite map in the HTTP scope:

```nginx
map $http_accept $aifeeds_image_format {
    default original;
    "~*image/avif" avif;
    "~*image/webp" webp;
}
```

Append `$aifeeds_image_format` to the `/img` cache key.

**Step 3: Validate before activation**

Run `nginx -t` against the staged configuration. Expected: syntax successful.

**Step 4: Activate and verify**

Reload Nginx, remove only cached `/img` objects using the reviewed cache-path method, and request one fixed image with AVIF/WebP and JPEG-only Accept headers. Verify correct `Content-Type`, `Vary: Accept`, finite body size and MISS → HIT.

**Step 5: Record rollback**

Rollback restores the timestamped files, runs `nginx -t`, reloads, and repeats the health checks. Record exact commands, checksums and output in the change evidence.

### Task 7: Complete the branch and production release

**Files:**
- Modify: `docs/reviews/2026-07-19-waterfall-polish-verification.md`

**Step 1: Re-run all verification gates**

Use fresh unit, lint, SSR build and five-device Playwright results.

**Step 2: Review the branch diff**

Confirm no secrets, generated build output or unrelated user changes are included.

**Step 3: Push and open a pull request**

Push `codex/polish-waterfall-persistence`, open a PR against `main`, and wait for required checks.

**Step 4: Merge and verify production**

After required checks are green, merge and verify the deployed build identity, selected waterfall Cookie behavior, mobile app-bar behavior, first-cover priority and responsive visual layout.

**Step 5: Close evidence**

Record production commit, build identity, deployment URL, browser evidence and Nginx image-cache verification. RUM remains a post-release observation and does not block code delivery.
