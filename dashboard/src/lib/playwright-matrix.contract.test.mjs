import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "../..");
const root = path.resolve(dashboard, "..");
const config = fs.readFileSync(path.join(dashboard, "playwright.config.ts"), "utf8");
const spec = fs.readFileSync(path.join(dashboard, "e2e/home-performance.spec.ts"), "utf8");
const feed = fs.readFileSync(path.join(dashboard, "src/components/Feed.tsx"), "utf8");
const prWorkflow = fs.readFileSync(path.join(root, ".github/workflows/pr-validation.yml"), "utf8");
const deployWorkflow = fs.readFileSync(path.join(root, ".github/workflows/deploy-dashboard.yml"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(dashboard, "package.json"), "utf8"));

test("mobile matrix contains real Chromium and WebKit engines", () => {
  assert.match(config, /name:\s*["']iphone-webkit["']/);
  assert.match(config, /browserName:\s*["']webkit["']/);
  assert.match(config, /name:\s*["']android-chromium["']/);
  assert.match(config, /name:\s*["']desktop-chromium["']/);
  assert.match(config, /name:\s*["']desktop-chromium["'][\s\S]{0,220}?userAgent:\s*chromiumUserAgent/);
  assert.match(config, /name:\s*["']tablet-chromium["'][\s\S]{0,260}?userAgent:\s*chromiumUserAgent/);
});

test("mobile swipe uses a non-CDP path under WebKit", () => {
  assert.match(spec, /projectName\.includes\(["']webkit["']\)/);
  assert.match(spec, /new TouchEvent\(type/);
  assert.doesNotMatch(spec, /new Touch\(/,
    "Playwright WebKit exposes TouchEvent but its Touch constructor is illegal");
  assert.match(spec, /Object\.defineProperties\(event/);
  assert.match(spec, /dispatch\(["']touchstart["']/);
  assert.match(spec, /newCDPSession/);
});

test("both CI hard gates install pinned Chromium and WebKit runtimes", () => {
  for (const workflow of [prWorkflow, deployWorkflow]) {
    assert.match(workflow, /playwright-chromium-webkit-/);
    assert.match(workflow, /playwright install --with-deps chromium webkit/);
    assert.match(workflow, /playwright install-deps chromium webkit/);
  }
});

test("perf staging has an exact-host five-device remote browser gate", () => {
  const remoteSpecPath = path.join(dashboard, "e2e/perf-staging-remote.spec.ts");
  assert.equal(fs.existsSync(remoteSpecPath), true, "remote perf-staging spec must exist");
  const remoteSpec = fs.readFileSync(remoteSpecPath, "utf8");
  const remoteRunnerPath = path.join(dashboard, "scripts/run-perf-staging-e2e.sh");
  assert.equal(fs.existsSync(remoteRunnerPath), true, "remote perf-staging runner must exist");
  const remoteRunner = fs.readFileSync(remoteRunnerPath, "utf8");
  const stagingRunbook = fs.readFileSync(
    path.join(root, "docs/reviews/c-end-perf-staging-change-packet.md"),
    "utf8",
  );

  assert.match(config, /E2E_BASE_URL/);
  assert.match(config, /E2E_OUTPUT_DIR/);
  assert.match(config, /aifeeds-perf-staging-/);
  assert.match(config, /perf-staging\.ai-feeds\.com/);
  assert.match(config, /target\.username/);
  assert.match(config, /target\.password/);
  assert.match(config, /target\.search/);
  assert.match(config, /target\.hash/);
  assert.match(config, /forbidOnly:\s*isCI\s*\|\|\s*isRemote/);
  assert.match(config, /webServer:\s*isRemote\s*\?\s*undefined/);
  assert.match(config, /trace:\s*isRemote\s*\?\s*["']off["']/);
  assert.match(config, /screenshot:\s*isRemote\s*\?\s*["']off["']/);
  assert.match(config, /serviceWorkers:\s*isRemote\s*\?\s*["']allow["']/);
  assert.match(config, /reporter:\s*isRemote[\s\S]{0,60}?\[\["line"\]\]/);
  assert.match(config, /PLAYWRIGHT_NO_COPY_PROMPT/);
  assert.match(packageJson.scripts["test:e2e:perf-staging"], /scripts\/run-perf-staging-e2e\.sh/);
  assert.match(remoteRunner, /E2E_EXPECTED_X_FIXTURE_ID/);
  assert.match(remoteRunner, /E2E_EXPECTED_BLOG_FIXTURE_ID/);
  assert.match(remoteRunner, /x_list:perf-staging-\[a-f0-9\]\{20\}/);
  assert.match(remoteRunner, /blog:perf-staging-\[a-f0-9\]\{20\}/);
  assert.match(remoteRunner, /exec npx playwright test e2e\/perf-staging-remote\.spec\.ts/);
  assert.match(stagingRunbook, /FIXTURES="\$EVIDENCE\/synthetic-feed-fixtures\.json"/);
  assert.match(stagingRunbook, /E2E_EXPECTED_X_FIXTURE_ID="\$X_FIXTURE_ID"/);
  assert.match(stagingRunbook, /E2E_EXPECTED_BLOG_FIXTURE_ID="\$BLOG_FIXTURE_ID"/);
  assert.match(remoteSpec, /E2E_REMOTE/);
  assert.match(remoteSpec, /E2E_COOKIE_JAR/);
  assert.match(remoteSpec, /E2E_EXPECTED_UID/);
  assert.match(remoteSpec, /E2E_EXPECTED_DID/);
  assert.match(remoteSpec, /E2E_EXPECTED_X_FIXTURE_ID/);
  assert.match(remoteSpec, /E2E_EXPECTED_BLOG_FIXTURE_ID/);
  assert.match(remoteSpec, /E2E_PERF_PROBE/);
  assert.match(remoteSpec, /X-Aifeeds-Perf-Probe/);
  assert.match(remoteSpec, /codex_perf_probe=1/);
  assert.match(remoteSpec, /aifeeds:feed-ready/);
  assert.match(remoteSpec, /workerStartMs/);
  const warmHelperStart = remoteSpec.indexOf("function expectWarmServiceWorkerNavigation");
  const warmHelperEnd = remoteSpec.indexOf("function", warmHelperStart + 20);
  const warmHelperBlock = remoteSpec.slice(warmHelperStart, warmHelperEnd);
  assert.notEqual(warmHelperStart, -1);
  assert.match(warmHelperBlock, /fromServiceWorker\(\)\)\.toBe\(true\)/);
  assert.match(warmHelperBlock, /swControllerPresent\)\.toBe\(true\)/);
  assert.match(warmHelperBlock, /transferBytes\)\.toBe\(0\)/);
  assert.match(warmHelperBlock,
    /if\s*\(!projectName\.includes\(["']webkit["']\)\)\s*\{[\s\S]{0,120}?workerStartMs\)\.toBeGreaterThan\(0\)/);
  const homeTestStart = remoteSpec.indexOf('test("five-device home');
  const homeTestEnd = remoteSpec.indexOf('test("the private synthetic login', homeTestStart);
  const homeTestBlock = remoteSpec.slice(homeTestStart, homeTestEnd);
  assert.notEqual(homeTestStart, -1);
  assert.match(homeTestBlock, /const warmNavigationResponse = await page\.reload/);
  assert.match(homeTestBlock,
    /expectWarmServiceWorkerNavigation\(\s*warm,\s*testInfo\.project\.name,\s*warmNavigationResponse/);
  assert.doesNotMatch(remoteSpec,
    /expect\(warm\.navigation\.workerStartMs\)\.toBeGreaterThan\(0\)/,
    "WebKit must prove warm Service Worker control without Chromium-only workerStart timing");
  assert.match(remoteSpec, /cold-warm-page-performance\.json/);
  assert.match(remoteSpec, /belowFoldMediaBeforeCutoffCount/);
  assert.match(remoteSpec, /request\.timing\(\)\.startTime/);
  assert.match(remoteSpec, /expectedInitialListSources/);
  assert.match(remoteSpec, /listRequestsBeforeCutoffCount\)\.toBe\(expectedSources\.length\)/);
  assert.match(remoteSpec, /contentionCutoff/);
  assert.match(remoteSpec, /\?\s*"feed_ready"\s*:\s*"lcp"/);
  assert.match(remoteSpec, /feedReadyMs:\s*5_000/);
  assert.match(remoteSpec, /lcpMs:\s*7_000/);
  assert.match(remoteSpec, /layoutShift\.status/);
  assert.match(remoteSpec, /"unsupported"/);
  assert.match(remoteSpec, /Math\.round\(value \* 10_000\) \/ 10_000/);
  assert.match(remoteSpec, /image\.decode\(\)/);
  assert.match(remoteSpec, /failedCardVariantRequestCount/);
  assert.match(remoteSpec, /mobile projects switch[\s\S]{0,500}?trackSafeMediaRequests/);
  assert.match(remoteSpec, /async function expectFeedColumnInViewport/);
  assert.match(remoteSpec, /getBoundingClientRect\(\)/);
  assert.match(remoteSpec, /matches\.length !== 1/);
  assert.match(remoteSpec,
    /const activeBlogFeed = await expectFeedColumnInViewport\(page, "blog,podcast"\)/);
  assert.match(remoteSpec, /expectedSyntheticFixtureId/);
  assert.match(remoteSpec, /readSyntheticFixtureFromUiResponse/);
  assert.match(remoteSpec, /readSyntheticFixtureFromUiResponse\(\s*listResponse/);
  assert.match(remoteSpec, /readSyntheticFixtureFromUiResponse\(\s*blogResponse/);
  assert.doesNotMatch(remoteSpec, /type APIRequestContext/);
  assert.doesNotMatch(remoteSpec, /expectSyntheticFixtureInUiList\(\s*request/);
  assert.match(remoteSpec, /url\.searchParams\.get\("source_type"\)/);
  assert.match(remoteSpec, /url\.searchParams\.get\("limit"\)\)\.toBe\("12"\)/);
  assert.match(remoteSpec, /url\.searchParams\.get\("sort"\)\)\.toBe\("published_at"\)/);
  assert.match(remoteSpec, /items\.find\(\(item\) => item\.id === expectedFixtureId\)/);
  assert.match(remoteSpec, /const blogResponsePromise = page\.waitForResponse/);
  assert.match(remoteSpec, /expectExactFixtureImage/);
  assert.match(remoteSpec, /requireFirst:\s*true/);
  const mobileSwipeStart = remoteSpec.indexOf('test("mobile projects switch');
  const mobileSwipeEnd = remoteSpec.indexOf('test("representative desktop', mobileSwipeStart);
  const mobileSwipeBlock = remoteSpec.slice(mobileSwipeStart, mobileSwipeEnd);
  assert.notEqual(mobileSwipeStart, -1);
  assert.match(mobileSwipeBlock,
    /readSyntheticFixtureFromUiResponse\(\s*blogResponse[\s\S]{0,180}?requireFirst:\s*true/);
  assert.match(mobileSwipeBlock,
    /await expectExactFixtureImage\(\s*activeBlogFeed,\s*expectedBlogImage\.originalPath,\s*expectedBlogImagePath/);
  assert.match(remoteSpec, /expectedBlogImagePath/);
  assert.match(remoteSpec, /mediaRequestRecords\.slice\(swipeMediaRequestBaseline\)/);
  assert.match(remoteSpec, /url\.pathname === expectedBlogImagePath/);
  assert.doesNotMatch(remoteSpec, /firstBlogImage/);
  assert.match(remoteSpec, /HTMLVideoElement[\s\S]{0,120}?element\.poster/);
  assert.match(remoteSpec, /renameSync\(temporary, file\)/);
  const settleStart = remoteSpec.indexOf("async function settleLcpAfterFeedReady");
  const settleEnd = remoteSpec.indexOf("async function settleVisibleCardMedia", settleStart);
  const settleBlock = remoteSpec.slice(settleStart, settleEnd);
  const visibleSettleIndex = settleBlock.indexOf("await settleVisibleCardMedia(page");
  const lcpFinalizeIndex = settleBlock.indexOf('dispatchEvent(new Event("aifeeds:lcp-settled"))');
  assert.notEqual(visibleSettleIndex, -1);
  assert.notEqual(lcpFinalizeIndex, -1);
  assert.ok(
    visibleSettleIndex < lcpFinalizeIndex,
    "visible LCP candidates must settle before the non-input event freezes LCP",
  );
  assert.doesNotMatch(settleBlock, /keyboard\.press/);
  assert.match(remoteSpec, /takeRecords\(\)/);
  assert.match(remoteSpec, /disconnect\(\)/);
  assert.match(remoteSpec, /WORKER_ASSET_ORIGIN\s*=\s*"https:\/\/staging-api\.ai-feeds\.com"/);
  assert.match(remoteSpec, /expectedPageOrigin/);
  assert.match(remoteSpec, /expectedAssetOrigin/);
  assert.match(remoteSpec, /url\.origin !== expectedAssetOrigin/);
  assert.match(remoteSpec, /url\.origin === workerAssetOrigin\s*&&\s*cardVariantPattern\.test/);
  const visibleSettleStart = remoteSpec.indexOf("async function settleVisibleCardMedia");
  const visibleSettleEnd = remoteSpec.indexOf("async function settleDeferredFontsAndLayout", visibleSettleStart);
  const visibleSettleBlock = remoteSpec.slice(visibleSettleStart, visibleSettleEnd);
  assert.notEqual(visibleSettleStart, -1);
  assert.notEqual(visibleSettleEnd, -1);
  assert.match(visibleSettleBlock, /while \(performance\.now\(\) < deadline\)/);
  assert.match(visibleSettleBlock, /querySelectorAll<HTMLImageElement>/);
  assert.match(visibleSettleBlock, /image\.isConnected/);
  assert.match(visibleSettleBlock, /safeLabel/);
  assert.match(visibleSettleBlock, /unsettledVisibleImages/);
  assert.match(visibleSettleBlock, /state:\s*"decode_failed" \| "decode_pending" \| "zero_dimension"/);
  assert.match(remoteSpec, /a card image removed by its error fallback does not block media settle/);
  assert.match(remoteSpec, /a persistent broken card fails closed with allowlisted diagnostics/);
  assert.match(remoteSpec, /visible card image decode did not settle/);
  const exactImageStart = remoteSpec.indexOf("async function expectExactFixtureImage");
  const exactImageEnd = remoteSpec.indexOf("async function", exactImageStart + 20);
  const exactImageBlock = remoteSpec.slice(exactImageStart, exactImageEnd);
  assert.match(exactImageBlock, /toBeInViewport\(\)/);
  assert.match(exactImageBlock, /toHaveAttribute\("loading",\s*"eager"\)/);
  assert.match(exactImageBlock, /currentSrc[\s\S]{0,160}?toBe\(variantPath\)/);
  const decodeIndex = exactImageBlock.indexOf("element.decode()");
  const currentSrcIndex = exactImageBlock.indexOf("element.currentSrc");
  assert.notEqual(decodeIndex, -1);
  assert.notEqual(currentSrcIndex, -1);
  assert.ok(decodeIndex < currentSrcIndex,
    "owned first-card media must decode before its exact currentSrc is asserted");
  assert.doesNotMatch(exactImageBlock, /scrollIntoViewIfNeeded/,
    "the owned rank-one fixture must already be in the first viewport");
  assert.match(remoteSpec, /HTMLVideoElement[\s\S]{0,300}?\.poster/);
  assert.match(remoteSpec, /aifeeds:cls-settled/);
  assert.match(remoteSpec, /data-aifeeds-deferred-font/);
  assert.match(remoteSpec, /document\.fonts\.ready/);
  assert.match(remoteSpec, /post-ready-settle-events/);
  assert.match(remoteSpec, /swipeMediaRequestBaseline/);
  assert.match(remoteSpec, /safeVisibleCardVariantRequestSummary/);
  assert.match(remoteSpec, /mediaRequestRecords,\s*swipeMediaRequestBaseline/);
  assert.match(remoteSpec, /visibleVariantUrls\.has\(url\.href\)/);
  assert.match(remoteSpec, /const column = image\.closest<HTMLElement>\("\[data-feed-column\]"\)/);
  assert.match(remoteSpec, /column\?\.dataset\.feedColumn !== feedSource/);
  const variantSummaryStart = remoteSpec.indexOf("async function safeVisibleCardVariantRequestSummary");
  const variantSummaryEnd = remoteSpec.indexOf("async function", variantSummaryStart + 20);
  const variantSummaryBlock = remoteSpec.slice(variantSummaryStart, variantSummaryEnd);
  assert.match(variantSummaryBlock, /const columnRect = column\?\.getBoundingClientRect\(\)/);
  assert.match(variantSummaryBlock, /columnRect\.right <= 0/);
  assert.match(variantSummaryBlock, /columnRect\.left >= innerWidth/);
  assert.match(variantSummaryBlock, /rect\.right <= 0/);
  assert.match(variantSummaryBlock, /rect\.left >= innerWidth/);
  assert.doesNotMatch(remoteSpec,
    /image\.closest<HTMLElement>\("\[data-feed-source\]"\)\?\.dataset\.feedSource !== feedSource/);
  assert.match(remoteSpec, /url\.origin !== expectedAssetOrigin/);
  assert.match(remoteSpec, /listResponseStatuses/);
  assert.match(remoteSpec, /expectSuccessfulInitialListResponses/);
  assert.match(remoteSpec, /status\s*>=\s*200\s*&&\s*status\s*<\s*300/);
  assert.match(feed, /data-feed-column=\{sourceType\}/);
  assert.match(remoteSpec,
    /for \(const source of expectedSources\)[\s\S]{0,180}?expectFeedColumnInViewport\(page, source\)/);
  assert.doesNotMatch(remoteSpec,
    /page\.locator\(\s*[`'"]\[data-feed-source="(?:x_list|blog,podcast)"\][`'"]\s*\)/,
    "feed-root visibility must not use the media telemetry attribute");
  assert.match(remoteSpec, /const publicHeaders/);
  assert.match(remoteSpec, /const apiHeaders/);
  assert.match(remoteSpec, /request\.get\("\/api\/search[^\n]*headers:\s*apiHeaders/);
  assert.match(remoteSpec, /request\.get\("\/robots\.txt",\s*\{ headers:\s*publicHeaders \}\)/);
  assert.match(remoteSpec, /url\.origin === workerAssetOrigin\s*&&\s*cardVariantPattern\.test/);
  assert.doesNotMatch(remoteSpec, /setExtraHTTPHeaders/);
  assert.match(remoteSpec, /addCookies/);
  assert.match(remoteSpec, /lstatSync/);
  assert.match(remoteSpec, /0o077/);
  assert.match(remoteSpec, /staging-api\.ai-feeds\.com/);
  assert.match(remoteSpec,
    /request\.get\(`\/api\/items\/\$\{encodeURIComponent\(expectedXFixtureId\)\}`/);
  assert.doesNotMatch(remoteSpec,
    /findRangeAsset\(await parseJsonWithoutBodyLeak\(xFeed\),\s*["']video["']\)/,
    "Range validation must resolve the owned synthetic X fixture by exact id");
  assert.match(remoteSpec, /xFixturePayload\.item\.id\)\.toBe\(expectedXFixtureId\)/);
  assert.match(remoteSpec, /findRangeAsset\(xFixturePayload\.item,\s*["']video["']\)/);
  assert.match(remoteSpec, /server-timing/i);
  assert.match(remoteSpec, /new TouchEvent\(type/);
  assert.match(remoteSpec, /newCDPSession/);
  const mediaSettleStart = remoteSpec.indexOf("async function settleVisibleCardMedia");
  const mediaSettleEnd = remoteSpec.indexOf("async function", mediaSettleStart + 20);
  const mediaSettleBlock = remoteSpec.slice(mediaSettleStart, mediaSettleEnd);
  assert.match(mediaSettleBlock, /rect\.right > 0 && rect\.left < innerWidth/);
  assert.equal(
    mediaSettleBlock.match(/rect\.right > 0 && rect\.left < innerWidth/g)?.length,
    2,
    "visible images and video posters must both intersect the horizontal viewport",
  );
});

test("waterfall staging has an exact-host five-device remote browser gate", () => {
  const remoteSpecPath = path.join(dashboard, "e2e/waterfall-staging-remote.spec.ts");
  const remoteRunnerPath = path.join(dashboard, "scripts/run-waterfall-staging-e2e.sh");
  assert.equal(fs.existsSync(remoteSpecPath), true);
  assert.equal(fs.existsSync(remoteRunnerPath), true);
  const remoteSpec = fs.readFileSync(remoteSpecPath, "utf8");
  const remoteRunner = fs.readFileSync(remoteRunnerPath, "utf8");

  assert.match(config, /WATERFALL_STAGING_REMOTE/);
  assert.match(config, /staging\.ai-feeds\.com/);
  assert.match(config, /aifeeds-waterfall-staging/);
  assert.match(packageJson.scripts["test:e2e:waterfall-staging"], /run-waterfall-staging-e2e\.sh/);
  assert.match(remoteRunner, /E2E_BASE_URL=https:\/\/staging\.ai-feeds\.com/);
  assert.match(remoteRunner, /PLAYWRIGHT_NO_COPY_PROMPT=1/);
  assert.match(remoteRunner, /waterfall-staging-remote\.spec\.ts/);
  assert.match(remoteSpec, /staging SSR contains at least 12 cards before JavaScript/);
  assert.match(remoteSpec, /staging hydration is clean and responsive within the CLS budget/);
  assert.match(remoteSpec, /staging loads a bounded page near the footer/);
  assert.match(remoteSpec, /scrollIntoViewIfNeeded/);
  assert.match(remoteSpec, /paginationRequests/);
  assert.match(remoteSpec, /staging view switch persists classic/);
});

test("waterfall SSR has a local-only five-device edge fixture and browser budget gate", () => {
  const waterfallSpecPath = path.join(dashboard, "e2e/waterfall-home.spec.ts");
  const edgeFixturePath = path.join(dashboard, "scripts/waterfall-edge-fixture.mjs");
  assert.equal(fs.existsSync(waterfallSpecPath), true, "waterfall browser spec must exist");
  assert.equal(fs.existsSync(edgeFixturePath), true, "local waterfall edge fixture must exist");

  const waterfallSpec = fs.readFileSync(waterfallSpecPath, "utf8");
  const edgeFixture = fs.readFileSync(edgeFixturePath, "utf8");
  assert.match(config, /WATERFALL_E2E/);
  assert.match(config, /waterfall-edge-fixture\.mjs/);
  assert.match(config, /ignoreHTTPSErrors:\s*isWaterfallE2E/);
  assert.match(packageJson.scripts["test:e2e:waterfall"], /waterfall-home\.spec\.ts/);
  assert.match(packageJson.scripts["build:e2e:waterfall"], /--ssr functions\/render-waterfall\.tsx/);
  assert.match(edgeFixture, /handleHomeRuntime/);
  assert.match(edgeFixture, /HOME_EXPERIENCE_ENABLED:\s*"true"/);
  assert.match(edgeFixture, /HOME_API/);
  assert.match(edgeFixture, /fixture_api/);
  assert.match(edgeFixture, /createServer\(await localTlsOptions\(\)/);
  assert.match(waterfallSpec, /javaScriptEnabled:\s*false/);
  assert.match(waterfallSpec, /SSR HTML has at least 12 cards before JavaScript/);
  assert.match(waterfallSpec, /hydration has no console errors/);
  assert.match(waterfallSpec, /prefers-reduced-motion/);
  assert.match(waterfallSpec, /keyboard/);
  assert.match(waterfallSpec, /toBeGreaterThanOrEqual\(44\)/);
  assert.match(waterfallSpec, /toBeLessThanOrEqual\(0\.1\)/);
  assert.match(waterfallSpec, /scrollWidth/);
  assert.match(waterfallSpec, /load more/);
  assert.match(waterfallSpec, /Drawer deep link/);
  assert.match(waterfallSpec, /document navigation/);
  assert.match(waterfallSpec, /aifeeds_view/);
  assert.match(waterfallSpec, /x-aifeeds-home-ssr/i);
  assert.match(waterfallSpec, /classic entry never requests the waterfall entry/);
  assert.match(waterfallSpec, /waterfall entry never requests the classic entry/);
});
