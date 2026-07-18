import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../api.ts"), "utf8");
const app = fs.readFileSync(path.join(here, "../App.tsx"), "utf8");
const feed = fs.readFileSync(path.join(here, "../components/Feed.tsx"), "utf8");
const html = fs.readFileSync(path.join(here, "../../index.html"), "utf8");
const scheduling = fs.readFileSync(path.join(here, "feedScheduling.ts"), "utf8");

test("fetchItems owns normalized exact-path single-flight and preserves Promise identity", () => {
  assert.match(api, /export function fetchItems\(/);
  assert.doesNotMatch(api, /export async function fetchItems\(/);
  assert.match(api, /const path = buildItemsPath\(query\)/);
  assert.match(api, /return runListSingleFlight\(path, purpose, \(readPurpose\) => \{/);
  const singleFlightFactory = api.slice(
    api.indexOf("return runListSingleFlight(path"),
    api.indexOf("export async function fetchFeedManifest"),
  );
  assert.match(singleFlightFactory, /consumeFeedPrefetch/,
    "HTML prefetch consumption must happen inside the one shared factory");
  assert.match(singleFlightFactory, /requestPurpose:\s*readPurpose/);
});

test("apiFetch strips purpose from native fetch and uses the bounded method-safe policy", () => {
  assert.match(api, /const requestPurpose = _omitPurpose \?\? ["']critical["']/);
  assert.match(api, /requestPurpose:\s*_omitPurpose/);
  assert.match(api, /executeRequestWithPolicy<Response>\(\{/);
  assert.match(api, /purpose:\s*requestPurpose/);
  assert.doesNotMatch(api, /RETRY_BACKOFFS_MS|attempt <= RETRY_BACKOFFS_MS\.length/);
  assert.doesNotMatch(api, /fetch\([^)]*requestPurpose/);
});

test("initial/list pagination budgets and background reads are explicit", () => {
  assert.match(feed, /const INITIAL_LIMIT = 12/);
  assert.match(feed, /loadMoreLimitForViewport\(window\.innerWidth\)/);
  assert.match(feed, /if \(placeholder \|\| !hasMore \|\| isNarrowFeed\) return;/,
    "mobile must not attach an automatic infinite-scroll observer");
  assert.match(feed, /加载更多/,
    "mobile pagination must remain available through explicit user intent");
  assert.doesNotMatch(feed, /const LOAD_MORE_LIMIT = 30/);
  assert.match(feed, /purpose:\s*["']background["']/,
    "polling or prefetch reads must opt out of retries");
  assert.match(html, /\/api\/items\?source_type=x_list&limit=12/);
  assert.doesNotMatch(html, /source_type=x_list&limit=30/);
});

test("actual non-placeholder Feed mounts are reference-counted for background scheduling", () => {
  assert.match(feed, /registerMountedFeed/);
  assert.match(feed, /if \(placeholder\) return;[\s\S]*?return registerMountedFeed\(sourceType\)/);
  assert.match(feed, /hasListRequestForSource\(sourceType\)/);
  assert.match(feed, /isFeedMounted\(sourceType\)/);
  assert.match(feed, /sourceType === ["']clawhub["'][\s\S]*?sourceType === ["']huodongxing["']/,
    "filtered channels must not use a source-only background cache key");
});

test("DeferredFeed mounts a responsive first row and gates lower IO until page scroll", () => {
  assert.match(app, /const DeferredFeed = forwardRef<FeedHandle/);
  assert.match(app, /rootMargin:\s*["']200px 0px["']/);
  assert.match(app, /typeof IntersectionObserver === ["']undefined["']/);
  assert.match(app, /mounted \|\| immediate/);
  assert.doesNotMatch(app, /setMounted\(false\)/);
  assert.match(app, /getImmediateColumnCount\(window\.innerWidth\)/);
  assert.match(app, /setImmediateColumnCount\(\(current\) => \([\s\S]*?Math\.max\(current, getImmediateColumnCount\(window\.innerWidth\)\)[\s\S]*?\)\)/,
    "desktop resize promotion must not demote an already-mounted first-row Feed");
  assert.match(app, /window\.scrollY > 0/);
  assert.match(app, /index < immediateColumnCount/);
  assert.match(app, /observationEnabled=\{pageHasScrolled\}/);
  assert.match(app, /onScrollCapture=\{unlockDeferredFeedsFromColumnScroll\}/,
    "desktop feed-body scroll must unlock lower rows");
  assert.match(app, /h-\[70vh\]/);
  assert.match(feed, /md:h-\[70vh\]/,
    "mounted desktop feeds must preserve the deferred shell row height");
});

test("lower-row reveals share one queue and release it only after the mounted Feed settles", () => {
  const deferredBlock = app.slice(app.indexOf("function DeferredFeed"), app.indexOf("function DashboardHome"));
  assert.match(app, /const deferredFeedMountQueue = createBackgroundQueue\(\)/);
  assert.match(deferredBlock, /deferredFeedMountQueue\.enqueue/);
  assert.match(deferredBlock, /onInitialRequestSettled=\{settleDeferredMount\}/);
  assert.match(
    deferredBlock,
    /if \(!entries\.some[\s\S]*?deferredFeedMountQueue\.enqueue[\s\S]*?setMounted\(true\)/,
    "an observer callback must acquire the serial queue before mounting a lower Feed",
  );
  assert.match(feed, /onInitialRequestSettled\?: \(\) => void/);
  assert.match(feed, /onInitialRequestSettledRef\.current\?\.\(\)/);
});

test("deferred shells contain no Feed or media and lower columns mount only once", () => {
  const deferredBlock = app.slice(app.indexOf("function DeferredFeed"), app.indexOf("function DashboardHome"));
  assert.match(deferredBlock, /if \(mounted \|\| immediate\)[\s\S]*?<Feed/);
  assert.match(deferredBlock, /data-deferred-feed-shell/);
  assert.doesNotMatch(deferredBlock, /<img|<video|animate-pulse/);
  assert.match(deferredBlock, /observer\.disconnect\(\)/);
});

test("mobile prefetch is driven only by chip or adjacent-swipe intent", () => {
  assert.match(app, /createIntentPrefetchController/);
  assert.match(app, /adjacentSourceForIntent/);
  assert.match(app, /canStartBackgroundPrefetch/);
  assert.match(app, /onPointerDown=\{\(\) => requestIntentPrefetch\(key\)\}/);
  assert.match(app, /onFocus=\{\(\) => requestIntentPrefetch\(key\)\}/);
  assert.match(app, /requestAdjacentIntentPrefetch/);
  assert.doesNotMatch(app, /const prefetchCandidates = SOURCE_COLUMNS/);
  assert.doesNotMatch(app, /waitForBackgroundReadiness/);
  assert.match(scheduling, /return !isBackgroundPrefetchDisabled\(readConnection\(\)\)/);
});

test("X polling uses one cancellable recursive timer and live eligibility", () => {
  assert.match(feed, /shouldPollFeed/);
  assert.match(feed, /window\.setTimeout\(runPoll, POLL_INTERVAL_MS\)/);
  assert.doesNotMatch(feed, /setInterval\(poll/);
  assert.match(feed, /visibilitychange/);
  assert.match(feed, /window\.addEventListener\(["']online["']/);
  assert.match(feed, /window\.addEventListener\(["']offline["']/);
});

test("the atomic P1 switch removes the C sources and stats gate", () => {
  assert.match(fs.readFileSync(path.join(here, "feedAvailability.ts"), "utf8"), /OPTIMISTIC_FEED_START = true/);
  assert.doesNotMatch(app, /fetchSources|fetchStats|setSources|setStats|\[sources|\[stats/);
  assert.match(app, /fetchFeedManifest/);
  assert.match(app, /onInitialRequestStart=/);
});
