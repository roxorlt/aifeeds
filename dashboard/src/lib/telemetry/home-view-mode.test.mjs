import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTelemetryHomeSsrState,
  resolveTelemetryHomeView,
} from "./home-view-mode.ts";

function root(value, attribute = "data-home-view") {
  return {
    getAttribute: (name) => name === attribute ? value : null,
  };
}

test("telemetry home cohort accepts only the finite waterfall marker", () => {
  assert.equal(resolveTelemetryHomeView(root("waterfall")), "waterfall");
  for (const value of ["classic", null, "", "WATERFALL", "other", "<script>"]) {
    assert.equal(resolveTelemetryHomeView(root(value)), "classic");
  }
  assert.equal(resolveTelemetryHomeView(undefined), "classic");
});

test("telemetry home SSR state accepts only finite cache and fallback diagnostics", () => {
  for (const value of ["classic", "generated", "fresh", "stale", "fallback"]) {
    assert.equal(resolveTelemetryHomeSsrState(root(value, "data-home-ssr")), value);
  }
  for (const value of [null, "", "STALE", "other", "<script>"]) {
    assert.equal(resolveTelemetryHomeSsrState(root(value, "data-home-ssr")), "classic");
  }
  assert.equal(resolveTelemetryHomeSsrState(undefined), "classic");
});
