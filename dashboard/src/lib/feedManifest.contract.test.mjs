import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = fs.readFileSync(path.join(here, "../api.ts"), "utf8");
const app = fs.readFileSync(path.join(here, "../App.tsx"), "utf8");
const types = fs.readFileSync(path.join(here, "../types.ts"), "utf8");
const feed = fs.readFileSync(path.join(here, "../components/Feed.tsx"), "utf8");

test("dashboard declares and fetches the narrow feed manifest contract", () => {
  assert.match(types, /export interface FeedManifest\s*\{/);
  assert.match(types, /live_source_types:\s*SourceType\[\]/);
  assert.match(types, /labels:\s*Partial<Record<SourceType, string>>/);
  assert.match(types, /generated_at:\s*string/);
  assert.match(api, /export async function fetchFeedManifest\(signal\?: AbortSignal\): Promise<FeedManifest>/);
  assert.match(api, /apiFetch\('\/api\/feed-manifest', \{/);
  assert.match(api, /requestPurpose: "background"/);
});

test("only a mounted Feed initial request can unlock manifest reconciliation", () => {
  assert.doesNotMatch(
    api,
    /firstFeedRequestStarted|markFirstFeedRequestStarted|waitForFirstFeedRequestStarted/,
    "generic fetchItems calls must not own the page lifecycle gate",
  );

  const prefetchBlock = feed.slice(
    feed.indexOf("const PREFETCH_LIMIT"),
    feed.indexOf("interface Props"),
  );
  assert.doesNotMatch(prefetchBlock, /onInitialRequestStart/,
    "background prefetch must not unlock manifest");

  const propsBlock = feed.slice(feed.indexOf("interface Props"), feed.indexOf("const INITIAL_LIMIT"));
  assert.match(propsBlock, /onInitialRequestStart\?: \(\) => void/);

  const initialRequestEffect = feed.slice(
    feed.indexOf("// Initial load + refresh on tick or sort change"),
    feed.indexOf("const loadMore", feed.indexOf("// Initial load + refresh on tick or sort change")),
  );
  const requestAt = initialRequestEffect.indexOf("const request = fetchItems(");
  const callbackAt = initialRequestEffect.indexOf("onInitialRequestStartRef.current?.()");
  const handlersAt = initialRequestEffect.indexOf("request\n      .then(");
  assert.ok(requestAt >= 0, "mounted Feed must create its list request promise");
  assert.ok(callbackAt > requestAt, "callback must run only after fetchItems has begun");
  assert.ok(handlersAt > callbackAt, "callback must run before result handlers are attached");
  const requestDependencies = initialRequestEffect.match(/\}, \[sourceType,[^\]]*\]\);/)?.[0] ?? "";
  assert.ok(requestDependencies, "request effect dependency list must be found");
  assert.doesNotMatch(requestDependencies, /onInitialRequestStart|onInitialRequestStartRef/,
    "withdrawing the one-shot callback must not clean up or restart the list request");
  assert.match(feed, /const onInitialRequestStartRef = useRef\(onInitialRequestStart\);\s*onInitialRequestStartRef\.current = onInitialRequestStart;/,
    "the latest callback capability must be stored without becoming an effect dependency");
});

test("multiple Feed callbacks unlock manifest only once per refresh tick", () => {
  assert.match(app, /const \[feedRequestStartedForTick, setFeedRequestStartedForTick\] = useState<number \| null>\(null\)/);
  assert.match(
    app,
    /const handleInitialFeedRequestStart = useCallback\(\(\) => \{[\s\S]*?setFeedRequestStartedForTick\(\(startedTick\) =>[\s\S]*?startedTick === refreshTick \? startedTick : refreshTick[\s\S]*?\);[\s\S]*?\}, \[refreshTick\]\);/,
  );
  assert.match(
    app,
    /const shouldLoadManifest = OPTIMISTIC_FEED_START\s*&&\s*feedRequestStartedForTick === refreshTick/,
  );
  assert.match(
    app,
    /onInitialRequestStart=\{OPTIMISTIC_FEED_START && !shouldLoadManifest\s*\? handleInitialFeedRequestStart\s*:\s*undefined\}/,
    "the capability must be withdrawn after the first mounted Feed unlocks this tick",
  );
});

test("fresh cache cannot bypass the mounted request signal in optimistic mode", () => {
  const initialRequestEffect = feed.slice(
    feed.indexOf("// Initial load + refresh on tick or sort change"),
    feed.indexOf("const loadMore", feed.indexOf("// Initial load + refresh on tick or sort change")),
  );
  const freshCacheReturn = initialRequestEffect.match(
    /if \(!onInitialRequestStartRef\.current[^\n]*fresh\?\.items\.length[^\n]*Date\.now\(\) - fresh\.ts < 60_000\)\s*\{[\s\S]*?onInitialRequestSettledRef\.current\?\.\(\);[\s\S]*?return;[\s\S]*?\}/,
  )?.[0] ?? "";

  assert.match(freshCacheReturn, /!onInitialRequestStartRef\.current/,
    "only a mount without the current-tick callback capability may take the cache return");
  assert.ok(
    initialRequestEffect.indexOf(freshCacheReturn) < initialRequestEffect.indexOf("const request = fetchItems("),
    "cache check must remain before the real request path",
  );
  assert.match(initialRequestEffect, /const hasHydrated = Boolean\(readFeedCache\(sourceType\)\?\.items\.length\);\s*if \(!hasHydrated\) setLoading\(true\)/,
    "optimistic mode should keep hydrated content visible while its request runs silently");
});

test("callback withdrawal preserves the in-flight request and later remounts restore cache skip", () => {
  const initialRequestEffect = feed.slice(
    feed.indexOf("// Initial load + refresh on tick or sort change"),
    feed.indexOf("const loadMore", feed.indexOf("// Initial load + refresh on tick or sort change")),
  );
  const requestAt = initialRequestEffect.indexOf("const request = fetchItems(");
  const callbackAt = initialRequestEffect.indexOf("onInitialRequestStartRef.current?.()");
  const cleanupAt = initialRequestEffect.indexOf("cancelled = true");

  assert.ok(requestAt >= 0 && callbackAt > requestAt && cleanupAt > callbackAt,
    "StrictMode setup must start request, signal idempotently, then retain normal cleanup ordering");
  assert.doesNotMatch(
    initialRequestEffect.match(/\}, \[sourceType,[^\]]*\]\);/)?.[0] ?? "",
    /onInitialRequestStart|onInitialRequestStartRef/,
  );
  assert.match(
    initialRequestEffect,
    /if \(!onInitialRequestStartRef\.current[^\n]*fresh[^\n]*\)\s*\{[\s\S]*?onInitialRequestSettledRef\.current\?\.\(\);[\s\S]*?return;/,
    "a later Feed remount after capability withdrawal must regain the 60-second skip and release its reveal slot",
  );
});

test("the atomic P1 switch uses only the abortable manifest path", () => {
  const manifestCall = app.indexOf("void fetchFeedManifest");
  const metadataEffectStart = app.lastIndexOf("useEffect(() => {", manifestCall);
  const metadataEffectEnd = app.indexOf("}, [refreshTick, shouldLoadManifest]);", manifestCall);
  assert.ok(metadataEffectStart >= 0, "metadata effect start must be found");
  assert.ok(metadataEffectEnd > metadataEffectStart, "metadata effect end must be found after its start");
  const metadataEffect = app.slice(metadataEffectStart, metadataEffectEnd);
  assert.match(metadataEffect, /if \(!shouldLoadManifest\) return/);
  assert.match(metadataEffect, /const controller = new AbortController\(\)/);
  assert.match(metadataEffect, /fetchFeedManifest\(controller\.signal\)/);
  assert.match(metadataEffect, /return \(\) => controller\.abort\(\)/);
  assert.doesNotMatch(app, /fetchSources|fetchStats|setSources|setStats/);
  assert.match(app, /\}, \[refreshTick, shouldLoadManifest\]\);/);
});

test("manifest reconciliation cannot gate Feed rendering or feed_ready", () => {
  assert.match(app, /manifest\?\.live_source_types/);
  assert.match(app, /manifest\?\.labels\.x_list/);
  assert.doesNotMatch(feed, /fetchFeedManifest|waitForFirstFeedRequestStarted|FeedManifest/);

  const feedRender = app.slice(app.indexOf("{visibleColumns.map"), app.indexOf("</main>"));
  assert.match(feedRender, /<DeferredFeed/);
  assert.doesNotMatch(feedRender, /await|fetchFeedManifest/);
  assert.doesNotMatch(app, /Promise\.all[^\n]*fetchFeedManifest/);

  const manifestCall = app.indexOf("void fetchFeedManifest");
  const metadataEffect = app.slice(
    app.lastIndexOf("useEffect(() => {", manifestCall),
    app.indexOf("}, [refreshTick, shouldLoadManifest]);", manifestCall),
  );
  assert.match(metadataEffect, /controller\.signal\.aborted/);
  assert.match(metadataEffect, /return \(\) => controller\.abort\(\)/);
});
