import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  escapeXml,
  publishIndexes,
} from '../publish-indexes.mjs';

const HASH = 'a'.repeat(64);
const CC_SITE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-index-test-'));
  const siteRoot = path.join(root, 'site');
  const stateDir = path.join(root, 'state');
  await mkdir(siteRoot, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  return { root, siteRoot, stateDir };
}

function metadata(source, title, publishedAt) {
  return {
    hash: HASH,
    source,
    title,
    published_at: publishedAt,
  };
}

function state(entries) {
  return {
    schema: 1,
    last_seq: entries.length,
    bootstrap: null,
    pages: Object.fromEntries(entries.map(([urlPath, value]) => [
      urlPath,
      value,
    ])),
  };
}

test('XML escaping covers all markup-significant characters', () => {
  assert.equal(
    escapeXml(`<loc a="b">Tom & Jerry's</loc>`),
    '&lt;loc a=&quot;b&quot;&gt;Tom &amp; Jerry&apos;s&lt;/loc&gt;',
  );
});

test('publishes sorted .cc archive pages and sitemap outputs', async () => {
  const dirs = await workspace();
  const pages = [];
  for (let index = 0; index < 51; index += 1) {
    pages.push([
      `/i/news/item-${String(index).padStart(2, '0')}`,
      metadata(
        'news',
        index === 0 ? 'A & <B>' : `Title ${index}`,
        index < 49
          ? `2026-07-${String(19 - Math.floor(index / 3)).padStart(2, '0')}T0${index % 10}:00:00Z`
          : null,
      ),
    ]);
  }

  await publishIndexes({
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    state: state(pages),
  });

  const first = await readFile(
    path.join(dirs.siteRoot, 'ai-news', 'index.html'),
    'utf8',
  );
  const second = await readFile(
    path.join(dirs.siteRoot, 'ai-news', 'page', '2', 'index.html'),
    'utf8',
  );
  assert.match(first, /<link rel="canonical" href="https:\/\/ai-feeds\.cc\/ai-news\/">/);
  assert.doesNotMatch(first, /rel="prev"/);
  assert.match(first, /rel="next" href="https:\/\/ai-feeds\.cc\/ai-news\/page\/2\/"/);
  assert.match(second, /rel="prev" href="https:\/\/ai-feeds\.cc\/ai-news\/"/);
  assert.doesNotMatch(second, /rel="next"/);
  assert.equal((first.match(/class="archive-item"/g) ?? []).length, 50);
  assert.equal((second.match(/class="archive-item"/g) ?? []).length, 1);
  assert.match(first, /A &amp; &lt;B&gt;/);
  assert.doesNotMatch(`${first}${second}`, /ai-feeds\.com/);
  assert.match(`${first}${second}`, /https:\/\/ai-feeds\.cc\/i\/news\/item-/);

  const sitemapIndex = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemap.xml'),
    'utf8',
  );
  assert.match(sitemapIndex, /https:\/\/ai-feeds\.cc\/sitemap-static\.xml/);
  assert.match(sitemapIndex, /https:\/\/ai-feeds\.cc\/sitemaps\/archive\.xml/);
  assert.match(sitemapIndex, /https:\/\/ai-feeds\.cc\/sitemaps\/news-1\.xml/);

  const archiveMap = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'archive.xml'),
    'utf8',
  );
  assert.match(archiveMap, /https:\/\/ai-feeds\.cc\/ai-news\//);
  assert.match(archiveMap, /https:\/\/ai-feeds\.cc\/ai-news\/page\/2\//);

  const newsMap = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'news-1.xml'),
    'utf8',
  );
  assert.equal((newsMap.match(/<url>/g) ?? []).length, 51);
  assert.match(newsMap, /<lastmod>2026-07-/);
  assert.doesNotMatch(newsMap, /<lastmod>null<\/lastmod>/);
  assert.equal((await stat(path.join(dirs.siteRoot, 'ai-news'))).isDirectory(), true);
});

test('sorts equal and undated items deterministically after dated items', async () => {
  const dirs = await workspace();
  await publishIndexes({
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    state: state([
      ['/i/x/z-null', metadata('x', 'z null', null)],
      ['/i/x/b-date', metadata('x', 'b date', '2026-07-20T00:00:00Z')],
      ['/i/x/a-date', metadata('x', 'a date', '2026-07-20T00:00:00Z')],
      ['/i/x/a-invalid', metadata('x', 'a invalid', 'not-a-date')],
    ]),
  });

  const html = await readFile(
    path.join(dirs.siteRoot, 'ai-news', 'index.html'),
    'utf8',
  );
  const titles = [...html.matchAll(/class="archive-item"><a[^>]*>([^<]*)<\/a>/g)]
    .map((match) => match[1]);
  assert.deepEqual(titles, ['a date', 'b date', 'a invalid', 'z null']);
  const sitemap = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'x-1.xml'),
    'utf8',
  );
  assert.equal((sitemap.match(/<lastmod>/g) ?? []).length, 2);
});

test('maps sources to fixed safe shard names and splits at 45,000 URLs', async () => {
  const dirs = await workspace();
  const entries = [];
  for (let index = 0; index < 45_001; index += 1) {
    entries.push([
      `/i/paper/${String(index).padStart(5, '0')}`,
      metadata('paper', `Paper ${index}`, '2026-07-20T00:00:00Z'),
    ]);
  }
  await publishIndexes({
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    state: state(entries),
  });

  const first = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'hf-paper-1.xml'),
    'utf8',
  );
  const second = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'hf-paper-2.xml'),
    'utf8',
  );
  assert.equal((first.match(/<url>/g) ?? []).length, 45_000);
  assert.equal((second.match(/<url>/g) ?? []).length, 1);
  const index = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemap.xml'),
    'utf8',
  );
  assert.match(index, /hf-paper-1\.xml/);
  assert.match(index, /hf-paper-2\.xml/);
  assert.doesNotMatch(index, /news-1\.xml|x-1\.xml|gh-1\.xml|ph-1\.xml/);
});

test('fails closed for an unknown source without replacing a prior generation', async () => {
  const dirs = await workspace();
  const oldState = state([
    ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
  ]);
  await publishIndexes({ ...dirs, state: oldState });
  const oldIndex = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemap.xml'),
    'utf8',
  );
  const oldArchive = await readFile(
    path.join(dirs.siteRoot, 'ai-news', 'index.html'),
    'utf8',
  );

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/unsafe', metadata('../unsafe', 'Unsafe', null)],
      ]),
    }),
    /unsupported sitemap source/i,
  );
  assert.equal(
    await readFile(path.join(dirs.stateDir, 'public', 'sitemap.xml'), 'utf8'),
    oldIndex,
  );
  assert.equal(
    await readFile(path.join(dirs.siteRoot, 'ai-news', 'index.html'), 'utf8'),
    oldArchive,
  );
});

test('publishes the root sitemap last and rolls back all outputs on commit failure', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const paths = {
    archive: path.join(dirs.siteRoot, 'ai-news', 'index.html'),
    shard: path.join(dirs.stateDir, 'public', 'sitemaps', 'news-1.xml'),
    index: path.join(dirs.stateDir, 'public', 'sitemap.xml'),
  };
  const before = Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([name, file]) => [
      name,
      await readFile(file, 'utf8'),
    ]),
  ));
  const order = [];

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        afterPublish(name) {
          order.push(name);
          if (name === 'sitemaps') throw new Error('injected publish failure');
        },
      },
    }),
    /injected publish failure/,
  );
  assert.deepEqual(order, ['archive', 'sitemaps']);
  for (const [name, file] of Object.entries(paths)) {
    assert.equal(await readFile(file, 'utf8'), before[name]);
  }

  order.length = 0;
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
    ]),
    hooks: {
      afterPublish(name) {
        order.push(name);
      },
    },
  });
  assert.deepEqual(order, ['archive', 'sitemaps', 'sitemap-index']);
});

test('a staging-generation failure leaves the entire previous generation untouched', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/x/old', metadata('x', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const archiveFile = path.join(dirs.siteRoot, 'ai-news', 'index.html');
  const sitemapFile = path.join(dirs.stateDir, 'public', 'sitemap.xml');
  const shardFile = path.join(
    dirs.stateDir,
    'public',
    'sitemaps',
    'x-1.xml',
  );
  const before = await Promise.all([
    readFile(archiveFile, 'utf8'),
    readFile(sitemapFile, 'utf8'),
    readFile(shardFile, 'utf8'),
  ]);

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/x/new', metadata('x', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        afterStageBuilt() {
          throw new Error('injected staging failure');
        },
      },
    }),
    /injected staging failure/,
  );
  assert.deepEqual(await Promise.all([
    readFile(archiveFile, 'utf8'),
    readFile(sitemapFile, 'utf8'),
    readFile(shardFile, 'utf8'),
  ]), before);
  assert.equal(
    (await readdir(dirs.siteRoot)).some((name) => name.includes('.stage.')),
    false,
  );
  assert.equal(
    (await readdir(dirs.stateDir)).some((name) => name.includes('.stage.')),
    false,
  );
});

test('a deleted state entry disappears from archive and sitemap', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/gh/keep', metadata('gh', 'Keep', '2026-07-20T00:00:00Z')],
      ['/i/gh/delete', metadata('gh', 'Delete', '2026-07-19T00:00:00Z')],
    ]),
  });
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/gh/keep', metadata('gh', 'Keep', '2026-07-20T00:00:00Z')],
    ]),
  });
  const archive = await readFile(
    path.join(dirs.siteRoot, 'ai-news', 'index.html'),
    'utf8',
  );
  const sitemap = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'gh-1.xml'),
    'utf8',
  );
  assert.match(`${archive}${sitemap}`, /\/i\/gh\/keep/);
  assert.doesNotMatch(`${archive}${sitemap}`, /\/i\/gh\/delete/);
});

test('rejects generated-root symlinks without writing through them', async () => {
  const dirs = await workspace();
  const outside = path.join(dirs.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, path.join(dirs.siteRoot, 'ai-news'));

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/item', metadata('news', 'Item', null)],
      ]),
    }),
    /symlink/i,
  );
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('publishes a 30,001 item fixture within a bounded heap increase', async () => {
  const dirs = await workspace();
  const entries = [];
  for (let index = 0; index < 30_001; index += 1) {
    entries.push([
      `/i/ph/${String(index).padStart(5, '0')}`,
      metadata('ph', `Product ${index}`, '2026-07-20T00:00:00Z'),
    ]);
  }
  const fixture = state(entries);
  const heapBefore = process.memoryUsage().heapUsed;
  await publishIndexes({ ...dirs, state: fixture });
  const heapIncrease = process.memoryUsage().heapUsed - heapBefore;

  assert.ok(heapIncrease < 192 * 1024 * 1024, `heap increase ${heapIncrease}`);
  assert.equal(
    (await readdir(path.join(dirs.siteRoot, 'ai-news', 'page'))).length,
    600,
  );
  const sitemap = await readFile(
    path.join(dirs.stateDir, 'public', 'sitemaps', 'ph-1.xml'),
    'utf8',
  );
  assert.equal((sitemap.match(/<url>/g) ?? []).length, 30_001);
});

test('manual static URL config, sitemap, robots, homepage, and deploy ownership agree', async () => {
  const configured = JSON.parse(
    await readFile(path.join(CC_SITE, 'sync', 'static-urls.json'), 'utf8'),
  );
  assert.deepEqual(configured, {
    base_url: 'https://ai-feeds.cc',
    paths: ['/', '/privacy.html', '/terms.html', '/contact.html'],
  });

  const staticMap = await readFile(
    path.join(CC_SITE, 'sitemap-static.xml'),
    'utf8',
  );
  const locations = [...staticMap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1]);
  assert.deepEqual(locations, configured.paths.map(
    (urlPath) => `${configured.base_url}${urlPath}`,
  ));
  assert.doesNotMatch(staticMap, /verify|verification/i);

  const robots = await readFile(path.join(CC_SITE, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/auth\/$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/ai-feeds\.cc\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /Disallow: \/(?:i|ai-news)\//);

  const homepage = await readFile(path.join(CC_SITE, 'index.html'), 'utf8');
  assert.ok((homepage.match(/href="\/ai-news\/"[^>]*>AI 资讯<\/a>/g) ?? []).length >= 2);

  const deploy = await readFile(path.join(CC_SITE, 'deploy.sh'), 'utf8');
  assert.match(deploy, /robots\.txt/);
  assert.match(deploy, /sitemap-static\.xml/);
  const operativeDeploy = deploy
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(operativeDeploy, /(^|[ /])sitemap\.xml([ \\\n]|$)/m);
  assert.doesNotMatch(operativeDeploy, /(^|[ /])(?:ai-news|sitemaps|i)([ /\\\n]|$)/m);
});
