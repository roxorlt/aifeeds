import { expect, test, type Page } from "@playwright/test";

const BASE_URL = "https://localhost:4187";
const INITIAL_IDS = [
  "x_list:fixture-01",
  "blog:fixture-02",
  "podcast:fixture-03",
  "github:fixture-owner/repo-04",
  "product_hunt:fixture-product-05:2026-07-17",
  "hf_paper:2607.00006",
  "huodongxing:5859894940007",
  "clawhub:fixture-08",
  "youtube:fixture-09",
  "x_list:fixture-10",
  "blog:fixture-11",
  "podcast:fixture-12",
] as const;

test.skip(process.env.WATERFALL_E2E !== "1", "production waterfall fixture is an explicit local-only gate");

async function setWaterfallCookie(page: Page) {
  await page.context().addCookies([{
    name: "aifeeds_view",
    value: "waterfall",
    url: BASE_URL,
    sameSite: "Lax",
  }]);
}

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForTimeout(250);
}

test("SSR HTML has at least 12 cards before JavaScript", async ({ browser }, testInfo) => {
  const configuredViewport = testInfo.project.use.viewport;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: configuredViewport && typeof configuredViewport === "object"
      ? configuredViewport
      : { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${BASE_URL}/?view=waterfall`, { waitUntil: "domcontentloaded" });
    expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
    await expect(page.locator(".waterfall-grid article")).toHaveCount(12);
    expect(await page.locator("#aifeeds-initial-data").textContent()).toContain('"view_mode":"waterfall"');
    await expect(page.locator(".waterfall-main")).toHaveCSS("opacity", "1");
  } finally {
    await context.close();
  }
});

test("hydration has no console errors and meets responsive CLS budgets", async ({ page }, testInfo) => {
  await setWaterfallCookie(page);
  const errors: string[] = [];
  const scriptRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.resourceType() === "script") scriptRequests.push(request.url());
  });
  await page.addInitScript(() => {
    globalThis.__waterfallCls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (!shift.hadRecentInput) {
            globalThis.__waterfallCls = (globalThis.__waterfallCls ?? 0) + (shift.value ?? 0);
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      globalThis.__waterfallCls = 0;
    }
  });

  const response = await page.goto("/?view=waterfall", { waitUntil: "load" });
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
  await expect(page.locator(".waterfall-card")).toHaveCount(12);
  await expect(page.locator(".waterfall-intro")).toHaveCount(0);
  await expect(page.locator(".waterfall-main [role=tablist], .waterfall-main .chips")).toHaveCount(0);
  await settleLayout(page);

  expect(errors).toEqual([]);
  expect(scriptRequests.some((url) => /\/assets\/waterfall-[^/]+\.js$/u.test(url))).toBe(true);
  expect(
    scriptRequests.some((url) => /\/assets\/main-[^/]+\.js$/u.test(url)),
    "waterfall entry never requests the classic entry",
  ).toBe(false);
  await expect(page.locator(".waterfall-card").first()).toHaveAttribute("data-item-id", INITIAL_IDS[0]);
  expect(await page.locator(".waterfall-card").evaluateAll((cards) => (
    cards.map((card) => card.getAttribute("data-item-id"))
  ))).toEqual([...INITIAL_IDS]);

  const width = testInfo.project.use.viewport?.width ?? 1440;
  const columnCount = await page.locator(".waterfall-grid").evaluate((grid) => {
    const style = getComputedStyle(grid);
    return style.display === "block"
      ? 1
      : style.gridTemplateColumns.split(" ").filter(Boolean).length;
  });
  expect(columnCount).toBe(
    width >= 1600 ? 6
      : width >= 1280 ? 5
        : width >= 1024 ? 4
          : width >= 768 ? 3
            : 2,
  );
  await expect(page.locator(".waterfall-card").first()).toHaveCSS("border-radius", "12px");

  const layout = await page.evaluate(() => ({
    cls: globalThis.__waterfallCls ?? 0,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const mediaSlack = await page.locator(".waterfall-card:has(.waterfall-card__image)").first().evaluate((card) => {
    const style = getComputedStyle(card);
    const span = Number.parseInt(style.getPropertyValue("--waterfall-row-span"), 10);
    const root = getComputedStyle(document.documentElement);
    const row = Number.parseFloat(root.getPropertyValue("--waterfall-row"));
    const gap = Number.parseFloat(root.getPropertyValue("--waterfall-gap"));
    const allocated = span * row + Math.max(0, span - 1) * gap;
    return allocated - card.getBoundingClientRect().height;
  });
  const maximumVisualGap = await page.locator(".waterfall-grid").evaluate((grid) => {
    const columns = new Map<number, DOMRect[]>();
    for (const card of grid.querySelectorAll(".waterfall-card")) {
      const rect = card.getBoundingClientRect();
      const column = columns.get(Math.round(rect.left)) ?? [];
      column.push(rect);
      columns.set(Math.round(rect.left), column);
    }
    let maximum = 0;
    for (const cards of columns.values()) {
      cards.sort((left, right) => left.top - right.top);
      for (let index = 1; index < cards.length; index += 1) {
        maximum = Math.max(
          maximum,
          cards[index].top - cards[index - 1].bottom,
        );
      }
    }
    return maximum;
  });
  expect(await page.locator(".waterfall-card__image").first().evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
  })).toBe(true);
  const mediaPolicies = await page.locator(".waterfall-card__image").evaluateAll((images) => (
    images.map((image) => ({
      loading: (image as HTMLImageElement).loading,
      fetchPriority: (image as HTMLImageElement).fetchPriority,
      srcSet: (image as HTMLImageElement).srcset,
    }))
  ));
  expect(mediaPolicies[0]).toMatchObject({
    loading: "eager",
    fetchPriority: "high",
  });
  if (mediaPolicies[1]) {
    expect(mediaPolicies[1]).toMatchObject({
      loading: "eager",
      fetchPriority: "auto",
    });
  }
  expect(mediaPolicies.slice(2).every((policy) => (
    policy.loading === "lazy" && policy.fetchPriority === "auto"
  ))).toBe(true);
  expect(mediaPolicies.some((policy) => policy.srcSet.includes("400w"))).toBe(true);
  expect(await page.locator('link[rel="preconnect"]').evaluateAll((links, expectedOrigin) => (
    links.some((link) => new URL((link as HTMLLinkElement).href).origin === expectedOrigin)
  ), BASE_URL)).toBe(true);
  expect(layout.cls).toBeLessThanOrEqual(0.1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(mediaSlack).toBeLessThan(9);
  expect(maximumVisualGap).toBeLessThan(17);
});

test("mobile app bar follows upward and downward scroll while desktop stays sticky", async ({ page }) => {
  await setWaterfallCookie(page);
  await page.goto("/?view=waterfall", { waitUntil: "load" });
  await settleLayout(page);
  const width = page.viewportSize()?.width ?? 1440;
  const readHeader = () => page.locator(".waterfall-appbar").evaluate((header) => {
    const style = getComputedStyle(header);
    return { transform: style.transform, opacity: Number.parseFloat(style.opacity) };
  });

  if (width >= 768) {
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(50);
    const header = await readHeader();
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(header.transform);
    expect(header.opacity).toBe(1);
    return;
  }

  const setRootScroll = async (top: number) => {
    await page.locator("#root").evaluate((root, value) => {
      root.scrollTop = value;
    }, top);
    await page.evaluate(() => new Promise<void>((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )));
  };
  await setRootScroll(160);
  let header = await readHeader();
  expect(header.opacity).toBeLessThanOrEqual(0.01);
  expect(header.transform).not.toBe("none");

  await setRootScroll(133);
  header = await readHeader();
  expect(header.opacity).toBeGreaterThan(0.45);
  expect(header.opacity).toBeLessThan(0.55);

  await setRootScroll(0);
  expect(await readHeader()).toEqual({ transform: "matrix(1, 0, 0, 1, 0, 0)", opacity: 1 });
});

test("a controlled service worker cannot reset a persisted waterfall preference", async ({ page }) => {
  await page.goto("/?view=classic", { waitUntil: "load" });
  const registration = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      return { ready: false, secure: globalThis.isSecureContext, error: "unsupported" };
    }
    try {
      await navigator.serviceWorker.register("/sw.js");
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => window.setTimeout(
          () => reject(new Error("service worker ready timeout")),
          5_000,
        )),
      ]);
      return { ready: true, secure: globalThis.isSecureContext, error: null };
    } catch (error) {
      return {
        ready: false,
        secure: globalThis.isSecureContext,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  });
  expect(registration).toEqual({ ready: true, secure: true, error: null });
  await page.goto("/?view=waterfall", { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-home-view", "waterfall");

  const coldPage = await page.context().newPage();
  try {
    const response = await coldPage.goto("/", { waitUntil: "load" });
    expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
    await expect(coldPage.locator("html")).toHaveAttribute("data-home-view", "waterfall");

    const deepLinkResponse = await coldPage.goto("/t/fixture-01", { waitUntil: "load" });
    expect(deepLinkResponse?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
    await expect(coldPage.locator("html")).toHaveAttribute("data-home-view", "waterfall");
  } finally {
    await coldPage.close();
  }
});

test("a failed cover collapses and the grid returns to compact spacing", async ({ page }) => {
  await setWaterfallCookie(page);
  await page.route("**/r/waterfall-fixture-square*.webp", (route) => route.abort());
  await page.goto("/?view=waterfall", { waitUntil: "load" });
  await settleLayout(page);

  await expect(page.locator(".waterfall-card__image")).toHaveCount(0);
  const maximumVisualGap = await page.locator(".waterfall-grid").evaluate((grid) => {
    const columns = new Map<number, DOMRect[]>();
    for (const card of grid.querySelectorAll(".waterfall-card")) {
      const rect = card.getBoundingClientRect();
      const column = columns.get(Math.round(rect.left)) ?? [];
      column.push(rect);
      columns.set(Math.round(rect.left), column);
    }
    let maximum = 0;
    for (const cards of columns.values()) {
      cards.sort((left, right) => left.top - right.top);
      for (let index = 1; index < cards.length; index += 1) {
        maximum = Math.max(maximum, cards[index].top - cards[index - 1].bottom);
      }
    }
    return maximum;
  });
  expect(maximumVisualGap).toBeLessThan(17);
});

test("classic entry never requests the waterfall entry", async ({ page }) => {
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scriptRequests.push(request.url());
  });
  const response = await page.goto("/?view=classic", { waitUntil: "load" });
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("classic");
  await page.waitForTimeout(250);
  expect(scriptRequests.some((url) => /\/assets\/main-[^/]+\.js$/u.test(url))).toBe(true);
  expect(
    scriptRequests.some((url) => /\/assets\/waterfall-[^/]+\.js$/u.test(url)),
    "classic entry never requests the waterfall entry",
  ).toBe(false);
});

test("prefers-reduced-motion and keyboard switch use one document navigation", async ({ page }) => {
  await setWaterfallCookie(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let documentNavigations = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentNavigations += 1;
  });
  await page.goto("/?view=waterfall", { waitUntil: "load" });
  await expect(page.locator(".waterfall-card").first()).toHaveCSS("transition-duration", "0s");

  const width = page.viewportSize()?.width ?? 1440;
  let classicButton;
  if (width < 768) {
    const summary = page.locator(".home-view-menu__summary");
    const size = await summary.boundingBox();
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(44);
    await summary.focus();
    await page.keyboard.press("Enter");
    classicButton = page.locator(".home-view-menu--mobile button", { hasText: "经典" });
  } else {
    classicButton = page.locator(".home-view-switch--desktop button", { hasText: "经典" });
  }
  await classicButton.focus();
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.keyboard.press("Enter");
  const response = await navigation;
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("classic");
  expect(documentNavigations, "switching performs one document navigation").toBe(2);
  const cookies = await page.context().cookies(BASE_URL);
  expect(cookies.find((cookie) => cookie.name === "aifeeds_view")?.value).toBe("classic");
});

test("load more preserves order and Drawer deep link opens without a document navigation", async ({ page }) => {
  await page.goto("/?view=waterfall", { waitUntil: "load" });
  const cookies = await page.context().cookies(BASE_URL);
  expect(cookies.find((cookie) => cookie.name === "aifeeds_view")?.value).toBe("waterfall");
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator(".waterfall-card")).toHaveCount(20);
  await page.locator(".waterfall-card__link").first().click();
  await expect(page).toHaveURL(/\/t\/fixture-01$/u);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("API fail-open returns classic HTML and expires aifeeds_view", async ({ page }) => {
  await setWaterfallCookie(page);
  const response = await page.goto("/?view=waterfall&fixture_api=fail", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("fallback");
  await expect(page.locator("html")).toHaveAttribute("data-home-view", "classic");
  const cookies = await page.context().cookies(BASE_URL);
  expect(cookies.some((cookie) => cookie.name === "aifeeds_view")).toBe(false);
});

declare global {
  // Browser-only local fixture metric, installed before navigation.
  var __waterfallCls: number | undefined;
}
