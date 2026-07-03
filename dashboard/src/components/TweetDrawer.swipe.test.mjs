import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./TweetDrawer.tsx", import.meta.url), "utf8");

test("drawer swipe-to-close can claim horizontal gestures inside the scroll body", () => {
  assert.match(source, /aside\.addEventListener\("touchmove", onMove, \{ passive: false \}\)/);
  assert.match(source, /e\.preventDefault\(\)/);
  assert.doesNotMatch(source, /touch-pan-y/);
  assert.match(source, /allow native vertical scroll/);
});
