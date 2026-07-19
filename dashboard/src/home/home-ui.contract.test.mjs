import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const viewSwitch = read("./HomeViewSwitch.tsx");
const home = read("./WaterfallHome.tsx");
const card = read("./WaterfallCard.tsx");
const shell = read("./WaterfallShell.tsx");
const breakpoint = read("../lib/breakpoint.ts");
const css = `${read("./waterfall.css")}\n${read("./home-view-switch.css")}`;
const template = read("../../waterfall.html");

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

test("waterfall restores the mobile follow-scroll app bar without moving it on desktop", () => {
  assert.match(shell, /useReducedMotion/);
  assert.match(shell, /useIsNarrow/);
  assert.match(shell, /addScrollRootListener/);
  assert.match(shell, /getScrollY/);
  assert.match(shell, /requestAnimationFrame/);
  assert.match(shell, /nextWaterfallHeaderRatio/);
  assert.match(shell, /ref=\{headerRef\}/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.waterfall-appbar\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /\.waterfall-appbar-spacer/);
});

test("waterfall preserves one ordered DOM list and never uses dense placement", () => {
  assert.match(home, /<ol[^>]+className="waterfall-grid"/);
  assert.match(home, /items\.map\(\(item/);
  assert.match(card, /<li/);
  assert.match(home, /ResizeObserver/);
  assert.match(card, /masonryRowSpan/);
  assert.doesNotMatch(home, /columns\.map|columnItems/);
  assert.doesNotMatch(css, /grid-auto-flow:\s*dense/);
});

test("waterfall auto-loads near the footer while preserving a manual failure fallback", () => {
  assert.match(home, /getIntersectionRoot/);
  assert.match(home, /useIsNarrow/);
  assert.match(home, /new IntersectionObserver/);
  assert.match(home, /rootMargin:\s*"600px 0px"/);
  assert.match(home, /loadingRef/);
  assert.match(home, /document\.visibilityState !== "visible"/);
  assert.match(home, /navigator\.onLine === false/);
  assert.match(home, /if \(error\) return/);
  assert.match(home, /ref=\{paginationRef\}/);
  assert.match(home, /\[cursor, error, hasMore, isNarrow, loadMore\]/);
  assert.match(home, /error \? "重试加载" : "加载更多"/);
  assert.match(breakpoint, /window\.addEventListener\("resize", update\)/);
  assert.match(breakpoint, /window\.removeEventListener\("resize", update\)/);
});

test("hydration keeps SSR visible and safely reconciles compact measured spans", () => {
  assert.match(home, /__aifeedsLayoutWaterfall/);
  assert.match(template, /getBoundingClientRect\(\)\.height[\s\S]*waterfall-main\.tsx/);
  assert.match(template, /--waterfall-row-span/);
  assert.doesNotMatch(css, /waterfall-hydrating[\s\S]*opacity:\s*0/);
  assert.match(card, /naturalWidth === 0/);
  assert.match(card, /setImageFailed\(true\)/);
});

test("waterfall warms the correct API origin and prioritizes actual covers instead of DOM positions", () => {
  assert.match(template, /__AIFEEDS_API_SAME_ORIGIN__/);
  assert.match(template, /__AIFEEDS_API_BASE__/);
  assert.match(template, /\["preconnect", "dns-prefetch"\]/);
  assert.match(home, /rankWaterfallMedia/);
  assert.match(card, /waterfallMediaPolicy\(mediaRank\)/);
  assert.doesNotMatch(card, /position < [24]/);
});

test("waterfall images expose responsive candidates sized to every column breakpoint", () => {
  assert.match(card, /srcSet=\{model\.image\.srcSet\}/);
  assert.match(card, /sizes=\{WATERFALL_IMAGE_SIZES\}/);
  assert.match(card, /max-width: 767px/);
  assert.match(card, /max-width: 1023px/);
  assert.match(card, /max-width: 1279px/);
});

test("cards retain no-JS deep links and only enhance unmodified primary clicks", () => {
  assert.match(card, /href=\{path\}/);
  assert.match(card, /event\.button !== 0/);
  assert.match(card, /event\.metaKey/);
  assert.match(card, /EVENTS\.ITEM_CLICK/);
  assert.match(card, /recordSignal\("consumed"\)/);
  assert.match(card, /openItem\(item, siblings\)/);
});

test("every waterfall card reports one shadow-only impression without filtering the DOM", () => {
  assert.match(card, /useImpression/);
  assert.match(card, /EVENTS\.ITEM_IMPRESSION/);
  assert.match(card, /view_mode:\s*"waterfall"/);
  assert.match(card, /shadow_filter_reason:/);
  assert.match(card, /shadow_rule_version:/);
  assert.match(card, /shadow_disposition:/);
  assert.doesNotMatch(home, /items\.filter|shadow.*(?:hide|remove)/i);
});

test("waterfall is 2/3/4/5/6 columns with independent cards and no category chrome", () => {
  assert.match(css, /\.waterfall-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(
    css,
    /@media\s*\(min-width:\s*768px\)[\s\S]*\.waterfall-grid\s*\{[\s\S]*repeat\(3,/,
  );
  assert.match(
    css,
    /@media\s*\(min-width:\s*1024px\)[\s\S]*\.waterfall-grid\s*\{[\s\S]*repeat\(4,/,
  );
  assert.match(
    css,
    /@media\s*\(min-width:\s*1280px\)[\s\S]*\.waterfall-grid\s*\{[\s\S]*repeat\(5,/,
  );
  assert.match(
    css,
    /@media\s*\(min-width:\s*1600px\)[\s\S]*\.waterfall-grid\s*\{[\s\S]*repeat\(6,/,
  );
  assert.match(css, /\.waterfall-card\s*\{[\s\S]*border:\s*1px solid/);
  assert.match(css, /\.waterfall-card\s*\{[\s\S]*border-radius:\s*12px/);
  assert.match(css, /\.waterfall-card\s*\{[\s\S]*box-shadow:/);
  assert.match(card, /waterfall-card--with-media/);
  assert.match(card, /waterfall-card--text-only/);
  assert.match(card, /waterfall-card--media-before/);
  assert.match(card, /waterfall-card--media-after/);
  assert.match(css, /\.waterfall-card__identity\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(css, /\.waterfall-card__identity-copy small\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(css, /\.waterfall-card__link p\s*\{[\s\S]*font-size:\s*13px/);
  assert.doesNotMatch(css, /\.waterfall-card\[data-source=.*\.waterfall-card__source-icon/);
  assert.doesNotMatch(css, /\.waterfall-grid\s*\{[\s\S]{0,160}?display:\s*block/);
  assert.doesNotMatch(home, /waterfall-intro|分类|category|sidebar/i);
});

test("approved card polish preserves readable hierarchy and restrained motion", () => {
  assert.match(css, /\.waterfall-card--media-before\s+\.waterfall-card__link p/);
  assert.match(css, /\.waterfall-card--text-only\s+\.waterfall-card__link p/);
  assert.match(css, /\.waterfall-card__metrics\s*\{[\s\S]*border-radius:/);
  assert.match(css, /\.waterfall-card__link:focus-visible\s*\{[\s\S]*outline:/);
  assert.match(
    css,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.waterfall-card:hover\s*\{[\s\S]*transform:\s*translateY\(-2px\)/,
  );
  assert.doesNotMatch(css, /animation:\s*[^;]*(?:infinite|linear)/);
});
