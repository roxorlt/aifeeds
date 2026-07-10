import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAWER_EASE,
  EASE_OUT,
  MOTION_DURATION,
  shouldCommitDismiss,
  shouldReduceMotion,
} from "./motion.ts";

test("exports the approved motion tokens", () => {
  assert.equal(EASE_OUT, "cubic-bezier(0.23, 1, 0.32, 1)");
  assert.equal(DRAWER_EASE, "cubic-bezier(0.32, 0.72, 0, 1)");
  assert.deepEqual(MOTION_DURATION, {
    tab: 160,
    popoverEnter: 160,
    popoverExit: 125,
    modalEnter: 220,
    modalExit: 200,
    drawerEnter: 260,
    drawerExit: 200,
    toastEnter: 160,
    toastExit: 110,
  });
});

test("reads reduced-motion through an injectable media-query reader", () => {
  assert.equal(shouldReduceMotion(() => ({ matches: true })), true);
  assert.equal(shouldReduceMotion(() => ({ matches: false })), false);
});

test("dismiss accepts deliberate distance or a short fast flick", () => {
  assert.equal(shouldCommitDismiss({ distance: 90, crossAxis: 10, elapsedMs: 900, viewport: 390 }), true);
  assert.equal(shouldCommitDismiss({ distance: 28, crossAxis: 4, elapsedMs: 100, viewport: 390 }), true);
});

test("dismiss rejects reverse, vertical, and slow short gestures", () => {
  assert.equal(shouldCommitDismiss({ distance: -120, crossAxis: 2, elapsedMs: 100, viewport: 390 }), false);
  assert.equal(shouldCommitDismiss({ distance: 40, crossAxis: 50, elapsedMs: 100, viewport: 390 }), false);
  assert.equal(shouldCommitDismiss({ distance: 30, crossAxis: 3, elapsedMs: 500, viewport: 390 }), false);
});
