import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';

import { assertCanonicalPageUrl } from './fs-safe.mjs';

const SITE_BASE = 'https://ai-feeds.cc';
const ARCHIVE_PAGE_SIZE = 50;
const SITEMAP_SHARD_SIZE = 45_000;
const PUBLICATION_SCHEMA = 2;
const JOURNAL_SCHEMA = 1;
const JOURNAL_FILE = 'publication-journal.json';
const SOURCE_BUCKETS = new Map([
  ['news', 'news'],
  ['x', 'x'],
  ['gh', 'gh'],
  ['ph', 'ph'],
  ['paper', 'hf-paper'],
]);
const SOURCE_ORDER = ['news', 'x', 'gh', 'ph', 'hf-paper'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const FILE_FLAGS = (
  constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | NOFOLLOW
);
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW;
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
      || typeof metadata.hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(metadata.hash)
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
      hash: metadata.hash,
      source: metadata.source,
      shard,
      title: metadata.title,
      publishedAt: metadata.published_at,
      timestamp,
      displayDate: timestamp === null
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

function publicationFingerprint(items, includeStaticSitemap) {
  return createHash('sha256').update(JSON.stringify({
    schema: PUBLICATION_SCHEMA,
    includeStaticSitemap,
    items: items.map((item) => ({
      urlPath: item.urlPath,
      hash: item.hash,
      source: item.source,
      title: item.title,
      publishedAt: item.publishedAt,
    })),
  })).digest('hex');
}

function archiveUrl(pageNumber) {
  return pageNumber === 1
    ? `${SITE_BASE}/ai-news/`
    : `${SITE_BASE}/ai-news/page/${pageNumber}/`;
}

function itemUrl(urlPath) {
  return `${SITE_BASE}${urlPath}`;
}

function complianceFooter() {
  return `<footer><div class="container"><p class="links"><a href="/">首页</a> · <a href="/ai-news/">AI 资讯</a> · <a href="/privacy.html">隐私政策</a> · <a href="/terms.html">服务条款</a> · <a href="/contact.html">联系我们</a> · <a href="mailto:support@ai-feeds.cc">support@ai-feeds.cc</a></p><p class="beian"><a href="https://beian.mps.gov.cn/#/query/webSearch?code=11010802048455" rel="noopener noreferrer" target="_blank"><img src="/assets/gongan-icon.png" alt="公安备案图标" width="14" height="16">京公网安备11010802048455号</a><a href="https://beian.miit.gov.cn/#/Integrated/index" rel="noopener noreferrer" target="_blank">京ICP备2025123594号-2</a></p><p>© 2026 AI源信. 版权所有</p></div></footer>`;
}

function renderArchivePage(items, pageNumber, pageCount) {
  const canonical = archiveUrl(pageNumber);
  const previous = pageNumber > 1 ? archiveUrl(pageNumber - 1) : null;
  const next = pageNumber < pageCount ? archiveUrl(pageNumber + 1) : null;
  const cards = items.length === 0
    ? '<p class="archive-empty">暂无可公开的 AI 资讯。</p>'
    : `<ol class="archive-list">\n${items.map((item) => {
      const date = item.displayDate === null
        ? '日期未知'
        : item.displayDate.slice(0, 10);
      const datetime = item.displayDate === null
        ? ''
        : ` datetime="${htmlEscape(item.displayDate)}"`;
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
${complianceFooter()}
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

function absoluteDirectoryPaths(target) {
  const root = path.parse(target).root;
  const relative = path.relative(root, target);
  const parts = relative === '' ? [] : relative.split(path.sep);
  const paths = [root];
  for (const part of parts) paths.push(path.join(paths.at(-1), part));
  return paths;
}

async function inspectDirectoryChain(target, name) {
  const chain = [];
  for (const directory of absoluteDirectoryPaths(target)) {
    const entry = await lstat(directory);
    assertDirectory(entry, name);
    chain.push({ path: directory, dev: entry.dev, ino: entry.ino });
  }
  return chain;
}

function assertSameDirectoryChain(expected, actual) {
  if (
    expected.length !== actual.length
    || expected.some((entry, index) => (
      entry.path !== actual[index].path
      || entry.dev !== actual[index].dev
      || entry.ino !== actual[index].ino
    ))
  ) {
    throw new Error('generated directory chain changed during publication');
  }
}

async function rootIdentity(root, name) {
  const chain = await inspectDirectoryChain(root, name);
  const entry = chain.at(-1);
  return { path: root, dev: entry.dev, ino: entry.ino, chain };
}

async function assertIdentity(identity) {
  const actual = await inspectDirectoryChain(identity.path, identity.path);
  assertSameDirectoryChain(identity.chain, actual);
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

async function createDirectory(parentIdentity, name, mode = 0o755) {
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
  for (const directory of parts) parent = await ensureDirectory(parent, directory);
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

async function readRegularFile(parentIdentity, name, maximumBytes = 1024 * 1024) {
  if (name.includes('/') || name.includes('\\')) throw new Error('unsafe file name');
  await assertIdentity(parentIdentity);
  const file = path.join(parentIdentity.path, name);
  const handle = await open(file, READ_FLAGS);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > maximumBytes) {
      throw new Error(`unsafe generated file: ${file}`);
    }
    const content = await handle.readFile('utf8');
    await assertIdentity(parentIdentity);
    return content;
  } finally {
    await handle.close();
  }
}

async function replaceDurableFile(parentIdentity, name, contents) {
  const token = randomUUID();
  const temporary = `.${name}.tmp.${token}`;
  await writeDurableFile(parentIdentity, temporary, contents);
  const target = path.join(parentIdentity.path, name);
  await assertIdentity(parentIdentity);
  const existing = await lstatOptional(target);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`unsafe durable file target: ${target}`);
  }
  await assertIdentity(parentIdentity);
  await rename(path.join(parentIdentity.path, temporary), target);
  await syncDirectory(parentIdentity);
}

async function staticSitemapIdentity(siteIdentity) {
  await assertIdentity(siteIdentity);
  const entry = await lstatOptional(path.join(siteIdentity.path, 'sitemap-static.xml'));
  await assertIdentity(siteIdentity);
  if (entry === null) {
    return { present: false, dev: null, ino: null };
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('static sitemap must be a regular non-symlink file');
  }
  return {
    present: true,
    dev: entry.dev,
    ino: entry.ino,
  };
}

async function assertStaticSitemapIdentity(siteIdentity, expected) {
  const actual = await staticSitemapIdentity(siteIdentity);
  if (
    actual.present !== expected.present
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error('static sitemap identity changed before publication');
  }
  await assertIdentity(siteIdentity);
}

function generationLink(id) {
  if (!UUID_RE.test(id)) throw new Error('unsafe generation id');
  return `generations/${id}`;
}

function parseGenerationLink(target) {
  if (typeof target !== 'string') throw new Error('unsafe current generation link');
  const match = /^generations\/([0-9a-f-]{36})$/.exec(target);
  if (match === null || !UUID_RE.test(match[1])) {
    throw new Error('unsafe current generation link');
  }
  return match[1];
}

async function inspectGeneration(generationsIdentity, id) {
  generationLink(id);
  await assertIdentity(generationsIdentity);
  const directory = path.join(generationsIdentity.path, id);
  const entry = await lstatOptional(directory);
  if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`unsafe generation directory: ${id}`);
  }
  const identity = await rootIdentity(directory, directory);
  await assertIdentity(generationsIdentity);
  return identity;
}

async function inspectCurrent(publicIdentity, generationsIdentity) {
  await assertIdentity(publicIdentity);
  const currentPath = path.join(publicIdentity.path, 'current');
  const entry = await lstatOptional(currentPath);
  if (entry === null) return null;
  if (!entry.isSymbolicLink()) throw new Error('current generation must be a symlink');
  const target = await readlink(currentPath);
  const id = parseGenerationLink(target);
  const generationIdentity = await inspectGeneration(generationsIdentity, id);
  await assertIdentity(publicIdentity);
  return { id, target, generationIdentity };
}

function validateJournalId(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`invalid publication journal ${name}`);
  }
  return value;
}

function validateJournal(value) {
  if (!value || typeof value !== 'object' || value.schema !== JOURNAL_SCHEMA) {
    throw new Error('invalid publication journal');
  }
  if (value.phase === 'stable') {
    return {
      schema: JOURNAL_SCHEMA,
      phase: 'stable',
      current: validateJournalId(value.current, 'current', true),
      previous: validateJournalId(value.previous, 'previous', true),
    };
  }
  if (value.phase === 'prepared') {
    return {
      schema: JOURNAL_SCHEMA,
      phase: 'prepared',
      prepared: validateJournalId(value.prepared, 'prepared'),
      previous: validateJournalId(value.previous, 'previous', true),
      priorPrevious: validateJournalId(
        value.priorPrevious,
        'priorPrevious',
        true,
      ),
    };
  }
  throw new Error('invalid publication journal phase');
}

async function loadJournal(publicIdentity) {
  await assertIdentity(publicIdentity);
  const entry = await lstatOptional(path.join(publicIdentity.path, JOURNAL_FILE));
  await assertIdentity(publicIdentity);
  if (entry === null) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('unsafe publication journal');
  }
  return validateJournal(JSON.parse(await readRegularFile(
    publicIdentity,
    JOURNAL_FILE,
    16 * 1024,
  )));
}

async function storeJournal(publicIdentity, journal) {
  await replaceDurableFile(
    publicIdentity,
    JOURNAL_FILE,
    `${JSON.stringify(validateJournal(journal))}\n`,
  );
}

async function removePinnedDirectory(parentIdentity, target) {
  await assertIdentity(parentIdentity);
  const entry = await lstatOptional(target);
  if (entry === null) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`refusing to remove unsafe generation: ${target}`);
  }
  const expected = { dev: entry.dev, ino: entry.ino };
  await assertIdentity(parentIdentity);
  const actual = await lstat(target);
  if (
    actual.isSymbolicLink()
    || !actual.isDirectory()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error(`generation changed before removal: ${target}`);
  }
  await rm(target, { recursive: true });
  await syncDirectory(parentIdentity);
}

async function cleanupPointerTemps(publicIdentity) {
  await assertIdentity(publicIdentity);
  const entries = await readdir(publicIdentity.path, { withFileTypes: true });
  await assertIdentity(publicIdentity);
  for (const entry of entries) {
    const match = /^\.current\.([0-9a-f-]{36})$/.exec(entry.name);
    if (match === null || !UUID_RE.test(match[1])) continue;
    const targetPath = path.join(publicIdentity.path, entry.name);
    await assertIdentity(publicIdentity);
    const actual = await lstat(targetPath);
    if (!actual.isSymbolicLink()) {
      throw new Error(`unsafe current pointer temporary: ${entry.name}`);
    }
    await assertIdentity(publicIdentity);
    parseGenerationLink(await readlink(targetPath));
    await assertIdentity(publicIdentity);
    await rm(targetPath);
    await syncDirectory(publicIdentity);
  }
}

async function cleanupJournalTemps(publicIdentity) {
  await assertIdentity(publicIdentity);
  const entries = await readdir(publicIdentity.path, { withFileTypes: true });
  await assertIdentity(publicIdentity);
  for (const entry of entries) {
    const match = /^\.publication-journal\.json\.tmp\.([0-9a-f-]{36})$/
      .exec(entry.name);
    if (match === null || !UUID_RE.test(match[1])) continue;
    const targetPath = path.join(publicIdentity.path, entry.name);
    await assertIdentity(publicIdentity);
    const actual = await lstat(targetPath);
    if (actual.isSymbolicLink() || !actual.isFile()) {
      throw new Error(`unsafe publication journal temporary: ${entry.name}`);
    }
    await assertIdentity(publicIdentity);
    await rm(targetPath);
    await syncDirectory(publicIdentity);
  }
}

async function garbageCollectGenerations(
  generationsIdentity,
  keepIds,
  hooks = {},
) {
  await hooks.beforeGarbageCollection?.();
  await assertIdentity(generationsIdentity);
  const entries = await readdir(generationsIdentity.path, {
    withFileTypes: true,
  });
  await assertIdentity(generationsIdentity);
  for (const entry of entries) {
    await assertIdentity(generationsIdentity);
    const stageMatch = /^\.stage\.([0-9a-f-]{36})$/.exec(entry.name);
    const safeStage = stageMatch !== null && UUID_RE.test(stageMatch[1]);
    const safeGeneration = UUID_RE.test(entry.name);
    if (!safeStage && !safeGeneration) continue;
    if (safeGeneration && keepIds.has(entry.name)) {
      await inspectGeneration(generationsIdentity, entry.name);
      continue;
    }
    await removePinnedDirectory(
      generationsIdentity,
      path.join(generationsIdentity.path, entry.name),
    );
  }
}

async function recoverPublication(
  publicIdentity,
  generationsIdentity,
  hooks = {},
) {
  await assertIdentity(publicIdentity);
  await assertIdentity(generationsIdentity);
  await cleanupPointerTemps(publicIdentity);
  await assertIdentity(generationsIdentity);
  await cleanupJournalTemps(publicIdentity);
  await assertIdentity(generationsIdentity);
  const current = await inspectCurrent(publicIdentity, generationsIdentity);
  const journal = await loadJournal(publicIdentity);
  let stable;

  if (journal === null) {
    stable = {
      schema: JOURNAL_SCHEMA,
      phase: 'stable',
      current: current?.id ?? null,
      previous: null,
    };
  } else if (journal.phase === 'stable') {
    if ((current?.id ?? null) !== journal.current) {
      throw new Error('current generation disagrees with publication journal');
    }
    stable = journal;
  } else if (current?.id === journal.prepared) {
    stable = {
      schema: JOURNAL_SCHEMA,
      phase: 'stable',
      current: journal.prepared,
      previous: journal.previous,
    };
  } else if ((current?.id ?? null) === journal.previous) {
    stable = {
      schema: JOURNAL_SCHEMA,
      phase: 'stable',
      current: journal.previous,
      previous: journal.priorPrevious,
    };
  } else {
    throw new Error('cannot safely recover publication journal');
  }

  if (stable.current !== null) {
    await inspectGeneration(generationsIdentity, stable.current);
  }
  if (stable.previous !== null && stable.previous !== stable.current) {
    await inspectGeneration(generationsIdentity, stable.previous);
  }
  await storeJournal(publicIdentity, stable);
  await garbageCollectGenerations(
    generationsIdentity,
    new Set([stable.current, stable.previous].filter(Boolean)),
    hooks,
  );
  await assertIdentity(publicIdentity);
  await assertIdentity(generationsIdentity);
  return stable;
}

async function readManifest(generationIdentity) {
  const value = JSON.parse(await readRegularFile(
    generationIdentity,
    'manifest.json',
    64 * 1024,
  ));
  if (
    !value
    || typeof value !== 'object'
    || value.schema !== PUBLICATION_SCHEMA
    || typeof value.generation !== 'string'
    || !UUID_RE.test(value.generation)
    || typeof value.fingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.fingerprint)
    || typeof value.generated_at !== 'string'
    || !Number.isFinite(Date.parse(value.generated_at))
    || typeof value.include_static_sitemap !== 'boolean'
  ) {
    throw new Error('invalid generation manifest');
  }
  return value;
}

async function validateGenerationComplete(generationIdentity, expectedId) {
  const manifest = await readManifest(generationIdentity);
  if (manifest.generation !== expectedId) {
    throw new Error('generation manifest id mismatch');
  }
  for (const name of ['ai-news', 'sitemaps']) {
    const entry = await lstat(path.join(generationIdentity.path, name));
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`incomplete generation directory: ${name}`);
    }
  }
  for (const name of ['sitemap.xml', 'manifest.json']) {
    const entry = await lstat(path.join(generationIdentity.path, name));
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`incomplete generation file: ${name}`);
    }
  }
  await assertIdentity(generationIdentity);
  return manifest;
}

async function buildGeneration({
  items,
  generationIdentity,
  generationId,
  generatedAt,
  includeStaticSitemap,
  fingerprint,
  hooks,
}) {
  const archiveIdentity = await createDirectory(
    generationIdentity,
    'ai-news',
  );
  const sitemapsIdentity = await createDirectory(
    generationIdentity,
    'sitemaps',
  );
  const pageCount = Math.max(1, Math.ceil(items.length / ARCHIVE_PAGE_SIZE));
  const archiveEntries = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pageItems = items.slice(
      (pageNumber - 1) * ARCHIVE_PAGE_SIZE,
      pageNumber * ARCHIVE_PAGE_SIZE,
    );
    await writeDurableFile(
      archiveIdentity,
      pageNumber === 1
        ? 'index.html'
        : `page/${pageNumber}/index.html`,
      renderArchivePage(pageItems, pageNumber, pageCount),
    );
    archiveEntries.push({
      loc: archiveUrl(pageNumber),
      lastmod: generatedAt,
    });
  }

  await writeDurableFile(
    sitemapsIdentity,
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
        sitemapsIdentity,
        shardFile,
        renderUrlSet(shardItems
          .slice(offset, offset + SITEMAP_SHARD_SIZE)
          .map((item) => ({ loc: itemUrl(item.urlPath), lastmod: null }))),
      );
      shardLocations.push(`${SITE_BASE}/sitemaps/${shardFile}`);
    }
  }

  await hooks.beforeStageSitemapIndex?.(generationIdentity.path);
  await writeDurableFile(
    generationIdentity,
    'sitemap.xml',
    renderSitemapIndex([
      ...(includeStaticSitemap
        ? [`${SITE_BASE}/sitemap-static.xml`]
        : []),
      `${SITE_BASE}/sitemaps/archive.xml`,
      ...shardLocations,
    ]),
  );
  await writeDurableFile(
    generationIdentity,
    'manifest.json',
    `${JSON.stringify({
      schema: PUBLICATION_SCHEMA,
      generation: generationId,
      fingerprint,
      generated_at: generatedAt,
      include_static_sitemap: includeStaticSitemap,
    })}\n`,
  );
  await syncDirectory(archiveIdentity);
  await syncDirectory(sitemapsIdentity);
  await syncDirectory(generationIdentity);
}

async function activateGeneration({
  siteIdentity,
  expectedStaticSitemap,
  publicIdentity,
  generationsIdentity,
  generationId,
  stable,
  hooks,
}) {
  const prepared = {
    schema: JOURNAL_SCHEMA,
    phase: 'prepared',
    prepared: generationId,
    previous: stable.current,
    priorPrevious: stable.previous,
  };
  await storeJournal(publicIdentity, prepared);
  await hooks.afterPrepared?.(generationId);

  const current = await inspectCurrent(publicIdentity, generationsIdentity);
  if ((current?.id ?? null) !== stable.current) {
    throw new Error('current generation changed before activation');
  }
  const temporaryName = `.current.${generationId}`;
  const temporaryPath = path.join(publicIdentity.path, temporaryName);
  await assertIdentity(publicIdentity);
  await symlink(generationLink(generationId), temporaryPath);
  if (parseGenerationLink(await readlink(temporaryPath)) !== generationId) {
    throw new Error('temporary current generation link changed');
  }
  await syncDirectory(publicIdentity);
  await assertStaticSitemapIdentity(
    siteIdentity,
    expectedStaticSitemap,
  );
  await assertIdentity(publicIdentity);
  await assertIdentity(generationsIdentity);
  await rename(temporaryPath, path.join(publicIdentity.path, 'current'));
  await syncDirectory(publicIdentity);
  await hooks.afterCurrentSwap?.(generationId);

  const activated = await inspectCurrent(publicIdentity, generationsIdentity);
  if (activated?.id !== generationId) {
    throw new Error('current generation activation failed');
  }
  await validateGenerationComplete(activated.generationIdentity, generationId);
  const nextStable = {
    schema: JOURNAL_SCHEMA,
    phase: 'stable',
    current: generationId,
    previous: stable.current,
  };
  await storeJournal(publicIdentity, nextStable);
  await garbageCollectGenerations(
    generationsIdentity,
    new Set([nextStable.current, nextStable.previous].filter(Boolean)),
    hooks,
  );
  return nextStable;
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
  const expectedStaticSitemap = await staticSitemapIdentity(siteIdentity);
  const includeStaticSitemap = expectedStaticSitemap.present;
  const publicIdentity = await ensureDirectory(stateIdentity, 'public');
  const generationsIdentity = await ensureDirectory(
    publicIdentity,
    'generations',
  );
  const stable = await recoverPublication(
    publicIdentity,
    generationsIdentity,
    hooks,
  );
  const current = await inspectCurrent(publicIdentity, generationsIdentity);
  const fingerprint = publicationFingerprint(items, includeStaticSitemap);
  if (current !== null) {
    const manifest = await validateGenerationComplete(
      current.generationIdentity,
      current.id,
    );
    if (manifest.fingerprint === fingerprint) {
      return { changed: false, generation: current.id };
    }
  }

  const generationId = randomUUID();
  const stageName = `.stage.${generationId}`;
  const stageIdentity = await createDirectory(
    generationsIdentity,
    stageName,
  );
  const generatedAt = new Date().toISOString();
  let immutableIdentity = null;
  try {
    await buildGeneration({
      items,
      generationIdentity: stageIdentity,
      generationId,
      generatedAt,
      includeStaticSitemap,
      fingerprint,
      hooks,
    });
    await hooks.afterStageBuilt?.(stageIdentity.path);
    await assertStaticSitemapIdentity(siteIdentity, expectedStaticSitemap);
    await assertIdentity(siteIdentity);
    await assertIdentity(stateIdentity);
    await assertIdentity(publicIdentity);
    await assertIdentity(generationsIdentity);
    const immutablePath = path.join(generationsIdentity.path, generationId);
    await rename(stageIdentity.path, immutablePath);
    await syncDirectory(generationsIdentity);
    immutableIdentity = await inspectGeneration(generationsIdentity, generationId);
    await validateGenerationComplete(immutableIdentity, generationId);
    await activateGeneration({
      siteIdentity,
      expectedStaticSitemap,
      publicIdentity,
      generationsIdentity,
      generationId,
      stable,
      hooks,
    });
    return { changed: true, generation: generationId };
  } catch (error) {
    try {
      await recoverPublication(publicIdentity, generationsIdentity, hooks);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'index publication failed and recovery was incomplete',
      );
    }
    throw error;
  }
}

export {
  ARCHIVE_PAGE_SIZE,
  SITEMAP_SHARD_SIZE,
  xmlEscape as escapeXml,
};
