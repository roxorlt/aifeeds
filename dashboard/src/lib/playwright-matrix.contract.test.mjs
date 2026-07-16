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
  assert.match(packageJson.scripts["test:e2e:perf-staging"], /perf-staging-remote\.spec\.ts/);
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
  assert.match(remoteSpec, /activeBlogFeed\.locator\(/);
  assert.match(remoteSpec, /activeFeed\?\.querySelectorAll/);
  assert.match(remoteSpec, /expectedSyntheticFixtureId/);
  assert.match(remoteSpec, /source_type=x_list&limit=12/);
  assert.match(remoteSpec, /source_type=blog%2Cpodcast&limit=12&sort=published_at/);
  assert.match(remoteSpec, /items\.some\(\(item\) => item\.id === expectedFixtureId\)/);
  assert.match(remoteSpec,
    /expect\.poll\(\(\) => firstBlogImage\.evaluate[\s\S]{0,160}?currentSrc/);
  assert.match(remoteSpec, /variantSummary\.width400Count/);
  assert.match(remoteSpec, /expect\(variantSummary\.width800Count\)\.toBe\(0\)/);
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
  assert.match(remoteSpec, /settleVisibleCardMedia/);
  assert.match(remoteSpec, /visibleImageDecodeSucceeded/);
  assert.match(remoteSpec, /visible card image decode did not settle/);
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
