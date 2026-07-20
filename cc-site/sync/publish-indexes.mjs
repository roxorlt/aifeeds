#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { assertCanonicalPageUrl } from './fs-safe.mjs';
import { loadState } from './state.mjs';

const SITE_BASE = 'https://ai-feeds.cc';
const ARCHIVE_PAGE_SIZE = 50;
const SITEMAP_SHARD_SIZE = 45_000;
const SOURCE_BUCKETS = new Map([
  ['news', 'news'],
  ['x', 'x'],
  ['gh', 'gh'],
  ['ph', 'ph'],
  ['paper', 'hf-paper'],
]);
const SOURCE_ORDER = ['news', 'x', 'gh', 'ph', 'hf-paper'];
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const FILE_FLAGS = (
  constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | NOFOLLOW
);
const DIRECTORY_FLAGS = constants.O_RDONLY | DIRECTORY | NOFOLLOW;

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function xmlEscape(value) {
  return htmlEscape(value).replaceAll('&#39;', '&apos;');
}

function lexicalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parsedTimestamp(value) {
  if (typeof value !== 'string' || value === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeItems(state) {
  if (
    !state
    || typeof state !== 'object'
    || !state.pages
    || typeof state.pages !== 'object'
    || Array.isArray(state.pages)
  ) {
    throw new Error('invalid state pages for index publication');
  }

  const items = [];
  for (const [urlPath, metadata] of Object.entries(state.pages)) {
    assertCanonicalPageUrl(urlPath);
    if (
      !metadata
      || typeof metadata !== 'object'
      || typeof metadata.source !== 'string'
      || typeof metadata.title !== 'string'
      || !(
        metadata.published_at === null
        || typeof metadata.published_at === 'string'
      )
    ) {
      throw new Error(`invalid page metadata for ${urlPath}`);
    }
    const shard = SOURCE_BUCKETS.get(metadata.source);
    if (shard === undefined) {
      throw new Error(`unsupported sitemap source: ${metadata.source}`);
    }
    const timestamp = parsedTimestamp(metadata.published_at);
    items.push({
      urlPath,
      source: metadata.source,
      shard,
      title: metadata.title,
      timestamp,
      lastmod: timestamp === null
        ? null
        : new Date(timestamp).toISOString(),
    });
  }

  items.sort((left, right) => {
    if (left.timestamp !== null && right.timestamp !== null) {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
    } else if (left.timestamp !== null) {
      return -1;
    } else if (right.timestamp !== null) {
      return 1;
    }
    return lexicalCompare(left.urlPath, right.urlPath);
  });
  return items;
}

function archiveUrl(pageNumber) {
  return pageNumber === 1
    ? `${SITE_BASE}/ai-news/`
    : `${SITE_BASE}/ai-news/page/${pageNumber}/`;
}

function itemUrl(urlPath) {
  return `${SITE_BASE}${urlPath}`;
}

function renderArchivePage(items, pageNumber, pageCount) {
  const canonical = archiveUrl(pageNumber);
  const previous = pageNumber > 1 ? archiveUrl(pageNumber - 1) : null;
  const next = pageNumber < pageCount ? archiveUrl(pageNumber + 1) : null;
  const cards = items.length === 0
    ? '<p class="archive-empty">暂无可公开的 AI 资讯。</p>'
    : `<ol class="archive-list">\n${items.map((item) => {
      const date = item.lastmod === null
        ? '日期未知'
        : item.lastmod.slice(0, 10);
      const datetime = item.lastmod === null
        ? ''
        : ` datetime="${htmlEscape(item.lastmod)}"`;
      return `    <li class="archive-item"><a href="${htmlEscape(itemUrl(item.urlPath))}">${htmlEscape(item.title)}</a><div><span>${htmlEscape(item.source)}</span> · <time${datetime}>${htmlEscape(date)}</time></div></li>`;
    }).join('\n')}\n  </ol>`;
  const headLinks = [
    `<link rel="canonical" href="${htmlEscape(canonical)}">`,
    previous === null
      ? ''
      : `<link rel="prev" href="${htmlEscape(previous)}">`,
    next === null
      ? ''
      : `<link rel="next" href="${htmlEscape(next)}">`,
  ].filter(Boolean).join('\n');
  const navigation = [
    previous === null
      ? '<span aria-disabled="true">上一页</span>'
      : `<a rel="prev" href="${htmlEscape(previous)}">上一页</a>`,
    `<span>第 ${pageNumber} / ${pageCount} 页</span>`,
    next === null
      ? '<span aria-disabled="true">下一页</span>'
      : `<a rel="next" href="${htmlEscape(next)}">下一页</a>`,
  ].join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI 资讯归档 · 第 ${pageNumber} 页 · AI源信</title>
<meta name="description" content="AI源信公开 AI 资讯内容归档，第 ${pageNumber} 页。">
${headLinks}
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><div class="container header-inner"><a href="/" class="logo"><span class="logo-dot"></span>AI源信</a><nav><a href="/">首页</a><a href="/ai-news/">AI 资讯</a></nav></div></header>
<main><section><div class="container">
  <h1>AI 资讯</h1>
  <p>来自海外公开信源、经筛选整理的 AI 领域内容。</p>
  ${cards}
  <nav class="archive-pagination" aria-label="归档分页">
      ${navigation}
  </nav>
</div></section></main>
<footer><div class="container"><p class="links"><a href="/">首页</a> · <a href="/ai-news/">AI 资讯</a> · <a href="/privacy.html">隐私政策</a> · <a href="/terms.html">服务条款</a> · <a href="/contact.html">联系我们</a></p><p>© 2026 AI源信. 版权所有</p></div></footer>
</body>
</html>
`;
}

function renderUrlSet(entries) {
  const body = entries.map(({ loc, lastmod }) => {
    const modified = lastmod === null || lastmod === undefined
      ? ''
      : `<lastmod>${xmlEscape(lastmod)}</lastmod>`;
    return `  <url><loc>${xmlEscape(loc)}</loc>${modified}</url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}${body === '' ? '' : '\n'}</urlset>
`;
}

function renderSitemapIndex(locations) {
  const body = locations
    .map((loc) => `  <sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}${body === '' ? '' : '\n'}</sitemapindex>
`;
}

function canonicalRoot(value, name) {
  if (
    typeof value !== 'string'
    || !path.isAbsolute(value)
    || value !== path.resolve(value)
    || value === path.parse(value).root
  ) {
    throw new Error(`${name} must be a canonical absolute non-root path`);
  }
  return value;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertDisjointRoots(siteRoot, stateDir) {
  if (containsPath(siteRoot, stateDir) || containsPath(stateDir, siteRoot)) {
    throw new Error('index publication roots must be disjoint');
  }
}

function assertDirectory(entry, name) {
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`unsafe generated directory: ${name}`);
  }
}

async function rootIdentity(root, name) {
  const entry = await lstat(root);
  assertDirectory(entry, name);
  return { path: root, dev: entry.dev, ino: entry.ino };
}

async function assertIdentity(identity) {
  const entry = await lstat(identity.path);
  assertDirectory(entry, identity.path);
  if (entry.dev !== identity.dev || entry.ino !== identity.ino) {
    throw new Error(`generated root changed during publication: ${identity.path}`);
  }
}

async function syncDirectory(identity) {
  await assertIdentity(identity);
  const handle = await open(identity.path, DIRECTORY_FLAGS);
  try {
    const entry = await handle.stat();
    if (entry.dev !== identity.dev || entry.ino !== identity.ino) {
      throw new Error(`generated directory changed before sync: ${identity.path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectory(parentIdentity, name, mode) {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('unsafe generated directory name');
  }
  await assertIdentity(parentIdentity);
  const directory = path.join(parentIdentity.path, name);
  await mkdir(directory, { mode });
  const identity = await rootIdentity(directory, directory);
  await syncDirectory(identity);
  await syncDirectory(parentIdentity);
  return identity;
}

async function ensureDirectory(parentIdentity, name, mode = 0o755) {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('unsafe generated directory name');
  }
  await assertIdentity(parentIdentity);
  const directory = path.join(parentIdentity.path, name);
  try {
    await mkdir(directory, { mode });
    await syncDirectory(parentIdentity);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return rootIdentity(directory, directory);
}

function safeRelativeParts(relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath === ''
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('unsafe generated relative path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => (
    part === ''
    || part === '.'
    || part === '..'
    || part.includes('\\')
    || part.includes('\0')
  ))) {
    throw new Error('unsafe generated relative path segments');
  }
  return parts;
}

async function writeDurableFile(rootIdentityValue, relativePath, contents) {
  const parts = safeRelativeParts(relativePath);
  const fileName = parts.pop();
  let parent = rootIdentityValue;
  for (const directory of parts) {
    parent = await ensureDirectory(parent, directory);
  }
  await assertIdentity(parent);
  const file = path.join(parent.path, fileName);
  const handle = await open(file, FILE_FLAGS, 0o644);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
  return file;
}

async function lstatOptional(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertReplaceable(entry, kind, target) {
  if (entry === null) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`refusing generated symlink target: ${target}`);
  }
  if (
    (kind === 'directory' && !entry.isDirectory())
    || (kind === 'file' && !entry.isFile())
  ) {
    throw new Error(`invalid generated ${kind} target: ${target}`);
  }
}

async function removeKnownEntry(target, kind) {
  const entry = await lstatOptional(target);
  if (entry === null) return;
  assertReplaceable(entry, kind, target);
  await rm(target, { recursive: kind === 'directory', force: true });
}

async function replaceGeneratedEntry({
  name,
  kind,
  stage,
  target,
  backup,
  parentIdentity,
  records,
  hooks,
}) {
  await hooks.beforePublish?.(name);
  await assertIdentity(parentIdentity);
  const oldEntry = await lstatOptional(target);
  assertReplaceable(oldEntry, kind, target);
  if (await lstatOptional(backup) !== null) {
    throw new Error(`generated backup already exists: ${backup}`);
  }
  const record = {
    name,
    kind,
    target,
    backup,
    parentIdentity,
    oldMoved: false,
    installed: false,
  };
  records.push(record);
  if (oldEntry !== null) {
    await rename(target, backup);
    record.oldMoved = true;
    await syncDirectory(parentIdentity);
  }
  await rename(stage, target);
  record.installed = true;
  await syncDirectory(parentIdentity);
  await hooks.afterPublish?.(name);
}

async function rollback(records) {
  const failures = [];
  for (const record of [...records].reverse()) {
    try {
      if (record.installed) {
        await removeKnownEntry(record.target, record.kind);
        await syncDirectory(record.parentIdentity);
      }
      if (record.oldMoved) {
        await rename(record.backup, record.target);
        await syncDirectory(record.parentIdentity);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to roll back generated indexes');
  }
}

async function cleanupEntry(target, kind) {
  try {
    await removeKnownEntry(target, kind);
  } catch {
    // Published data is already durable; stale random-name staging/backup
    // entries are safer than turning successful publication into a rollback.
  }
}

async function buildStaging({ items, archiveStage, publicStage }) {
  const pageCount = Math.max(1, Math.ceil(items.length / ARCHIVE_PAGE_SIZE));
  const archiveEntries = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pageItems = items.slice(
      (pageNumber - 1) * ARCHIVE_PAGE_SIZE,
      pageNumber * ARCHIVE_PAGE_SIZE,
    );
    const relativePath = pageNumber === 1
      ? 'index.html'
      : `page/${pageNumber}/index.html`;
    await writeDurableFile(
      archiveStage,
      relativePath,
      renderArchivePage(pageItems, pageNumber, pageCount),
    );
    archiveEntries.push({
      loc: archiveUrl(pageNumber),
      lastmod: pageItems.find((item) => item.lastmod !== null)?.lastmod ?? null,
    });
  }

  const sitemapsStage = await createDirectory(publicStage, 'sitemaps', 0o755);
  await writeDurableFile(
    sitemapsStage,
    'archive.xml',
    renderUrlSet(archiveEntries),
  );

  const shardLocations = [];
  for (const shardName of SOURCE_ORDER) {
    const shardItems = items
      .filter((item) => item.shard === shardName)
      .sort((left, right) => lexicalCompare(left.urlPath, right.urlPath));
    for (
      let offset = 0, shardNumber = 1;
      offset < shardItems.length;
      offset += SITEMAP_SHARD_SIZE, shardNumber += 1
    ) {
      const shardFile = `${shardName}-${shardNumber}.xml`;
      await writeDurableFile(
        sitemapsStage,
        shardFile,
        renderUrlSet(
          shardItems
            .slice(offset, offset + SITEMAP_SHARD_SIZE)
            .map((item) => ({
              loc: itemUrl(item.urlPath),
              lastmod: item.lastmod,
            })),
        ),
      );
      shardLocations.push(`${SITE_BASE}/sitemaps/${shardFile}`);
    }
  }

  await writeDurableFile(
    publicStage,
    'sitemap.xml',
    renderSitemapIndex([
      `${SITE_BASE}/sitemap-static.xml`,
      `${SITE_BASE}/sitemaps/archive.xml`,
      ...shardLocations,
    ]),
  );
  return { sitemapsStage };
}

export async function publishIndexes({
  siteRoot,
  stateDir,
  state,
  hooks = {},
}) {
  const safeSiteRoot = canonicalRoot(siteRoot, 'siteRoot');
  const safeStateDir = canonicalRoot(stateDir, 'stateDir');
  assertDisjointRoots(safeSiteRoot, safeStateDir);
  const items = normalizeItems(state);
  const siteIdentity = await rootIdentity(safeSiteRoot, 'siteRoot');
  const stateIdentity = await rootIdentity(safeStateDir, 'stateDir');
  const token = randomUUID();
  const archiveStage = await createDirectory(
    siteIdentity,
    `.ai-news.stage.${token}`,
    0o755,
  );
  const publicStage = await createDirectory(
    stateIdentity,
    `.public.stage.${token}`,
    0o755,
  );
  let sitemapsStage;
  const records = [];
  try {
    ({ sitemapsStage } = await buildStaging({
      items,
      archiveStage,
      publicStage,
    }));
    await hooks.afterStageBuilt?.();

    const publicIdentity = await ensureDirectory(stateIdentity, 'public');
    await replaceGeneratedEntry({
      name: 'archive',
      kind: 'directory',
      stage: archiveStage.path,
      target: path.join(safeSiteRoot, 'ai-news'),
      backup: path.join(safeSiteRoot, `.ai-news.backup.${token}`),
      parentIdentity: siteIdentity,
      records,
      hooks,
    });
    await replaceGeneratedEntry({
      name: 'sitemaps',
      kind: 'directory',
      stage: sitemapsStage.path,
      target: path.join(publicIdentity.path, 'sitemaps'),
      backup: path.join(publicIdentity.path, `.sitemaps.backup.${token}`),
      parentIdentity: publicIdentity,
      records,
      hooks,
    });
    await replaceGeneratedEntry({
      name: 'sitemap-index',
      kind: 'file',
      stage: path.join(publicStage.path, 'sitemap.xml'),
      target: path.join(publicIdentity.path, 'sitemap.xml'),
      backup: path.join(publicIdentity.path, `.sitemap.xml.backup.${token}`),
      parentIdentity: publicIdentity,
      records,
      hooks,
    });

    for (const record of records) {
      if (record.oldMoved) {
        await cleanupEntry(record.backup, record.kind);
      }
    }
  } catch (error) {
    try {
      await rollback(records);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'index publication failed and rollback was incomplete',
      );
    }
    throw error;
  } finally {
    await cleanupEntry(archiveStage.path, 'directory');
    await cleanupEntry(publicStage.path, 'directory');
  }
}

async function main() {
  const config = loadConfig();
  const state = await loadState(config.stateDir);
  if (state === null) throw new Error('cc sync state does not exist');
  await publishIndexes({
    siteRoot: config.siteRoot,
    stateDir: config.stateDir,
    state,
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  ARCHIVE_PAGE_SIZE,
  SITEMAP_SHARD_SIZE,
  xmlEscape as escapeXml,
};
