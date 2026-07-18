import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const viewSwitch = read("./HomeViewSwitch.tsx");
const home = read("./WaterfallHome.tsx");
const card = read("./WaterfallCard.tsx");
const css = `${read("./waterfall.css")}\n${read("./home-view-switch.css")}`;

test("classic switch is fail-closed and has separate desktop and 44px mobile controls", () => {
  assert.match(viewSwitch, /data-home-view-available/);
  assert.match(viewSwitch, /if \(!available\) return null/);
  assert.match(viewSwitch, /aria-label="首页视图"/);
  assert.match(viewSwitch, /home-view-switch--desktop/);
  assert.match(viewSwitch, /home-view-menu--mobile/);
  assert.match(css, /\.home-view-menu__summary\s*\{[\s\S]*min-block-size:\s*44px/);
});

test("switching persists one bounded cookie, emits a finite event, and navigates canonically", () => {
  assert.match(viewSwitch, /document\.cookie = serializeHomeViewCookie\(mode\)/);
  assert.match(viewSwitch, /persistHomeView\(nextMode\)/);
  assert.match(viewSwitch, /EVENTS\.HOME_VIEW_SWITCH/);
  assert.match(viewSwitch, /from_view: current/);
  assert.match(viewSwitch, /to_view: nextMode/);
  assert.match(viewSwitch, /entry: "appbar"/);
  assert.match(viewSwitch, /window\.location\.assign/);
  assert.doesNotMatch(viewSwitch, /location\.reload/);
});

test("waterfall preserves one ordered DOM list and never uses dense placement", () => {
  assert.match(home, /<ol[^>]+className="waterfall-grid"/);
  assert.match(home, /items\.map\(\(item/);
  assert.match(card, /<li/);
  assert.match(card, /ResizeObserver/);
  assert.match(card, /nonShrinkingMasonrySpan/);
  assert.doesNotMatch(home, /columns\.map|columnItems/);
  assert.doesNotMatch(css, /grid-auto-flow:\s*dense/);
});

test("cards retain no-JS deep links and only enhance unmodified primary clicks", () => {
  assert.match(card, /href=\{path\}/);
  assert.match(card, /event\.button !== 0/);
  assert.match(card, /event\.metaKey/);
  assert.match(card, /openItem\(item, siblings\)/);
});

test("mobile waterfall is one normal-flow column", () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*767px\)[\s\S]*\.waterfall-grid\s*\{[\s\S]*display:\s*block/,
  );
});
