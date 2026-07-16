import assert from "node:assert/strict";
import test from "node:test";
import { updateObservedImpressionElement } from "./impressionElementLifecycle.ts";
import { capturePosterFromRef } from "./posterCapture.ts";
import { isTcoOnly } from "./tcoResolvedLink.ts";
import { createTurnstileCallbackBridge } from "./turnstileCallbackBridge.ts";
import { articleTier } from "./xArticleTier.ts";

test("isTcoOnly accepts one t.co URL and rejects surrounding content", () => {
  assert.equal(isTcoOnly(" https://t.co/abc123 \n"), true);
  assert.equal(isTcoOnly("read https://t.co/abc123"), false);
  assert.equal(isTcoOnly(null), false);
});

test("articleTier preserves rich, mid, and basic classification", () => {
  assert.equal(articleTier({ fetched_at: "2026-07-11", title: "A" }), "rich");
  assert.equal(
    articleTier({ fetch_failed_at: "2026-07-11", author_handle: "author" }),
    "mid",
  );
  assert.equal(articleTier({ title: "missing fetched_at" }), "basic");
  assert.equal(articleTier(undefined), "basic");
});

test("capturePosterFromRef delegates to the mounted canvas and rejects a missing canvas", async () => {
  const expected = new Blob(["poster"], { type: "image/png" });
  const actual = await capturePosterFromRef({
    current: { capture: async () => expected },
  });

  assert.equal(actual, expected);
  await assert.rejects(
    () => capturePosterFromRef({ current: null }),
    /PosterCanvas not mounted/,
  );
});

test("Turnstile SDK-owned callbacks dispatch to the latest React handlers", () => {
  const calls = [];
  const bridge = createTurnstileCallbackBridge({
    onToken: (token) => calls.push(`old-token:${token}`),
    onError: (message) => calls.push(`old-error:${message}`),
    onExpire: () => calls.push("old-expire"),
  });
  const sdkOnToken = bridge.onToken;
  const sdkOnError = bridge.onError;
  const sdkOnExpire = bridge.onExpire;

  bridge.update({
    onToken: (token) => calls.push(`new-token:${token}`),
    onError: (message) => calls.push(`new-error:${message}`),
    onExpire: () => calls.push("new-expire"),
  });
  sdkOnToken("verified");
  sdkOnError("network");
  sdkOnExpire();

  assert.deepEqual(calls, [
    "new-token:verified",
    "new-error:network",
    "new-expire",
  ]);
});

test("an impression item change cancels the old dwell and registers only the new id", () => {
  const pending = new WeakMap();
  const observed = [];
  const unobserved = [];
  const cleared = [];
  const lifecycle = {
    pending,
    observe: (node) => observed.push(node),
    unobserve: (node) => unobserved.push(node),
    clearTimer: (timer) => cleared.push(timer),
  };
  const node = {};
  const elementRef = { current: null };

  updateObservedImpressionElement(node, "old-id", elementRef, lifecycle);
  pending.get(node).timer = 41;

  // React callback-ref ordering on a dependency change: old(null), then new(node).
  updateObservedImpressionElement(null, null, elementRef, lifecycle);
  updateObservedImpressionElement(node, "new-id", elementRef, lifecycle);

  assert.deepEqual(cleared, [41]);
  assert.deepEqual(unobserved, [node]);
  assert.deepEqual(observed, [node, node]);
  assert.deepEqual(pending.get(node), { itemId: "new-id", timer: null });
  assert.equal(elementRef.current, node);
});
