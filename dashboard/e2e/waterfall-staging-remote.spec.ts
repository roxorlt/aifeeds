import { expect, test, type Page } from "@playwright/test";

const STAGING_ORIGIN = "https://staging.ai-feeds.com";
const remoteEnabled = process.env.WATERFALL_STAGING_REMOTE === "1";

test.skip(!remoteEnabled, "remote waterfall probes require the explicit staging gate");

async function setWaterfallCookie(page: Page): Promise<void> {
  await page.context().addCookies([{
    name: "aifeeds_view",
    value: "waterfall",
    url: STAGING_ORIGIN,
    sameSite: "Lax",
  }]);
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => (
      requestAnimationFrame(() => resolve())
    )));
  });
  await page.waitForTimeout(250);
}

test("staging SSR contains at least 12 cards before JavaScript", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: testInfo.project.use.viewport ?? { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${STAGING_ORIGIN}/?view=waterfall`, {
      waitUntil: "load",
    });
    expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
    expect(await page.locator(".waterfall-grid article").count()).toBeGreaterThanOrEqual(12);
    expect(await page.locator("#aifeeds-initial-data").textContent()).toContain(
      '"view_mode":"waterfall"',
    );
    if ((testInfo.project.use.viewport?.width ?? 1440) >= 768) {
      const undersized = await page.locator(".waterfall-card").evaluateAll((cards) => cards
        .map((card) => {
          const span = Number.parseInt(
            (card as HTMLElement).style.getPropertyValue("--waterfall-row-span"),
            10,
          );
          const height = card.getBoundingClientRect().height;
          return {
            id: (card as HTMLElement).dataset.itemId ?? "unknown",
            span,
            height,
            allocatedHeight: (span * 20) - 12,
          };
        })
        .filter((card) => card.allocatedHeight + 0.5 < card.height));
      expect(undersized, JSON.stringify(undersized)).toEqual([]);
    }
  } finally {
    await context.close();
  }
});

test("staging hydration is clean and responsive within the CLS budget", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const scripts: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await page.addInitScript(() => {
    globalThis.__waterfallStagingCls = 0;
    globalThis.__waterfallStagingShifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            value?: number;
            sources?: Array<{
              node?: Node;
              previousRect?: DOMRectReadOnly;
              currentRect?: DOMRectReadOnly;
            }>;
          };
          if (!shift.hadRecentInput) {
            globalThis.__waterfallStagingCls += shift.value ?? 0;
            globalThis.__waterfallStagingShifts.push({
              value: shift.value ?? 0,
              sources: (shift.sources ?? []).map((source) => {
                const element = source.node instanceof Element ? source.node : null;
                return {
                  tag: element?.tagName.toLowerCase() ?? "unknown",
                  className: typeof element?.className === "string"
                    ? element.className.slice(0, 160)
                    : "",
                  previous: source.previousRect
                    ? { x: source.previousRect.x, y: source.previousRect.y, width: source.previousRect.width, height: source.previousRect.height }
                    : null,
                  current: source.currentRect
                    ? { x: source.currentRect.x, y: source.currentRect.y, width: source.currentRect.width, height: source.currentRect.height }
                    : null,
                };
              }),
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      globalThis.__waterfallStagingCls = 0;
    }
  });

  const response = await page.goto("/?view=waterfall", { waitUntil: "load" });
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("waterfall");
  expect(await page.locator(".waterfall-card").count()).toBeGreaterThanOrEqual(12);
  await settleLayout(page);

  expect(errors).toEqual([]);
  expect(scripts.some((url) => /\/assets\/waterfall-[^/]+\.js$/u.test(url))).toBe(true);
  expect(scripts.some((url) => /\/assets\/main-[^/]+\.js$/u.test(url))).toBe(false);
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
  const layout = await page.evaluate(() => ({
    cls: globalThis.__waterfallStagingCls,
    shifts: globalThis.__waterfallStagingShifts,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(layout.cls, JSON.stringify(layout.shifts)).toBeLessThanOrEqual(0.1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
});

test("staging load more appends a bounded page without document navigation", async ({ page }) => {
  await setWaterfallCookie(page);
  let documentRequests = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests += 1;
  });
  await page.goto("/", { waitUntil: "load" });
  const before = await page.locator(".waterfall-card").count();
  expect(before).toBeGreaterThanOrEqual(12);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect.poll(() => page.locator(".waterfall-card").count()).toBeGreaterThan(before);
  expect(await page.locator(".waterfall-card").count()).toBeLessThanOrEqual(before + 24);
  expect(documentRequests).toBe(1);
});

test("staging view switch persists classic and performs one navigation", async ({ page }) => {
  await setWaterfallCookie(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "load" });
  const width = page.viewportSize()?.width ?? 1440;
  let classicButton;
  if (width < 768) {
    const summary = page.locator(".home-view-menu__summary");
    expect((await summary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await summary.click();
    classicButton = page.locator(".home-view-menu--mobile button", { hasText: "经典" });
  } else {
    classicButton = page.locator(".home-view-switch--desktop button", { hasText: "经典" });
  }
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await classicButton.click();
  const response = await navigation;
  expect(response?.headers()["x-aifeeds-home-ssr"]).toBe("classic");
  const cookies = await page.context().cookies(STAGING_ORIGIN);
  expect(cookies.find((cookie) => cookie.name === "aifeeds_view")?.value).toBe("classic");
});

declare global {
  var __waterfallStagingCls: number;
  var __waterfallStagingShifts: Array<{
    value: number;
    sources: Array<{
      tag: string;
      className: string;
      previous: { x: number; y: number; width: number; height: number } | null;
      current: { x: number; y: number; width: number; height: number } | null;
    }>;
  }>;
}
