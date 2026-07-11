import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 1,
  reporter: isCI
    ? [["line"], ["html", { outputFolder: "output/playwright/report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "output/playwright/report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  expect: { timeout: 8_000 },
  timeout: 30_000,
  projects: [
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: "tablet-chromium",
      use: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true },
    },
    {
      name: "iphone-chromium",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
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
      },
    },
  ],
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
});
