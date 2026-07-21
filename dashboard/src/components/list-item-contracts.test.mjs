import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");

const githubCard = read("GithubCard.tsx");
const hfCard = read("HfPaperCard.tsx");
const blogCard = read("BlogCard.tsx");
const podcastCard = read("PodcastCard.tsx");
const quoteSnapshotModal = read("QuoteSnapshotModal.tsx");

test("GitHub list card consumes the compact cover_url and never parses README", () => {
  assert.match(githubCard, /extra\.cover_url/);
  assert.doesNotMatch(githubCard, /readme_excerpt|extractFirstReadmeImage|raw\.githubusercontent\.com/);
});

test("HF list card consumes only the compact deep-analysis TLDR", () => {
  assert.match(hfCard, /extra\.deep_analysis\?\.tldr/);
  assert.doesNotMatch(hfCard, /discussion_comments|deep_analysis\?\.(?:problem|method|limitations)/);
});

test("blog and podcast list cards use compact excerpt fields, not detail bodies", () => {
  assert.match(blogCard, /extra\.excerpt_zh/);
  assert.match(blogCard, /extra\.excerpt/);
  assert.doesNotMatch(blogCard, /body_markdown|transcript_text|shownotes/);

  assert.match(podcastCard, /extra\.excerpt_zh/);
  assert.match(podcastCard, /extra\.excerpt/);
  assert.doesNotMatch(podcastCard, /body_markdown|transcript_text|shownotes/);
});

test("quote snapshot modal does not request article body removed from the list DTO", () => {
  assert.match(quoteSnapshotModal, /<XArticleCard/);
  assert.doesNotMatch(quoteSnapshotModal, /\bshowBody\b/);
  assert.match(quoteSnapshotModal, /在 X 打开/);
});
