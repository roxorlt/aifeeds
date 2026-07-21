import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..");
const read = (relativePath) => {
  const filename = path.join(src, relativePath);
  return fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : "";
};

const tweetCard = read("components/TweetCard.tsx");
const linkCard = read("components/LinkCard.tsx");
const hook = read("lib/useDeferredVideoPoster.ts");

test("TweetCard and LinkCard defer lazy video poster attributes through the shared hook", () => {
  for (const component of [tweetCard, linkCard]) {
    assert.match(component, /useDeferredVideoPoster/);
  }
  assert.doesNotMatch(tweetCard, /poster=\{first\.poster \? proxyImg\(/);
  assert.doesNotMatch(linkCard, /<video[\s\S]*?poster=\{posterSrc\}/);
  assert.match(tweetCard, /posterVariants=\{first\.poster_variants\}/);
  assert.match(tweetCard, /mediaPolicy=\{mediaPolicy\}/);
});

test("the deferred hook observes near the current feed body and exposes user-intent activation", () => {
  assert.match(hook, /IntersectionObserver/);
  assert.match(hook, /rootMargin:\s*VIDEO_POSTER_ROOT_MARGIN/);
  assert.match(hook, /resolveVideoPosterObserverRoot/);
  assert.match(hook, /requestPoster/);

  for (const component of [tweetCard, linkCard]) {
    assert.match(component, /onPointerDown=\{requestPoster\}|requestPoster\(\)/);
    assert.match(component, /onFocus=\{requestPoster\}|onFocusCapture=\{requestPoster\}/);
  }
});
