import assert from "node:assert/strict";
import test from "node:test";

import { acquireScrollLock } from "./useScrollLock.ts";

test("nested scroll locks restore the original target out of cleanup order", () => {
  const target = { style: { overflow: "auto" }, scrollTop: 42 };
  const releaseOuter = acquireScrollLock(target, true);
  target.scrollTop = 99;
  const releaseInner = acquireScrollLock(target, true);

  assert.equal(target.style.overflow, "hidden");
  releaseOuter();
  assert.equal(target.style.overflow, "hidden");
  assert.equal(target.scrollTop, 99);

  releaseInner();
  assert.equal(target.style.overflow, "auto");
  assert.equal(target.scrollTop, 42);
  releaseInner();
  assert.equal(target.style.overflow, "auto");
});
