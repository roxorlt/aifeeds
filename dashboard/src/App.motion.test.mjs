import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(here, "index.css"), "utf8");
const reducedMotionHookPath = path.join(here, "lib/useReducedMotion.ts");
const reducedMotionHook = fs.existsSync(reducedMotionHookPath)
  ? fs.readFileSync(reducedMotionHookPath, "utf8")
  : "";

test("channel click does not mount a timed skeleton wash", () => {
  assert.doesNotMatch(source, /transitionActive/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => setTransitionActive/);
  assert.doesNotMatch(source, /opacity 220ms ease-out/);
});

test("active channel indicator is a single transform-only pill", () => {
  assert.doesNotMatch(source, /useFancyAnimation|inkPill|pillBRef|bridgePathRef|feGaussianBlur/);
  assert.doesNotMatch(source, /width 220ms|height 220ms/);
  assert.match(source, /transform 160ms cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
});

test("channel indicator has no idle perpetual animation loop", () => {
  assert.doesNotMatch(source, /const tick = \(\) =>[\s\S]*requestAnimationFrame\(tick\)/);
});

test("horizontal swipe preserves the current header visibility", () => {
  assert.match(source, /swipeAdjacent[^\n]*top: number/);
  assert.doesNotMatch(source, /if \(transitionActive \|\| swipeAdjacent\)[\s\S]*hideRatioRef\.current = 0/);
});

test("PC top-bar scroll animates only the last interacted column", () => {
  assert.match(source, /lastInteractedColumnRef/);
  assert.match(source, /instant: columnId !== animatedColumnId/);
  assert.doesNotMatch(source, /feedRefs\.current\.forEach\(\(handle\) => handle\?\.scrollToTop\(\)\)/);
});

test("reduced motion makes channel focus movement immediate", () => {
  assert.match(source, /motion-channel-pill/);
  assert.match(source, /behavior: reduceMotion \? "auto" : "smooth"/);
  assert.match(css, /\.motion-channel-pill[\s\S]*transition:\s*none\s*!important/);
});

test("reduced motion keeps the mobile header visible", () => {
  assert.match(source, /if \(!isNarrow \|\| reduceMotion\) \{/);
  assert.match(source, /hideRatioRef\.current = 0;[\s\S]*apply\(0\);/);
});

test("reduced motion changes channels without swipe or pill transforms", () => {
  assert.match(source, /const reduceMotion = useReducedMotion\(\);/);
  assert.doesNotMatch(source, /const reduceMotion = shouldReduceMotion\(\);/);
  assert.match(source, /if \(reduceMotion\) return;[\s\S]*applyMainTransform\(dampened, false\)/);
  assert.match(
    source,
    /if \(reduceMotion\) \{[\s\S]*switchChannelRef\.current\([\s\S]*resetInkToActive\([\s\S]*false\);[\s\S]*return;/,
  );
});

test("channel swipe settle is cancellable and does not own raw transition listeners", () => {
  assert.match(source, /watchTransformTransition/);
  assert.match(source, /cancelPendingSettle\(\)/);
  assert.doesNotMatch(source, /el\.addEventListener\('transitionend', onTransitionEnd\)/);
});

test("mobile header cleanup cancels its pending scroll frame and restores the PC header", () => {
  assert.match(source, /let scrollRaf: number \| null = null;/);
  assert.match(source, /scrollRaf = requestAnimationFrame\(\(\) => \{[\s\S]*scrollRaf = null;/);
  assert.match(
    source,
    /return \(\) => \{[\s\S]*removeScrollListener\(\);[\s\S]*cancelAnimationFrame\(scrollRaf\)[\s\S]*hideRatioRef\.current = 0;[\s\S]*apply\(0\);/,
  );
});

test("channel swipe owns one touch identifier and cancels multi-touch before preventing defaults", () => {
  assert.match(source, /let activeTouchId: number \| null = null;/);
  assert.match(source, /touch\.identifier === activeTouchId/);
  assert.match(source, /if \(e\.touches\.length !== 1\) \{[\s\S]*cancelSwipeGesture\(\);[\s\S]*return;/);

  const move = source.slice(source.indexOf("const onMove = (e: TouchEvent) => {"));
  assert.ok(move.indexOf("e.touches.length !== 1") < move.indexOf("e.preventDefault()"));
  assert.match(move, /findActiveTouch\(e\.touches\)/);
  assert.match(source, /const t = findActiveTouch\(e\.changedTouches\);/);
  assert.match(
    source,
    /const cancelSwipeGesture = \(\) => \{[\s\S]*cancelPendingSettle\(\);[\s\S]*resetTransform\(\);[\s\S]*cleanupAdjacent\(\);/,
  );
  assert.match(source, /const onCancel = \(e: TouchEvent\) => \{[\s\S]*cancelSwipeGesture\(\);/);
  assert.match(
    source,
    /return \(\) => \{[\s\S]*cancelSwipeGesture\(\);[\s\S]*removeEventListener\('touchcancel', onCancel\);/,
  );
});

test("channel swipe requires explicit horizontal intent instead of taking every diagonal", () => {
  assert.match(source, /resolveChannelSwipeIntent\(dx, dy\)/);
  assert.doesNotMatch(source, /if \(absDx > absDy\)/);
});

test("non-scroll-zone guard also tracks one touch and releases on multi-touch", () => {
  const guard = source.slice(source.indexOf("// Block page-scroll initiation"));
  assert.match(guard, /let guardTouchId: number \| null = null;/);
  assert.match(guard, /touch\.identifier === guardTouchId/);
  assert.match(guard, /if \(e\.touches\.length !== 1\) \{[\s\S]*resetGuardGesture\(\);[\s\S]*return;/);
  assert.match(guard, /findGuardTouch\(e\.touches\)/);
  assert.match(guard, /findGuardTouch\(e\.changedTouches\)/);
});

test("runtime reduced-motion changes tear down active header and swipe movement", () => {
  assert.match(reducedMotionHook, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(reducedMotionHook, /addEventListener\("change", handler\)/);
  assert.match(reducedMotionHook, /removeEventListener\("change", handler\)/);
  assert.match(source, /\[isNarrow, reduceMotion\]/);
  assert.match(
    source,
    /\[isNarrow, reduceMotion, renderInkBetween, resetInkToActive\]/,
  );
});
