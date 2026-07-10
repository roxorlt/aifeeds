import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiTimingDetail,
  classifyApiEndpoint,
  classifyResourceUrl,
  createFeedReadyScheduler,
  installApiResourceObserver,
  safeLcpDescriptor,
  safeLcpDescriptorFromMetric,
} from "./performance-detail.ts";

const PAGE_ORIGIN = "https://ai-feeds.com";

test("classifies only privacy-safe resource categories", () => {
  assert.deepEqual(
    classifyResourceUrl("https://api.ai-feeds.com/r/x/a.jpg", PAGE_ORIGIN),
    { kind: "r2", origin_class: "api" },
  );
  assert.deepEqual(
    classifyResourceUrl("https://api.ai-feeds.com/img?url=https%3A%2F%2Fsecret.example%2Fa.jpg", PAGE_ORIGIN),
    { kind: "img_proxy", origin_class: "api" },
  );
  assert.deepEqual(
    classifyResourceUrl("https://ai-feeds.com/assets/index-secret.js", PAGE_ORIGIN),
    { kind: "static_asset", origin_class: "same_origin" },
  );
  assert.deepEqual(
    classifyResourceUrl("https://cdn-thumbnails.huggingface.co/social/a.png", PAGE_ORIGIN),
    { kind: "third_party_hf", origin_class: "third_party" },
  );
  assert.deepEqual(
    classifyResourceUrl("https://wimg.huodongxing.com/path/a.jpg", PAGE_ORIGIN),
    { kind: "third_party_hdx", origin_class: "third_party" },
  );
  assert.deepEqual(
    classifyResourceUrl("https://media.example/author/private-title.jpg?token=secret", PAGE_ORIGIN),
    { kind: "other_third_party", origin_class: "third_party" },
  );
  assert.deepEqual(classifyResourceUrl("", PAGE_ORIGIN), { kind: "none", origin_class: "none" });
  assert.deepEqual(classifyResourceUrl("not a url", PAGE_ORIGIN), { kind: "none", origin_class: "none" });
});

test("safe LCP descriptor cannot leak element content, attributes, URL, or CSS classes", () => {
  const feed = {
    getAttribute(name) {
      return name === "data-feed-source" ? "github" : null;
    },
  };
  const element = {
    tagName: "IMG",
    textContent: "private card title",
    src: "https://private.example/item/123?author=alice",
    href: "/item/123",
    className: "secret-title author-alice",
    getAttribute(name) {
      return name === "data-media-priority" ? "high" : null;
    },
    closest(selector) {
      return selector === "[data-feed-source]" ? feed : null;
    },
  };

  const detail = safeLcpDescriptor(
    {
      element,
      url: "https://api.ai-feeds.com/r/github/private-title.jpg?item_id=123",
    },
    PAGE_ORIGIN,
  );

  assert.deepEqual(detail, {
    tag: "img",
    resource_kind: "r2",
    source_type: "github",
    media_priority: "high",
  });
  assert.deepEqual(Object.keys(detail).sort(), [
    "media_priority",
    "resource_kind",
    "source_type",
    "tag",
  ]);
  const serialized = JSON.stringify(detail);
  for (const secret of ["private", "alice", "123", "http", "item_id", "secret-title"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test("safe LCP descriptor uses bounded tag/source/priority enums", () => {
  const element = {
    tagName: "P",
    getAttribute() {
      return "author email or arbitrary data";
    },
    closest() {
      return { getAttribute: () => "not-a-real-source/private" };
    },
  };
  assert.deepEqual(safeLcpDescriptor({ element, url: "" }, PAGE_ORIGIN), {
    tag: "text",
    resource_kind: "none",
  });
  assert.deepEqual(safeLcpDescriptor({ element: null, url: "" }, PAGE_ORIGIN), {
    tag: "other",
    resource_kind: "none",
  });
});

test("safe LCP priority reads bounded native image attributes used by production cards", () => {
  const nativeHigh = {
    tagName: "IMG",
    getAttribute(name) {
      if (name === "fetchpriority") return "high";
      if (name === "loading") return "lazy";
      return null;
    },
    closest: () => null,
  };
  assert.deepEqual(safeLcpDescriptor({ element: nativeHigh, url: "" }, PAGE_ORIGIN), {
    tag: "img",
    resource_kind: "none",
    media_priority: "high",
  });

  const nativeEager = {
    tagName: "IMG",
    getAttribute: (name) => (name === "loading" ? "eager" : null),
    closest: () => null,
  };
  assert.equal(safeLcpDescriptor({ element: nativeEager, url: "" }, PAGE_ORIGIN).media_priority, "eager");
});

test("LCP enrichment uses the final entry supplied by web-vitals", () => {
  const node = (source) => ({
    tagName: "IMG",
    getAttribute: () => null,
    closest: () => ({ getAttribute: () => source }),
  });
  const detail = safeLcpDescriptorFromMetric(
    {
      entries: [
        { element: node("x_list"), url: "https://api.ai-feeds.com/r/x/first.jpg" },
        { element: node("hf_paper"), url: "https://cdn-thumbnails.huggingface.co/final.jpg" },
      ],
    },
    PAGE_ORIGIN,
  );
  assert.deepEqual(detail, {
    tag: "img",
    resource_kind: "third_party_hf",
    source_type: "hf_paper",
  });
});

test("classifies only the fixed API endpoint categories", () => {
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/items?source_type=x_list"), "items");
  assert.equal(classifyApiEndpoint("https://ai-feeds.com/api/feed-manifest?v=2"), "feed_manifest");
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/sources"), "sources");
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/stats"), "stats");
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/auth/me"), "auth_me");
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/items/secret-id"), null);
  assert.equal(classifyApiEndpoint("https://api.ai-feeds.com/api/search?q=secret"), null);
  assert.equal(classifyApiEndpoint("malformed"), null);
});

test("API timing payload contains only a fixed endpoint category and finite non-negative phases", () => {
  const detail = buildApiTimingDetail(
    {
      name: "https://api.ai-feeds.com/api/items?source_type=github&token=secret",
      initiatorType: "fetch",
      startTime: 10,
      domainLookupStart: 12,
      domainLookupEnd: 14,
      connectStart: 14,
      secureConnectionStart: 15,
      connectEnd: 20,
      requestStart: 22,
      responseStart: 42,
      responseEnd: 70,
      transferSize: 2048,
    },
    PAGE_ORIGIN,
  );
  assert.deepEqual(detail, {
    endpoint: "items",
    dns: 2,
    connect: 6,
    tls: 5,
    request: 20,
    response: 28,
    total: 60,
    transfer_kb: 2,
    initiator: "fetch",
    same_origin: false,
  });
  assert.equal(JSON.stringify(detail).includes("github"), false);
  assert.equal(JSON.stringify(detail).includes("secret"), false);

  const clamped = buildApiTimingDetail(
    {
      name: "https://ai-feeds.com/api/stats",
      initiatorType: "fetch",
      startTime: 20,
      domainLookupStart: Number.NaN,
      domainLookupEnd: 1,
      connectStart: 10,
      secureConnectionStart: 0,
      connectEnd: 5,
      requestStart: 9,
      responseStart: 8,
      responseEnd: 7,
      transferSize: -1,
    },
    PAGE_ORIGIN,
  );
  assert.deepEqual(clamped, {
    endpoint: "stats",
    dns: 0,
    connect: 0,
    tls: 0,
    request: 0,
    response: 0,
    total: 0,
    transfer_kb: 0,
    initiator: "fetch",
    same_origin: true,
  });
});

test("API observer reports only fetches to fixed endpoint categories and never a raw name", () => {
  let callback;
  let observed;
  let disconnected = false;
  class FakeObserver {
    constructor(cb) {
      callback = cb;
    }
    observe(options) {
      observed = options;
    }
    disconnect() {
      disconnected = true;
    }
  }
  const base = {
    initiatorType: "fetch",
    startTime: 0,
    domainLookupStart: 0,
    domainLookupEnd: 0,
    connectStart: 0,
    secureConnectionStart: 0,
    connectEnd: 0,
    requestStart: 1,
    responseStart: 2,
    responseEnd: 3,
    transferSize: 1024,
  };
  const reports = [];
  const cleanup = installApiResourceObserver({
    ObserverCtor: FakeObserver,
    pageOrigin: PAGE_ORIGIN,
    deviceMeta: () => ({ nettype: "4g" }),
    report: (detail) => reports.push(detail),
  });
  assert.deepEqual(observed, { type: "resource", buffered: true });
  callback({
    getEntries: () => [
      { ...base, name: "https://api.ai-feeds.com/api/items?private=query" },
      { ...base, name: "https://api.ai-feeds.com/api/search?q=private" },
      { ...base, name: "https://api.ai-feeds.com/api/stats", initiatorType: "xmlhttprequest" },
      { ...base, name: "https://api.ai-feeds.com/api/auth/me" },
    ],
  });
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((r) => r.endpoint), ["items", "auth_me"]);
  assert.equal(reports.every((r) => r.nettype === "4g"), true);
  assert.equal(reports.some((r) => "name" in r || "url" in r || "path" in r), false);
  cleanup();
  assert.equal(disconnected, true);
});

test("API observer gracefully no-ops when PerformanceObserver is unsupported", () => {
  assert.doesNotThrow(() => {
    const cleanup = installApiResourceObserver({
      ObserverCtor: null,
      report: () => assert.fail("must not report"),
    });
    cleanup();
  });
});

test("feed_ready scheduler keeps other Feed contenders alive when the first unmounts", () => {
  const frames = new Map();
  const reports = [];
  let id = 0;
  const scheduler = createFeedReadyScheduler({
    requestFrame: (cb) => {
      id += 1;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (frameId) => frames.delete(frameId),
    report: (payload) => reports.push(payload),
  });
  const first = {
    source_type: "x_list",
    item_count: 12,
    data_source: "network",
    query_time_ms: 223,
  };
  const second = { source_type: "github", item_count: 8, data_source: "memory_cache" };

  const cancel = scheduler.schedule(first);
  scheduler.schedule(second);
  assert.deepEqual(reports, []);
  cancel();
  frames.get([...frames.keys()][0])();
  assert.deepEqual(reports, [second]);
  scheduler.schedule(first);
  assert.deepEqual(reports, [second]);
});

test("feed_ready scheduler atomically reports only the first frame when contenders both paint", () => {
  const frames = [];
  const reports = [];
  const scheduler = createFeedReadyScheduler({
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    report: (payload) => reports.push(payload),
  });
  const first = { source_type: "x_list", item_count: 12, data_source: "network" };
  const second = { source_type: "github", item_count: 8, data_source: "memory_cache" };
  scheduler.schedule(first);
  scheduler.schedule(second);
  assert.equal(frames.length, 2);
  frames[1]();
  frames[0]();
  assert.deepEqual(reports, [second]);
});
