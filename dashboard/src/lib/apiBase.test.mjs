import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(dashboardRoot, "..");

test("api base module is importable without browser or Vite globals", async () => {
  const apiBase = await import("./apiBase.ts");
  assert.equal(typeof apiBase.API_BASE, "string");
});

test("api base resolution is exposed as an injectable pure function", async () => {
  const apiBase = await import("./apiBase.ts");
  assert.equal(typeof apiBase.resolveApiBase, "function");
});

test("same-origin true overrides an explicit external API base", async () => {
  const { resolveApiBase } = await import("./apiBase.ts");
  const input = {
    hostname: "staging.ai-feeds.com",
    envBase: "https://staging-api.ai-feeds.com",
  };

  assert.equal(resolveApiBase({ ...input, sameOriginFlag: true }), "");
  assert.equal(resolveApiBase({ ...input, sameOriginFlag: "true" }), "");
});

test("same-origin false preserves the checked-in external staging API", async () => {
  const { resolveApiBase } = await import("./apiBase.ts");
  const expected = "https://staging-api.ai-feeds.com";

  assert.equal(resolveApiBase({
    hostname: "perf-staging.ai-feeds.com",
    envBase: expected,
    sameOriginFlag: false,
  }), expected);
  assert.equal(resolveApiBase({
    hostname: "perf-staging.ai-feeds.com",
    envBase: expected,
    sameOriginFlag: "false",
  }), expected);
});

test("host fallbacks keep ordinary Pages builds external and route explicit experiment hosts locally", async () => {
  const { resolveApiBase } = await import("./apiBase.ts");
  const cases = [
    ["ai-feeds.com", "https://api.ai-feeds.com"],
    ["www.ai-feeds.com", ""],
    ["staging.ai-feeds.com", "https://staging-api.ai-feeds.com"],
    ["perf-staging.ai-feeds.com", ""],
    ["localhost", ""],
    ["127.0.0.1", ""],
    ["feature.xlist-dashboard.pages.dev", "https://api.ai-feeds.com"],
    ["xlist-dashboard-staging.pages.dev", "https://staging-api.ai-feeds.com"],
    ["feature.xlist-dashboard-staging.pages.dev", "https://staging-api.ai-feeds.com"],
  ];

  for (const [hostname, expected] of cases) {
    assert.equal(resolveApiBase({ hostname, sameOriginFlag: false }), expected, hostname);
  }
});

test("production switches to same-origin only under the explicit build flag", async () => {
  const { resolveApiBase } = await import("./apiBase.ts");

  assert.equal(resolveApiBase({ hostname: "ai-feeds.com", sameOriginFlag: false }), "https://api.ai-feeds.com");
  assert.equal(resolveApiBase({ hostname: "ai-feeds.com", sameOriginFlag: true }), "");
});

test("request and public Worker bases keep share targets in the correct environment", async () => {
  const {
    buildPublicWorkerUrl,
    resolveApiBase,
    resolvePublicWorkerBase,
  } = await import("./apiBase.ts");
  const stagingBase = "https://staging-api.ai-feeds.com";
  const cases = [
    {
      label: "normal production",
      input: { hostname: "ai-feeds.com", sameOriginFlag: false },
      requestBase: "https://api.ai-feeds.com",
      publicBase: "https://api.ai-feeds.com",
    },
    {
      label: "normal staging",
      input: { hostname: "staging.ai-feeds.com", envBase: stagingBase, sameOriginFlag: false },
      requestBase: stagingBase,
      publicBase: stagingBase,
    },
    {
      label: "perf staging same-origin",
      input: { hostname: "perf-staging.ai-feeds.com", envBase: stagingBase, sameOriginFlag: true },
      requestBase: "",
      publicBase: stagingBase,
    },
    {
      label: "production same-origin",
      input: { hostname: "ai-feeds.com", sameOriginFlag: true },
      requestBase: "",
      publicBase: "https://api.ai-feeds.com",
    },
  ];

  for (const entry of cases) {
    const requestBase = resolveApiBase(entry.input);
    const publicBase = resolvePublicWorkerBase(entry.input);
    assert.equal(requestBase, entry.requestBase, `${entry.label} request base`);
    assert.equal(publicBase, entry.publicBase, `${entry.label} public base`);
    assert.equal(
      buildPublicWorkerUrl("/s/a%2Fb", publicBase),
      `${entry.publicBase}/s/a%2Fb`,
      `${entry.label} share target`,
    );
  }
});

test("package scripts define isolated perf and production same-origin builds without changing normal builds", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dashboardRoot, "package.json"), "utf8"));

  assert.equal(pkg.scripts.build, "tsc -b && vite build");
  assert.equal(pkg.scripts["build:staging"], "tsc -b && vite build --mode staging");
  assert.equal(
    pkg.scripts["build:perf-staging"],
    "VITE_API_SAME_ORIGIN=true tsc -b && VITE_API_SAME_ORIGIN=true vite build --mode staging",
  );
  assert.equal(
    pkg.scripts["build:same-origin"],
    "VITE_API_SAME_ORIGIN=true tsc -b && VITE_API_SAME_ORIGIN=true vite build",
  );
  assert.equal(pkg.scripts["predeploy:same-origin"], undefined);
  assert.doesNotMatch(pkg.scripts["deploy:same-origin"], /wrangler|npm run build/);
  assert.match(pkg.scripts["deploy:same-origin"], /process\.exit\(1\)/);
  assert.match(pkg.scripts["deploy:same-origin"], /docs\/operations\.md/);

  const guard = spawnSync("npm", ["run", "deploy:same-origin", "--silent"], {
    cwd: dashboardRoot,
    encoding: "utf8",
  });
  assert.notEqual(guard.status, 0, "same-origin production deploy must fail closed by default");
  assert.match(`${guard.stdout}${guard.stderr}`, /BLOCKED.*explicit approval/i);
});

test("HTML prefetch lets the same-origin build fetch a relative items path", () => {
  const html = fs.readFileSync(path.join(dashboardRoot, "index.html"), "utf8");
  const viteConfig = fs.readFileSync(path.join(dashboardRoot, "vite.config.ts"), "utf8");

  assert.match(html, /<script>[\s\S]*?__AIFEEDS_API_SAME_ORIGIN__/,
    "prefetch must stay parser-inline instead of being bundled with the app module");
  assert.match(html, /__AIFEEDS_API_BASE__/);
  assert.match(html, /sameOrigin[\s\S]*?configuredBase/,
    "same-origin flag must be evaluated before the configured external base");
  assert.match(html, /base === null/,
    "empty string is a valid same-origin base and must not skip prefetch");
  assert.match(html, /fetch\(base \+ path,/);
  assert.doesNotMatch(html, /<link rel="(?:preconnect|dns-prefetch)" href="https:\/\/api\.ai-feeds\.com"/,
    "same-origin artifacts must not retain a static second-origin connection hint");
  assert.match(viteConfig, /transformIndexHtml/);
  assert.match(viteConfig, /loadEnv/);
  assert.match(viteConfig, /JSON\.stringify/,
    "public env values must be encoded as JS literals rather than interpolated unsafely");
  assert.match(viteConfig, /replace\(\/<\/g, ['"]\\\\u003c['"]\)/,
    "inline literals must escape '<' so an API base cannot terminate the script element");
});

test("versioned nginx location is placeholder-only, uncached, and preserves auth timing headers", () => {
  const configPath = path.join(repoRoot, "deploy/nginx/aifeeds-api-location.conf");
  assert.equal(fs.existsSync(configPath), true, "versioned nginx API location must exist");
  const config = fs.readFileSync(configPath, "utf8");

  assert.match(config, /location \^~ \/api\/\s*\{/);
  for (const placeholder of ["__WORKER_UPSTREAM_HOST__", "__PUBLIC_API_HOST__", "__ORIGIN_SECRET__"]) {
    assert.match(config, new RegExp(placeholder));
  }
  assert.doesNotMatch(config, /xlist-api\.ltsms86\.workers\.dev/,
    "the reusable location must not bake in a production or staging upstream");
  assert.match(config, /proxy_set_header\s+X-Request-Id\s+\$request_id;/);
  assert.match(config, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/,
    "the trusted VPS must replace any client-supplied forwarding chain");
  assert.doesNotMatch(config, /\$proxy_add_x_forwarded_for/,
    "client-controlled X-Forwarded-For must not reach the Worker origin gate");
  assert.match(config, /proxy_pass_header Set-Cookie;/);
  assert.match(config, /proxy_pass_header Server-Timing;/);
  assert.match(config, /proxy_pass_header X-Request-Id;/);
  assert.match(config, /proxy_cache off;/);
  assert.match(config, /proxy_no_cache\s+1;/);
  assert.match(config, /proxy_cache_bypass\s+1;/);
});

test("operations runbook keeps perf staging isolated and makes auth, deep-link, and rollback gates explicit", () => {
  const operations = fs.readFileSync(path.join(repoRoot, "docs/operations.md"), "utf8");
  const start = operations.indexOf("<!-- aifeeds-same-origin-api:start -->");
  const end = operations.indexOf("<!-- aifeeds-same-origin-api:end -->");
  assert.ok(start >= 0 && end > start, "same-origin API runbook section must be bounded");
  const section = operations.slice(start, end);

  for (const required of [
    "当前未部署",
    "xlist-dashboard-perf",
    "perf-staging.ai-feeds.com",
    "现有 staging 保持不变",
    "独立明确审批",
    "/api/auth/me",
    "邮件验证码",
    "SMS",
    "favorite",
    "subscription",
    "feedback",
    "/t/:id",
    "/g/:owner/:repo",
    "/ph/:slug/:date",
    "/c/:slug",
    "/e/:eventId",
    "/h/:arxivId",
    "/o/:id",
    "/s/:token",
    "/daily",
    "/i/",
    "Set-Cookie",
    "Server-Timing",
    "X-Request-Id",
    "npm run deploy",
    "保留 `/api/` route",
  ]) {
    assert.match(section, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
  }
});

test("share and Worker media paths use the public base instead of request-base mirrors", () => {
  const app = fs.readFileSync(path.join(dashboardRoot, "src/App.tsx"), "utf8");
  const utils = fs.readFileSync(path.join(dashboardRoot, "src/lib/utils.ts"), "utf8");
  const asset = fs.readFileSync(path.join(dashboardRoot, "src/lib/asset.ts"), "utf8");
  const githubDrawer = fs.readFileSync(path.join(dashboardRoot, "src/components/GithubDrawerBody.tsx"), "utf8");
  const githubReadme = fs.readFileSync(path.join(dashboardRoot, "src/lib/githubReadme.ts"), "utf8");
  const audited = `${app}\n${utils}\n${asset}\n${githubDrawer}\n${githubReadme}`;

  assert.match(app, /buildPublicWorkerUrl\(`\/s\/\$\{encodeURIComponent\(token\)\}`\)/);
  assert.match(utils, /PUBLIC_WORKER_BASE/);
  assert.match(asset, /PUBLIC_WORKER_BASE/);
  assert.match(githubReadme, /PUBLIC_WORKER_BASE/);
  assert.doesNotMatch(audited, /import\.meta\.env\.VITE_API_BASE/);
  assert.doesNotMatch(audited, /API_BASE\s*\|\|\s*['"]https:\/\/api\.ai-feeds\.com/);
});
