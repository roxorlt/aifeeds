import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryBootstrap } from "./bootstrap.ts";

test("global telemetry initializes before an immediately replayed buffered API entry on every route", () => {
  const calls = [];
  const events = [];
  let initialized = false;
  const track = (type, payload) => {
    assert.equal(initialized, true, `${type} emitted before initTelemetry`);
    events.push({ type, payload });
  };
  const bootstrap = createTelemetryBootstrap({
    endpoint: "https://api.ai-feeds.com/api/track",
    events: { APP_OPEN: "app_open", PAGE_VIEW: "page_view", PERF_API: "perf_api" },
    initTelemetry: ({ endpoint }) => {
      calls.push(["init", endpoint]);
      initialized = true;
    },
    installVitals: () => calls.push(["vitals"]),
    installNavTiming: () => calls.push(["nav"]),
    installImgTiming: () => calls.push(["img"]),
    installApiTiming: () => {
      calls.push(["api"]);
      track("perf_api", { endpoint: "items" });
    },
    installErrorHandlers: () => calls.push(["errors"]),
    track,
    location: { pathname: "/settings", search: "?tab=account" },
    referrer: "",
  });

  bootstrap();
  bootstrap();

  assert.equal(calls.filter(([name]) => name === "init").length, 1);
  assert.equal(calls.filter(([name]) => name === "api").length, 1);
  assert.equal(calls[0][0], "init");
  assert.ok(events.some((event) => event.type === "perf_api"));
  assert.ok(events.some((event) => event.type === "app_open"));
  assert.deepEqual(events.find((event) => event.type === "page_view")?.payload, {
    path: "/settings",
  });
});

test("startup attribution stores categories instead of raw query or referrer text", () => {
  const tracked = [];
  const bootstrap = createTelemetryBootstrap(bootstrapDeps({
    location: {
      pathname: "/search",
      search: "?q=alice%40example.com&utm_source=newsletter&utm_campaign=private-token",
    },
    referrer: "https://www.google.com/search?q=alice%40example.com",
    track: (type, payload) => tracked.push({ type, payload }),
  }));

  bootstrap();
  assert.deepEqual(tracked, [
    {
      type: "app_open",
      payload: { utm_source: "newsletter", utm_campaign: "present", referrer: "search" },
    },
    { type: "page_view", payload: { path: "/search" } },
  ]);
  assert.doesNotMatch(JSON.stringify(tracked), /alice|private-token|google\.com/);
});

function bootstrapDeps(overrides = {}) {
  return {
    endpoint: "https://api.ai-feeds.com/api/track",
    events: { APP_OPEN: "app_open", PAGE_VIEW: "page_view" },
    initTelemetry: () => {},
    installVitals: () => {},
    installNavTiming: () => {},
    installImgTiming: () => {},
    installApiTiming: () => {},
    installErrorHandlers: () => {},
    track: () => {},
    location: { pathname: "/", search: "" },
    referrer: "",
    ...overrides,
  };
}

test("a throwing telemetry init fails open, disables installers, and remains idempotent", () => {
  const calls = [];
  const bootstrap = createTelemetryBootstrap(bootstrapDeps({
    initTelemetry: () => {
      calls.push("init");
      throw new Error("storage unavailable");
    },
    installVitals: () => calls.push("vitals"),
    track: (type) => calls.push(type),
  }));

  assert.doesNotThrow(() => bootstrap());
  assert.doesNotThrow(() => bootstrap());
  assert.deepEqual(calls, ["init"]);
});

test("a throwing installer is isolated while later installers and startup events continue", () => {
  const calls = [];
  const bootstrap = createTelemetryBootstrap(bootstrapDeps({
    initTelemetry: () => calls.push("init"),
    installErrorHandlers: () => calls.push("errors"),
    installVitals: () => {
      calls.push("vitals");
      throw new Error("PerformanceObserver unavailable");
    },
    installNavTiming: () => calls.push("nav"),
    installImgTiming: () => calls.push("img"),
    installApiTiming: () => calls.push("api"),
    track: (type) => calls.push(type),
  }));

  assert.doesNotThrow(() => bootstrap());
  assert.doesNotThrow(() => bootstrap());
  assert.deepEqual(calls, [
    "init", "errors", "vitals", "nav", "img", "api", "app_open", "page_view",
  ]);
});

test("a throwing startup track call cannot abort the next event or escape bootstrap", () => {
  const tracked = [];
  const bootstrap = createTelemetryBootstrap(bootstrapDeps({
    track: (type) => {
      tracked.push(type);
      if (type === "app_open") throw new Error("queue rejected event");
    },
  }));

  assert.doesNotThrow(() => bootstrap());
  assert.doesNotThrow(() => bootstrap());
  assert.deepEqual(tracked, ["app_open", "page_view"]);
});
