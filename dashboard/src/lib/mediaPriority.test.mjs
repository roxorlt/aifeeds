import assert from "node:assert/strict";
import test from "node:test";

import {
  LAZY_MEDIA_LOAD_POLICY,
  demoteMediaLoadPolicy,
  getMediaLoadPolicy,
  getMediaPriorityTelemetryLabel,
} from "./mediaPriority.ts";

test("only the first row of an immediate column may load eagerly", () => {
  assert.deepEqual(
    getMediaLoadPolicy({ columnIndex: 0, rowIndex: 0, immediate: true }),
    { loading: "eager", fetchPriority: "high" },
  );
  assert.deepEqual(
    getMediaLoadPolicy({ columnIndex: 1, rowIndex: 0, immediate: true }),
    { loading: "eager", fetchPriority: "auto" },
  );
  assert.deepEqual(
    getMediaLoadPolicy({ columnIndex: 3, rowIndex: 0, immediate: false }),
    { loading: "lazy", fetchPriority: "auto" },
  );
  assert.deepEqual(
    getMediaLoadPolicy({ columnIndex: 0, rowIndex: 1, immediate: true }),
    { loading: "lazy", fetchPriority: "auto" },
  );
});

test("a responsive page can produce at most one high-priority media policy", () => {
  for (const immediateColumnCount of [1, 2, 3]) {
    const policies = Array.from({ length: 8 }, (_, columnIndex) =>
      Array.from({ length: 12 }, (_, rowIndex) =>
        getMediaLoadPolicy({
          columnIndex,
          rowIndex,
          immediate: columnIndex < immediateColumnCount,
        }),
      ),
    ).flat();

    assert.equal(
      policies.filter((policy) => policy.fetchPriority === "high").length,
      1,
    );
  }
});

test("secondary media is always lazy and never competes with the LCP candidate", () => {
  assert.deepEqual(
    demoteMediaLoadPolicy({ loading: "eager", fetchPriority: "high" }),
    LAZY_MEDIA_LOAD_POLICY,
  );
  assert.deepEqual(
    demoteMediaLoadPolicy({ loading: "eager", fetchPriority: "auto" }),
    LAZY_MEDIA_LOAD_POLICY,
  );
});

test("telemetry labels preserve loading intent when fetch priority is auto", () => {
  assert.equal(
    getMediaPriorityTelemetryLabel({ loading: "eager", fetchPriority: "high" }),
    "high",
  );
  assert.equal(
    getMediaPriorityTelemetryLabel({ loading: "eager", fetchPriority: "auto" }),
    "eager",
  );
  assert.equal(
    getMediaPriorityTelemetryLabel({ loading: "lazy", fetchPriority: "auto" }),
    "lazy",
  );
});
