# Daily Source Recovery and Video SEO Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore reliable GitHub and Hugging Face coverage in the 08:00 digest, clear the production backlog, and publish each completed daily video into R2 and the matching static daily page with complete video SEO metadata and discovery signals.

**Architecture:** The source pipeline will separate ingestion freshness from enrichment completion: GitHub re-trending updates a digest-visible timestamp, both GitHub and HF receive bounded automatic pending drains, and cron routing is expressed as testable decisions so no slot can be shadowed by an earlier return. The video publisher will use an authenticated Worker endpoint to store content-addressed MP4/poster/VTT objects in R2 and one `daily_videos` metadata row in D1; the Worker then injects an idempotent top-of-page player and `VideoObject` into the existing historical HTML snapshot, exposes a video sitemap, updates last-modified metadata, and submits IndexNow URLs. HK keeps a durable publish state and retries only after the video is fully ready.

**Tech Stack:** Cloudflare Workers, D1, R2, Workflows, TypeScript, Vitest, Node.js, FFmpeg/ffprobe, HK VPS systemd/cron, IndexNow, schema.org `VideoObject`, video sitemap XML.

---

### Task 1: Establish the isolated branch and regression baseline

**Files:**
- Create: `docs/plans/2026-07-14-daily-source-video-seo.md`
- Test: `worker/src/digest/selection.test.ts`
- Test: `worker/src/github.test.ts`
- Test: `worker/src/seo-routes.test.ts`
- Test: `worker/src/digest/daily-page.test.ts`
- Test: `worker/src/digest/daily-page-run.test.ts`

**Step 1: Install locked Worker dependencies**

Run: `cd worker && npm ci`

Expected: dependencies install without changing `package-lock.json`.

**Step 2: Run the focused existing test baseline**

Run: `cd worker && npm test -- src/digest/selection.test.ts src/github.test.ts src/seo-routes.test.ts src/digest/daily-page.test.ts src/digest/daily-page-run.test.ts`

Expected: all existing tests pass before production code changes.

### Task 2: Make GitHub re-trending items digest-visible and self-draining

**Files:**
- Modify: `worker/src/github.ts`
- Modify: `worker/src/digest/selection.ts`
- Create or modify: `worker/src/github.test.ts`
- Modify: `worker/src/digest/selection.test.ts`
- Create: `worker/src/ops/source-pipeline.ts`
- Create: `worker/src/ops/source-pipeline.test.ts`

**Step 1: Write failing tests**

Add tests proving that an existing GitHub repo seen again on today's trending page receives a current `last_seen_on_trending_at`, that digest selection uses that current-trending timestamp rather than only the original `scraped_at`, and that a bounded drain chooses old `gh_pending` rows in deterministic order.

**Step 2: Run the tests and confirm RED**

Run: `cd worker && npm test -- src/github.test.ts src/digest/selection.test.ts src/ops/source-pipeline.test.ts`

Expected: failures demonstrate the stale `scraped_at` filter and missing drain helper.

**Step 3: Implement the minimal fix**

Update re-trending rows without falsifying original ingestion time, select GitHub candidates with `COALESCE(last_seen_on_trending_at, trending_date_str, scraped_at)` semantics, and add a bounded workflow-trigger drain that records picked/started/failed counts and leaves failed rows retryable.

**Step 4: Run focused tests and confirm GREEN**

Run: `cd worker && npm test -- src/github.test.ts src/digest/selection.test.ts src/ops/source-pipeline.test.ts`

Expected: all pass.

### Task 3: Unshadow HF cron work and add source readiness gates

**Files:**
- Create: `worker/src/ops/cron-routing.ts`
- Create: `worker/src/ops/cron-routing.test.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/ops/source-pipeline.ts`
- Modify: `worker/src/ops/source-pipeline.test.ts`

**Step 1: Write failing routing tests**

Prove that BJT `:20` and `:50` can schedule both HDX and HF drains without an early return, podcast work is not shadowed at `:50`, HF fetching no longer races the 08:00 digest, and a pre-digest readiness check reports GH/HF ready and pending counts.

**Step 2: Run the tests and confirm RED**

Run: `cd worker && npm test -- src/ops/cron-routing.test.ts src/ops/source-pipeline.test.ts`

Expected: failures capture the current shadowed route behavior.

**Step 3: Implement composable cron actions**

Replace mutually shadowing early-return slot checks with an explicit action list, run bounded GH/HF pending drains on their own safe cadence, move HF discovery after the daily digest window, and emit structured readiness/lag logs before the 08:00 digest.

**Step 4: Run focused and scheduler tests**

Run: `cd worker && npm test -- src/ops/cron-routing.test.ts src/ops/source-pipeline.test.ts src/index.test.ts`

Expected: all pass and no existing scheduled action disappears.

### Task 4: Add D1 video metadata and authenticated content-addressed upload

**Files:**
- Create: `worker/migrations/028-daily-videos.sql`
- Create: `worker/src/digest/daily-video.ts`
- Create: `worker/src/digest/daily-video.test.ts`
- Modify: `worker/src/index.ts`

**Step 1: Write failing upload tests**

Cover missing/invalid bearer token, invalid date/type/size, multipart MP4/poster/VTT upload, SHA-256 content-addressed keys, idempotent same-SHA upload, replacement with a new SHA, D1 upsert, and cleanup of superseded objects only after metadata succeeds.

**Step 2: Run the test and confirm RED**

Run: `cd worker && npm test -- src/digest/daily-video.test.ts`

Expected: module/route missing failures.

**Step 3: Implement upload and metadata storage**

Use `X_CARD_SHARED_TOKEN` bearer authentication, validate `YYYY-MM-DD`, generate `daily-video/YYYY-MM-DD/<sha256>.(mp4|jpg|vtt)` keys, store immutable R2 objects with correct content types, and upsert duration/title/description/size/upload timestamps into `daily_videos`.

**Step 4: Run the tests and confirm GREEN**

Run: `cd worker && npm test -- src/digest/daily-video.test.ts`

Expected: all pass.

### Task 5: Put the video at the top of the matching daily static page

**Files:**
- Modify: `worker/src/digest/daily-page.ts`
- Modify: `worker/src/digest/daily-page.test.ts`
- Modify: `worker/src/digest/daily-page-run.ts`
- Modify: `worker/src/digest/daily-page-run.test.ts`
- Modify: `worker/src/digest/daily-video.ts`

**Step 1: Write failing rendering and historical-patch tests**

Assert that a page with video metadata renders a responsive top player before article sections, uses poster and VTT captions, emits a `VideoObject` with `name`, `description`, `thumbnailUrl`, `uploadDate`, `duration`, `contentUrl`, and retains the existing page content byte-for-byte outside idempotent markers when patching a historical R2 snapshot.

**Step 2: Run the tests and confirm RED**

Run: `cd worker && npm test -- src/digest/daily-page.test.ts src/digest/daily-page-run.test.ts src/digest/daily-video.test.ts`

Expected: missing player and structured-data assertions fail.

**Step 3: Implement native future rendering and safe historical injection**

Load video metadata for new page renders, add `<video controls preload="metadata" playsinline>` at page top, add a default caption track, merge `VideoObject` into the JSON-LD graph, and patch historical snapshots between stable markers instead of rerunning historical content selection.

**Step 4: Run focused tests and confirm GREEN**

Run: `cd worker && npm test -- src/digest/daily-page.test.ts src/digest/daily-page-run.test.ts src/digest/daily-video.test.ts`

Expected: all pass, including idempotency.

### Task 6: Add video discovery surfaces and recrawl signals

**Files:**
- Modify: `worker/src/seo-routes.ts`
- Modify: `worker/src/seo-routes.test.ts`
- Modify: `worker/src/digest/daily-video.ts`

**Step 1: Write failing sitemap tests**

Assert `/video-sitemap.xml` has one entry per active `daily_videos` row with landing-page URL, thumbnail, title, description, content location, publication date and duration; assert `/sitemap.xml` references it, robots references the sitemap index, and daily sitemap lastmod reflects the video publish update.

**Step 2: Run and confirm RED**

Run: `cd worker && npm test -- src/seo-routes.test.ts`

Expected: video sitemap assertions fail.

**Step 3: Implement sitemap, lastmod and IndexNow updates**

Serve valid escaped XML, include the video sitemap in the index, update `daily_pages.generated_at` only after successful page injection, and submit the landing page, video sitemap, daily sitemap and sitemap index through the existing resilient IndexNow client.

**Step 4: Run and confirm GREEN**

Run: `cd worker && npm test -- src/seo-routes.test.ts src/digest/daily-video.test.ts`

Expected: all pass.

### Task 7: Publish completed HK videos with durable retry state

**Files:**
- Create: `/Users/roxor/Documents/dailyVideo/workflows/aifeeds-daily/publish-video-seo.mjs`
- Create: `/Users/roxor/Documents/dailyVideo/workflows/aifeeds-daily/publish-video-seo.test.mjs`
- Modify: `/Users/roxor/Documents/dailyVideo/workflows/aifeeds-daily/run.mjs`
- Modify: `/Users/roxor/Documents/dailyVideo/workflows/aifeeds-x-card/server.mjs`
- Modify: `/Users/roxor/Documents/dailyVideo/workflows/aifeeds-x-card/share-index.test.mjs`

**Step 1: Write failing publisher tests**

Cover readiness validation (MP4, 16:9 poster, VTT, ffprobe duration), SHA calculation, multipart payload, successful receipt persistence, transient retry state, permanent validation failure, and workbench progress/status output.

**Step 2: Run and confirm RED**

Run: `node --test workflows/aifeeds-daily/publish-video-seo.test.mjs workflows/aifeeds-x-card/share-index.test.mjs`

Expected: publisher/status tests fail before implementation.

**Step 3: Implement post-ready publication**

Invoke the publisher only after the daily video is marked ready, write an atomic local receipt keyed by date and SHA, retry network/5xx failures without rerendering media, and expose upload/page-index status and failure reason in `/aifeeds/latest/`.

**Step 4: Run and confirm GREEN**

Run: `node --test workflows/aifeeds-daily/publish-video-seo.test.mjs workflows/aifeeds-x-card/share-index.test.mjs`

Expected: all pass.

### Task 8: Clear production backlog and regenerate affected dates

**Files:**
- No source changes; production operations only after Tasks 1–7 pass.

**Step 1: Deploy migration and Worker to staging**

Run the D1 migration, deploy the feature Worker, and perform authenticated staging upload and Range-request smoke tests.

Expected: upload returns metadata; `GET /r/<mp4-key>` returns `206` for a byte range.

**Step 2: Drain GH and HF backlogs in bounded batches**

Trigger automatic/admin drains repeatedly while checking pending, completed, failed, oldest-age, and ready-pool counts after every batch.

Expected: pending counts reach zero or every residual row has an explicit terminal reason; no silent NULL backlog remains.

**Step 3: Rerun digest selection and downstream material generation**

Regenerate affected daily pools, push corrected payloads to HK, and rerun posters/videos for dates whose GH/HF sections were incomplete, prioritizing 2026-07-14.

Expected: corrected input and generated assets contain the selected GH/HF items and pass existing audio/video alignment gates.

### Task 9: Production verification, integration and rollout

**Files:**
- Verify all modified files from Tasks 1–7.

**Step 1: Run full Worker tests and type/build checks**

Run: `cd worker && npm test`

Run: `cd worker && npx tsc --noEmit`

Expected: zero failures.

**Step 2: Run dailyVideo tests and syntax checks**

Run: `node --test workflows/aifeeds-daily/*.test.mjs workflows/aifeeds-x-card/share-index.test.mjs`

Run: `node --check workflows/aifeeds-daily/run.mjs && node --check workflows/aifeeds-daily/publish-video-seo.mjs`

Expected: zero failures.

**Step 3: Deploy production and verify public behavior**

Verify `/daily/2026-07-14` has the player at the top, MP4 Range requests work, captions load, `VideoObject` parses, `/video-sitemap.xml` contains the date, `/sitemap.xml` references it, and `/aifeeds/latest/` reports video SEO publication complete.

Expected: all checks pass from public endpoints.

**Step 4: Integrate only after verification**

Commit the feature branch, rebase on the latest remote `main`, rerun focused verification, push the branch, fast-forward or merge into `main`, push `main`, deploy the merged revision, and record rollback commands and deployed commit SHA.

Expected: remote `main` contains the verified commits and production runs that exact revision.
