import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isStagingSeoProxyRequest,
  maybeProxyStagingSeoRequest,
  proxyStagingSeoRequest,
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

test("staging SEO proxy preserves method and query while targeting the Worker origin", async () => {
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
  const response = await proxyStagingSeoRequest(request, async (nextRequest) => {
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

test("Pages routes invoke the staging proxy for daily and video sitemap requests", () => {
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
