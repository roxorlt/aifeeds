import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryLifecycle } from "./runtime-state.ts";

test("a partial telemetry init disables the runtime, drops later work, and never retries", () => {
  const lifecycle = createTelemetryLifecycle();
  const calls = [];

  assert.throws(() => lifecycle.initialize(() => {
    calls.push("init");
    throw new Error("pagehide listener rejected");
  }), /pagehide listener rejected/);
  assert.equal(lifecycle.state(), "disabled");

  assert.equal(lifecycle.runIfReady(() => calls.push("track")), false);
  assert.equal(lifecycle.initialize(() => calls.push("retry")), false);
  assert.deepEqual(calls, ["init"]);
});

test("telemetry work becomes available only after the complete initializer succeeds", () => {
  const lifecycle = createTelemetryLifecycle();
  const calls = [];

  assert.equal(lifecycle.runIfReady(() => calls.push("too-early")), false);
  assert.equal(lifecycle.initialize(() => calls.push("init")), true);
  assert.equal(lifecycle.state(), "ready");
  assert.equal(lifecycle.runIfReady(() => calls.push("track")), true);
  assert.equal(lifecycle.initialize(() => calls.push("duplicate")), true);
  assert.deepEqual(calls, ["init", "track"]);
});

test("a runtime telemetry failure is swallowed and disables later work", () => {
  const lifecycle = createTelemetryLifecycle();
  lifecycle.initialize(() => {});

  assert.doesNotThrow(() => {
    assert.equal(lifecycle.runIfReady(() => {
      throw new Error("queue write failed");
    }), false);
  });
  assert.equal(lifecycle.state(), "disabled");
  assert.equal(lifecycle.runIfReady(() => {
    throw new Error("must not run");
  }), false);
});
