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

test("drawer swipe supports velocity dismissal and protects the active touch", () => {
  assert.match(source, /shouldCommitDismiss/);
  assert.match(source, /e\.touches\.length !== 1/);
  assert.match(source, /identifier/);
  assert.doesNotMatch(source, /SWIPE_COMMIT_PX|setTimeout\(close, SWIPE_ANIM_MS\)/);
});

test("drawer drag writes transform and backdrop opacity without React frame state", () => {
  assert.doesNotMatch(source, /const \[dragX, setDragX\]/);
  assert.match(source, /aside\.style\.transform/);
  assert.match(source, /backdropRef\.current/);
  assert.match(source, /style\.opacity/);
});

test("drawer completes an asymmetric exit before ordinary close", () => {
  assert.match(source, /DRAWER_ENTER_MS = 260/);
  assert.match(source, /DRAWER_EXIT_MS = 200/);
  assert.match(source, /requestClose/);
  assert.match(source, /onClick=\{requestClose\}/);
});

test("drawer restores its visible position when closing back to an earlier depth", () => {
  assert.match(source, /drawerActivationMode/);
  assert.match(source, /closeTimerRef\.current = null/);
  assert.match(
    source,
    /\[open, item\?\.id, depth, applyDrawerPosition\]/,
  );
});
