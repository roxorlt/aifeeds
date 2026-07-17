import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("Product Hunt feed never uses an animated original as the static preview fallback", () => {
  const card = read("PhCard.tsx");
  assert.match(card, /card_preview_status/);
  assert.match(card, /staticOnly:/);
  assert.match(card, /card_preview_status === "unavailable"/);
});

test("Product Hunt drawer creates the original GIF image only after explicit intent", () => {
  const drawer = read("PhDrawerBody.tsx");
  assert.match(drawer, /function PhAnimatedGalleryImage/);
  assert.match(drawer, /播放动图/);
  assert.match(drawer, /playing \?/);
  assert.match(drawer, /setPlaying\(true\)/);
  assert.match(drawer, /setPlaying\(false\)/);
  assert.match(drawer, /key=\{`\$\{item\.id\}:\$\{m\.url\}`\}/);
});

test("lightbox gates reduced-motion and preview-less GIFs behind explicit playback intent", () => {
  const lightbox = read("Lightbox.tsx");
  assert.match(lightbox, /useReducedMotion/);
  assert.match(lightbox, /autoPlay=\{!reduceMotion\}/);
  assert.match(lightbox, /isAnimatedImageMedia\(current\)/);
  assert.match(lightbox, /reduceMotion[\s\S]*animatedImageRequestedUrl !== current\.url/);
  assert.match(lightbox, /!staticPreview\?\.fallbackSrc[\s\S]*animatedImageRequestedUrl !== current\.url/);
  assert.match(lightbox, /动图预览暂不可用/);
  assert.match(lightbox, /setAnimatedImageFailedUrl\(current\.url\)/);
});
