import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PERF_ORIGIN = "https://perf-staging.ai-feeds.com";
const WORKER_ASSET_ORIGIN = "https://staging-api.ai-feeds.com";
const MEDIA_RANGE_FIXTURES = [
  "https://video.twimg.com/amplify_video/2076702860364886016/vid/avc1/3840x2160/BwwHYBEeqpBduuC3.mp4",
  "https://video.twimg.com/amplify_video/2076713390454792192/vid/avc1/3168x2160/MtKXLM2wuyt1RLjQ.mp4",
] as const;
const PERF_PATH = "/?codex_perf_probe=1";
const remoteEnabled = process.env.E2E_REMOTE === "1";
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36";
const projectNames = new Set([
  "desktop-chromium",
  "tablet-chromium",
  "iphone-chromium",
  "iphone-webkit",
  "android-chromium",
]);
const remoteSmokeCeilings = Object.freeze({
  cold: Object.freeze({ feedReadyMs: 5_000, lcpMs: 7_000 }),
  warm: Object.freeze({ feedReadyMs: 3_000, lcpMs: 5_000 }),
});

const resourceCategories = [
  "api_list",
  "api_other",
  "static_js_css",
  "worker_r2",
  "worker_img",
  "font",
  "third_party",
  "other",
] as const;
type ResourceCategory = typeof resourceCategories[number];
type MetricStatus = "ok" | "unsupported" | "missing";
type SafeMetric = { status: MetricStatus; valueMs: number | null };
type SafeScalarMetric = { status: MetricStatus; value: number | null };
type SafeResourceBucket = {
  count: number;
  transferBytes: number;
  encodedBytes: number;
  cacheHitCount: number;
  durationMs: number;
  maxDurationMs: number;
  beforeCutoffCount: number;
  beforeCutoffTransferBytes: number;
};
type SafeMediaRequestRecord = {
  url: string;
  startedAtUnixMs: number;
  finished: boolean;
  failed: boolean;
  httpStatus: number | null;
};
type SafeListResponseStatus = { source: string; status: number };
type SafePagePerformance = {
  schema: 1;
  milestones: { fcp: SafeMetric; lcp: SafeMetric; feedReady: SafeMetric };
  navigation: {
    workerStartMs: number;
    swControllerPresent: boolean;
    protocol: "h2" | "h3" | "http/1.1" | "other" | "none";
    dnsMs: number;
    connectMs: number;
    tlsMs: number;
    ttfbMs: number;
    responseMs: number;
    transferBytes: number;
    encodedBytes: number;
  };
  resources: Record<ResourceCategory, SafeResourceBucket>;
  visuals: {
    visibleCardImageCount: number;
    decodedVisibleCardImageCount: number;
    failedVisibleCardImageCount: number;
    cardVariantRequestCount: number;
    cardVariant400RequestCount: number;
    cardVariant800RequestCount: number;
    failedCardVariantRequestCount: number;
    pendingCardVariantRequestCount: number;
    layoutShift: SafeScalarMetric;
  };
  budgets: {
    contentionCutoff: "lcp" | "feed_ready";
    totalTransferBytes: number;
    listTransferBeforeCutoffBytes: number;
    listRequestsBeforeCutoffCount: number;
    belowFoldListBeforeCutoffCount: number;
    highPriorityImageCount: number;
    belowFoldMediaBeforeCutoffCount: number;
    deferredMediaCount: number;
  };
  finalization: "post-ready-settle-events";
};

function isMobileProject(name: string): boolean {
  return name.startsWith("iphone-") || name.startsWith("android-");
}

function expectWarmServiceWorkerNavigation(
  sample: SafePagePerformance,
  projectName: string,
  navigationResponse: PlaywrightResponse | null,
): void {
  expect(navigationResponse, "warm navigation response must exist").not.toBeNull();
  expect(navigationResponse!.ok()).toBe(true);
  expect(new URL(navigationResponse!.url()).origin).toBe(PERF_ORIGIN);
  expect(new URL(navigationResponse!.url()).pathname).toBe("/");
  expect(navigationResponse!.fromServiceWorker()).toBe(true);
  expect(sample.navigation.swControllerPresent).toBe(true);
  expect(sample.navigation.transferBytes).toBe(0);
  if (!projectName.includes("webkit")) {
    expect(sample.navigation.workerStartMs).toBeGreaterThan(0);
  }
}

function expectedInitialListSources(project: string): string[] {
  if (isMobileProject(project)) return ["x_list"];
  if (project === "tablet-chromium") return ["blog,podcast", "x_list"];
  return ["blog,podcast", "product_hunt", "x_list"];
}

type SyntheticFixtureEnv =
  | "E2E_EXPECTED_X_FIXTURE_ID"
  | "E2E_EXPECTED_BLOG_FIXTURE_ID";

function expectedSyntheticFixtureId(
  envName: SyntheticFixtureEnv,
  sourceType: "x_list" | "blog",
): string {
  const value = process.env[envName]?.trim() || "";
  const expected = new RegExp(`^${sourceType}:perf-staging-[a-f0-9]{20}$`);
  if (!expected.test(value)) {
    throw new Error(`${envName} must identify the owned ${sourceType} perf-staging fixture`);
  }
  return value;
}

type SyntheticFixtureItem = {
  id?: string;
  media?: unknown;
  extra?: unknown;
};

async function readSyntheticFixtureFromUiResponse(
  response: APIResponse | PlaywrightResponse,
  envName: SyntheticFixtureEnv,
  sourceType: "x_list" | "blog",
  options: { requireFirst?: boolean } = {},
): Promise<SyntheticFixtureItem> {
  const expectedFixtureId = expectedSyntheticFixtureId(envName, sourceType);
  const url = new URL(response.url());
  expect(url.origin).toBe(PERF_ORIGIN);
  expect(url.pathname).toBe("/api/items");
  expect(url.searchParams.get("source_type")).toBe(sourceType === "blog" ? "blog,podcast" : "x_list");
  expect(url.searchParams.get("limit")).toBe("12");
  if (sourceType === "blog") expect(url.searchParams.get("sort")).toBe("published_at");
  expect(response.ok(), sourceType + " fixture list request must succeed").toBe(true);
  const payload = await parseJsonWithoutBodyLeak(response) as {
    items?: SyntheticFixtureItem[];
  } | null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (options.requireFirst) {
    expect(
      items[0]?.id,
      sourceType + " fixture must be the first row so cold media stays user-visible",
    ).toBe(expectedFixtureId);
  }
  const fixture = items.find((item) => item.id === expectedFixtureId);
  expect(fixture, sourceType + " fixture must be visible in the page's exact UI list response").toBeTruthy();
  return fixture!;
}

function exactFixtureImagePaths(
  fixture: SyntheticFixtureItem,
  sourceType: "x_list" | "blog",
  expectedWidth: 400 | 800,
): { originalPath: string; variantPath: string } {
  let originalPath = "";
  let variants: unknown = null;
  if (sourceType === "x_list") {
    const media = Array.isArray(fixture.media) ? fixture.media : [];
    const image = media.find((entry) => (
      entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "image"
    )) as Record<string, unknown> | undefined;
    originalPath = typeof image?.url === "string" ? image.url : "";
    variants = image?.card_variants;
  } else {
    const extra = fixture.extra && typeof fixture.extra === "object" && !Array.isArray(fixture.extra)
      ? fixture.extra as Record<string, unknown>
      : {};
    originalPath = typeof extra.cover_image === "string" ? extra.cover_image : "";
    variants = extra.cover_image_variants;
  }
  const variant = (Array.isArray(variants) ? variants : []).find((entry) => (
    entry && typeof entry === "object"
    && (entry as Record<string, unknown>).width === expectedWidth
    && (entry as Record<string, unknown>).format === "webp"
  )) as Record<string, unknown> | undefined;
  const variantPath = typeof variant?.url === "string" ? variant.url : "";
  if (
    !/^\/r\/[a-z]+\/[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/.test(originalPath)
    || !new RegExp("^/r/[a-z]+/card/[a-f0-9]{64}-w" + expectedWidth + "\\.webp$").test(variantPath)
  ) throw new Error(sourceType + " fixture image contract mismatch");
  return { originalPath, variantPath };
}

async function expectExactFixtureImage(
  feed: Locator,
  originalPath: string,
  variantPath: string,
): Promise<Locator> {
  const image = feed.locator('img[src="' + WORKER_ASSET_ORIGIN + originalPath + '"]');
  await expect(image).toHaveCount(1);
  await expect(image).toBeVisible();
  await expect(image).toBeInViewport();
  await expect(image).toHaveAttribute("loading", "eager");
  const decoded = await image.evaluate(async (element: HTMLImageElement) => {
    try {
      await element.decode();
    } catch {
      return false;
    }
    return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
  });
  expect(decoded, "owned fixture image must decode").toBe(true);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => {
    if (!element.currentSrc) return "";
    return new URL(element.currentSrc, location.href).pathname;
  })).toBe(variantPath);
  return image;
}
async function expectFeedColumnInViewport(page: Page, source: string): Promise<Locator> {
  const columns = page.locator(`[data-feed-column="${source}"]`);
  let matchedIndex = -1;
  await expect.poll(async () => {
    const matches = await columns.evaluateAll((elements) => elements.flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < innerHeight
        && rect.right > 0 && rect.left < innerWidth
        ? [index]
        : [];
    }));
    if (matches.length !== 1) {
      matchedIndex = -1;
      return false;
    }
    matchedIndex = matches[0];
    return true;
  }).toBe(true);
  return columns.nth(matchedIndex);
}

async function expectSuccessfulInitialListResponses(
  page: Page,
  listResponseStatuses: SafeListResponseStatus[],
  expectedSources: string[],
): Promise<void> {
  await expect.poll(() => expectedSources.every((source) => {
    const statuses = listResponseStatuses
      .filter((record) => record.source === source)
      .map((record) => record.status);
    return statuses.length > 0 && statuses.every((status) => status >= 200 && status < 300);
  })).toBe(true);
  for (const source of expectedSources) {
    await expectFeedColumnInViewport(page, source);
  }
}

function trackSafeMediaRequests(page: Page): SafeMediaRequestRecord[] {
  const records: SafeMediaRequestRecord[] = [];
  const byRequest = new Map<PlaywrightRequest, SafeMediaRequestRecord>();
  page.on("request", (request) => {
    if (!new Set(["image", "media"]).has(request.resourceType())) return;
    let startedAtUnixMs = Date.now();
    try {
      const timingStart = request.timing().startTime;
      if (Number.isFinite(timingStart) && timingStart > 0) startedAtUnixMs = timingStart;
    } catch {
      // Date.now is a conservative near-start fallback and never enters evidence.
    }
    const record: SafeMediaRequestRecord = {
      url: request.url(),
      startedAtUnixMs,
      finished: false,
      failed: false,
      httpStatus: null,
    };
    records.push(record);
    byRequest.set(request, record);
  });
  page.on("response", (response) => {
    const record = byRequest.get(response.request());
    if (record) record.httpStatus = response.status();
  });
  page.on("requestfinished", (request) => {
    const record = byRequest.get(request);
    if (record) record.finished = true;
  });
  page.on("requestfailed", (request) => {
    const record = byRequest.get(request);
    if (record) {
      record.finished = true;
      record.failed = true;
    }
  });
  return records;
}

async function safeVisibleCardVariantRequestSummary(
  page: Page,
  records: SafeMediaRequestRecord[],
  recordStartIndex: number,
  sourceType: string,
  expectedPageOrigin: string,
  expectedAssetOrigin: string,
): Promise<{
  count: number;
  width400Count: number;
  width800Count: number;
  failedCount: number;
  pendingCount: number;
}> {
  if (!Number.isInteger(recordStartIndex) || recordStartIndex < 0 || recordStartIndex > records.length) {
    throw new Error("visible card variant baseline mismatch");
  }
  return page.evaluate(({ mediaRequests, feedSource, expectedPageOrigin, expectedAssetOrigin }) => {
    if (location.origin !== expectedPageOrigin) throw new Error("visible card variant page origin mismatch");
    const pattern = /^\/r\/(?:x|blog|podcast|ph|hf|gh)\/card\/[a-f0-9]{64}-w(400|800)\.webp$/;
    const visibleVariantUrls = new Set(
      [...document.querySelectorAll<HTMLImageElement>(
        'img[data-media-priority], [data-media-priority] img',
      )].flatMap((image) => {
        const column = image.closest<HTMLElement>("[data-feed-column]");
        const columnRect = column?.getBoundingClientRect();
        const rect = image.getBoundingClientRect();
        if (
          column?.dataset.feedColumn !== feedSource
          || !columnRect
          || columnRect.bottom <= 0
          || columnRect.top >= innerHeight
          || columnRect.right <= 0
          || columnRect.left >= innerWidth
          || !image.currentSrc
          || rect.bottom <= 0
          || rect.top >= innerHeight
          || rect.right <= 0
          || rect.left >= innerWidth
        ) return [];
        try {
          const url = new URL(image.currentSrc, location.href);
          return url.origin === expectedAssetOrigin && pattern.test(url.pathname) ? [url.href] : [];
        } catch {
          return [];
        }
      }),
    );
    const variants = mediaRequests.flatMap((record) => {
      try {
        const url = new URL(record.url);
        if (url.origin !== expectedAssetOrigin || !visibleVariantUrls.has(url.href)) return [];
        const width = url.pathname.match(pattern)?.[1];
        return width ? [{ record, width }] : [];
      } catch {
        return [];
      }
    });
    return {
      count: variants.length,
      width400Count: variants.filter(({ width }) => width === "400").length,
      width800Count: variants.filter(({ width }) => width === "800").length,
      failedCount: variants.filter(({ record }) => record.failed
        || (record.httpStatus !== null && (record.httpStatus < 200 || record.httpStatus >= 300))).length,
      pendingCount: variants.filter(({ record }) => !record.finished).length,
    };
  }, {
    mediaRequests: records.slice(recordStartIndex),
    feedSource: sourceType,
    expectedPageOrigin,
    expectedAssetOrigin,
  });
}

async function installSafeLcpObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsLcpSettled?: boolean;
      __aifeedsCls?: number | null;
      __aifeedsClsSettled?: boolean;
    };
    const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
    target.__aifeedsLcpMs = null;
    target.__aifeedsLcpSettled = false;
    target.__aifeedsCls = supported.has("layout-shift") ? 0 : null;
    target.__aifeedsClsSettled = false;
    let lcpObserver: PerformanceObserver | null = null;
    let layoutShiftObserver: PerformanceObserver | null = null;
    const recordLcpEntries = (entries: PerformanceEntry[]) => {
      for (const entry of entries) target.__aifeedsLcpMs = entry.startTime;
    };
    const recordLayoutShiftEntries = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput && typeof shift.value === "number") {
          target.__aifeedsCls = (target.__aifeedsCls || 0) + shift.value;
        }
      }
    };
    addEventListener("aifeeds:lcp-settled", () => {
      if (lcpObserver) {
        recordLcpEntries(lcpObserver.takeRecords());
        lcpObserver.disconnect();
      }
      target.__aifeedsLcpSettled = true;
    }, { once: true });
    addEventListener("aifeeds:cls-settled", () => {
      if (layoutShiftObserver) {
        recordLayoutShiftEntries(layoutShiftObserver.takeRecords());
        layoutShiftObserver.disconnect();
      }
      target.__aifeedsClsSettled = true;
    }, { once: true });
    try {
      lcpObserver = new PerformanceObserver((list) => {
        if (target.__aifeedsLcpSettled) return;
        recordLcpEntries(list.getEntries());
      });
      lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      lcpObserver = null;
      target.__aifeedsLcpMs = null;
    }
    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        if (target.__aifeedsClsSettled) return;
        recordLayoutShiftEntries(list.getEntries());
      });
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true });
    } catch {
      layoutShiftObserver = null;
      target.__aifeedsCls = null;
    }
  });
}

function boundedNumber(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error("privacy-safe performance evidence numeric contract mismatch");
  }
  return Math.round(value * 10) / 10;
}

function boundedScalarNumber(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error("privacy-safe scalar evidence numeric contract mismatch");
  }
  return Math.round(value * 10_000) / 10_000;
}

function sanitizeMetric(value: unknown): SafeMetric {
  const candidate = value as { status?: unknown; valueMs?: unknown };
  if (!candidate || !["ok", "unsupported", "missing"].includes(String(candidate.status))) {
    throw new Error("privacy-safe performance milestone contract mismatch");
  }
  const status = candidate.status as MetricStatus;
  if (status !== "ok") {
    if (candidate.valueMs !== null) throw new Error("unsupported performance milestone must be null");
    return { status, valueMs: null };
  }
  return { status, valueMs: boundedNumber(candidate.valueMs, 600_000) };
}

function sanitizeScalarMetric(value: unknown, max: number): SafeScalarMetric {
  const candidate = value as { status?: unknown; value?: unknown };
  if (!candidate || !["ok", "unsupported", "missing"].includes(String(candidate.status))) {
    throw new Error("privacy-safe scalar metric contract mismatch");
  }
  const status = candidate.status as MetricStatus;
  if (status !== "ok") {
    if (candidate.value !== null) throw new Error("unsupported scalar metric must be null");
    return { status, value: null };
  }
  return { status, value: boundedScalarNumber(candidate.value, max) };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function sanitizeSafePagePerformance(value: unknown): SafePagePerformance {
  const raw = objectRecord(value);
  if (!raw || raw.schema !== 1 || raw.finalization !== "post-ready-settle-events") {
    throw new Error("privacy-safe performance evidence schema mismatch");
  }
  const navigation = objectRecord(raw.navigation);
  const milestoneValues = objectRecord(raw.milestones);
  const resourceValues = objectRecord(raw.resources);
  const budgetValues = objectRecord(raw.budgets);
  const visualValues = objectRecord(raw.visuals);
  const protocol = navigation.protocol;
  if (typeof protocol !== "string" || !["h2", "h3", "http/1.1", "other", "none"].includes(protocol)) {
    throw new Error("privacy-safe navigation protocol mismatch");
  }
  const resources = {} as Record<ResourceCategory, SafeResourceBucket>;
  for (const category of resourceCategories) {
    const bucket = objectRecord(resourceValues[category]);
    resources[category] = {
      count: boundedNumber(bucket.count, 10_000),
      transferBytes: boundedNumber(bucket.transferBytes, 1_000_000_000),
      encodedBytes: boundedNumber(bucket.encodedBytes, 1_000_000_000),
      cacheHitCount: boundedNumber(bucket.cacheHitCount, 10_000),
      durationMs: boundedNumber(bucket.durationMs, 6_000_000),
      maxDurationMs: boundedNumber(bucket.maxDurationMs, 600_000),
      beforeCutoffCount: boundedNumber(bucket.beforeCutoffCount, 10_000),
      beforeCutoffTransferBytes: boundedNumber(bucket.beforeCutoffTransferBytes, 1_000_000_000),
    };
  }
  return {
    schema: 1,
    milestones: {
      fcp: sanitizeMetric(milestoneValues.fcp),
      lcp: sanitizeMetric(milestoneValues.lcp),
      feedReady: sanitizeMetric(milestoneValues.feedReady),
    },
    navigation: {
      workerStartMs: boundedNumber(navigation.workerStartMs, 600_000),
      swControllerPresent: navigation.swControllerPresent === true,
      protocol: protocol as SafePagePerformance["navigation"]["protocol"],
      dnsMs: boundedNumber(navigation.dnsMs, 600_000),
      connectMs: boundedNumber(navigation.connectMs, 600_000),
      tlsMs: boundedNumber(navigation.tlsMs, 600_000),
      ttfbMs: boundedNumber(navigation.ttfbMs, 600_000),
      responseMs: boundedNumber(navigation.responseMs, 600_000),
      transferBytes: boundedNumber(navigation.transferBytes, 1_000_000_000),
      encodedBytes: boundedNumber(navigation.encodedBytes, 1_000_000_000),
    },
    resources,
    visuals: {
      visibleCardImageCount: boundedNumber(visualValues.visibleCardImageCount, 10_000),
      decodedVisibleCardImageCount: boundedNumber(visualValues.decodedVisibleCardImageCount, 10_000),
      failedVisibleCardImageCount: boundedNumber(visualValues.failedVisibleCardImageCount, 10_000),
      cardVariantRequestCount: boundedNumber(visualValues.cardVariantRequestCount, 10_000),
      cardVariant400RequestCount: boundedNumber(visualValues.cardVariant400RequestCount, 10_000),
      cardVariant800RequestCount: boundedNumber(visualValues.cardVariant800RequestCount, 10_000),
      failedCardVariantRequestCount: boundedNumber(visualValues.failedCardVariantRequestCount, 10_000),
      pendingCardVariantRequestCount: boundedNumber(visualValues.pendingCardVariantRequestCount, 10_000),
      layoutShift: sanitizeScalarMetric(visualValues.layoutShift, 100),
    },
    budgets: {
      contentionCutoff: budgetValues.contentionCutoff === "lcp"
        ? "lcp"
        : budgetValues.contentionCutoff === "feed_ready"
          ? "feed_ready"
          : (() => { throw new Error("privacy-safe contention cutoff mismatch"); })(),
      totalTransferBytes: boundedNumber(budgetValues.totalTransferBytes, 1_000_000_000),
      listTransferBeforeCutoffBytes: boundedNumber(budgetValues.listTransferBeforeCutoffBytes, 1_000_000_000),
      listRequestsBeforeCutoffCount: boundedNumber(budgetValues.listRequestsBeforeCutoffCount, 100),
      belowFoldListBeforeCutoffCount: boundedNumber(budgetValues.belowFoldListBeforeCutoffCount, 100),
      highPriorityImageCount: boundedNumber(budgetValues.highPriorityImageCount, 100),
      belowFoldMediaBeforeCutoffCount: boundedNumber(budgetValues.belowFoldMediaBeforeCutoffCount, 10_000),
      deferredMediaCount: boundedNumber(budgetValues.deferredMediaCount, 10_000),
    },
    finalization: "post-ready-settle-events",
  };
}

async function settleLcpAfterFeedReady(
  page: Page,
  mediaRequestRecords: SafeMediaRequestRecord[],
): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    performance.getEntriesByName("aifeeds:feed-ready", "mark")[0]?.startTime ?? 0
  ))).toBeGreaterThan(0);
  await settleVisibleCardMedia(page, mediaRequestRecords);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(500);
  await page.evaluate(() => dispatchEvent(new Event("aifeeds:lcp-settled")));
  await expect.poll(() => page.evaluate(() => {
    const target = window as Window & { __aifeedsLcpSettled?: boolean };
    const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
    return !supported.has("largest-contentful-paint") || target.__aifeedsLcpSettled === true;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsListRequestStarts?: number[];
    };
    const feedReady = performance.getEntriesByName("aifeeds:feed-ready", "mark")[0]?.startTime;
    const cutoff = typeof target.__aifeedsLcpMs === "number" ? target.__aifeedsLcpMs : feedReady;
    if (typeof cutoff !== "number") return false;
    const started = (target.__aifeedsListRequestStarts || [])
      .filter((startTime) => startTime <= cutoff).length;
    const completed = performance.getEntriesByType("resource")
      .filter((entry) => {
        if (!(entry instanceof PerformanceResourceTiming) || entry.startTime > cutoff) return false;
        const url = new URL(entry.name);
        return url.origin === location.origin && url.pathname === "/api/items";
      }).length;
    return started > 0 && completed >= started;
  })).toBe(true);
  await settleDeferredFontsAndLayout(page, mediaRequestRecords);
}

async function settleVisibleCardMedia(
  page: Page,
  mediaRequestRecords: SafeMediaRequestRecord[],
  decodeTimeoutMs = 5_000,
): Promise<void> {
  if (!Number.isInteger(decodeTimeoutMs) || decodeTimeoutMs < 1 || decodeTimeoutMs > 5_000) {
    throw new Error("visible card image decode timeout contract mismatch");
  }
  const visibleImageDecodeSucceeded = await page.evaluate(async (timeoutMs) => {
    const visible = [...document.querySelectorAll<HTMLImageElement>(
      'img[data-media-priority], [data-media-priority] img',
    )].filter((image) => {
      const rect = image.getBoundingClientRect();
      return Boolean(image.currentSrc || image.src)
        && rect.bottom > 0 && rect.top < innerHeight
        && rect.right > 0 && rect.left < innerWidth;
    });
    const results = await Promise.all(visible.map((image) => new Promise<boolean>((resolve) => {
      let settled = false;
      let timer = 0;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = window.setTimeout(() => finish(false), timeoutMs);
      image.decode().then(
        () => finish(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        () => finish(false),
      );
    })));
    return results.every(Boolean);
  }, decodeTimeoutMs);
  expect(visibleImageDecodeSucceeded, "visible card image decode did not settle").toBe(true);
  await expect.poll(() => page.evaluate((mediaRequests) => {
    const visiblePosters = [...document.querySelectorAll<HTMLVideoElement>("video[poster]")]
      .filter((video) => {
        const rect = video.getBoundingClientRect();
        return Boolean(video.poster)
          && rect.bottom > 0 && rect.top < innerHeight
          && rect.right > 0 && rect.left < innerWidth;
      })
      .map((video) => new URL(video.poster, location.href).href);
    const navigationTimeOrigin = performance.timeOrigin;
    const currentNavigationRequests = mediaRequests.filter((record) => {
      const relativeStart = record.startedAtUnixMs - navigationTimeOrigin;
      return relativeStart >= 0 && relativeStart <= 600_000;
    });
    return visiblePosters.every((posterUrl) => {
      const matching = currentNavigationRequests.filter((record) => record.url === posterUrl);
      if (matching.length > 0) {
        return matching.every((record) => record.finished
          && !record.failed
          && (record.httpStatus === null || (record.httpStatus >= 200 && record.httpStatus < 300)));
      }
      return performance.getEntriesByName(posterUrl, "resource").length > 0;
    });
  }, mediaRequestRecords)).toBe(true);
}

async function settleDeferredFontsAndLayout(
  page: Page,
  mediaRequestRecords: SafeMediaRequestRecord[],
): Promise<void> {
  await page.evaluate(() => dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await expect.poll(() => page.evaluate(() => {
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    const effectiveType = connection?.effectiveType?.toLowerCase();
    const shouldSkip = connection?.saveData === true
      || effectiveType === "slow-2g"
      || effectiveType === "2g"
      || effectiveType === "3g";
    const links = [...document.querySelectorAll<HTMLLinkElement>(
      'link[data-aifeeds-deferred-font]',
    )];
    return shouldSkip
      ? links.length === 0
      : links.length === 3 && links.every((link) => link.sheet !== null);
  }), { timeout: 8_000 }).toBe(true);
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
  });
  await settleVisibleCardMedia(page, mediaRequestRecords);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(500);
  await page.evaluate(() => dispatchEvent(new Event("aifeeds:cls-settled")));
  await expect.poll(() => page.evaluate(() => {
    const target = window as Window & { __aifeedsClsSettled?: boolean };
    const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
    return !supported.has("layout-shift") || target.__aifeedsClsSettled === true;
  })).toBe(true);
}

async function safeListSourcesBeforeContentionCutoff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsListRequestStarts?: number[];
      __aifeedsListRequestSources?: string[];
    };
    const feedReady = performance.getEntriesByName("aifeeds:feed-ready", "mark")[0]?.startTime;
    const cutoff = typeof target.__aifeedsLcpMs === "number" ? target.__aifeedsLcpMs : feedReady;
    if (typeof cutoff !== "number") return [];
    return (target.__aifeedsListRequestStarts || [])
      .map((startTime, index) => startTime <= cutoff
        ? target.__aifeedsListRequestSources?.[index] || "unexpected"
        : null)
      .filter((source): source is string => source !== null)
      .sort();
  });
}

async function captureSafePagePerformance(
  page: Page,
  mediaRequestRecords: SafeMediaRequestRecord[] = [],
): Promise<SafePagePerformance> {
  const raw = await page.evaluate(({ categories, mediaRequests, workerAssetOrigin }) => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const roundScalar = (value: number) => Math.round(value * 10_000) / 10_000;
    const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
    const classify = (entry: PerformanceResourceTiming): ResourceCategory => {
      const url = new URL(entry.name);
      if (url.origin === location.origin && url.pathname === "/api/items") return "api_list";
      if (url.origin === location.origin && url.pathname.startsWith("/api/")) return "api_other";
      if (url.pathname === "/r" || url.pathname.startsWith("/r/")) return "worker_r2";
      if (url.pathname === "/img" || url.pathname.startsWith("/img/")) return "worker_img";
      if (url.origin === location.origin && url.pathname.startsWith("/assets/")) return "static_js_css";
      if (entry.initiatorType === "font") return "font";
      if (url.origin !== location.origin) return "third_party";
      return "other";
    };
    const emptyBucket = (): SafeResourceBucket => ({
      count: 0,
      transferBytes: 0,
      encodedBytes: 0,
      cacheHitCount: 0,
      durationMs: 0,
      maxDurationMs: 0,
      beforeCutoffCount: 0,
      beforeCutoffTransferBytes: 0,
    });
    const resources = Object.fromEntries(
      categories.map((category) => [category, emptyBucket()]),
    ) as Record<ResourceCategory, SafeResourceBucket>;
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsListRequestStarts?: number[];
      __aifeedsCls?: number | null;
    };
    const feedReady = performance.getEntriesByName("aifeeds:feed-ready", "mark")[0];
    const lcpMs = typeof target.__aifeedsLcpMs === "number" ? target.__aifeedsLcpMs : null;
    const contentionCutoff = lcpMs !== null ? "lcp" : "feed_ready";
    const contentionCutoffMs = lcpMs ?? feedReady?.startTime ?? null;
    const resourceEntries = performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming);
    for (const entry of resourceEntries) {
      const bucket = resources[classify(entry)];
      const beforeCutoff = contentionCutoffMs !== null && entry.startTime <= contentionCutoffMs;
      bucket.count += 1;
      bucket.transferBytes += entry.transferSize;
      bucket.encodedBytes += entry.encodedBodySize;
      if (entry.transferSize === 0 && entry.decodedBodySize > 0) bucket.cacheHitCount += 1;
      bucket.durationMs += entry.duration;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, entry.duration);
      if (beforeCutoff) {
        bucket.beforeCutoffCount += 1;
        bucket.beforeCutoffTransferBytes += entry.transferSize;
      }
    }
    for (const bucket of Object.values(resources)) {
      bucket.durationMs = round(bucket.durationMs);
      bucket.maxDurationMs = round(bucket.maxDurationMs);
    }
    const media = [...document.querySelectorAll("img,video,audio")];
    const navigationTimeOrigin = performance.timeOrigin;
    const mediaRequestsThisNavigation = mediaRequests.filter((record) => {
      const relativeStart = record.startedAtUnixMs - navigationTimeOrigin;
      return relativeStart >= 0 && relativeStart <= 600_000;
    });
    const mediaUrlsStartedBeforeCutoff = new Set(contentionCutoffMs === null ? [] : mediaRequestsThisNavigation
      .filter((record) => record.startedAtUnixMs - navigationTimeOrigin <= contentionCutoffMs)
      .map((record) => record.url));
    const belowFoldMediaBeforeCutoffCount = media.filter((element) => {
      if (contentionCutoffMs === null || element.getBoundingClientRect().top < innerHeight) return false;
      const rawUrls = element instanceof HTMLImageElement
        ? [element.currentSrc || element.src]
        : element instanceof HTMLVideoElement
          ? [element.currentSrc || element.src, element.poster]
          : element instanceof HTMLMediaElement ? [element.currentSrc || element.src] : [];
      return rawUrls.filter(Boolean).some((rawUrl) => (
        mediaUrlsStartedBeforeCutoff.has(new URL(rawUrl, location.href).href)
      ));
    }).length;
    const visibleCardImages = [...document.querySelectorAll<HTMLImageElement>(
      'img[data-media-priority], [data-media-priority] img',
    )].filter((image) => {
      const rect = image.getBoundingClientRect();
      return Boolean(image.currentSrc || image.src) && rect.bottom > 0 && rect.top < innerHeight;
    });
    const cardVariantPattern = /^\/r\/(?:x|blog|podcast|ph|hf|gh)\/card\/[a-f0-9]{64}-w(400|800)\.webp$/;
    const cardVariantRequests = mediaRequestsThisNavigation.filter((record) => {
      try {
        const url = new URL(record.url);
        return url.origin === workerAssetOrigin && cardVariantPattern.test(url.pathname);
      } catch {
        return false;
      }
    });
    const cardVariantWidth = (record: SafeMediaRequestRecord): string | null => {
      try {
        return new URL(record.url).pathname.match(cardVariantPattern)?.[1] ?? null;
      } catch {
        return null;
      }
    };
    const cardVariantFailed = (record: SafeMediaRequestRecord): boolean => record.failed
      || (record.httpStatus !== null && (record.httpStatus < 200 || record.httpStatus >= 300));
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const immediateListBudget = innerWidth < 768 ? 1 : innerWidth < 1024 ? 2 : 3;
    const listRequestsBeforeCutoffCount = contentionCutoffMs === null
      ? 0
      : (target.__aifeedsListRequestStarts || []).filter((startTime) => startTime <= contentionCutoffMs).length;
    const protocol = navigation?.nextHopProtocol === "h2"
      ? "h2"
      : navigation?.nextHopProtocol === "h3"
        ? "h3"
        : navigation?.nextHopProtocol === "http/1.1"
          ? "http/1.1"
          : navigation?.nextHopProtocol ? "other" : "none";
    const metric = (isSupported: boolean, value: number | null): SafeMetric => isSupported
      ? value === null ? { status: "missing", valueMs: null } : { status: "ok", valueMs: round(value) }
      : { status: "unsupported", valueMs: null };
    const scalarMetric = (isSupported: boolean, value: number | null): SafeScalarMetric => isSupported
      ? value === null ? { status: "missing", value: null } : { status: "ok", value: roundScalar(value) }
      : { status: "unsupported", value: null };
    return {
      schema: 1,
      milestones: {
        fcp: metric(supported.has("paint"), paint?.startTime ?? null),
        lcp: metric(supported.has("largest-contentful-paint"), lcpMs),
        feedReady: metric(true, feedReady?.startTime ?? null),
      },
      navigation: {
        workerStartMs: round(navigation?.workerStart ?? 0),
        swControllerPresent: navigator.serviceWorker?.controller != null,
        protocol,
        dnsMs: round((navigation?.domainLookupEnd ?? 0) - (navigation?.domainLookupStart ?? 0)),
        connectMs: round((navigation?.connectEnd ?? 0) - (navigation?.connectStart ?? 0)),
        tlsMs: round(navigation?.secureConnectionStart
          ? (navigation?.connectEnd ?? 0) - navigation.secureConnectionStart
          : 0),
        ttfbMs: round((navigation?.responseStart ?? 0) - (navigation?.requestStart ?? 0)),
        responseMs: round((navigation?.responseEnd ?? 0) - (navigation?.responseStart ?? 0)),
        transferBytes: navigation?.transferSize ?? 0,
        encodedBytes: navigation?.encodedBodySize ?? 0,
      },
      resources,
      visuals: {
        visibleCardImageCount: visibleCardImages.length,
        decodedVisibleCardImageCount: visibleCardImages
          .filter((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length,
        failedVisibleCardImageCount: visibleCardImages
          .filter((image) => image.complete && (image.naturalWidth === 0 || image.naturalHeight === 0)).length,
        cardVariantRequestCount: cardVariantRequests.length,
        cardVariant400RequestCount: cardVariantRequests.filter((record) => cardVariantWidth(record) === "400").length,
        cardVariant800RequestCount: cardVariantRequests.filter((record) => cardVariantWidth(record) === "800").length,
        failedCardVariantRequestCount: cardVariantRequests.filter(cardVariantFailed).length,
        pendingCardVariantRequestCount: cardVariantRequests.filter((record) => !record.finished).length,
        layoutShift: scalarMetric(
          supported.has("layout-shift"),
          typeof target.__aifeedsCls === "number" ? target.__aifeedsCls : null,
        ),
      },
      budgets: {
        contentionCutoff,
        totalTransferBytes: Object.values(resources)
          .reduce((total, bucket) => total + bucket.transferBytes, navigation?.transferSize ?? 0),
        listTransferBeforeCutoffBytes: resources.api_list.beforeCutoffTransferBytes,
        listRequestsBeforeCutoffCount,
        belowFoldListBeforeCutoffCount: Math.max(0, listRequestsBeforeCutoffCount - immediateListBudget),
        highPriorityImageCount: document.querySelectorAll('img[fetchpriority="high"]').length,
        belowFoldMediaBeforeCutoffCount,
        deferredMediaCount: media.filter((element) => {
          if (element instanceof HTMLImageElement) return element.loading === "lazy";
          return element instanceof HTMLMediaElement && element.preload === "none";
        }).length,
      },
      finalization: "post-ready-settle-events",
    };
  }, {
    categories: resourceCategories,
    mediaRequests: mediaRequestRecords,
    workerAssetOrigin: WORKER_ASSET_ORIGIN,
  });
  return sanitizeSafePagePerformance(raw);
}

function parseSafeServerTiming(value: string | undefined): { d1Ms: number; threadD1Ms: number | null } | null {
  if (!value || value.length > 512) return null;
  const allowed = new Map<string, number>();
  for (const part of value.split(",")) {
    const match = part.trim().match(/^(d1|thread_d1);dur=([0-9]+(?:\.[0-9]+)?)$/);
    if (!match) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration) && duration >= 0 && duration <= 600_000) allowed.set(match[1], duration);
  }
  const d1Ms = allowed.get("d1");
  return d1Ms === undefined ? null : {
    d1Ms: boundedNumber(d1Ms, 600_000),
    threadD1Ms: allowed.has("thread_d1") ? boundedNumber(allowed.get("thread_d1"), 600_000) : null,
  };
}

async function parseJsonWithoutBodyLeak(
  response: APIResponse | PlaywrightResponse,
): Promise<unknown | null> {
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

async function requestWithoutUrlLeak(action: () => Promise<APIResponse>): Promise<APIResponse | null> {
  try {
    return await action();
  } catch {
    return null;
  }
}

function requireResponse(response: APIResponse | null, message: string): asserts response is APIResponse {
  if (!response) throw new Error(message);
}

function persistBrowserJoinEvidence(project: string, requestId: string): void {
  const outputRoot = process.env.E2E_OUTPUT_DIR || "";
  if (
    !projectNames.has(project)
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)
    || !/^\/private\/tmp\/aifeeds-perf-staging-\d{8}T\d{6}-[A-Za-z0-9]{6}\/playwright$/.test(outputRoot)
  ) throw new Error("browser join evidence contract mismatch");
  const directory = join(outputRoot, "join");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.uid !== process.getuid?.()
    || (directoryStat.mode & 0o077) !== 0
  ) throw new Error("browser join evidence directory is not private");
  const file = join(directory, `${project}.json`);
  const temporary = join(directory, `.${project}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ schema: 1, project, request_id: requestId })}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original atomic-publish error.
    }
    throw error;
  }
}

function findRangeAsset(value: unknown, kind: "video" | "audio"): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRangeAsset(entry, kind);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    kind === "video"
    && record.type === "video"
    && typeof record.url === "string"
    && record.url.startsWith("/r/")
  ) return record.url;
  if (
    kind === "audio"
    && typeof record.audio_url === "string"
    && record.audio_url.startsWith("/r/")
  ) return record.audio_url;
  for (const entry of Object.values(record)) {
    const found = findRangeAsset(entry, kind);
    if (found) return found;
  }
  return null;
}

function readPrivateSessionCookie(): {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax";
} {
  const cookieJar = process.env.E2E_COOKIE_JAR || "";
  if (!/^\/private\/tmp\/aifeeds-perf-staging-[a-f0-9]{20}\.cookies$/.test(cookieJar)) {
    throw new Error("E2E_COOKIE_JAR must be the private synthetic perf-staging cookie jar");
  }
  const file = lstatSync(cookieJar);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) {
    throw new Error("E2E_COOKIE_JAR must be a regular file owned by the current user");
  }
  if ((file.mode & 0o077) !== 0) {
    throw new Error("E2E_COOKIE_JAR must not be group/world accessible");
  }
  const cookieLine = readFileSync(cookieJar, "utf8")
    .split(/\r?\n/)
    .map((line) => line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line)
    .find((line) => !line.startsWith("#") && line.split("\t")[5] === "xlist_sid_stg");
  if (!cookieLine) throw new Error("synthetic staging session cookie is missing");
  const [domain, , path, secure, , name, value] = cookieLine.split("\t");
  if (
    ![".ai-feeds.com", "perf-staging.ai-feeds.com"].includes(domain)
    || path !== "/"
    || secure !== "TRUE"
    || name !== "xlist_sid_stg"
    || !/^[A-Za-z0-9_-]{32}$/.test(value)
  ) {
    throw new Error("synthetic staging session cookie contract mismatch");
  }
  return { name, value, domain, path, secure: true, httpOnly: true, sameSite: "Lax" };
}

async function swipeToNextChannel(page: Page, projectName: string): Promise<void> {
  const box = await page.locator("main").boundingBox();
  if (!box) throw new Error("main feed is not visible");
  const y = Math.min(box.y + 280, 600);
  const fromX = box.x + box.width * 0.82;
  const toX = box.x + box.width * 0.18;

  if (projectName.includes("webkit")) {
    await page.evaluate(({ startX, endX, touchY }) => {
      const target = document.querySelector("main");
      if (!(target instanceof HTMLElement)) throw new Error("main feed is not visible");
      const makeTouch = (x: number) => ({
        identifier: 1,
        target,
        clientX: x,
        clientY: touchY,
        pageX: x,
        pageY: touchY,
        screenX: x,
        screenY: touchY,
        radiusX: 2,
        radiusY: 2,
        force: 1,
      });
      const dispatch = (type: "touchstart" | "touchmove" | "touchend", x: number) => {
        const changed = makeTouch(x);
        const active = type === "touchend" ? [] : [changed];
        const event = new TouchEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: active },
          targetTouches: { value: active },
          changedTouches: { value: [changed] },
        });
        target.dispatchEvent(event);
      };
      dispatch("touchstart", startX);
      for (let step = 1; step <= 6; step += 1) {
        dispatch("touchmove", startX + ((endX - startX) * step) / 6);
      }
      dispatch("touchend", endX);
    }, { startX: fromX, endX: toX, touchY: y });
    return;
  }

  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: fromX, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
  });
  for (let step = 1; step <= 6; step += 1) {
    const x = fromX + ((toX - fromX) * step) / 6;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("perf-staging remote acceptance", () => {
  test.skip(!remoteEnabled, "remote writes and probes require the approved perf-staging gate");

  test.beforeEach(async ({ context }) => {
    const expectedDeviceId = process.env.E2E_EXPECTED_DID || "";
    if (!/^perf-[a-f0-9]{24}$/.test(expectedDeviceId)) {
      throw new Error("E2E_EXPECTED_DID must identify the synthetic perf-staging device");
    }
    const perfProbe = process.env.E2E_PERF_PROBE || "";
    if (!/^upstream-[0-9]{10,16}-[a-f0-9]{8}$/.test(perfProbe)) {
      throw new Error("E2E_PERF_PROBE must identify the approved synthetic performance run");
    }
    await context.addInitScript(({ deviceId, probe }) => {
      localStorage.setItem("xlist_did", deviceId);
      const target = window as Window & {
        __aifeedsListRequestStarts?: number[];
        __aifeedsListRequestSources?: string[];
      };
      target.__aifeedsListRequestStarts = [];
      target.__aifeedsListRequestSources = [];
      const safeListSources = new Set([
        "x_list",
        "blog,podcast",
        "product_hunt",
        "github",
        "hf_paper",
        "huodongxing",
        "clawhub",
      ]);
      const nativeFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        let url: URL;
        try {
          url = new URL(input instanceof Request ? input.url : String(input), location.href);
        } catch {
          return nativeFetch(input, init);
        }
        if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
          return nativeFetch(input, init);
        }
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        headers.set("X-Aifeeds-Perf-Probe", probe);
        if (url.pathname === "/api/items") {
          target.__aifeedsListRequestStarts!.push(performance.now());
          const source = url.searchParams.get("source_type") || "unexpected";
          target.__aifeedsListRequestSources!.push(safeListSources.has(source) ? source : "unexpected");
        }
        return nativeFetch(input, { ...init, headers });
      }) as typeof window.fetch;
    }, { deviceId: expectedDeviceId, probe: perfProbe });
  });

  test("five-device home uses the same-origin API and publishes timing evidence", async ({ page }, testInfo) => {
    const mediaRequestRecords = trackSafeMediaRequests(page);
    const expectedSources = expectedInitialListSources(testInfo.project.name);
    const listResponseStatuses: SafeListResponseStatus[] = [];
    let forbiddenApiRequestCount = 0;
    let apiOptions = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      const host = url.hostname;
      if (
        (host === "api.ai-feeds.com" || host === "staging-api.ai-feeds.com")
        && url.pathname.startsWith("/api/")
      ) {
        forbiddenApiRequestCount += 1;
      }
      if (url.origin === PERF_ORIGIN && url.pathname.startsWith("/api/") && request.method() === "OPTIONS") {
        apiOptions += 1;
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== PERF_ORIGIN || url.pathname !== "/api/items") return;
      const source = url.searchParams.get("source_type");
      if (source && expectedSources.includes(source)) {
        listResponseStatuses.push({ source, status: response.status() });
      }
    });

    await installSafeLcpObserver(page);
    const waitForListResponse = () => page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === PERF_ORIGIN
        && url.pathname === "/api/items"
        && url.searchParams.get("source_type") === "x_list";
    });
    const listResponsePromise = waitForListResponse();
    await page.goto(PERF_PATH, { waitUntil: "domcontentloaded" });
    const listResponse = await listResponsePromise;

    expect(listResponse.ok()).toBe(true);
    expect(new URL(listResponse.url()).origin).toBe(PERF_ORIGIN);
    const xFixture = await readSyntheticFixtureFromUiResponse(
      listResponse,
      "E2E_EXPECTED_X_FIXTURE_ID",
      "x_list",
      { requireFirst: true },
    );
    const expectedXImageWidth = testInfo.project.name === "desktop-chromium" ? 400 : 800;
    const expectedXImage = exactFixtureImagePaths(xFixture, "x_list", expectedXImageWidth);
    const serverTiming = parseSafeServerTiming(listResponse.headers()["server-timing"]);
    const rawRequestId = listResponse.headers()["x-request-id"];
    const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(rawRequestId || "") ? rawRequestId : null;
    expect(serverTiming).not.toBeNull();
    expect(requestId).not.toBeNull();
    const activeXFeed = await expectFeedColumnInViewport(page, "x_list");
    await expectExactFixtureImage(
      activeXFeed,
      expectedXImage.originalPath,
      expectedXImage.variantPath,
    );
    await expectSuccessfulInitialListResponses(page, listResponseStatuses, expectedSources);
    await settleLcpAfterFeedReady(page, mediaRequestRecords);
    const pageQuality = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content || "";
      const viewportDirectives = new Map(viewport.split(",").map((directive) => {
        const [rawKey, ...rawValue] = directive.trim().split("=");
        return [rawKey.toLowerCase(), rawValue.join("=").trim().toLowerCase()];
      }));
      const labelledByText = (element: Element): string => (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .join(" ")
        .trim();
      const namelessButtons = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => {
          if (button.hidden || button.getClientRects().length === 0 || button.closest('[aria-hidden="true"]')) return false;
          return !(
            button.getAttribute("aria-label")?.trim()
            || labelledByText(button)
            || button.getAttribute("title")?.trim()
            || button.textContent?.trim()
            || button.querySelector<HTMLImageElement>('img[alt]:not([alt=""])')?.alt.trim()
          );
        }).length;
      const videoViaImageProxy = [...document.querySelectorAll<HTMLVideoElement>("video[src]")]
        .filter((video) => new URL(video.currentSrc || video.src, location.href).pathname === "/img")
        .length;
      const imageProxyTargetsVideo = [...document.querySelectorAll<HTMLImageElement>("img[src]")]
        .filter((image) => {
          const url = new URL(image.currentSrc || image.src, location.href);
          if (url.pathname !== "/img") return false;
          return /\.(?:mp4|mov|webm)(?:$|[?#])/i.test(url.searchParams.get("url") || "");
        }).length;
      const phAvatars = [...document.querySelectorAll<HTMLImageElement>(
        '[data-feed-source="product_hunt"] img.rounded-full',
      )].map((image) => new URL(image.currentSrc || image.src, location.href));
      return {
        viewportAllowsZoom: !["no", "0"].includes(viewportDirectives.get("user-scalable") || "")
          && (!viewportDirectives.has("maximum-scale")
            || Number(viewportDirectives.get("maximum-scale")) > 1),
        anchorsWithoutHref: [...document.querySelectorAll<HTMLAnchorElement>("a")]
          .filter((anchor) => !anchor.getAttribute("href")?.trim()).length,
        namelessButtons,
        videoViaImageProxy,
        imageProxyTargetsVideo,
        invalidPhAvatars: phAvatars.filter((url) => {
          const isR2Avatar = url.hostname === "staging-api.ai-feeds.com"
            && /^\/r\/ph\/[a-f0-9]{64}\.(?:png|jpg|gif|webp|svg|avif|ico)$/i.test(url.pathname);
          if (isR2Avatar) return false;
          if (!url.hostname.endsWith(".imgix.net")) return true;
          const width = Number(url.searchParams.get("w"));
          const height = Number(url.searchParams.get("h"));
          return !Number.isFinite(width) || width < 16 || width > 96
            || !Number.isFinite(height) || height < 16 || height > 96;
        }).length,
        phAvatarCount: phAvatars.length,
      };
    });
    const { phAvatarCount, ...pageQualityAssertions } = pageQuality;
    expect(pageQualityAssertions).toEqual({
      viewportAllowsZoom: true,
      anchorsWithoutHref: 0,
      namelessButtons: 0,
      videoViaImageProxy: 0,
      imageProxyTargetsVideo: 0,
      invalidPhAvatars: 0,
    });
    if (testInfo.project.name.startsWith("desktop-")) expect(phAvatarCount).toBeGreaterThan(0);
    const axeResult = await new AxeBuilder({ page })
      .withRules(["color-contrast", "nested-interactive"])
      .analyze();
    const axeViolationSummary = axeResult.violations.map((violation) => ({
      id: violation.id,
      nodeCount: violation.nodes.length,
    }));
    expect(axeViolationSummary).toEqual([]);
    const cold = await captureSafePagePerformance(page, mediaRequestRecords);
    const coldListSources = await safeListSourcesBeforeContentionCutoff(page);
    expect(forbiddenApiRequestCount).toBe(0);
    expect(apiOptions).toBe(0);

    if (isMobileProject(testInfo.project.name)) {
      await expect(page.locator('[data-chip-key="x_list"]')).toBeVisible();
    } else {
      await expect(page.locator('[data-chip-key="x_list"]')).toHaveCount(0);
    }

    await expect.poll(async () => page.evaluate(() => {
      const entry = performance.getEntriesByType("resource")
        .find((candidate) => candidate.name.includes("/api/items?source_type=x_list"));
      return entry?.duration ?? 0;
    })).toBeGreaterThan(0);
    const rawTiming = await page.evaluate(() => {
      const entry = performance.getEntriesByType("resource")
        .find((candidate) => candidate.name.includes("/api/items?source_type=x_list"));
      if (!(entry instanceof PerformanceResourceTiming)) return null;
      const protocol = entry.nextHopProtocol === "h2"
        ? "h2"
        : entry.nextHopProtocol === "h3"
          ? "h3"
          : entry.nextHopProtocol === "http/1.1" ? "http/1.1" : "other";
      return {
        duration: entry.duration,
        dns: entry.domainLookupEnd - entry.domainLookupStart,
        connect: entry.connectEnd - entry.connectStart,
        tls: entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0,
        request: entry.responseStart - entry.requestStart,
        protocol,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
      };
    });
    const timing = rawTiming ? {
      duration: boundedNumber(rawTiming.duration, 600_000),
      dns: boundedNumber(rawTiming.dns, 600_000),
      connect: boundedNumber(rawTiming.connect, 600_000),
      tls: boundedNumber(rawTiming.tls, 600_000),
      request: boundedNumber(rawTiming.request, 600_000),
      protocol: rawTiming.protocol,
      transferSize: boundedNumber(rawTiming.transferSize, 1_000_000_000),
      encodedBodySize: boundedNumber(rawTiming.encodedBodySize, 1_000_000_000),
    } : null;
    expect(timing).not.toBeNull();
    expect(timing?.protocol).toBe("h2");
    expect(timing?.connect).toBe(0);
    expect(timing?.tls).toBe(0);

    await page.waitForLoadState("load");
    await expect.poll(() => page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.some((registration) => registration.active != null);
    })).toBe(true);
    await expect.poll(() => page.evaluate(async () => {
      const cacheNames = await caches.keys();
      const shellCache = cacheNames.find((name) => name.startsWith("aifeeds-shell-"));
      if (!shellCache) return false;
      const response = await (await caches.open(shellCache)).match("/");
      return response?.ok === true;
    })).toBe(true);
    listResponseStatuses.length = 0;
    const warmListResponsePromise = waitForListResponse();
    const warmNavigationResponse = await page.reload({ waitUntil: "domcontentloaded" });
    const warmListResponse = await warmListResponsePromise;
    expect(warmListResponse.ok()).toBe(true);
    await expectFeedColumnInViewport(page, "x_list");
    await expectSuccessfulInitialListResponses(page, listResponseStatuses, expectedSources);
    await settleLcpAfterFeedReady(page, mediaRequestRecords);
    const warm = await captureSafePagePerformance(page, mediaRequestRecords);
    const warmListSources = await safeListSourcesBeforeContentionCutoff(page);
    expect(cold.navigation.workerStartMs).toBe(0);
    expectWarmServiceWorkerNavigation(warm, testInfo.project.name, warmNavigationResponse);
    expect(mediaRequestRecords.filter((record) => {
      try {
        return new URL(record.url).pathname === "/img" && record.httpStatus === 403;
      } catch {
        return false;
      }
    })).toHaveLength(0);
    const listTransferBudget = isMobileProject(testInfo.project.name) ? 100 * 1024 : 250 * 1024;
    expect(coldListSources).toEqual(expectedSources);
    expect(warmListSources).toEqual(expectedSources);
    for (const { sample, ceilings } of [
      { sample: cold, ceilings: remoteSmokeCeilings.cold },
      { sample: warm, ceilings: remoteSmokeCeilings.warm },
    ]) {
      expect(sample.milestones.feedReady.status).toBe("ok");
      expect(sample.milestones.feedReady.valueMs).toBeGreaterThan(0);
      expect(sample.milestones.feedReady.valueMs).toBeLessThanOrEqual(ceilings.feedReadyMs);
      for (const metric of [sample.milestones.fcp, sample.milestones.lcp]) {
        expect(metric.status === "ok" || metric.status === "unsupported").toBe(true);
        if (metric.status === "ok") expect(metric.valueMs).toBeGreaterThan(0);
      }
      if (sample.milestones.lcp.status === "ok") {
        expect(sample.milestones.lcp.valueMs).toBeLessThanOrEqual(ceilings.lcpMs);
      }
      expect(sample.budgets.totalTransferBytes).toBeGreaterThanOrEqual(0);
      const expectedCutoff = sample.milestones.lcp.status === "unsupported" ? "feed_ready" : "lcp";
      expect(sample.budgets.contentionCutoff).toBe(expectedCutoff);
      expect(sample.budgets.listTransferBeforeCutoffBytes).toBeLessThanOrEqual(listTransferBudget);
      expect(sample.budgets.listRequestsBeforeCutoffCount).toBe(expectedSources.length);
      expect(sample.budgets.belowFoldListBeforeCutoffCount).toBe(0);
      expect(sample.budgets.highPriorityImageCount).toBeLessThanOrEqual(1);
      expect(sample.budgets.belowFoldMediaBeforeCutoffCount).toBe(0);
      expect(sample.visuals.failedVisibleCardImageCount).toBe(0);
      expect(sample.visuals.decodedVisibleCardImageCount).toBe(sample.visuals.visibleCardImageCount);
      expect(sample.visuals.failedCardVariantRequestCount).toBe(0);
      expect(sample.visuals.pendingCardVariantRequestCount).toBe(0);
      expect(
        sample.visuals.layoutShift.status === "ok"
        || sample.visuals.layoutShift.status === "unsupported",
      ).toBe(true);
      if (sample.visuals.layoutShift.status === "ok") {
        expect(sample.visuals.layoutShift.value).toBeLessThanOrEqual(0.1);
      }
      if (!isMobileProject(testInfo.project.name)) {
        expect(sample.visuals.visibleCardImageCount).toBeGreaterThan(0);
        expect(sample.visuals.cardVariantRequestCount).toBeGreaterThan(0);
      }
      if (testInfo.project.name === "desktop-chromium") {
        expect(sample.visuals.cardVariant400RequestCount).toBeGreaterThan(0);
      }
      if (testInfo.project.name === "tablet-chromium") {
        expect(sample.visuals.cardVariant800RequestCount).toBeGreaterThan(0);
      }
    }
    await testInfo.attach("same-origin-api-timing.json", {
      body: Buffer.from(JSON.stringify({ ...timing, requestId, serverTiming, apiOptions }, null, 2)),
      contentType: "application/json",
    });
    await testInfo.attach("cold-warm-page-performance.json", {
      body: Buffer.from(JSON.stringify({
        schema: 1,
        project: testInfo.project.name,
        warmShellCacheProven: true,
        expectedInitialListSources: expectedSources,
        smokeCeilings: remoteSmokeCeilings,
        cold,
        warm,
      }, null, 2)),
      contentType: "application/json",
    });
    // Publish the final per-project join only after every assertion and safe
    // attachment has succeeded. Atomic replacement keeps Playwright retryable.
    persistBrowserJoinEvidence(testInfo.project.name, requestId!);
  });

  test("the private synthetic login remains valid on every device profile", async ({ context, page }) => {
    const expectedUserId = process.env.E2E_EXPECTED_UID || "";
    if (!/^[A-Za-z0-9_-]{14}$/.test(expectedUserId)) {
      throw new Error("E2E_EXPECTED_UID must identify the synthetic perf-staging account");
    }
    try {
      await context.addCookies([readPrivateSessionCookie()]);
    } catch {
      throw new Error("synthetic staging session cookie could not be installed");
    }
    await page.goto(PERF_PATH, { waitUntil: "domcontentloaded" });
    const readMe = () => page.evaluate(async (expectedUserIdInPage) => {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      const raw = await response.text();
      try {
        const body = JSON.parse(raw) as { user?: { id?: string } };
        return { status: response.status, idMatches: body.user?.id === expectedUserIdInPage };
      } catch {
        return { status: response.status, idMatches: false };
      }
    }, expectedUserId);
    const first = await readMe();
    expect(first).toEqual({ status: 200, idMatches: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    const second = await readMe();
    expect(second).toEqual({ status: 200, idMatches: true });
  });

  test("mobile projects switch the live remote feed with a touch swipe", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), "mobile interaction only");
    const mediaRequestRecords = trackSafeMediaRequests(page);
    await page.goto(PERF_PATH, { waitUntil: "domcontentloaded" });
    await expectFeedColumnInViewport(page, "x_list");
    const swipeMediaRequestBaseline = mediaRequestRecords.length;
    const blogResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === PERF_ORIGIN
        && url.pathname === "/api/items"
        && url.searchParams.get("source_type") === "blog,podcast"
        && url.searchParams.get("limit") === "12"
        && url.searchParams.get("sort") === "published_at";
    });
    await swipeToNextChannel(page, testInfo.project.name);
    const blogResponse = await blogResponsePromise;
    const blogFixture = await readSyntheticFixtureFromUiResponse(
      blogResponse,
      "E2E_EXPECTED_BLOG_FIXTURE_ID",
      "blog",
      { requireFirst: true },
    );
    const expectedBlogImage = exactFixtureImagePaths(blogFixture, "blog", 400);
    const expectedBlogImagePath = expectedBlogImage.variantPath;
    const activeBlogFeed = await expectFeedColumnInViewport(page, "blog,podcast");
    await expectExactFixtureImage(
      activeBlogFeed,
      expectedBlogImage.originalPath,
      expectedBlogImagePath,
    );
    const exactBlogRequests = () => mediaRequestRecords.slice(swipeMediaRequestBaseline)
      .filter((record) => {
        try {
          const url = new URL(record.url);
          return url.origin === WORKER_ASSET_ORIGIN && url.pathname === expectedBlogImagePath;
        } catch {
          return false;
        }
      });
    await expect.poll(() => exactBlogRequests().some((record) => record.finished)).toBe(true);
    const completedBlogRequests = exactBlogRequests();
    expect(completedBlogRequests.length).toBeGreaterThan(0);
    expect(completedBlogRequests.some((record) => (
      !record.failed
      && record.httpStatus !== null
      && record.httpStatus >= 200
      && record.httpStatus < 300
    ))).toBe(true);
    expect(completedBlogRequests.filter((record) => (
      record.failed
      || record.httpStatus === null
      || record.httpStatus < 200
      || record.httpStatus >= 300
    ))).toHaveLength(0);
  });

  test("representative desktop validates API errors, search, SEO and SPA routing", async ({ request }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("desktop-"), "one browser covers route topology");
    const publicHeaders = {
      Origin: PERF_ORIGIN,
      "User-Agent": browserUserAgent,
    };
    const apiHeaders = {
      ...publicHeaders,
      "X-Aifeeds-Perf-Probe": process.env.E2E_PERF_PROBE!,
    };

    const search = await request.get("/api/search?q=AI", { headers: apiHeaders });
    expect(search.ok()).toBe(true);
    expect(/^[A-Za-z0-9._:-]{8,128}$/.test(search.headers()["x-request-id"] || "")).toBe(true);

    const me = await request.get("/api/auth/me", { headers: apiHeaders });
    expect(me.status()).toBe(200);
    expect(await parseJsonWithoutBodyLeak(me)).toEqual({ user: null });
    expect(me.headers()["cache-control"] || "").toContain("no-store");
    expect(me.headers()["cf-cache-status"]?.toUpperCase() === "HIT").toBe(false);

    let mediaRangeSummary: {
      status: number;
      contentLength: string | null;
      contentRange: string | null;
      acceptRanges: string | null;
      cacheControl: string | null;
      contentType: string | null;
    } | null = null;
    for (const fixture of MEDIA_RANGE_FIXTURES) {
      const mediaResponse = await fetch(
        `${WORKER_ASSET_ORIGIN}/media?${new URLSearchParams({ url: fixture })}`,
        {
          headers: { Range: "bytes=0-1023", "User-Agent": browserUserAgent },
          signal: AbortSignal.timeout(20_000),
        },
      );
      const candidate = {
        status: mediaResponse.status,
        contentLength: mediaResponse.headers.get("content-length"),
        contentRange: mediaResponse.headers.get("content-range"),
        acceptRanges: mediaResponse.headers.get("accept-ranges"),
        cacheControl: mediaResponse.headers.get("cache-control"),
        contentType: mediaResponse.headers.get("content-type"),
      };
      await mediaResponse.body?.cancel();
      if (candidate.status === 206) {
        mediaRangeSummary = candidate;
        break;
      }
    }
    expect(mediaRangeSummary).toEqual({
      status: 206,
      contentLength: "1024",
      contentRange: expect.stringMatching(/^bytes 0-1023\/[1-9][0-9]*$/),
      acceptRanges: "bytes",
      cacheControl: "no-store",
      contentType: expect.stringMatching(/^video\/mp4(?:;|$)/),
    });

    const sms = await request.post("/api/auth/sms/send", { headers: apiHeaders, data: {} });
    expect(sms.status()).toBe(403);
    const smsBody = await parseJsonWithoutBodyLeak(sms);
    const smsReason = smsBody && typeof smsBody === "object"
      ? (smsBody as { reason?: unknown }).reason
      : null;
    expect(smsReason === "sms_disabled").toBe(true);

    const robots = await request.get("/robots.txt", { headers: publicHeaders });
    expect(robots.ok()).toBe(true);
    expect(/^text\/plain/.test(robots.headers()["content-type"] || "")).toBe(true);
    const robotsBody = await robots.text();
    expect({
      userAgent: robotsBody.includes("User-agent: *"),
      sitemap: robotsBody.includes("Sitemap: https://staging.ai-feeds.com/sitemap.xml"),
      spaRoot: robotsBody.includes('<div id="root">'),
    }).toEqual({ userAgent: true, sitemap: true, spaRoot: false });

    const sitemap = await request.get("/sitemap.xml", { headers: publicHeaders });
    expect(sitemap.ok()).toBe(true);
    expect(/^application\/xml/.test(sitemap.headers()["content-type"] || "")).toBe(true);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody.includes("<sitemapindex")).toBe(true);
    const shardLocations = [...sitemapBody.matchAll(/<loc>(https:\/\/[^<]+\/sitemap-[^<]+\.xml)<\/loc>/g)]
      .map((match) => match[1])
      .filter((location) => !location.endsWith("/sitemap-daily.xml"));
    expect(shardLocations.length).toBeGreaterThan(0);
    let itemPath: string | null = null;
    for (const location of shardLocations) {
      let shardPath: string;
      try {
        shardPath = new URL(location).pathname;
      } catch {
        continue;
      }
      const shard = await requestWithoutUrlLeak(() => request.get(shardPath, { headers: publicHeaders }));
      requireResponse(shard, "sitemap shard request failed");
      expect(shard.ok(), "sitemap shard must be reachable").toBe(true);
      expect(/^application\/xml/.test(shard.headers()["content-type"] || "")).toBe(true);
      const shardBody = await shard.text();
      expect(shardBody.includes("<urlset")).toBe(true);
      const itemLocation = shardBody.match(/<loc>(https:\/\/[^<]+\/i\/[^<]+)<\/loc>/)?.[1];
      if (itemLocation) {
        try {
          const parsedItem = new URL(itemLocation);
          itemPath = `${parsedItem.pathname}${parsedItem.search}`;
          break;
        } catch {
          // A malformed live sitemap entry is represented only by a missing safe route signal.
        }
      }
    }
    expect(itemPath, "at least one live sitemap item is required for /i route validation").toBeTruthy();
    const itemPage = await requestWithoutUrlLeak(() => request.get(itemPath!, { headers: publicHeaders }));
    requireResponse(itemPage, "item SEO route request failed");
    expect(itemPage.ok()).toBe(true);
    expect(/^text\/html/.test(itemPage.headers()["content-type"] || "")).toBe(true);
    const itemHtml = await itemPage.text();
    expect({
      article: itemHtml.includes("<article>"),
      jsonLd: itemHtml.includes("application/ld+json"),
      spaRoot: itemHtml.includes('<div id="root">'),
    }).toEqual({ article: true, jsonLd: true, spaRoot: false });

    const llms = await request.get("/llms.txt", { headers: publicHeaders });
    expect(llms.ok()).toBe(true);
    expect(/^text\/plain/.test(llms.headers()["content-type"] || "")).toBe(true);
    expect((await llms.text()).split(/\r?\n/, 1)[0] === "# AI Feeds").toBe(true);

    const daily = await request.get("/daily/", { headers: publicHeaders });
    expect(daily.ok()).toBe(true);
    expect(/^text\/html/.test(daily.headers()["content-type"] || "")).toBe(true);
    const dailyHtml = await daily.text();
    expect({
      archiveHeading: dailyHtml.includes("<h1>AI 日报归档</h1>"),
      spaRoot: dailyHtml.includes('<div id="root">'),
    }).toEqual({ archiveHeading: true, spaRoot: false });

    const home = await request.get("/", { headers: publicHeaders });
    expect(home.ok()).toBe(true);
    const homeHtml = await home.text();
    const assetPath = homeHtml.match(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/)?.[1];
    expect(assetPath, "deployed HTML must reference a hashed JS/CSS asset").toBeTruthy();
    const asset = await requestWithoutUrlLeak(() => request.get(assetPath!, { headers: publicHeaders }));
    requireResponse(asset, "hashed frontend asset request failed");
    expect(asset.ok()).toBe(true);
    expect(/(?:javascript|text\/css)/.test(asset.headers()["content-type"] || "")).toBe(true);
    expect((await asset.text()).includes('<div id="root">')).toBe(false);

    for (const pathname of [
      "/settings/account",
      "/feedback",
      "/subscribe",
      "/me/subscription",
      "/t/perf-staging-probe",
      "/g/perf-staging/probe",
      "/ph/perf-staging/2026-07-12",
      "/c/perf-staging-probe",
      "/e/perf-staging-probe",
      "/h/perf-staging-probe",
      "/o/perf-staging-probe",
    ]) {
      const response = await request.get(pathname, { headers: publicHeaders });
      expect(response.ok(), pathname).toBe(true);
      expect(/^text\/html/.test(response.headers()["content-type"] || "")).toBe(true);
      expect((await response.text()).includes('<div id="root">')).toBe(true);
    }

    const podcastFeed = await request.get("/api/items?source_type=podcast&limit=50", { headers: apiHeaders });
    expect(podcastFeed.ok()).toBe(true);
    const expectedXFixtureId = expectedSyntheticFixtureId(
      "E2E_EXPECTED_X_FIXTURE_ID",
      "x_list",
    );
    const xFixture = await requestWithoutUrlLeak(() => (
      request.get(`/api/items/${encodeURIComponent(expectedXFixtureId)}`, { headers: apiHeaders })
    ));
    requireResponse(xFixture, "owned synthetic X fixture detail request failed");
    expect(xFixture.ok()).toBe(true);
    const xFixturePayload = await parseJsonWithoutBodyLeak(xFixture) as {
      item?: SyntheticFixtureItem;
    } | null;
    if (!xFixturePayload?.item) throw new Error("owned synthetic X fixture detail is missing");
    expect(xFixturePayload.item.id).toBe(expectedXFixtureId);
    const videoUrl = findRangeAsset(xFixturePayload.item, "video");
    const podcastList = await parseJsonWithoutBodyLeak(podcastFeed) as { items?: Array<{ id?: string }> } | null;
    let audioUrl: string | null = null;
    for (const item of (podcastList?.items || []).slice(0, 20)) {
      if (!item.id) continue;
      const detail = await requestWithoutUrlLeak(() => (
        request.get(`/api/items/${encodeURIComponent(item.id!)}`, { headers: apiHeaders })
      ));
      if (!detail) continue;
      if (!detail.ok()) continue;
      audioUrl = findRangeAsset(await parseJsonWithoutBodyLeak(detail), "audio");
      if (audioUrl) break;
    }
    expect(videoUrl, "staging must contain one Worker-backed X video for Range validation").toBeTruthy();
    expect(audioUrl, "staging must contain one Worker-backed podcast audio for Range validation").toBeTruthy();
    for (const assetUrl of [videoUrl!, audioUrl!]) {
      let workerAssetUrl: URL;
      try {
        workerAssetUrl = new URL(assetUrl, "https://staging-api.ai-feeds.com");
      } catch {
        throw new Error("Worker-backed media returned an invalid relative URL");
      }
      expect(workerAssetUrl.origin === "https://staging-api.ai-feeds.com").toBe(true);
      const range = await requestWithoutUrlLeak(() => request.get(workerAssetUrl.href, {
        headers: { ...publicHeaders, Range: "bytes=0-0" },
      }));
      requireResponse(range, "Worker-backed media Range request failed");
      expect(range.status(), "Worker-backed media must honor a one-byte Range request").toBe(206);
      expect(/^bytes 0-0\/\d+$/.test(range.headers()["content-range"] || "")).toBe(true);
    }
  });
});

test("privacy-safe collector executes inside a real browser context", async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_COLLECTOR_SELF_TEST !== "1"
      || !new Set(["desktop-chromium", "iphone-webkit"]).has(testInfo.project.name),
    "explicit Chromium/WebKit collector self-test",
  );
  const mediaRequestRecords = trackSafeMediaRequests(page);
  let releaseRoute: (() => void) | null = null;
  await page.route("https://collector.invalid/**", async (route) => {
    await new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    await route.abort("aborted");
  });
  await installSafeLcpObserver(page);
  await page.goto("data:text/html,<main>collector self test</main>", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsListRequestStarts?: number[];
    };
    target.__aifeedsListRequestStarts = [];
    const video = document.createElement("video");
    video.dataset.mediaPriority = "lazy-auto";
    video.width = 400;
    video.height = 250;
    video.preload = "none";
    video.style.display = "block";
    video.style.position = "absolute";
    video.style.top = `${innerHeight + 1000}px`;
    video.style.left = "0";
    video.poster = `https://collector.invalid/r/x/card/${"a".repeat(64)}-w400.webp`;
    document.body.append(video);
  });
  await expect.poll(() => mediaRequestRecords.length).toBe(1);
  await page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsLcpSettled?: boolean;
      __aifeedsCls?: number | null;
    };
    const supported = new Set(PerformanceObserver.supportedEntryTypes || []);
    performance.mark("aifeeds:feed-ready");
    target.__aifeedsLcpMs = supported.has("largest-contentful-paint")
      ? performance.now() + 100
      : null;
    target.__aifeedsLcpSettled = true;
    target.__aifeedsCls = supported.has("layout-shift") ? 0.149 : null;
  });
  const mediaDiagnostics = await page.evaluate((mediaRequests) => {
    const video = document.querySelector("video");
    const feedReady = performance.getEntriesByName("aifeeds:feed-ready", "mark")[0]?.startTime ?? null;
    const posterUrl = video?.poster ? new URL(video.poster, location.href).href : null;
    const relativeStarts = mediaRequests.map((record) => record.startedAtUnixMs - performance.timeOrigin);
    return {
      belowFold: Boolean(video && video.getBoundingClientRect().top >= innerHeight),
      posterMatchesRequest: posterUrl !== null && mediaRequests.some((record) => record.url === posterUrl),
      requestStartedBeforeFeedReady: feedReady !== null
        && relativeStarts.some((startTime) => startTime >= 0 && startTime <= feedReady),
    };
  }, mediaRequestRecords);
  expect(mediaDiagnostics).toEqual({
    belowFold: true,
    posterMatchesRequest: true,
    requestStartedBeforeFeedReady: true,
  });
  const evidence = await captureSafePagePerformance(page, mediaRequestRecords);
  expect(evidence.schema).toBe(1);
  expect(evidence.milestones.feedReady.status).toBe("ok");
  const chromium = testInfo.project.name === "desktop-chromium";
  expect(evidence.budgets.contentionCutoff).toBe(chromium ? "lcp" : "feed_ready");
  expect(evidence.budgets.belowFoldListBeforeCutoffCount).toBe(0);
  expect(evidence.budgets.belowFoldMediaBeforeCutoffCount).toBe(1);
  expect(evidence.milestones.lcp.status).toBe(chromium ? "ok" : "unsupported");
  expect(evidence.visuals.layoutShift.status).toBe(chromium ? "ok" : "unsupported");
  if (chromium) expect(evidence.visuals.layoutShift.value).toBeGreaterThan(0.1);
  else expect(evidence.visuals.layoutShift.value).toBeNull();
  expect(evidence.visuals.cardVariantRequestCount).toBe(0);
  expect(evidence.visuals.pendingCardVariantRequestCount).toBe(0);
  expect(releaseRoute).not.toBeNull();
  releaseRoute!();
  await expect.poll(() => mediaRequestRecords[0]?.failed).toBe(true);
  persistBrowserJoinEvidence(testInfo.project.name, "collector-self-test-12345678");
  persistBrowserJoinEvidence(testInfo.project.name, "collector-self-test-87654321");
  const joinFile = join(process.env.E2E_OUTPUT_DIR!, "join", `${testInfo.project.name}.json`);
  expect((lstatSync(joinFile).mode & 0o077) === 0).toBe(true);
  expect(JSON.parse(readFileSync(joinFile, "utf8")).request_id).toBe("collector-self-test-87654321");
});

test("visible variant summary is scoped to the post-swipe feed and trusted origin", async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_COLLECTOR_SELF_TEST !== "1"
      || !new Set(["desktop-chromium", "iphone-webkit"]).has(testInfo.project.name),
    "explicit Chromium/WebKit collector self-test",
  );
  const mediaRequestRecords = trackSafeMediaRequests(page);
  const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="black"/></svg>';
  await page.route("https://collector.invalid/**", async (route) => {
    if (route.request().resourceType() === "document") {
      await route.fulfill({
        contentType: "text/html",
        body: '<main><section data-feed-column="x_list" data-feed-source="x_list"><img id="x" data-media-priority="high" width="20" height="20"></section><section data-feed-column="blog,podcast" data-feed-source="blog,podcast"><img id="blog" data-media-priority="high" width="20" height="20"><img id="foreign" data-media-priority="high" width="20" height="20"></section><section data-feed-column="blog,podcast" data-feed-source="blog,podcast" style="position:absolute;left:200vw;top:0"><img id="offscreen" data-media-priority="high" width="20" height="20"></section></main>',
      });
      return;
    }
    await route.fulfill({ contentType: "image/svg+xml", body: imageBody });
  });
  await page.route("https://assets.invalid/**", async (route) => {
    await route.fulfill({ contentType: "image/svg+xml", body: imageBody });
  });
  await page.route("https://other.invalid/**", async (route) => {
    await route.fulfill({ contentType: "image/svg+xml", body: imageBody });
  });
  await page.goto("https://collector.invalid/visible-variants", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>("#x");
    if (image) image.src = `https://assets.invalid/r/x/card/${"a".repeat(64)}-w400.webp`;
  });
  await expect.poll(() => mediaRequestRecords.length).toBe(1);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLImageElement>("#x")?.complete)).toBe(true);
  const swipeMediaRequestBaseline = mediaRequestRecords.length;
  await page.evaluate(() => {
    const blog = document.querySelector<HTMLImageElement>("#blog");
    const foreign = document.querySelector<HTMLImageElement>("#foreign");
    const offscreen = document.querySelector<HTMLImageElement>("#offscreen");
    if (blog) blog.src = `https://assets.invalid/r/blog/card/${"b".repeat(64)}-w400.webp`;
    if (foreign) foreign.src = `https://other.invalid/r/blog/card/${"c".repeat(64)}-w400.webp`;
    if (offscreen) offscreen.src = `https://assets.invalid/r/blog/card/${"d".repeat(64)}-w400.webp`;
  });
  await expect.poll(() => mediaRequestRecords.length).toBe(4);
  await expect.poll(() => mediaRequestRecords.slice(swipeMediaRequestBaseline).every((record) => record.finished))
    .toBe(true);
  const summary = await safeVisibleCardVariantRequestSummary(
    page,
    mediaRequestRecords,
    swipeMediaRequestBaseline,
    "blog,podcast",
    "https://collector.invalid",
    "https://assets.invalid",
  );
  expect(summary).toEqual({
    count: 1,
    width400Count: 1,
    width800Count: 0,
    failedCount: 0,
    pendingCount: 0,
  });
});

test("visible video poster must finish before card media is settled", async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_COLLECTOR_SELF_TEST !== "1"
      || !new Set(["desktop-chromium", "iphone-webkit"]).has(testInfo.project.name),
    "explicit Chromium/WebKit collector self-test",
  );
  const mediaRequestRecords = trackSafeMediaRequests(page);
  let releasePoster: (() => void) | null = null;
  await page.route("https://collector.invalid/poster-settle", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<video width="320" height="180" poster="https://assets.invalid/r/x/card/${"d".repeat(64)}-w400.webp"></video>`,
    });
  });
  await page.route("https://assets.invalid/**", async (route) => {
    await new Promise<void>((resolve) => {
      releasePoster = resolve;
    });
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="black"/></svg>',
    });
  });
  await page.goto("https://collector.invalid/poster-settle", { waitUntil: "domcontentloaded" });
  await expect.poll(() => mediaRequestRecords.length).toBe(1);
  let mediaSettled = false;
  const settlePromise = settleVisibleCardMedia(page, mediaRequestRecords).then(() => {
    mediaSettled = true;
  });
  await page.waitForTimeout(100);
  expect(mediaSettled).toBe(false);
  expect(releasePoster).not.toBeNull();
  releasePoster!();
  await settlePromise;
  expect(mediaSettled).toBe(true);
});

test("visible image decode timeout fails closed before LCP settles", async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_COLLECTOR_SELF_TEST !== "1"
      || testInfo.project.name !== "desktop-chromium",
    "explicit Chromium collector timeout self-test",
  );
  const mediaRequestRecords = trackSafeMediaRequests(page);
  let releaseImage: (() => void) | null = null;
  await page.route("https://collector.invalid/image-decode-timeout", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<img data-media-priority="high" width="320" height="180" src="https://assets.invalid/r/x/card/${"e".repeat(64)}-w400.webp">`,
    });
  });
  await page.route("https://assets.invalid/**", async (route) => {
    await new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await route.abort("aborted");
  });
  await page.goto("https://collector.invalid/image-decode-timeout", { waitUntil: "domcontentloaded" });
  await expect.poll(() => mediaRequestRecords.length).toBe(1);
  await expect(settleVisibleCardMedia(page, mediaRequestRecords, 50))
    .rejects.toThrow(/visible card image decode did not settle/);
  expect(releaseImage).not.toBeNull();
  releaseImage!();
  await expect.poll(() => mediaRequestRecords[0]?.failed).toBe(true);
});

test("LCP and CLS observers freeze on separate non-input settle events", async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_COLLECTOR_SELF_TEST !== "1"
      || !new Set(["desktop-chromium", "iphone-webkit"]).has(testInfo.project.name),
    "explicit Chromium/WebKit collector self-test",
  );
  await installSafeLcpObserver(page);
  await page.goto("data:text/html,<main style='font-size:48px'>observer self test</main>", {
    waitUntil: "domcontentloaded",
  });
  const lcpSupported = await page.evaluate(() => (
    new Set(PerformanceObserver.supportedEntryTypes || []).has("largest-contentful-paint")
  ));
  if (lcpSupported) {
    await expect.poll(() => page.evaluate(() => {
      const target = window as Window & { __aifeedsLcpMs?: number | null };
      return target.__aifeedsLcpMs ?? 0;
    })).toBeGreaterThan(0);
  }
  const frozenLcp = await page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsLcpSettled?: boolean;
      __aifeedsClsSettled?: boolean;
    };
    dispatchEvent(new Event("aifeeds:lcp-settled"));
    if (!target.__aifeedsLcpSettled || target.__aifeedsClsSettled) {
      throw new Error("performance observer settle ordering mismatch");
    }
    return target.__aifeedsLcpMs ?? null;
  });
  await page.evaluate(() => {
    const late = document.createElement("div");
    late.textContent = "late candidate ".repeat(5_000);
    late.style.fontSize = "64px";
    document.body.prepend(late);
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(100);
  const finalState = await page.evaluate(() => {
    const target = window as Window & {
      __aifeedsLcpMs?: number | null;
      __aifeedsCls?: number | null;
      __aifeedsClsSettled?: boolean;
    };
    if (typeof target.__aifeedsCls === "number") target.__aifeedsCls += 0.2;
    dispatchEvent(new Event("aifeeds:cls-settled"));
    return {
      lcp: target.__aifeedsLcpMs ?? null,
      clsSettled: target.__aifeedsClsSettled === true,
      cls: target.__aifeedsCls ?? null,
    };
  });
  expect(finalState.lcp).toBe(frozenLcp);
  expect(finalState.clsSettled).toBe(true);
  if (testInfo.project.name === "desktop-chromium") expect(finalState.cls).toBeGreaterThanOrEqual(0.2);
  else expect(finalState.cls).toBeNull();
});
