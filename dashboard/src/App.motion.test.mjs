import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(here, "index.css"), "utf8");

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
  assert.match(source, /behavior: shouldReduceMotion\(\) \? "auto" : "smooth"/);
  assert.match(css, /\.motion-channel-pill[\s\S]*transition:\s*none\s*!important/);
});

test("reduced motion keeps the mobile header visible", () => {
  assert.match(source, /if \(!isNarrow \|\| shouldReduceMotion\(\)\) \{/);
  assert.match(source, /hideRatioRef\.current = 0;[\s\S]*apply\(0\);/);
});

test("reduced motion changes channels without swipe or pill transforms", () => {
  assert.match(source, /const reduceMotion = shouldReduceMotion\(\);/);
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
