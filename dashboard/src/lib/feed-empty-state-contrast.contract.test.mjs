import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const feed = readFileSync(resolve(here, "../components/Feed.tsx"), "utf8");

test("placeholder and empty feed copy use accessible contrast on white", () => {
  const emptyStates = [...feed.matchAll(
    /className="([^"]*min-h-\[60vh\][^"]*)">\s*(?:暂无数据源|\{isHdx)/g,
  )].map((match) => match[1]);

  assert.equal(emptyStates.length, 2);
  for (const classes of emptyStates) {
    assert.match(classes, /\btext-neutral-600\b/);
    assert.doesNotMatch(classes, /\btext-neutral-400\b/);
  }
});
