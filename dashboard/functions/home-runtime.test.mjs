import assert from "node:assert/strict";
import test from "node:test";

import {
  handleHomeRuntime,
  INITIAL_DATA_SENTINEL,
  SSR_MARKUP_SENTINEL,
} from "./home-runtime.ts";

const TEMPLATE = `<!doctype html><html lang="zh-CN"><body><div id="root">${SSR_MARKUP_SENTINEL}</div><script id="aifeeds-initial-data" type="application/json">${INITIAL_DATA_SENTINEL}</script></body></html>`;

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
} = {}) {
  const calls = { assets: [], api: 0, render: 0, waitUntil: 0 };
  const env = {
    HOME_EXPERIENCE_ENABLED: enabled,
    HOME_RENDERER_TOKEN: token,
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        calls.assets.push(path);
        if (path === "/waterfall.html") return new Response(template, {
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
        return apiResponse.clone();
      },
    },
  };
  const request = new Request(`https://ai-feeds.com${pathname}`, {
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
      waitUntil: () => { calls.waitUntil += 1; },
    },
  };
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

test("waterfall renders safe JSON and meaningful server markup", async () => {
  const fixture = harness();
  const response = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  assert.match(html, /<article>SSR card<\/article>/);
  assert.doesNotMatch(html, new RegExp(SSR_MARKUP_SENTINEL));
  assert.doesNotMatch(html, new RegExp(INITIAL_DATA_SENTINEL));
  const json = html.match(/type="application\/json">([^<]*)<\/script>/)?.[1] ?? "";
  assert.doesNotMatch(json, /</);
  assert.match(json, /\\u003c\/script>/);
  assert.match(json, /\\u2028/);
  assert.match(json, /\\u2029/);
  assert.equal(fixture.calls.api, 1);
  assert.equal(fixture.calls.render, 1);
});

for (const [name, options] of [
  ["missing binding", { token: "" }],
  ["non-200 API", { apiResponse: Response.json({ error: "no" }, { status: 503 }) }],
  ["invalid API JSON", { apiResponse: new Response("not-json") }],
  ["wrong response mode", { apiResponse: Response.json(feed({ view_mode: "classic" })) }],
  ["template marker loss", { template: "<html><body>no markers</body></html>" }],
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
  const stored = new Map();
  const cache = {
    match: async (request) => stored.get(request.url)?.clone(),
    put: async (request, response) => {
      stored.set(request.url, response.clone());
    },
  };
  const fixture = harness();
  fixture.deps.cache = cache;
  const first = await handleHomeRuntime(fixture.request, fixture.env, fixture.deps);
  assert.equal(first.headers.get("X-AIFeeds-Home-SSR"), "waterfall");
  await Promise.resolve();

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
