import assert from "node:assert/strict";
import test from "node:test";

import { buildResponsiveCardImage, optimizedAvatarUrl, proxyImg, proxyVideo, variantsForCurrentCover } from "./utils.ts";

test("stored WebP variants are sorted into a typed picture source with original fallback", () => {
  const result = buildResponsiveCardImage(
    "/r/x/original.jpg",
    [
      { url: "/r/x/card/w800.webp", width: 800, height: 509, format: "webp" },
      { url: "/r/x/card/w400.webp", width: 400, height: 255, format: "webp" },
    ],
  );

  assert.equal(result.fallbackSrc, "https://api.ai-feeds.com/r/x/original.jpg");
  assert.equal(
    result.webpSrcSet,
    "https://api.ai-feeds.com/r/x/card/w400.webp 400w, https://api.ai-feeds.com/r/x/card/w800.webp 800w",
  );
  assert.equal(result.srcSet, undefined);
});

test("legacy allowlisted third-party images use bounded 400/800 controlled URLs", () => {
  const source = "https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/1.png";
  const result = buildResponsiveCardImage(source, undefined, { fallbackWidth: 400 });

  assert.match(result.fallbackSrc, /^https:\/\/api\.ai-feeds\.com\/img\?/);
  assert.match(result.fallbackSrc, /w=400/);
  assert.match(result.srcSet || "", /w=400[^,]* 400w/);
  assert.match(result.srcSet || "", /w=800[^,]* 800w/);
  assert.equal(result.webpSrcSet, undefined);
});

test("an R2 original never fabricates a recursive resize URL", () => {
  const result = buildResponsiveCardImage("/r/blog/original.jpg", undefined);
  assert.equal(result.fallbackSrc, "https://api.ai-feeds.com/r/blog/original.jpg");
  assert.equal(result.srcSet, undefined);
  assert.equal(result.webpSrcSet, undefined);
});

test("invalid, duplicate and non-WebP variant records are ignored", () => {
  const result = buildResponsiveCardImage("https://cdn.example.com/original.jpg", [
    { url: "/r/x/card/good.webp", width: 400, format: "webp" },
    { url: "/r/x/card/duplicate.webp", width: 400, format: "webp" },
    { url: "javascript:alert(1)", width: 800, format: "webp" },
    { url: "/r/x/card/wrong.avif", width: 800, format: "avif" },
  ]);

  assert.equal(result.webpSrcSet, "https://api.ai-feeds.com/r/x/card/good.webp 400w");
});

test("scalar variants are ignored after a cover replacement and accept equivalent R2 forms", () => {
  const variants = [{ url: "/r/blog/card/good.webp", width: 400, format: "webp" }];
  assert.equal(
    variantsForCurrentCover("/r/blog/new.jpg", "/r/blog/old.jpg", variants),
    undefined,
  );
  assert.deepEqual(
    variantsForCurrentCover(
      "/r/blog/current.jpg",
      "https://api.ai-feeds.com/r/blog/current.jpg",
      variants,
    ),
    variants,
  );
});

test("unknown external still images fall back to their direct URL instead of a guaranteed /img 403", () => {
  assert.equal(
    proxyImg("https://d111111abcdef8.cloudfront.net/cover.jpg", 400, { force: true }),
    "https://d111111abcdef8.cloudfront.net/cover.jpg",
  );
});

test("legacy X video uses the dedicated media endpoint while R2 video stays direct", () => {
  assert.match(
    proxyVideo("https://video.twimg.com/ext_tw_video/example.mp4"),
    /^https:\/\/api\.ai-feeds\.com\/media\?/,
  );
  assert.equal(
    proxyVideo("/r/x/example.mp4"),
    "https://api.ai-feeds.com/r/x/example.mp4",
  );
});

test("imgix avatars replace original-size parameters with a bounded crop", () => {
  const result = new URL(optimizedAvatarUrl(
    "https://ph-avatars.imgix.net/original.png?auto=format&fit=max&w=2801",
    48,
  ));
  assert.equal(result.searchParams.get("w"), "48");
  assert.equal(result.searchParams.get("h"), "48");
  assert.equal(result.searchParams.get("fit"), "crop");
  assert.equal(result.searchParams.get("auto"), "format,compress");
});
