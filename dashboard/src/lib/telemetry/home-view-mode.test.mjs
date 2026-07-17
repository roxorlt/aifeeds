import assert from "node:assert/strict";
import test from "node:test";

import { resolveTelemetryHomeView } from "./home-view-mode.ts";

function root(value) {
  return {
    getAttribute: (name) => name === "data-home-view" ? value : null,
  };
}

test("telemetry home cohort accepts only the finite waterfall marker", () => {
  assert.equal(resolveTelemetryHomeView(root("waterfall")), "waterfall");
  for (const value of ["classic", null, "", "WATERFALL", "other", "<script>"]) {
    assert.equal(resolveTelemetryHomeView(root(value)), "classic");
  }
  assert.equal(resolveTelemetryHomeView(undefined), "classic");
});
