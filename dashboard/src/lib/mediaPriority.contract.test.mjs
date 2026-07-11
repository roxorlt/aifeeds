import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), "utf8");

const app = read("App.tsx");
const feed = read("components/Feed.tsx");
const itemCard = read("components/ItemCard.tsx");
const threadCard = read("components/ThreadCard.tsx");
const tweetCard = read("components/TweetCard.tsx");
const linkCard = read("components/LinkCard.tsx");
const posterCanvas = read("components/PosterCanvas.tsx");
const indexHtml = fs.readFileSync(path.join(src, "../index.html"), "utf8");
const cardFiles = [
  "components/GithubCard.tsx",
  "components/PhCard.tsx",
  "components/ClawhubCard.tsx",
  "components/HuodongxingCard.tsx",
  "components/HfPaperCard.tsx",
  "components/BlogCard.tsx",
  "components/PodcastCard.tsx",
  "components/TweetCard.tsx",
  "components/LinkCard.tsx",
].map(read);

test("App and Feed derive an explicit policy from page column and row position", () => {
  assert.match(app, /mediaColumnIndex=\{index\}/);
  assert.match(app, /mediaColumnImmediate=\{index < immediateColumnCount\}/);
  assert.match(feed, /getMediaLoadPolicy\(\{[\s\S]*columnIndex: mediaColumnIndex,[\s\S]*rowIndex: idx,[\s\S]*immediate: mediaColumnImmediate/);
  assert.doesNotMatch(feed, /const eager = idx < 3/);
  assert.doesNotMatch(feed, /eager=\{/);
});

test("the explicit policy crosses ItemCard and ThreadCard without boolean eager props", () => {
  assert.match(itemCard, /mediaPolicy\?: MediaLoadPolicy/);
  assert.match(itemCard, /mediaPolicy=\{mediaPolicy\}/g);
  assert.doesNotMatch(itemCard, /eager\?: boolean|eager=\{/);
  assert.match(threadCard, /mediaPolicy: MediaLoadPolicy/);
  assert.match(threadCard, /mediaPolicy=\{mediaPolicy\}/);
  assert.match(threadCard, /mediaPolicy=\{LAZY_MEDIA_LOAD_POLICY\}/);

  for (const card of cardFiles) {
    assert.doesNotMatch(card, /eager\?: boolean|loading=\{eager|fetchPriority=\{eager/);
  }
});

test("LCP-capable card wrappers expose feed source and assigned priority", () => {
  for (const card of cardFiles.filter((source) => source.includes("data-feed-source"))) {
    assert.match(card, /data-feed-source=/);
    assert.match(card, /data-media-priority=/);
  }
  assert.equal(cardFiles.filter((source) => source.includes("data-feed-source")).length >= 8, true);
  for (const card of cardFiles) {
    assert.doesNotMatch(card, /data-media-priority=\{mediaPolicy\.fetchPriority\}/);
  }
});

test("X cards demote a link preview when primary media already owns the policy", () => {
  assert.match(tweetCard, /hasPrimaryMedia/);
  assert.match(tweetCard, /demoteMediaLoadPolicy\(mediaPolicy\)/);
  assert.match(linkCard, /preload="none"/);
});

test("every offscreen poster card loads media eagerly without consuming the page's high policy", () => {
  const cardForItem = posterCanvas.slice(
    posterCanvas.indexOf("function CardForItem"),
    posterCanvas.indexOf("interface Props"),
  );
  const posterCards = [
    "TweetCard",
    "GithubCard",
    "PhCard",
    "HfPaperCard",
    "ClawhubCard",
    "HuodongxingCard",
    "BlogCard",
    "PodcastCard",
  ];

  assert.doesNotMatch(cardForItem, /HIGH_MEDIA_LOAD_POLICY/);
  for (const card of posterCards) {
    assert.match(
      cardForItem,
      new RegExp(`<${card}\\b[^>]*mediaPolicy=\\{EAGER_MEDIA_LOAD_POLICY\\}[^>]*\\/>`),
      `${card} must opt into eager/auto media inside the offscreen capture tree`,
    );
  }
});

test("font scheduling lives in the tested helper while noscript fallback remains", () => {
  assert.match(indexHtml, /import \{ installDeferredFonts \} from "\/src\/lib\/deferredFonts\.ts"/);
  assert.match(indexHtml, /installDeferredFonts\(\)/);
  assert.doesNotMatch(indexHtml, /window\.addEventListener\("load", function/);
  assert.doesNotMatch(
    indexHtml,
    /<link\s+rel="(?:preconnect|dns-prefetch)"\s+href="https:\/\/fonts\.ai-feeds\.com"/,
    "the font origin must not open a connection before the deferred trigger",
  );
  assert.match(indexHtml, /<noscript>[\s\S]*hmos-regular[\s\S]*hmos-medium[\s\S]*hmos-bold[\s\S]*<\/noscript>/);
});
