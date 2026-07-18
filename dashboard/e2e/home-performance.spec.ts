import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const LIVE_SOURCES = [
  "x_list",
  "blog",
  "podcast",
  "product_hunt",
  "github",
  "hf_paper",
  "huodongxing",
  "clawhub",
] as const;

type MockOptions = {
  saveData?: boolean;
  pendingManifest?: boolean;
  pendingCard?: boolean;
  pendingRefresh?: boolean;
  failManifest?: boolean;
  failFirstList?: boolean;
  videoPosterFixture?: boolean;
  gifPreviewFixture?: boolean;
  imageFallbackFixture?: "fallback-succeeds" | "fallback-fails";
};

type MockState = {
  listRequests: string[];
  fontRequests: string[];
  detailRequests: string[];
  posterRequests: string[];
  imageFallbackRequests: string[];
  gifOriginalRequests: string[];
  gifPreviewRequests: string[];
  searchRequests: string[];
  listAttempts: number;
  maxConcurrentLists: number;
  releaseManifest: () => void;
  releaseCards: () => void;
  releaseRefresh: () => void;
};

function sourceFromQuery(value: string | null): string {
  return value || "x_list";
}

function cardImage(source: string): string {
  return `/e2e/card.svg?source=${encodeURIComponent(source)}`;
}

function posterRequestKey(raw: string): string | null {
  const url = new URL(raw);
  if (url.pathname.startsWith("/r/e2e/video-posters/")) return url.pathname;
  if (url.hostname === "example.com" && url.pathname === "/e2e-link-poster.jpg") {
    return "link-poster";
  }
  return null;
}

function makeItem(requestedSource: string) {
  const sourceType = requestedSource === "blog,podcast" ? "blog" : requestedSource;
  const base = {
    id: sourceType === "github" ? "github:acme/repo" : `${sourceType}:fixture-1`,
    source_type: sourceType,
    source_id: sourceType === "github" ? "acme/repo" : `${sourceType}-fixture-1`,
    source_ref: null,
    title: `Fixture ${requestedSource}`,
    content: `Fixture ${requestedSource} body`,
    content_translated: null,
    author: "E2E Author",
    handle: "e2e",
    url: "https://example.com/item",
    metrics: {},
    published_at: "2026-07-11T08:00:00.000Z",
    scraped_at: "2026-07-11 08:00:00",
    is_relevant: 1,
    is_hot: 0,
    matched_by: null,
    lang: "zh",
    extra: {},
    media: [{
      type: "image",
      url: cardImage(requestedSource),
      width: 800,
      height: 500,
    }],
  };

  if (sourceType === "blog") {
    return {
      ...base,
      extra: {
        title_zh: `Fixture ${requestedSource}`,
        ai_summary_zh: "Official news fixture summary",
        source_company: "E2E News",
        cover_image: cardImage(requestedSource),
        reading_minutes: 3,
      },
    };
  }
  if (sourceType === "product_hunt") {
    return {
      ...base,
      media: [{
        type: "image",
        role: "gallery",
        url: cardImage(requestedSource),
        width: 800,
        height: 450,
      }],
      metrics: { votes: 42, comments: 3 },
      extra: { launch_date_pt: "2026-07-11", daily_rank: 1, ai_summary: "PH fixture" },
    };
  }
  if (sourceType === "github") {
    return {
      ...base,
      metrics: { stars: 1234, forks: 12 },
      extra: {
        ai_summary: "GitHub fixture summary",
        ai_category: "tool",
        cover_url: cardImage(requestedSource),
        daily_rank: 1,
        trending_date_str: "2026-07-11",
      },
    };
  }
  if (sourceType === "hf_paper") {
    return {
      ...base,
      metrics: { upvotes: 10, num_comments: 2 },
      extra: {
        title_zh: `Fixture ${requestedSource}`,
        ai_summary_zh: "Paper fixture summary",
        arxiv_id: "2607.00001",
      },
    };
  }
  if (sourceType === "huodongxing") {
    return {
      ...base,
      source_id: "5859894940100",
      extra: {
        city: "北京",
        is_online: false,
        time_raw: "07/11 14:00",
        location_raw: "北京朝阳",
        og_image: cardImage(requestedSource),
      },
    };
  }
  if (sourceType === "clawhub") {
    return {
      ...base,
      metrics: { stars: 88, downloads: 900 },
      extra: { slug: "fixture-skill", latest_version: "1.0.0", category: "coding" },
    };
  }
  return base;
}

function makeGifPreviewItem(
  suffix = "animated",
  title = "Fixture Product Hunt GIF",
) {
  return {
    ...makeItem("product_hunt"),
    id: `product_hunt:${suffix}`,
    source_id: suffix,
    title,
    extra: {
      launch_date_pt: "2026-07-11",
      daily_rank: suffix === "animated" ? 1 : 2,
      ai_summary: `${title} summary`,
      ai_category: "ai_image_gen",
      topics: ["design-tools"],
    },
    media: [
      {
        type: "image",
        role: "gallery",
        url: `/r/e2e/ph/large-animation-${suffix}.gif`,
        width: 800,
        height: 450,
        card_preview_status: "ready",
        card_variants: [
          {
            url: `/r/e2e/ph/card/large-animation-${suffix}-w400.webp`,
            width: 400,
            height: 225,
            format: "webp",
          },
        ],
      },
      {
        type: "image",
        role: "gallery",
        url: "/e2e/ph/static-neighbor.svg",
        width: 800,
        height: 450,
      },
      {
        type: "image",
        role: "gallery",
        url: "/r/e2e/ph/large-animation-unavailable.gif",
        width: 800,
        height: 450,
        card_preview_status: "unavailable",
      },
    ],
  };
}

function makeVideoPosterItems() {
  const base = makeItem("x_list");
  const item = (suffix: string, overrides: Record<string, unknown> = {}) => ({
    ...base,
    id: `x_list:poster-${suffix}`,
    source_id: `poster-${suffix}`,
    title: `Poster fixture ${suffix}`,
    content: `Poster fixture ${suffix} body`,
    media: [],
    extra: {},
    ...overrides,
  });
  const videoMedia = (key: string) => [{
    type: "video",
    url: `/e2e/video/${key}.mp4`,
    poster: `https://pbs.twimg.com/media/e2e-${key}-original.jpg`,
    poster_variants: [
      { url: `/r/e2e/video-posters/${key}-800.webp`, width: 800, height: 450, format: "webp" },
      { url: `/r/e2e/video-posters/${key}-400.webp`, width: 400, height: 225, format: "webp" },
    ],
    width: 800,
    height: 450,
  }];

  return [
    item("eager", { media: videoMedia("eager") }),
    ...Array.from({ length: 6 }, (_, index) => item(`filler-${index}`, {
      content: `Filler ${index} ` + "keeps the lazy video below the feed viewport. ".repeat(16),
    })),
    item("lazy", { media: videoMedia("lazy") }),
    item("link", {
      extra: {
        link_card: {
          url: "https://example.com/e2e-link",
          display_url: "example.com",
          title: "Lazy link video",
          image_url: "https://example.com/e2e-link-poster.jpg",
          video_url: "/e2e/video/link.mp4",
        },
      },
    }),
  ];
}

function makeImageFallbackItem() {
  return {
    ...makeItem("x_list"),
    id: "x_list:image-fallback",
    source_id: "image-fallback",
    title: "Image fallback fixture",
    content: "Image fallback fixture body",
    media: [{
      type: "image",
      url: "/r/e2e/card-original.svg",
      card_variants: [{
        url: "/r/e2e/card-variants/broken.webp",
        width: 400,
        height: 250,
        format: "webp",
      }],
      width: 800,
      height: 500,
      alt: "image fallback fixture",
    }],
  };
}

function makeGithubDetail() {
  return {
    ...makeItem("github"),
    id: "github:acme/repo",
    source_id: "acme/repo",
    extra: {
      ai_summary: "Full GitHub analysis fixture",
      ai_category: "tool",
      default_branch: "main",
      readme_excerpt: "# FULL README E2E CONTRACT\n\nDeep drawer body is preserved.",
      readme_translated: "# 完整 README E2E CONTRACT",
      recent_commits: [{ sha: "abc123", message: "Full detail commit" }],
      cover_status: "none",
    },
  };
}

function normalizeListUrl(raw: string): string | null {
  const url = new URL(raw);
  if (url.pathname !== "/api/items") return null;
  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a.localeCompare(b) || av.localeCompare(bv),
  );
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state: MockState = {
    listRequests: [],
    fontRequests: [],
    detailRequests: [],
    posterRequests: [],
    imageFallbackRequests: [],
    gifOriginalRequests: [],
    gifPreviewRequests: [],
    searchRequests: [],
    listAttempts: 0,
    maxConcurrentLists: 0,
    releaseManifest: () => {},
    releaseCards: () => {},
    releaseRefresh: () => {},
  };
  let concurrentLists = 0;
  let manifestReleased = !options.pendingManifest;
  let resolveManifest: (() => void) | null = null;
  const manifestGate = new Promise<void>((resolve) => {
    resolveManifest = resolve;
    if (manifestReleased) resolve();
  });
  state.releaseManifest = () => {
    manifestReleased = true;
    resolveManifest?.();
  };
  let cardsReleased = !options.pendingCard;
  let resolveCards: (() => void) | null = null;
  const cardGate = new Promise<void>((resolve) => {
    resolveCards = resolve;
    if (cardsReleased) resolve();
  });
  state.releaseCards = () => {
    cardsReleased = true;
    resolveCards?.();
  };
  let refreshReleased = !options.pendingRefresh;
  let resolveRefresh: (() => void) | null = null;
  const refreshGate = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
    if (refreshReleased) resolve();
  });
  state.releaseRefresh = () => {
    refreshReleased = true;
    resolveRefresh?.();
  };

  await page.addInitScript(({ saveData, disableVideoAutoplay }) => {
    localStorage.clear();
    sessionStorage.clear();
    if (disableVideoAutoplay) {
      localStorage.setItem("ai-feeds-video-prefs", JSON.stringify({
        state: { prefs: { autoplay: false, muted: true } },
        version: 0,
      }));
    }
    if (saveData) {
      const connection = {
        saveData: true,
        effectiveType: "4g",
        addEventListener() {},
        removeEventListener() {},
      };
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: connection,
      });
    }
  }, {
    saveData: Boolean(options.saveData),
    disableVideoAutoplay: Boolean(options.videoPosterFixture),
  });

  page.on("request", (request) => {
    const normalized = normalizeListUrl(request.url());
    if (request.method() === "GET" && normalized) state.listRequests.push(normalized);
    const url = new URL(request.url());
    if (url.hostname === "fonts.ai-feeds.com" || /\.(?:woff2?|ttf)(?:$|\?)/i.test(url.pathname)) {
      state.fontRequests.push(request.url());
    }
    if (request.method() === "GET" && url.pathname.startsWith("/api/items/")) {
      state.detailRequests.push(url.pathname);
    }
    const posterKey = posterRequestKey(request.url());
    if (request.method() === "GET" && posterKey) state.posterRequests.push(posterKey);
    if (
      request.method() === "GET"
      && (url.pathname === "/r/e2e/card-variants/broken.webp" || url.pathname === "/r/e2e/card-original.svg")
    ) {
      state.imageFallbackRequests.push(url.pathname);
    }
    if (
      request.method() === "GET"
      && /^\/r\/e2e\/ph\/large-animation-[^/]+\.gif$/.test(url.pathname)
    ) {
      state.gifOriginalRequests.push(url.pathname);
    }
    if (
      request.method() === "GET"
      && /^\/r\/e2e\/ph\/card\/large-animation-[^/]+-w400\.webp$/.test(url.pathname)
    ) {
      state.gifPreviewRequests.push(url.pathname);
    }
    if (request.method() === "GET" && url.pathname === "/api/search") {
      state.searchRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.hostname === "fonts.ai-feeds.com") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    if (url.pathname === "/e2e/card.svg") {
      await cardGate;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#d4d4d4"/></svg>',
      });
      return;
    }
    if (url.pathname === "/e2e/ph/static-neighbor.svg") {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#b8d5c7"/></svg>',
      });
      return;
    }
    if (url.pathname === "/r/e2e/card-variants/broken.webp") {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "broken variant" });
      return;
    }
    if (url.pathname === "/r/e2e/card-original.svg") {
      if (options.imageFallbackFixture === "fallback-fails") {
        await route.fulfill({ status: 503, contentType: "text/plain", body: "broken original" });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#b8d5c7"/></svg>',
        });
      }
      return;
    }
    if (/^\/r\/e2e\/ph\/card\/large-animation-[^/]+-w400\.webp$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225"><rect width="400" height="225" fill="#c4b5fd"/></svg>',
      });
      return;
    }
    if (url.pathname === "/r/e2e/ph/large-animation.gif") {
      await route.fulfill({
        status: 200,
        contentType: "image/gif",
        body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
      });
      return;
    }
    if (posterRequestKey(request.url())) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225"><rect width="400" height="225" fill="#777"/></svg>',
      });
      return;
    }
    if (url.pathname.startsWith("/e2e/video/")) {
      await route.fulfill({ status: 204, contentType: "video/mp4", body: "" });
      return;
    }
    if (url.pathname === "/api/feed-manifest") {
      if (options.failManifest) {
        await fulfillJson(route, { error: "manifest unavailable" }, 503);
        return;
      }
      await manifestGate;
      await fulfillJson(route, {
        live_source_types: [...LIVE_SOURCES],
        labels: { x_list: "动态" },
        generated_at: "2026-07-11T08:00:00.000Z",
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/items") {
      state.listAttempts++;
      concurrentLists++;
      state.maxConcurrentLists = Math.max(state.maxConcurrentLists, concurrentLists);
      try {
        if (options.pendingRefresh && state.listAttempts > 1) await refreshGate;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (options.failFirstList && state.listAttempts === 1) {
          await fulfillJson(route, { error: "temporary" }, 503);
          return;
        }
        const requestedSource = sourceFromQuery(url.searchParams.get("source_type"));
        await fulfillJson(route, {
          items: options.videoPosterFixture && requestedSource === "x_list"
            ? makeVideoPosterItems()
            : options.imageFallbackFixture && requestedSource === "x_list"
              ? [makeImageFallbackItem()]
              : options.gifPreviewFixture && requestedSource === "product_hunt"
                ? [
                    makeGifPreviewItem(),
                    makeGifPreviewItem("animated-related", "Fixture Related Product Hunt GIF"),
                  ]
            : [makeItem(requestedSource)],
          next_cursor: null,
          has_more: false,
          query_time_ms: 12,
        });
      } finally {
        concurrentLists--;
      }
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/search") {
      await fulfillJson(route, {
        mode: "grouped",
        groups: [{ source_type: "github", total: 1, items: [makeItem("github")] }],
        query_time_ms: 4,
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.startsWith("/api/items/")) {
      const requestedGifItem = url.pathname.includes("animated-related")
        ? makeGifPreviewItem("animated-related", "Fixture Related Product Hunt GIF")
        : makeGifPreviewItem();
      await fulfillJson(route, {
        item: options.gifPreviewFixture && url.pathname.includes("product_hunt")
          ? requestedGifItem
          : makeGithubDetail(),
        siblings: [],
        siblings_has_more: false,
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.includes("/refresh")) {
      await fulfillJson(route, { refreshed: false, source_type: "github", reason: "throttled" });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await fulfillJson(route, { user: null });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await fulfillJson(route, {});
      return;
    }
    await route.continue();
  });
  return state;
}

function initialListBudget(projectName: string): number {
  if (projectName.startsWith("desktop")) return 3;
  if (projectName.startsWith("tablet")) return 2;
  return 1;
}

function expectedDeviceScaleFactor(projectName: string): number {
  if (projectName.startsWith("desktop")) return 1;
  if (projectName.startsWith("iphone")) return 3;
  return 2;
}

async function swipeToNextChannel(page: Page, projectName: string) {
  const box = await page.locator("main").boundingBox();
  if (!box) throw new Error("main feed is not visible");
  const y = Math.min(box.y + 280, 600);
  const fromX = box.x + box.width * 0.82;
  const toX = box.x + box.width * 0.18;
  if (projectName.includes("webkit")) {
    await page.evaluate(({ startX, endX, touchY }) => {
      const target = document.querySelector("main");
      if (!(target instanceof HTMLElement)) throw new Error("main feed is not visible");
      // Playwright WebKit exposes TouchEvent but its Touch constructor is
      // constructor. Shadow the readonly TouchList properties with the minimal
      // stable shape consumed by the app's native touch listeners.
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
        const event = new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
        });
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
  for (let step = 1; step <= 6; step++) {
    const x = fromX + ((toX - fromX) * step) / 6;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("first usable feed obeys the cross-device request and media budgets", async ({ page }, testInfo) => {
  const state = await installMocks(page, { pendingManifest: true });
  const budget = initialListBudget(testInfo.project.name);

  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();
  await expect.poll(() => state.listRequests.length).toBe(budget);

  expect(new Set(state.listRequests).size).toBe(state.listRequests.length);
  expect(state.fontRequests).toHaveLength(0);
  expect(await page.locator('img[fetchpriority="high"]').count()).toBeLessThanOrEqual(1);

  if (budget > 1) {
    const shells = page.locator("[data-deferred-feed-shell]");
    expect(await shells.count()).toBeGreaterThan(0);
    expect(await page.locator("[data-deferred-feed-shell] img, [data-deferred-feed-shell] video").count()).toBe(0);
  }

  // The card is already usable while manifest is still deliberately pending.
  state.releaseManifest();

  if (testInfo.project.name.includes("iphone") || testInfo.project.name.includes("android")) {
    await expect(page.locator('[data-chip-key="x_list"]')).toBeVisible();
    await swipeToNextChannel(page, testInfo.project.name);
    await expect(page.getByText("Fixture blog,podcast", { exact: false }).first()).toBeVisible();
  } else {
    await page.evaluate(() => window.scrollTo(0, Math.max(900, document.body.scrollHeight * 0.55)));
    await expect.poll(() => state.listRequests.length).toBeGreaterThan(budget);
  }
});

test("PageSpeed contrast and nested-interactive rules pass on a representative feed", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-"), "remote staging repeats this gate on all five devices");
  await installMocks(page, { videoPosterFixture: true });
  await page.goto("/");
  await expect(page.getByText("Poster fixture eager", { exact: false }).first()).toBeVisible();

  const result = await new AxeBuilder({ page })
    .withRules(["color-contrast", "nested-interactive"])
    .analyze();
  const safeSummary = result.violations.map((violation) => ({
    id: violation.id,
    nodeCount: violation.nodes.length,
  }));
  expect(safeSummary).toEqual([]);
});

test("card media reserves its geometry across DPR 1/2/3", async ({ page }, testInfo) => {
  const state = await installMocks(page, { pendingCard: true });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();

  expect(await page.evaluate(() => window.devicePixelRatio))
    .toBe(expectedDeviceScaleFactor(testInfo.project.name));
  const image = page.locator('[data-feed-source="x_list"] img').first();
  await expect(image).toBeVisible();
  const before = await image.boundingBox();
  expect(before).not.toBeNull();
  // X media is intentionally inset beside the author rail, so its CSS width
  // is smaller than the outer 360–400px card on every responsive project.
  expect(before!.width).toBeGreaterThanOrEqual(240);
  expect(before!.width).toBeLessThanOrEqual(440);

  state.releaseCards();
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const after = await image.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath(`card-dpr-${expectedDeviceScaleFactor(testInfo.project.name)}.png`),
    fullPage: true,
  });
});

test("save-data blocks deferred fonts and background channel prefetch", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real iOS-engine project is sufficient");
  const state = await installMocks(page, { saveData: true });
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new Event("aifeeds:lcp-settled"));
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  expect(state.listRequests).toHaveLength(1);
  expect(state.fontRequests).toHaveLength(0);
});

test("Product Hunt GIF stays static until explicit playback intent", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real mobile engine is sufficient");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await installMocks(page, { gifPreviewFixture: true, saveData: true });
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();

  await page.locator('[data-chip-key="product_hunt"]').click();
  await expect(page.getByText("Fixture Product Hunt GIF", { exact: true }).first()).toBeVisible();
  await expect.poll(() => state.gifPreviewRequests.length).toBeGreaterThan(0);
  expect(state.gifOriginalRequests).toHaveLength(0);

  await page.getByText("Fixture Product Hunt GIF", { exact: true }).first().click();
  await expect(page.getByText("截图与视频", { exact: true })).toBeVisible();
  expect(state.gifOriginalRequests).toHaveLength(0);

  await page.locator('img[src*="large-animation-animated-w400.webp"]').last().click();
  await expect(page.getByRole("dialog", { name: "媒体预览" })).toBeVisible();
  expect(state.gifOriginalRequests).toHaveLength(0);

  await page.getByRole("button", { name: "播放动图" }).last().click();
  await expect.poll(() => state.gifOriginalRequests.length).toBe(1);
});

test("Product Hunt GIF playback intent never leaks into a related item", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real mobile engine is sufficient");
  const state = await installMocks(page, { gifPreviewFixture: true, saveData: true });
  await page.goto("/");
  await page.locator('[data-chip-key="product_hunt"]').click();
  await page.getByText("Fixture Product Hunt GIF", { exact: true }).first().click();
  await expect(page.getByText("截图与视频", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "播放动图" }).first().click();
  await expect.poll(() => state.gifOriginalRequests).toEqual([
    "/r/e2e/ph/large-animation-animated.gif",
  ]);

  await page.getByRole("button", { name: "Fixture Related Product Hunt GIF" }).click();
  await expect(
    page.getByText("Fixture Related Product Hunt GIF", { exact: true }).first(),
  ).toBeVisible();
  await page.waitForTimeout(200);
  expect(state.gifOriginalRequests).toEqual([
    "/r/e2e/ph/large-animation-animated.gif",
  ]);
});

test("preview-less Product Hunt GIF stays gated when reached through Lightbox navigation", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real mobile engine is sufficient");
  const state = await installMocks(page, { gifPreviewFixture: true, saveData: true });
  await page.goto("/");
  await page.locator('[data-chip-key="product_hunt"]').click();
  await page.getByText("Fixture Product Hunt GIF", { exact: true }).first().click();
  await expect(page.getByText("截图与视频", { exact: true })).toBeVisible();

  await page.locator('img[src*="/e2e/ph/static-neighbor.svg"]').first().click();
  await expect(page.getByRole("dialog", { name: "媒体预览" })).toBeVisible();
  await page.getByRole("button", { name: "下一张" }).click();
  await expect(page.getByText("动图预览暂不可用", { exact: true }).last()).toBeVisible();
  expect(state.gifOriginalRequests).not.toContain(
    "/r/e2e/ph/large-animation-unavailable.gif",
  );

  await page.getByRole("button", { name: "播放动图" }).last().click();
  await expect.poll(() => state.gifOriginalRequests).toContain(
    "/r/e2e/ph/large-animation-unavailable.gif",
  );
});

test("mobile modal locks and restores the real page scroller", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real iOS-engine project is sufficient");
  await installMocks(page);
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录 / 注册" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.locator("#root").evaluate((node) => (
    (node as HTMLElement).style.overflow
  ))).toBe("hidden");
  await expect.poll(() => page.locator("body").evaluate((node) => (
    (node as HTMLElement).style.overflow
  ))).toBe("hidden");

  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => window.matchMedia("(max-width: 767px)").matches)).toBe(false);
  await expect(page.locator("#root")).toHaveCSS("overflow", "hidden");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.locator("#root").evaluate((node) => (
    (node as HTMLElement).style.overflow
  ))).toBe("");
  await expect.poll(() => page.locator("body").evaluate((node) => (
    (node as HTMLElement).style.overflow
  ))).toBe("");
});

test("a cancelled vertical pull never commits a refresh", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real iOS-engine project is sufficient");
  const state = await installMocks(page, { saveData: true });
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();
  const attemptsBefore = state.listAttempts;

  const opacityBeforeCancel = await page.evaluate(() => {
    const target = document.querySelector('[data-feed-source="x_list"] .feed-body');
    const indicator = document.querySelector('[data-feed-source="x_list"] .motion-pull-indicator');
    const root = document.getElementById("root");
    if (!(target instanceof HTMLElement) || !(indicator instanceof HTMLElement) || !root) {
      throw new Error("pull-to-refresh fixture is not visible");
    }
    root.scrollTop = 0;
    const makeTouch = (y: number) => ({
      identifier: 77,
      target,
      clientX: 180,
      clientY: y,
      pageX: 180,
      pageY: y,
      screenX: 180,
      screenY: y,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    });
    const dispatch = (type: "touchstart" | "touchmove" | "touchcancel", y: number) => {
      const changed = makeTouch(y);
      const active = type === "touchcancel" ? [] : [changed];
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active },
        targetTouches: { value: active },
        changedTouches: { value: [changed] },
      });
      target.dispatchEvent(event);
    };
    dispatch("touchstart", 100);
    dispatch("touchmove", 300);
    const opacity = indicator.style.opacity;
    dispatch("touchcancel", 300);
    return opacity;
  });

  expect(opacityBeforeCancel).toBe("1");
  await expect(page.locator('[data-feed-source="x_list"] .motion-pull-indicator'))
    .toHaveCSS("opacity", "0");
  await page.waitForTimeout(150);
  expect(state.listAttempts).toBe(attemptsBefore);
});

test("a committed pull stays visibly refreshing until its request settles", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("iphone-webkit"), "one real iOS-engine project is sufficient");
  const state = await installMocks(page, { saveData: true, pendingRefresh: true });
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();
  const attemptsBefore = state.listAttempts;

  await page.evaluate(() => {
    const target = document.querySelector('[data-feed-source="x_list"] .feed-body');
    const root = document.getElementById("root");
    if (!(target instanceof HTMLElement) || !root) throw new Error("pull-to-refresh fixture is not visible");
    root.scrollTop = 0;
    const makeTouch = (y: number) => ({
      identifier: 78,
      target,
      clientX: 180,
      clientY: y,
      pageX: 180,
      pageY: y,
      screenX: 180,
      screenY: y,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    });
    const dispatch = (type: "touchstart" | "touchmove" | "touchend", y: number) => {
      const changed = makeTouch(y);
      const active = type === "touchend" ? [] : [changed];
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active },
        targetTouches: { value: active },
        changedTouches: { value: [changed] },
      });
      target.dispatchEvent(event);
    };
    dispatch("touchstart", 100);
    dispatch("touchmove", 350);
    dispatch("touchend", 350);
  });

  await expect.poll(() => state.listAttempts).toBe(attemptsBefore + 1);
  const indicator = page.locator('[data-feed-source="x_list"] .motion-pull-indicator');
  await expect(indicator).toContainText("正在刷新");
  await expect(indicator).toHaveCSS("opacity", "1");
  await page.waitForTimeout(200);
  await expect(indicator).toContainText("正在刷新");
  await expect(indicator).toHaveCSS("opacity", "1");

  state.releaseRefresh();
  await expect(indicator).toHaveCSS("opacity", "0");
});

test("pull-to-refresh listeners follow the live responsive breakpoint", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-chromium"), "one responsive Chromium project is sufficient");
  const state = await installMocks(page, { saveData: true });
  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();

  const dispatchPull = () => page.evaluate(() => {
    const target = document.querySelector('[data-feed-source="x_list"] .feed-body');
    const root = document.getElementById("root");
    if (!(target instanceof HTMLElement) || !root) throw new Error("pull-to-refresh fixture is not visible");
    root.scrollTop = 0;
    const makeTouch = (y: number) => ({
      identifier: 79,
      target,
      clientX: 180,
      clientY: y,
      pageX: 180,
      pageY: y,
      screenX: 180,
      screenY: y,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    });
    const dispatch = (type: "touchstart" | "touchmove" | "touchend", y: number) => {
      const changed = makeTouch(y);
      const active = type === "touchend" ? [] : [changed];
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active },
        targetTouches: { value: active },
        changedTouches: { value: [changed] },
      });
      target.dispatchEvent(event);
    };
    dispatch("touchstart", 100);
    dispatch("touchmove", 350);
    dispatch("touchend", 350);
  });

  const desktopAttempts = state.listAttempts;
  await dispatchPull();
  await page.waitForTimeout(100);
  expect(state.listAttempts).toBe(desktopAttempts);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => window.matchMedia("(max-width: 767px)").matches)).toBe(true);
  await dispatchPull();
  await expect.poll(() => state.listAttempts).toBe(desktopAttempts + 1);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => window.matchMedia("(max-width: 767px)").matches)).toBe(false);
  await expect(page.locator('[data-feed-source="x_list"] .motion-pull-indicator')).toHaveCSS("opacity", "0");
  const restoredDesktopAttempts = state.listAttempts;
  await dispatchPull();
  await page.waitForTimeout(100);
  expect(state.listAttempts).toBe(restoredDesktopAttempts);
});

test("slow transient failures recover without concurrent duplicate list reads", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("android"), "one mobile recovery project is sufficient");
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 120,
    downloadThroughput: 100 * 1024,
    uploadThroughput: 50 * 1024,
    connectionType: "cellular3g",
  });
  const state = await installMocks(page, { failManifest: true, failFirstList: true });

  await page.goto("/");
  await expect(page.getByText("Fixture x_list", { exact: false }).first()).toBeVisible();
  expect(state.listAttempts).toBeGreaterThanOrEqual(2);
  expect(state.maxConcurrentLists).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("slow-recovery.png"), fullPage: true });
});

test("drawer upgrades compact GitHub data to the full detail contract", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "detail contract needs one representative viewport");
  const state = await installMocks(page);
  await page.goto("/g/acme/repo");

  await expect(page.getByText("FULL README E2E CONTRACT", { exact: false }).first()).toBeVisible();
  expect(state.detailRequests).toEqual(["/api/items/github%3Aacme%2Frepo"]);
});

test("search-provider handoff keeps one in-flight GitHub detail GET", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "provider handoff needs one representative viewport");
  const state = await installMocks(page);

  await page.goto("/search?q=acme");
  const result = page.getByText("Fixture github", { exact: false }).first();
  await expect(result).toBeVisible();
  await result.click();

  await expect(page).toHaveURL(/\/g\/acme\/repo$/);
  await expect(page.getByText("FULL README E2E CONTRACT", { exact: false }).first()).toBeVisible();
  expect(state.searchRequests).toEqual(["/api/search?q=acme"]);
  expect(state.detailRequests).toEqual(["/api/items/github%3Aacme%2Frepo"]);
});

test("a failed stored WebP variant falls back to the original card image", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "one browser engine verifies picture fallback");
  const state = await installMocks(page, { imageFallbackFixture: "fallback-succeeds" });

  await page.goto("/");
  const image = page.locator('img[alt="image fallback fixture"]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect.poll(() => state.imageFallbackRequests).toEqual([
    "/r/e2e/card-variants/broken.webp",
    "/r/e2e/card-original.svg",
  ]);
});

test("a card image disappears only after both its WebP variant and original fail", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "one browser engine verifies terminal fallback");
  const state = await installMocks(page, { imageFallbackFixture: "fallback-fails" });

  await page.goto("/");
  await expect(page.getByText("Image fallback fixture", { exact: false }).first()).toBeVisible();
  await expect(page.locator('img[alt="image fallback fixture"]')).toHaveCount(0);
  await expect.poll(() => state.imageFallbackRequests).toEqual([
    "/r/e2e/card-variants/broken.webp",
    "/r/e2e/card-original.svg",
  ]);
});

test("lazy video posters wait for their feed viewport or explicit play intent", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "one independently scrolling feed is sufficient");
  const state = await installMocks(page, { videoPosterFixture: true });

  await page.goto("/");
  await expect(page.getByText("Poster fixture eager", { exact: false }).first()).toBeVisible();

  const feedBody = page.locator(".feed-body").first();
  const eagerVideo = feedBody.locator('video[src*="/e2e/video/eager.mp4"]');
  const lazyVideo = feedBody.locator('video[src*="/e2e/video/lazy.mp4"]');
  const linkVideo = feedBody.locator('video[src*="/e2e/video/link.mp4"]');
  await expect(eagerVideo).toHaveAttribute("poster", /\/r\/e2e\/video-posters\/eager-400\.webp$/);
  await expect(lazyVideo).not.toHaveAttribute("poster", /.+/);
  await expect(linkVideo).not.toHaveAttribute("poster", /.+/);
  await expect.poll(() => state.posterRequests).toEqual([
    "/r/e2e/video-posters/eager-400.webp",
  ]);

  // Pointer/focus preparation is allowed to request an otherwise offscreen
  // poster, but must not release a sibling video's poster budget.
  await linkVideo.evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await expect(linkVideo).toHaveAttribute("poster", "https://example.com/e2e-link-poster.jpg");
  await expect.poll(() => state.posterRequests).toEqual([
    "/r/e2e/video-posters/eager-400.webp",
    "link-poster",
  ]);
  await expect(lazyVideo).not.toHaveAttribute("poster", /.+/);

  await feedBody.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(lazyVideo).toHaveAttribute("poster", /\/r\/e2e\/video-posters\/lazy-400\.webp$/);
  await expect.poll(() => [...state.posterRequests].sort()).toEqual([
    "/r/e2e/video-posters/eager-400.webp",
    "/r/e2e/video-posters/lazy-400.webp",
    "link-poster",
  ]);
  expect(state.posterRequests.some((request) => request.includes("-800.webp"))).toBe(false);
});
