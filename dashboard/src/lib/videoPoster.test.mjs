import assert from "node:assert/strict";
import test from "node:test";

const videoPoster = await import("./videoPoster.ts").catch(() => ({}));

test("eager or high media policies expose a video poster immediately", () => {
  assert.equal(typeof videoPoster.shouldLoadVideoPosterImmediately, "function");
  const shouldLoad = videoPoster.shouldLoadVideoPosterImmediately;

  assert.equal(shouldLoad({ loading: "eager", fetchPriority: "auto" }), true);
  assert.equal(shouldLoad({ loading: "lazy", fetchPriority: "high" }), true);
  assert.equal(shouldLoad({ loading: "lazy", fetchPriority: "auto" }), false);
});

test("video posters prefer the exact 400px stored WebP variant", () => {
  assert.equal(typeof videoPoster.resolveVideoPosterSource, "function");
  const resolvePoster = videoPoster.resolveVideoPosterSource;

  assert.equal(
    resolvePoster("https://pbs.twimg.com/media/original.jpg", [
      { url: "/r/x/card/poster-800.webp", width: 800, format: "webp" },
      { url: "/r/x/card/poster-400.webp", width: 400, format: "webp" },
    ]),
    "https://api.ai-feeds.com/r/x/card/poster-400.webp",
  );
});

test("video poster source chooses the smallest valid WebP above the target then falls back safely", () => {
  assert.equal(typeof videoPoster.resolveVideoPosterSource, "function");
  const resolvePoster = videoPoster.resolveVideoPosterSource;

  assert.equal(
    resolvePoster("https://pbs.twimg.com/media/original.jpg", [
      { url: "/r/x/card/poster-320.webp", width: 320, format: "webp" },
      { url: "/r/x/card/poster-640.webp", width: 640, format: "webp" },
      { url: "javascript:alert(1)", width: 400, format: "webp" },
    ]),
    "https://api.ai-feeds.com/r/x/card/poster-640.webp",
  );

  const fallback = resolvePoster(
    "https://example.com/link-poster.jpg",
    undefined,
    { forceProxy: true },
  );
  assert.match(fallback || "", /^https:\/\/api\.ai-feeds\.com\/img\?/);
  assert.match(fallback || "", /w=400/);
  assert.equal(resolvePoster(undefined, [{ url: "/r/stale.webp", width: 400, format: "webp" }]), undefined);
});

test("poster observation uses a clipped feed body but the viewport for mobile document flow", () => {
  assert.equal(typeof videoPoster.resolveVideoPosterObserverRoot, "function");
  const resolveRoot = videoPoster.resolveVideoPosterObserverRoot;
  const feedBody = {};
  const selectors = [];
  const node = {
    closest(selector) {
      selectors.push(selector);
      return feedBody;
    },
  };

  assert.equal(resolveRoot(node, () => "auto"), feedBody);
  assert.equal(resolveRoot(node, () => "visible"), null);
  assert.deepEqual(selectors, [".feed-body", ".feed-body"]);
  assert.equal(resolveRoot({ closest: () => null }, () => "auto"), null);
});
