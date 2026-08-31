import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isSeoProxyRequest,
  isStagingSeoProxyRequest,
  maybeProxySeoRequest,
  maybeProxyStagingSeoRequest,
  proxySeoRequest,
} from "./seo-proxy.ts";

test("only the staging Pages hostname proxies the selected SEO routes", () => {
  for (const pathname of [
    "/daily",
    "/daily/2026-07-14",
    "/video/daily/2026-07-14",
    "/sitemap-daily.xml",
    "/video-sitemap.xml",
  ]) {
    assert.equal(
      isStagingSeoProxyRequest(
        new Request(`https://staging.ai-feeds.com${pathname}`),
      ),
      true,
      `staging must proxy ${pathname}`,
    );
  }
  assert.equal(
    isStagingSeoProxyRequest(
      new Request("https://ai-feeds.com/video/daily/2026-07-14"),
    ),
    false,
  );
  assert.equal(
    isStagingSeoProxyRequest(
      new Request("https://staging.ai-feeds.com/search?q=video"),
    ),
    false,
  );
});

test("configured Pages hosts proxy only the selected SEO routes", () => {
  const seoPaths = [
    "/daily",
    "/daily/2026-07-14",
    "/video/daily/2026-07-14",
    "/sitemap-daily.xml",
    "/video-sitemap.xml",
  ];
  for (const hostname of [
    "staging.ai-feeds.com",
    "xlist-dashboard.pages.dev",
    "ai-feeds.com",
    "www.ai-feeds.com",
  ]) {
    for (const pathname of seoPaths) {
      assert.equal(
        isSeoProxyRequest(new Request(`https://${hostname}${pathname}`)),
        true,
        `${hostname} must proxy ${pathname}`,
      );
    }
  }

  assert.equal(
    isSeoProxyRequest(
      new Request("https://unknown.example/video/daily/2026-07-14"),
    ),
    false,
  );
  assert.equal(
    isSeoProxyRequest(
      new Request("https://ai-feeds.com/search?q=video"),
    ),
    false,
  );
});

test("staging SEO proxy preserves method and query while targeting the staging Worker", async () => {
  const request = new Request(
    "https://staging.ai-feeds.com/sitemap-daily.xml?source=watch",
    { method: "HEAD", headers: { "X-AIFeeds-Test": "preserved" } },
  );
  let forwarded;

  const upstream = new Response("<?xml version=\"1.0\"?>", {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
  const response = await proxySeoRequest(request, async (nextRequest) => {
    forwarded = nextRequest;
    return upstream;
  });

  assert.equal(response, upstream, "proxy must return the upstream response unchanged");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.ok(forwarded instanceof Request);
  assert.equal(
    forwarded.url,
    "https://staging-api.ai-feeds.com/sitemap-daily.xml?source=watch",
  );
  assert.equal(forwarded.method, "HEAD");
  assert.equal(forwarded.headers.get("X-AIFeeds-Test"), "preserved");
});

test("production SEO requests never call the staging Worker", async () => {
  let calls = 0;
  const response = await maybeProxyStagingSeoRequest(
    new Request("https://ai-feeds.com/video/daily/2026-07-14"),
    async () => {
      calls += 1;
      return new Response("unexpected");
    },
  );

  assert.equal(response, null);
  assert.equal(calls, 0);
});

test("production Pages SEO requests proxy to the production Worker", async () => {
  const request = new Request(
    "https://xlist-dashboard.pages.dev/video/daily/2026-08-31?source=sitemap",
    { headers: { "X-AIFeeds-Test": "production" } },
  );
  const upstream = new Response("watch page", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  let forwarded;

  const response = await maybeProxySeoRequest(
    request,
    async (nextRequest) => {
      forwarded = nextRequest;
      return upstream;
    },
  );

  assert.equal(response, upstream);
  assert.ok(forwarded instanceof Request);
  assert.equal(
    forwarded.url,
    "https://api.ai-feeds.com/video/daily/2026-08-31?source=sitemap",
  );
  assert.equal(forwarded.headers.get("X-AIFeeds-Test"), "production");
});

test("all production host aliases use the production Worker without changing the request", async () => {
  for (const hostname of [
    "xlist-dashboard.pages.dev",
    "ai-feeds.com",
    "www.ai-feeds.com",
  ]) {
    const request = new Request(
      `https://${hostname}/video/daily/2026-08-31?source=review&version=4`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-AIFeeds-Test": hostname,
        },
        body: `payload:${hostname}`,
      },
    );
    const upstream = new Response(`upstream:${hostname}`, {
      status: 203,
      headers: { "X-Upstream": hostname },
    });
    let forwarded;

    const response = await maybeProxySeoRequest(request, async (nextRequest) => {
      forwarded = nextRequest;
      return upstream;
    });

    assert.equal(response, upstream);
    assert.equal(response.status, 203);
    assert.equal(response.headers.get("X-Upstream"), hostname);
    assert.ok(forwarded instanceof Request);
    assert.equal(
      forwarded.url,
      "https://api.ai-feeds.com/video/daily/2026-08-31?source=review&version=4",
    );
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.headers.get("X-AIFeeds-Test"), hostname);
    assert.equal(await forwarded.text(), `payload:${hostname}`);
  }
});

test("unknown hosts and non-SEO paths do not invoke a proxy upstream", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response("unexpected");
  };

  assert.equal(
    await maybeProxySeoRequest(
      new Request("https://unknown.example/video/daily/2026-08-31"),
      fetcher,
    ),
    null,
  );
  assert.equal(
    await maybeProxySeoRequest(
      new Request("https://ai-feeds.com/search?q=video"),
      fetcher,
    ),
    null,
  );
  assert.equal(calls, 0);
});

test("Pages routes invoke the SEO proxy for daily and video sitemap requests", () => {
  const routes = JSON.parse(
    readFileSync(new URL("../public/_routes.json", import.meta.url), "utf8"),
  );
  for (const path of [
    "/daily",
    "/daily/*",
    "/video/daily/*",
    "/sitemap-daily.xml",
    "/video-sitemap.xml",
  ]) {
    assert.ok(routes.include.includes(path), `missing Pages include for ${path}`);
    assert.ok(!routes.exclude.includes(path), `unexpected Pages exclude for ${path}`);
  }
});
