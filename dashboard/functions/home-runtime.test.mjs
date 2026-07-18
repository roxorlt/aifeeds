import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleHomeRuntime,
  INITIAL_DATA_SENTINEL,
  SSR_MARKUP_SENTINEL,
} from "./home-runtime.ts";

const BUILD_ID_A = "a".repeat(64);
const BUILD_ID_B = "b".repeat(64);
function templateFor(buildId) {
  return `<!doctype html><html lang="zh-CN"><head><meta name="aifeeds-build-id" content="${buildId}"></head><body><div id="root">${SSR_MARKUP_SENTINEL}</div><script id="aifeeds-initial-data" type="application/json">${INITIAL_DATA_SENTINEL}</script></body></html>`;
}
function cacheKey(buildId = BUILD_ID_A, hostname = "ai-feeds.com") {
  return `https://aifeeds-home-cache.invalid/${buildId}/${encodeURIComponent(hostname)}/waterfall-root`;
}
const TEMPLATE = templateFor(BUILD_ID_A);
const CACHE_KEY = cacheKey();
const NOW_MS = Date.parse("2026-07-17T10:00:00.000Z");

test("Wrangler Pages bundle uses the automatic JSX runtime", async () => {
  const raw = await readFile(new URL("../tsconfig.json", import.meta.url), "utf8");
  const config = JSON.parse(raw);
  assert.equal(config.compilerOptions?.jsx, "react-jsx");
});

const ITEM = {
  id: "blog:openai:fixture",
  source_type: "blog",
  source_id: "fixture",
  title: "</script><script>alert(1)</script>\u2028\u2029",
  scraped_at: "2026-07-17T00:00:00.000Z",
};

function feed(overrides = {}) {
  return {
    view_mode: "waterfall",
    ranking_version: 2,
    items: [ITEM],
    next_cursor: null,
    has_more: false,
    query_time_ms: 4,
    generated_at: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function harness({
  enabled = "true",
  cookie = "aifeeds_view=waterfall",
  apiResponse = Response.json(feed()),
  template = TEMPLATE,
  render = async () => "<main><article>SSR card</article></main>",
  pathname = "/",
  method = "GET",
  token = "renderer-token",
  apiFetch,
  now = NOW_MS,
  origin = "https://ai-feeds.com",
} = {}) {
  const calls = { assets: [], api: 0, render: 0, waitUntil: 0 };
  const background = [];
  const env = {
    HOME_EXPERIENCE_ENABLED: enabled,
    HOME_RENDERER_TOKEN: token,
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        calls.assets.push(path);
        if (path === "/waterfall") return new Response(template, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
        return new Response("<!doctype html><html><body>classic</body></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
    HOME_API: {
      fetch: async (request) => {
        calls.api += 1;
        assert.equal(request.headers.get("X-Home-Renderer-Token"), token);
        assert.equal(request.headers.get("X-Home-Ranking-Version"), "2");
        if (apiFetch) return apiFetch(request);
        return apiResponse.clone();
      },
    },
  };
  const request = new Request(`${origin}${pathname}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {},
  });
  return {
    calls,
    env,
    request,
    deps: {
      renderWaterfall: async (data, location) => {
        calls.render += 1;
        return render(data, location);
      },
      waitUntil: (promise) => {
        calls.waitUntil += 1;
        background.push(promise);
      },
      now: () => now,
    },
    background,
  };
}

function memoryCache(initialResponse, initialKey = CACHE_KEY) {
  const stored = new Map();
  if (initialResponse) stored.set(initialKey, initialResponse.clone());
  const calls = { match: 0, put: 0 };
  return {
    calls,
    stored,
    cache: {
      match: async (request) => {
        calls.match += 1;
        return stored.get(request.url)?.clone();
      },
      put: async (request, response) => {
        calls.put += 1;
        stored.set(request.url, response.clone());
      },
    },
  };
}

function cachedHtml(body, ageSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
      "X-AIFeeds-Home-Generated-At": new Date(NOW_MS - ageSeconds * 1_000).toISOString(),
    },
  });
}

test("disabled and non-home requests never call the API or renderer", async () => {
  const disabled = harness();
  delete disabled.env.HOME_EXPERIENCE_ENABLED;
  const disabledResponse = await handleHomeRuntime(disabled.request, disabled.env, disabled.deps);
  assert.equal(disabledResponse.headers.get("X-AIFeeds-Home-SSR"), "disabled");
  assert.deepEqual(disabled.calls, { assets: ["/index.html"], api: 0, render: 0, waitUntil: 0 });

  const nonHome = harness({ pathname: "/search" });
  const nonHomeResponse = await handleHomeRuntime(nonHome.request, nonHome.env, nonHome.deps);
  assert.equal(nonHomeResponse.headers.get("X-AIFeeds-Home-SSR"), "pass");
  assert.equal(nonHome.calls.api, 0);
  assert.equal(nonHome.calls.render, 0);
});

test("classic mode receives only bounded availability metadata", async () => {
  const fixture = harness({ cookie: "aifeeds_view=classic" });
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  const html = await response.text();
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "classic");
  assert.match(html, /data-home-view-available="true"/);
  assert.match(html, /data-home-view="classic"/);
  assert.equal(fixture.calls.api, 0);
  assert.equal(fixture.calls.render, 0);
});

test("valid query overrides persist the selected view for same-origin pagination", async () => {
  const waterfall = harness({
    pathname: "/?view=waterfall",
    cookie: "",
  });
  const waterfallResponse = await handleHomeRuntime(
    waterfall.request,
    waterfall.env,
    waterfall.deps,
  );
  assert.equal(waterfallResponse.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.equal(
    waterfallResponse.headers.get("Set-Cookie"),
    "aifeeds_view=waterfall; Path=/; Max-Age=15552000; SameSite=Lax; Secure",
  );

  const classic = harness({
    pathname: "/?view=classic",
    cookie: "",
  });
  const classicResponse = await handleHomeRuntime(
    classic.request,
    classic.env,
    classic.deps,
  );
  assert.equal(classicResponse.headers.get("X-AIFeeds-Home-SSR"), "classic");
  assert.equal(
    classicResponse.headers.get("Set-Cookie"),
    "aifeeds_view=classic; Path=/; Max-Age=15552000; SameSite=Lax; Secure",
  );

  const invalid = harness({
    pathname: "/?view=invalid",
    cookie: "",
  });
  const invalidResponse = await handleHomeRuntime(
    invalid.request,
    invalid.env,
    invalid.deps,
  );
  assert.equal(invalidResponse.headers.get("X-AIFeeds-Home-SSR"), "classic");
  assert.equal(invalidResponse.headers.get("Set-Cookie"), null);
});

test("waterfall renders safe JSON and meaningful server markup", async () => {
  const fixture = harness();
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.match(html, /<article>SSR card<\/article>/);
  assert.match(html, /data-home-ssr="generated"/);
  assert.doesNotMatch(html, new RegExp(SSR_MARKUP_SENTINEL));
  assert.doesNotMatch(html, new RegExp(INITIAL_DATA_SENTINEL));
  const json = html.match(/type="application\/json">([^<]*)<\/script>/)?.[1] ?? "";
  assert.doesNotMatch(json, /</);
  assert.match(json, /\\u003c\/script>/);
  assert.match(json, /\\u2028/);
  assert.match(json, /\\u2029/);
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.render, 1);
  assert.deepEqual(fixture.calls.assets, ["/waterfall"]);
});

test("new Pages normalizes a legacy Worker response without ranking_version to v1", async () => {
  const { ranking_version: _rankingVersion, ...legacyFeed } = feed();
  const fixture = harness({
    apiResponse: Response.json(legacyFeed),
    render: async (data) => {
      assert.equal(data.ranking_version, 1);
      return "<main><article>Legacy v1 card</article></main>";
    },
  });
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  const html = await response.text();

  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.match(html, /Legacy v1 card/);
  assert.match(html, /"ranking_version":1/);
});

for (const [name, options] of [
  ["missing binding", { token: "" }],
  ["non-200 API", { apiResponse: Response.json({ error: "no" }, { status: 503 }) }],
  ["invalid API JSON", { apiResponse: new Response("not-json") }],
  ["wrong response mode", { apiResponse: Response.json(feed({ view_mode: "classic" })) }],
  ["template marker loss", { template: "<html><body>no markers</body></html>" }],
  ["build identity loss", { template: templateFor("not-a-build-identity") }],
  ["renderer error", { render: async () => { throw new Error("render failed"); } }],
]) {
  test(`${name} expires waterfall preference and fails open to classic`, async () => {
    const fixture = harness(options);
    const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "fallback");
    assert.match(response.headers.get("Set-Cookie") ?? "", /aifeeds_view=;/);
    assert.match(await response.text(), /classic/);
  });
}

test("same-origin pagination is bounded and unavailable to classic mode", async () => {
  const waterfall = harness({ pathname: "/_home/feed?limit=999&cursor=a%2Fb" });
  const response = await handleHomeRuntime(waterfall.request, waterfall.env, waterfall.deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(waterfall.calls.api, 1);

  const classic = harness({
    pathname: "/_home/feed",
    cookie: "aifeeds_view=classic",
  });
  const denied = await handleHomeRuntime(classic.request, classic.env, classic.deps);
  assert.equal(denied.status, 404);
  assert.equal(classic.calls.api, 0);
});

test("HEAD returns matching diagnostics with no body", async () => {
  const fixture = harness({ method: "HEAD" });
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.equal(await response.text(), "");
});

test("root cache is shared across arbitrary cookie text without repeating API or render work", async () => {
  const memory = memoryCache();
  const fixture = harness();
  fixture.deps.cache = memory.cache;
  const first = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(first.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  await Promise.all(fixture.background);

  const secondRequest = new Request("https://ai-feeds.com/", {
    headers: {
      Cookie: "arbitrary_private_cookie=must-not-vary-cache; aifeeds_view=waterfall",
    },
  });
  const second = await handleHomeRuntime(secondRequest, fixture.env, fixture.deps);
  assert.equal(second.headers.get("X-AIFeeds-Home-SSR"), "waterfall-cache");
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.render, 1);
  assert.doesNotMatch(await second.text(), /arbitrary_private_cookie|must-not-vary-cache/);
});

test("cache namespace changes with the deployed build identity and request hostname", async () => {
  const memory = memoryCache();
  const first = harness({ render: async () => "<main>build A</main>" });
  first.deps.cache = memory.cache;
  const firstResponse = await handleHomeRuntime(first.request, first.env, first.deps);
  assert.equal(firstResponse.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  await Promise.all(first.background);
  assert.match(await memory.stored.get(cacheKey(BUILD_ID_A)).text(), /build A/);

  const nextBuild = harness({
    template: templateFor(BUILD_ID_B),
    render: async () => "<main>build B</main>",
  });
  nextBuild.deps.cache = memory.cache;
  const nextResponse = await handleHomeRuntime(nextBuild.request, nextBuild.env, nextBuild.deps);
  assert.equal(nextResponse.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.match(await nextResponse.text(), /build B/);
  await Promise.all(nextBuild.background);
  assert.match(await memory.stored.get(cacheKey(BUILD_ID_B)).text(), /build B/);

  const stagingHost = harness({
    template: templateFor(BUILD_ID_B),
    origin: "https://staging.ai-feeds.com",
    render: async () => "<main>staging host</main>",
  });
  stagingHost.deps.cache = memory.cache;
  const stagingResponse = await handleHomeRuntime(
    stagingHost.request,
    stagingHost.env,
    stagingHost.deps,
  );
  assert.equal(stagingResponse.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.match(await stagingResponse.text(), /staging host/);
  await Promise.all(stagingHost.background);
  assert.match(
    await memory.stored.get(cacheKey(BUILD_ID_B, "staging.ai-feeds.com")).text(),
    /staging host/,
  );
});

test("concurrent build namespaces never share a refresh flight", async () => {
  const memory = memoryCache();
  let releaseApi;
  const apiGate = new Promise((resolve) => { releaseApi = resolve; });
  const buildA = harness({
    apiFetch: async () => {
      await apiGate;
      return Response.json(feed());
    },
  });
  const buildB = harness({
    template: templateFor(BUILD_ID_B),
    apiFetch: async () => {
      await apiGate;
      return Response.json(feed());
    },
  });
  buildA.deps.cache = memory.cache;
  buildB.deps.cache = memory.cache;

  const first = handleHomeRuntime(buildA.request, buildA.env, buildA.deps);
  const second = handleHomeRuntime(buildB.request, buildB.env, buildB.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(buildA.calls.api, 1);
  assert.equal(buildB.calls.api, 1);
  releaseApi();
  await Promise.all([first, second]);
  await Promise.all([...buildA.background, ...buildB.background]);
  assert.equal(memory.calls.put, 2);
  assert.ok(memory.stored.has(cacheKey(BUILD_ID_A)));
  assert.ok(memory.stored.has(cacheKey(BUILD_ID_B)));
});

test("fresh cache returns immediately with bounded age diagnostics and no origin work", async () => {
  const memory = memoryCache(cachedHtml("<html>fresh cached waterfall</html>", 30));
  const fixture = harness();
  fixture.deps.cache = memory.cache;

  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall-cache");
  assert.equal(response.headers.get("X-AIFeeds-Home-Freshness"), "fresh");
  assert.equal(response.headers.get("X-AIFeeds-Home-Age"), "30");
  const html = await response.text();
  assert.match(html, /fresh cached waterfall/);
  assert.match(html, /data-home-ssr="fresh"/);
  assert.equal(fixture.calls.api, 0);
  assert.equal(fixture.calls.render, 0);
  assert.equal(fixture.calls.waitUntil, 0);
});

test("stale cache returns before one background refresh and successful refresh replaces it", async () => {
  const memory = memoryCache(cachedHtml("<html>stale cached waterfall</html>", 120));
  let releaseApi;
  const apiGate = new Promise((resolve) => { releaseApi = resolve; });
  const fixture = harness({
    apiFetch: async () => {
      await apiGate;
      return Response.json(feed({ generated_at: "2026-07-17T10:00:00.000Z" }));
    },
    render: async () => "<main>freshly refreshed waterfall</main>",
  });
  fixture.deps.cache = memory.cache;

  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall-stale");
  assert.equal(response.headers.get("X-AIFeeds-Home-Freshness"), "stale");
  const html = await response.text();
  assert.match(html, /stale cached waterfall/);
  assert.match(html, /data-home-ssr="stale"/);
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.waitUntil, 1);
  assert.equal(memory.calls.put, 0);

  releaseApi();
  await Promise.all(fixture.background);
  assert.equal(memory.calls.put, 1);
  assert.match(await memory.stored.get(CACHE_KEY).text(), /freshly refreshed waterfall/);
});

test("concurrent stale hits share one isolate refresh flight", async () => {
  const memory = memoryCache(cachedHtml("<html>shared stale waterfall</html>", 120));
  let releaseApi;
  const apiGate = new Promise((resolve) => { releaseApi = resolve; });
  const fixture = harness({
    apiFetch: async () => {
      await apiGate;
      return Response.json(feed());
    },
  });
  fixture.deps.cache = memory.cache;

  const [first, second] = await Promise.all([
    handleHomeRuntime(fixture.request, fixture.env, fixture.deps),
    handleHomeRuntime(fixture.request, fixture.env, fixture.deps),
  ]);
  assert.equal(first.headers.get("X-AIFeeds-Home-SSR"), "waterfall-stale");
  assert.equal(second.headers.get("X-AIFeeds-Home-SSR"), "waterfall-stale");
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.render, 0);
  assert.equal(fixture.calls.waitUntil, 1);

  releaseApi();
  await Promise.all(fixture.background);
  assert.equal(fixture.calls.render, 1);
  assert.equal(memory.calls.put, 1);
});

test("failed stale refresh preserves the last good snapshot", async () => {
  const original = "<html>last good stale waterfall</html>";
  const memory = memoryCache(cachedHtml(original, 120));
  const fixture = harness({
    apiResponse: Response.json({ error: "origin down" }, { status: 503 }),
  });
  fixture.deps.cache = memory.cache;

  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall-stale");
  await Promise.all(fixture.background);
  assert.equal(memory.calls.put, 0);
  assert.equal(await memory.stored.get(CACHE_KEY).text(), original);
});

test("snapshot older than max-stale refreshes synchronously and fails open to classic", async () => {
  const memory = memoryCache(cachedHtml("<html>expired waterfall</html>", 601));
  const fixture = harness({
    apiResponse: Response.json({ error: "origin down" }, { status: 503 }),
  });
  fixture.deps.cache = memory.cache;

  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "fallback");
  const html = await response.text();
  assert.match(html, /classic/);
  assert.match(html, /data-home-ssr="fallback"/);
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.waitUntil, 1);
  assert.equal(memory.calls.put, 0);
});

test("cache retention is explicit without relying on native stale-while-revalidate", async () => {
  const memory = memoryCache();
  const fixture = harness();
  fixture.deps.cache = memory.cache;
  await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  await Promise.all(fixture.background);

  const stored = memory.stored.get(CACHE_KEY);
  assert.ok(stored);
  assert.equal(stored.headers.get("Cache-Control"), "public, max-age=0, s-maxage=86400");
  assert.doesNotMatch(stored.headers.get("Cache-Control") ?? "", /stale-while-revalidate/i);
  assert.equal(stored.headers.get("X-AIFeeds-Home-Generated-At"), new Date(NOW_MS).toISOString());
});

test("auth cookies and query overrides never read or write the shared waterfall body", async () => {
  for (const { pathname, cookie } of [
    { pathname: "/", cookie: "aifeeds_view=waterfall; xlist_sid=private-session" },
    { pathname: "/?view=waterfall", cookie: "" },
  ]) {
    const memory = memoryCache(cachedHtml("<html>must not be shared</html>", 10));
    const fixture = harness({ pathname, cookie });
    fixture.deps.cache = memory.cache;
    const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
    assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
    assert.doesNotMatch(await response.text(), /must not be shared/);
    assert.deepEqual(memory.calls, { match: 0, put: 0 });
  }
});

test("HEAD cache hits retain diagnostics without returning a body", async () => {
  const memory = memoryCache(cachedHtml("<html>fresh head body</html>", 20));
  const fixture = harness({ method: "HEAD" });
  fixture.deps.cache = memory.cache;
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(response.headers.get("X-AIFeeds-Home-Freshness"), "fresh");
  assert.equal(response.headers.get("X-AIFeeds-Home-Age"), "20");
  assert.equal(await response.text(), "");
});
