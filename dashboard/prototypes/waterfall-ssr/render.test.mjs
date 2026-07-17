import assert from "node:assert/strict";
import test from "node:test";

import { renderDocument } from "./render.mjs";

for (const mode of ["classic", "waterfall"]) {
  test(`${mode} document contains meaningful server-rendered content before client scripts`, () => {
    const html = renderDocument({ mode });
    const articleIndex = html.indexOf("<article");
    const clientIndex = html.indexOf('<script type="module" src="/client.mjs"');

    assert.ok(articleIndex > 0, "SSR should emit at least one article");
    assert.ok(clientIndex > articleIndex, "cards must precede client JavaScript");
    assert.match(html, new RegExp(`<main[^>]+data-layout="${mode}"`));
    assert.match(html, /data-rendered="server"/);
    assert.equal((html.match(/data-view-mode=/g) || []).length, 1);
    assert.match(html, /<img[^>]+width="\d+"[^>]+height="\d+"/);
  });
}

test("initial data is JSON-script safe and retains the selected mode", () => {
  const html = renderDocument({
    mode: "waterfall",
    items: [{
      id: "unsafe",
      source: "news",
      sourceLabel: "新闻",
      title: "</script><script>alert(1)</script>",
      summary: "safe",
      meta: "刚刚",
    }],
  });
  const match = html.match(/<script id="aifeeds-initial-data" type="application\/json">([^<]*)<\/script>/);

  assert.ok(match, "initial-data JSON script should exist");
  assert.doesNotMatch(match[1], /</);
  const data = JSON.parse(match[1]);
  assert.equal(data.view_mode, "waterfall");
  assert.equal(data.items[0].title, "</script><script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("server markup exposes separate accessible desktop and mobile view controls", () => {
  const html = renderDocument({ mode: "classic" });

  assert.match(html, /aria-label="首页视图"/);
  assert.match(html, /class="view-switch view-switch--desktop"/);
  assert.match(html, /class="view-menu view-menu--mobile"/);
  assert.match(html, /data-select-view="classic"[^>]+aria-pressed="true"/);
  assert.match(html, /data-select-view="waterfall"[^>]+aria-pressed="false"/);
});
