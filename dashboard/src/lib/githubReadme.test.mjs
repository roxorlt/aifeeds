import assert from "node:assert/strict";
import test from "node:test";
import { extractReadmeImages, resolveGithubReadmeUrl } from "./githubReadme.ts";

test("GitHub README URLs preserve absolute links and resolve repo-relative links", () => {
  assert.equal(
    resolveGithubReadmeUrl("https://example.com/a.png", "openai", "codex", "main", "raw"),
    "https://example.com/a.png",
  );
  assert.equal(
    resolveGithubReadmeUrl("./assets/a.png", "openai", "codex", "next", "raw"),
    "https://raw.githubusercontent.com/openai/codex/next/assets/a.png",
  );
  assert.equal(
    resolveGithubReadmeUrl("docs/start.md", "openai", "codex", "next", "page"),
    "https://github.com/openai/codex/blob/next/docs/start.md",
  );
  assert.match(
    resolveGithubReadmeUrl("/r/github/readme.png", "openai", "codex", "main", "raw") ?? "",
    /^https:\/\/(?:staging-)?api\.ai-feeds\.com\/r\/github\/readme\.png$/,
  );
});

test("README image extraction preserves the existing markdown/HTML parsing and de-duplicates URLs", () => {
  assert.deepEqual(
    extractReadmeImages(
      '![first](assets/a.png) ![duplicate](assets/a.png) <img src="https://example.com/b.png">',
      "openai",
      "codex",
      "main",
    ),
    [
      {
        type: "image",
        url: "https://raw.githubusercontent.com/openai/codex/main/assets/a.png",
      },
      { type: "image", url: "https://example.com/b.png" },
    ],
  );
});
