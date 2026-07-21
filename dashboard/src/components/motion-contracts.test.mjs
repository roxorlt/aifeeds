import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const feed = fs.readFileSync(path.join(here, "Feed.tsx"), "utf8");
const tweet = fs.readFileSync(path.join(here, "TweetCard.tsx"), "utf8");
const userMenu = fs.readFileSync(path.join(here, "UserMenu.tsx"), "utf8");
const huodongxingHeader = fs.readFileSync(
  path.join(here, "HuodongxingColumnHeader.tsx"),
  "utf8",
);
const toast = fs.readFileSync(path.join(here, "Toast.tsx"), "utf8");
const quoteSnapshotModal = fs.readFileSync(
  path.join(here, "QuoteSnapshotModal.tsx"),
  "utf8",
);
const css = fs.readFileSync(path.join(here, "../index.css"), "utf8");

test("pull-to-refresh updates a fixed indicator with transform and opacity", () => {
  assert.doesNotMatch(feed, /const \[pullY, setPullY\]/);
  assert.doesNotMatch(feed, /height:\s*isRefreshingPull|"height 200ms/);
  assert.match(feed, /pullIndicatorRef/);
  assert.match(feed, /style\.transform/);
  assert.match(feed, /style\.opacity/);
});

test("pull-to-refresh owns one touch, yields horizontal intent, and never commits on cancel", () => {
  assert.match(feed, /resolveChannelSwipeIntent\(dx, dy\)/);
  assert.match(feed, /pullTouchId\.current = touch\.identifier/);
  assert.match(feed, /touch\.identifier === pullTouchId\.current/);
  assert.match(feed, /intent === "horizontal"/);
  assert.match(feed, /window\.addEventListener\("touchcancel", onCancel\)/);
  const cancelHandler = feed.match(/const onCancel = \(\) => \{([\s\S]*?)\n    \};/)?.[1] ?? "";
  assert.match(cancelHandler, /resetPullGesture\(true\)/);
  assert.doesNotMatch(cancelHandler, /setRetryTick|setIsRefreshingPull/);
  const refreshBranch = feed.match(/if \(shouldRefresh\) \{([\s\S]*?)\n      \}/)?.[1] ?? "";
  assert.match(refreshBranch, /setLoading\(true\)/);
  assert.ok(
    refreshBranch.indexOf("setLoading(true)") < refreshBranch.indexOf("setRetryTick"),
    "the refresh must enter a durable loading state before retryTick starts the request",
  );
  const reset = feed.match(/const resetPullGesture = \(animate: boolean\) => \{([\s\S]*?)\n    \};/)?.[1] ?? "";
  assert.match(reset, /!isRefreshingPull/);
  assert.doesNotMatch(reset, /!loadingRef\.current/);
  const pullEffect = feed.slice(
    feed.indexOf("// Native touch listeners"),
    feed.indexOf("// Hot mode:"),
  );
  assert.match(pullEffect, /if \(!isNarrowFeed\) return;/);
  assert.doesNotMatch(pullEffect, /if \(!window\.matchMedia\("\(max-width: 767px\)"\)\.matches\) return;/);
  assert.match(pullEffect, /\[[^\]]*isNarrowFeed[^\]]*\]\);/);
});

test("card image hover movement is gated to fine pointers", () => {
  assert.doesNotMatch(tweet, /transition-transform hover:scale-\[1\.02\]/);
  assert.match(tweet, /motion-card-media/);
  assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
  assert.match(css, /\.motion-card-media:hover/);
});

test("global reduced motion keeps feedback but removes movement and loops", () => {
  const reducedBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /0\.001ms/);
  assert.match(css, /scroll-behavior:\s*auto/);
  assert.match(css, /\.animate-spin,[\s\S]*\.animate-pulse\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /\.motion-card-media\s*\{[\s\S]*transform:\s*none/);
  assert.match(
    css,
    /\.motion-layer,[\s\S]*transition-property:\s*opacity, color, background-color[\s\S]*transition-duration:\s*120ms/,
  );
  assert.match(
    css,
    /\.motion-pull-indicator[\s\S]*transition-property:\s*opacity, color, background-color[\s\S]*transition-duration:\s*120ms/,
  );
  assert.match(
    reducedBlock,
    /\.motion-layer,\s*\.motion-layer-popover\s*\{[\s\S]*animation:\s*motion-layer-enter 120ms/,
  );
  assert.match(reducedBlock, /\.motion-layer-panel\s*\{[\s\S]*animation:\s*none/);
});

test("layer entrances do not depend on starting-style support", () => {
  assert.match(css, /@keyframes\s+motion-layer-enter/);
  assert.match(css, /@keyframes\s+motion-popover-enter/);
  assert.doesNotMatch(css, /@starting-style/);
});

test("Escape closes both popovers immediately while pointer dismissals may animate", () => {
  for (const source of [userMenu, huodongxingHeader]) {
    assert.match(source, /if \(e\.key === "Escape"\) setOpen\(false\);/);
    assert.match(source, /contains\(e\.target as Node\)\) requestClose\(\)/);
  }
});

test("toast entrance and exit are transition-based and interruptible", () => {
  assert.doesNotMatch(css, /@keyframes\s+motion-toast-enter/);
  assert.doesNotMatch(css, /\.motion-toast\s*\{[^}]*animation\s*:/);
  assert.match(toast, /requestAnimationFrame/);
  assert.match(toast, /data-mounted=\{entered && !it\.leaving \? 'true' : 'false'\}/);
  assert.match(css, /\.motion-toast\[data-mounted="false"\]\s*\{/);
  assert.match(css, /transition:\s*[\s\S]*opacity 160ms[\s\S]*transform 160ms/);
});

test("quote snapshot is a mobile sheet and a desktop modal", () => {
  assert.match(quoteSnapshotModal, /useMotionDismiss\(closeModal, "sheet", Boolean\(quote\)\)/);
  assert.match(quoteSnapshotModal, /motion-layer-adaptive/);
  assert.match(quoteSnapshotModal, /activateModalFocus\(panel,\s*\{[\s\S]*?onEscape:/);
  assert.doesNotMatch(quoteSnapshotModal, /window\.addEventListener\("keydown"/);
  assert.match(
    css,
    /@media\s*\(min-width:\s*640px\)[\s\S]*\.motion-layer-adaptive\.motion-layer-sheet \.motion-layer-panel\s*\{[\s\S]*animation-name:\s*motion-modal-enter/,
  );
  assert.match(
    css,
    /\.motion-layer-adaptive\.motion-layer-sheet\.motion-layer-leaving \.motion-layer-panel\s*\{[\s\S]*transform:\s*translateY\(8px\) scale\(0\.97\)/,
  );
});
