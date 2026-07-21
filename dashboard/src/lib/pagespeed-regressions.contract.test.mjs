import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), "utf8");

const indexHtml = fs.readFileSync(path.join(src, "../index.html"), "utf8");
const tweetCard = read("components/TweetCard.tsx");
const linkCard = read("components/LinkCard.tsx");
const xArticleCard = read("components/XArticleCard.tsx");
const phCard = read("components/PhCard.tsx");
const sortSelector = read("components/SortSelector.tsx");
const authStore = read("lib/authStore.ts");

test("mobile viewport keeps pinch zoom available", () => {
  assert.doesNotMatch(indexHtml, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(indexHtml, /maximum-scale\s*=\s*1(?:\.0)?/i);
});

test("feed media exposes a stable accessible name and videos avoid the image endpoint", () => {
  assert.match(tweetCard, /aria-label="查看媒体大图"/);
  assert.match(tweetCard, /src=\{proxyVideo\(first\.url\)\}/);
  assert.doesNotMatch(tweetCard, /src=\{proxyImg\(first\.url\)\}/);
});

test("optional link cards do not emit anchors without href", () => {
  assert.match(linkCard, /if \(!href\) return/);
  assert.match(linkCard, /if \(!href\) return[\s\S]*?<a[\s\S]*?href=\{href\}/);
});

test("link and article controls are never nested inside external anchors", () => {
  assert.match(linkCard, /if \(showVideo\) return[\s\S]*?<div[\s\S]*?\{mediaContents\}[\s\S]*?<a/);
  assert.match(xArticleCard, /href=\{showBody \? undefined : url\}/);
  assert.match(xArticleCard, /showBody && url[\s\S]*?href=\{url\}/);
});

test("Product Hunt maker avatars request a bounded physical size", () => {
  assert.match(phCard, /optimizedAvatarUrl\(m\.avatar_url, 48\)/);
  assert.doesNotMatch(phCard, /const src = resolveAssetUrl\(m\.avatar_url\)/);
});

test("sort control accessible name contains both visible choices", () => {
  assert.match(sortSelector, /aria-label=\{`排序方式：热度 \/ 时间（当前 \$\{LABELS\[value\]\}）`\}/);
});

test("post-login session discovery treats a nullable user as a sync failure", () => {
  assert.match(authStore, /if \(!me\.user\) throw new Error\(/);
});
