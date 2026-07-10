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
    path: "/settings?tab=account",
  });
});
