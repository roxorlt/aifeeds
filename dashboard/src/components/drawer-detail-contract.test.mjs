import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("drawer bodies reuse the provider detail response instead of fetching it again", () => {
  for (const filename of [
    "BlogDrawerBody.tsx",
    "PodcastDrawerBody.tsx",
    "GithubDrawerBody.tsx",
    "ClawhubDrawerBody.tsx",
  ]) {
    assert.doesNotMatch(
      read(filename),
      /\bfetchItem\b/,
      `${filename} must not own a second detail request`,
    );
  }
});

test("drawer provider carries metrics history into GitHub and Clawhub bodies", () => {
  const provider = read("../lib/drawer.tsx");
  const drawer = read("TweetDrawer.tsx");

  assert.match(provider, /metrics_history\?: ItemDetailResponse\["metrics_history"\]/);
  assert.match(provider, /siblings_has_more, metrics_history/);
  assert.match(drawer, /<GithubDrawerBody item=\{item\} metricsHistory=\{metrics_history\}/);
  assert.match(drawer, /<ClawhubDrawerBody item=\{item\} metricsHistory=\{metrics_history\}/);
});

test("blog and podcast language defaults are derived per item without effect state sync", () => {
  const blog = read("BlogDrawerBody.tsx");
  const podcast = read("PodcastDrawerBody.tsx");

  assert.match(blog, /tabChoice\?\.itemId === item\.id/);
  assert.doesNotMatch(blog, /userSwitchedTab|setFullItem/);
  assert.match(podcast, /transcriptTabChoice\?\.itemId === item\.id/);
  assert.doesNotMatch(podcast, /userSwitchedTTab|setFullItem|setDubState\("loading"\)/);
});
