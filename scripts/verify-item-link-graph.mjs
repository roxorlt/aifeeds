#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizedSiteBase(siteBase) {
  return String(siteBase).replace(/\/+$/, '');
}

export function extractInternalLinks(html, pageUrl, siteBase) {
  const base = normalizedSiteBase(siteBase);
  const links = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    const raw = decodeEntities(match[2]).trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) {
      continue;
    }
    let url;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(base).origin) continue;
    url.hash = '';
    const normalized = `${base}${url.pathname}${url.search}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      links.push(normalized);
    }
  }
  return links;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  return [...repeated].sort();
}

export function auditItemLinkGraph({ siteBase, itemUrls, archivePages }) {
  const base = normalizedSiteBase(siteBase);
  const root = `${base}/archive/`;
  const itemSet = new Set(itemUrls);
  const pageSet = new Set(archivePages.keys());
  const incomingItems = new Set();
  const linksToUnknownItems = new Set();
  const missingArchiveTargets = new Set();
  const edges = new Map();

  for (const [pageUrl, html] of archivePages) {
    const links = extractInternalLinks(html, pageUrl, base);
    edges.set(pageUrl, links);
    for (const link of links) {
      const path = new URL(link).pathname;
      if (path.startsWith('/i/')) {
        if (itemSet.has(link)) incomingItems.add(link);
        else linksToUnknownItems.add(link);
      }
      if ((path === '/archive' || path.startsWith('/archive/')) && !pageSet.has(link)) {
        missingArchiveTargets.add(link);
      }
    }
  }

  const depth = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const from = queue.shift();
    const fromDepth = depth.get(from);
    for (const target of edges.get(from) || []) {
      if (!pageSet.has(target) && !itemSet.has(target)) continue;
      if (depth.has(target)) continue;
      depth.set(target, fromDepth + 1);
      if (pageSet.has(target)) queue.push(target);
    }
  }

  const orphanItems = [...itemSet].filter((url) => !incomingItems.has(url)).sort();
  const reachableItemDepths = [...itemSet]
    .map((url) => depth.get(url))
    .filter((value) => Number.isInteger(value));
  const maxItemDepth = reachableItemDepths.length ? Math.max(...reachableItemDepths) : 0;
  const duplicateItemUrls = duplicates(itemUrls);
  const report = {
    itemCount: itemSet.size,
    archivePageCount: archivePages.size,
    orphanItems,
    linksToUnknownItems: [...linksToUnknownItems].sort(),
    missingArchiveTargets: [...missingArchiveTargets].sort(),
    duplicateItemUrls,
    maxItemDepth,
  };
  return {
    ...report,
    ok:
      report.orphanItems.length === 0 &&
      report.linksToUnknownItems.length === 0 &&
      report.missingArchiveTargets.length === 0 &&
      report.duplicateItemUrls.length === 0 &&
      report.maxItemDepth <= 5,
  };
}

function extractLocs(xml) {
  return [...String(xml).matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) =>
    decodeEntities(match[1].trim()),
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'aifeeds-link-graph-verifier/1.0' },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export async function verifyPublicItemLinkGraph(siteBase) {
  const base = normalizedSiteBase(siteBase);
  const sitemapIndex = await fetchText(`${base}/sitemap.xml`);
  const sitemapUrls = extractLocs(sitemapIndex);
  const itemSitemaps = sitemapUrls.filter((url) =>
    /\/sitemap-(?:x|gh|ph|hf-paper|news)(?:-\d+)?\.xml$/.test(new URL(url).pathname),
  );
  const archiveSitemapUrl =
    sitemapUrls.find((url) => new URL(url).pathname === '/sitemap-archive.xml') ||
    `${base}/sitemap-archive.xml`;

  const itemXmls = await mapLimit(itemSitemaps, 6, fetchText);
  const itemUrls = itemXmls.flatMap(extractLocs).filter((url) => new URL(url).pathname.startsWith('/i/'));
  const archiveXml = await fetchText(archiveSitemapUrl);
  const archiveUrls = extractLocs(archiveXml).filter((url) => {
    const path = new URL(url).pathname;
    return path === '/archive/' || path.startsWith('/archive/');
  });
  const archiveHtml = await mapLimit(archiveUrls, 6, fetchText);
  const archivePages = new Map(archiveUrls.map((url, index) => [url, archiveHtml[index]]));
  return auditItemLinkGraph({ siteBase: base, itemUrls, archivePages });
}

async function main() {
  const index = process.argv.indexOf('--base-url');
  const base = index >= 0 ? process.argv[index + 1] : 'https://ai-feeds.com';
  if (!base) throw new Error('--base-url requires a value');
  const report = await verifyPublicItemLinkGraph(base);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
