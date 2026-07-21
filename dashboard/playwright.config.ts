import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const requestedBaseURL = process.env.E2E_BASE_URL?.trim().replace(/\/+$/, "");
const isRemote = Boolean(requestedBaseURL);
const isWaterfallE2E = process.env.WATERFALL_E2E === "1";
const isWaterfallStagingRemote = process.env.WATERFALL_STAGING_REMOTE === "1";
const requestedOutputDir = process.env.E2E_OUTPUT_DIR?.trim().replace(/\/+$/, "");

if (isRemote && isWaterfallE2E) {
  throw new Error("WATERFALL_E2E is local-only and cannot target a remote host");
}
if (isWaterfallStagingRemote && !isRemote) {
  throw new Error("WATERFALL_STAGING_REMOTE requires an exact remote staging host");
}

if (requestedBaseURL) {
  const target = new URL(requestedBaseURL);
  if (
    target.protocol !== "https:" ||
    target.hostname !== (isWaterfallStagingRemote
      ? "staging.ai-feeds.com"
      : "perf-staging.ai-feeds.com") ||
    target.port ||
    target.pathname !== "/" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error(isWaterfallStagingRemote
      ? "E2E_BASE_URL must be exactly https://staging.ai-feeds.com"
      : "E2E_BASE_URL must be exactly https://perf-staging.ai-feeds.com");
  }
}

const remoteOutputPattern = isWaterfallStagingRemote
  ? /^\/private\/tmp\/aifeeds-waterfall-staging\.[A-Za-z0-9]+\/playwright$/
  : /^\/private\/tmp\/aifeeds-perf-staging-\d{8}T\d{6}-[A-Za-z0-9]{6}\/playwright$/;
if (isRemote && !remoteOutputPattern.test(requestedOutputDir || "")) {
  throw new Error("E2E_OUTPUT_DIR must be the active private perf-staging evidence directory");
}
if (!isRemote && requestedOutputDir) {
  throw new Error("E2E_OUTPUT_DIR is only allowed for the exact remote perf-staging gate");
}
if (isRemote && process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") {
  throw new Error("PLAYWRIGHT_NO_COPY_PROMPT=1 is required to suppress remote page snapshots");
}

const baseURL = requestedBaseURL
  || (isWaterfallE2E ? "https://localhost:4187" : "http://127.0.0.1:4173");
const outputRoot = requestedOutputDir || "./output/playwright";
const chromiumUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36";

export default defineConfig({
  testDir: "./e2e",
  outputDir: `${outputRoot}/test-results`,
  fullyParallel: false,
  forbidOnly: isCI || isRemote,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 1,
  reporter: isRemote
    ? [["line"]]
    : isCI
      ? [["line"], ["html", { outputFolder: `${outputRoot}/report`, open: "never" }]]
      : [["list"], ["html", { outputFolder: `${outputRoot}/report`, open: "never" }]],
  use: {
    baseURL,
    ignoreHTTPSErrors: isWaterfallE2E,
    serviceWorkers: isRemote ? "allow" : isWaterfallE2E ? "allow" : "block",
    trace: isRemote ? "off" : "retain-on-failure",
    screenshot: isRemote ? "off" : "only-on-failure",
    video: "off",
  },
  expect: { timeout: 8_000 },
  timeout: 30_000,
  projects: [
    {
      name: "desktop-chromium",
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        userAgent: chromiumUserAgent,
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    {
      name: "tablet-chromium",
      use: {
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        hasTouch: true,
        userAgent: chromiumUserAgent,
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    {
      name: "iphone-chromium",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    {
      name: "iphone-webkit",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      },
    },
    {
      name: "android-chromium",
      use: {
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/139.0 Mobile Safari/537.36",
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
  ],
  webServer: isRemote ? undefined : {
    command: isWaterfallE2E
      ? "node scripts/waterfall-edge-fixture.mjs"
      : "npm run preview -- --host 127.0.0.1 --port 4173",
    url: isWaterfallE2E
      ? "https://127.0.0.1:4187"
      : "http://127.0.0.1:4173",
    ignoreHTTPSErrors: isWaterfallE2E,
    reuseExistingServer: isWaterfallE2E ? false : !isCI,
    timeout: 30_000,
  },
});
