import assert from 'node:assert/strict';
import test from 'node:test';

import { auditItemLinkGraph, extractInternalLinks } from './verify-item-link-graph.mjs';

const SITE = 'https://ai-feeds.com';

test('extractInternalLinks keeps ordinary same-site links and normalizes absolute/relative URLs', () => {
  const links = extractInternalLinks(
    `<a href="/archive/x/">X</a>
     <a href="${SITE}/i/x/1">one</a>
     <a href="https://example.com/out">out</a>
     <a href="#top">top</a>`,
    `${SITE}/archive/`,
    SITE,
  );
  assert.deepEqual(links, [`${SITE}/archive/x/`, `${SITE}/i/x/1`]);
});

test('archive graph gives every sitemap item an incoming HTML link with bounded depth', () => {
  const pages = new Map([
    [`${SITE}/archive/`, `<a href="/archive/x/">X</a>`],
    [`${SITE}/archive/x/`, `<a href="/archive/x/2026-07/">July</a>`],
    [
      `${SITE}/archive/x/2026-07/`,
      `<a href="/i/x/1">one</a><a href="/archive/x/2026-07/2">2</a>`,
    ],
    [`${SITE}/archive/x/2026-07/2`, `<a href="/i/x/2">two</a>`],
  ]);
  const report = auditItemLinkGraph({
    siteBase: SITE,
    itemUrls: [`${SITE}/i/x/1`, `${SITE}/i/x/2`],
    archivePages: pages,
  });

  assert.deepEqual(report.orphanItems, []);
  assert.deepEqual(report.linksToUnknownItems, []);
  assert.equal(report.maxItemDepth, 4);
  assert.equal(report.ok, true);
});

test('reports orphan items, links to gone/unknown items, missing archive pages and duplicate PH canonicals', () => {
  const pages = new Map([
    [
      `${SITE}/archive/`,
      `<a href="/archive/ph/">PH</a><a href="/archive/missing/">missing</a>`,
    ],
    [
      `${SITE}/archive/ph/`,
      `<a href="/i/ph/tool">tool</a><a href="/i/x/gone">gone</a>`,
    ],
  ]);
  const report = auditItemLinkGraph({
    siteBase: SITE,
    itemUrls: [
      `${SITE}/i/ph/tool`,
      `${SITE}/i/ph/tool`,
      `${SITE}/i/x/orphan`,
    ],
    archivePages: pages,
  });

  assert.deepEqual(report.orphanItems, [`${SITE}/i/x/orphan`]);
  assert.deepEqual(report.linksToUnknownItems, [`${SITE}/i/x/gone`]);
  assert.deepEqual(report.missingArchiveTargets, [`${SITE}/archive/missing/`]);
  assert.deepEqual(report.duplicateItemUrls, [`${SITE}/i/ph/tool`]);
  assert.equal(report.ok, false);
});
