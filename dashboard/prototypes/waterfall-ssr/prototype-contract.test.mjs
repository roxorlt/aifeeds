import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const here = new URL("./", import.meta.url);

test("waterfall is three columns on PC, two on tablet, and one readable stream on mobile", async () => {
  const css = await readFile(new URL("styles.css", here), "utf8");

  assert.match(css, /\.waterfall-grid\s*\{[^}]*column-count:\s*3/s);
  assert.match(css, /@media\s*\(max-width:\s*1023px\)[\s\S]*?\.waterfall-grid\s*\{[^}]*column-count:\s*2/s);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*?\.waterfall-grid\s*\{[^}]*column-count:\s*1/s);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*?min-block-size:\s*44px/s);
});

test("prototype preserves keyboard focus and reduced-motion behavior", async () => {
  const css = await readFile(new URL("styles.css", here), "utf8");

  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /transition:\s*all/);
});

test("view switch persists a finite cookie and navigates the same canonical homepage", async () => {
  const client = await readFile(new URL("client.mjs", here), "utf8");

  assert.match(client, /serializeViewCookie/);
  assert.match(client, /document\.cookie\s*=\s*serializeViewCookie\(nextMode\)/);
  assert.match(client, /localStorage\.setItem\(["']aifeeds_view["'],\s*nextMode\)/);
  assert.match(client, /window\.location\.assign\(`\/\?view=\$\{nextMode\}&from=switch`\)/);
  assert.match(client, /switch-status/);
});

test("prototype has no third-party runtime or asset dependency", async () => {
  const [css, client] = await Promise.all([
    readFile(new URL("styles.css", here), "utf8"),
    readFile(new URL("client.mjs", here), "utf8"),
  ]);

  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(client, /https?:\/\//);
});
