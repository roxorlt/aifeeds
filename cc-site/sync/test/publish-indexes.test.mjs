import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  escapeXml,
  publishIndexes,
} from '../publish-indexes.mjs';

const HASH = 'a'.repeat(64);
const RETAINED_GENERATIONS = 24;
const SITE_BASE_FOR_TESTS = 'https://ai-feeds.cc';
const PUBLIC_SITEMAP_URL_RE = /^https:\/\/ai-feeds\.cc\/sitemaps\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(archive|(?:news|x|gh|ph|hf-paper)-[1-9][0-9]*)\.xml$/;
const CC_SITE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

async function workspace({ staticSitemap = 'present' } = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'cc-index-test-'));
  const siteRoot = path.join(root, 'site');
  const stateDir = path.join(root, 'state');
  await mkdir(siteRoot, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  if (staticSitemap === 'present') {
    await writeFile(
      path.join(siteRoot, 'sitemap-static.xml'),
      '<urlset></urlset>\n',
    );
  } else if (staticSitemap === 'symlink') {
    const outsideStatic = path.join(root, 'outside-static.xml');
    await writeFile(outsideStatic, '<urlset></urlset>\n');
    await symlink(outsideStatic, path.join(siteRoot, 'sitemap-static.xml'));
  }
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

function publishedPath(dirs, ...parts) {
  return path.join(dirs.stateDir, 'public', 'current', ...parts);
}

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await lstat(file);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`publisher child exited early with ${child.exitCode}`);
    }
    await delay(25);
  }
  throw new Error('publisher child did not reach crash checkpoint');
}

test('XML escaping covers all markup-significant characters', () => {
  assert.equal(
    escapeXml(`<loc a="b">Tom & Jerry's</loc>`),
    '&lt;loc a=&quot;b&quot;&gt;Tom &amp; Jerry&apos;s&lt;/loc&gt;',
  );
});

test('index publisher has no standalone CLI outside the sync lock', async () => {
  const source = await readFile(
    path.join(CC_SITE, 'sync', 'publish-indexes.mjs'),
    'utf8',
  );
  assert.doesNotMatch(source, /process\.argv|isMain|loadConfig|loadState/);
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

  const published = await publishIndexes({
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    state: state(pages),
  });

  const first = await readFile(
    publishedPath(dirs, 'ai-news', 'index.html'),
    'utf8',
  );
  const second = await readFile(
    publishedPath(dirs, 'ai-news', 'page', '2', 'index.html'),
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
  for (const required of [
    '京ICP备2025123594号-2',
    '京公网安备11010802048455号',
    '/assets/gongan-icon.png',
    'support@ai-feeds.cc',
    '/privacy.html',
    '/terms.html',
    '/contact.html',
  ]) {
    assert.ok(first.includes(required), `archive footer missing ${required}`);
  }

  const sitemapIndex = await readFile(
    publishedPath(dirs, 'sitemap.xml'),
    'utf8',
  );
  assert.match(sitemapIndex, /https:\/\/ai-feeds\.cc\/sitemap-static\.xml/);
  assert.match(
    sitemapIndex,
    new RegExp(`https://ai-feeds\\.cc/sitemaps/${published.generation}/archive\\.xml`),
  );
  assert.match(
    sitemapIndex,
    new RegExp(`https://ai-feeds\\.cc/sitemaps/${published.generation}/news-1\\.xml`),
  );
  assert.doesNotMatch(
    sitemapIndex,
    /https:\/\/ai-feeds\.cc\/sitemaps\/(?:archive|news-1)\.xml/,
  );

  const archiveMap = await readFile(
    publishedPath(dirs, 'sitemaps', 'archive.xml'),
    'utf8',
  );
  assert.match(archiveMap, /https:\/\/ai-feeds\.cc\/ai-news\//);
  assert.match(archiveMap, /https:\/\/ai-feeds\.cc\/ai-news\/page\/2\//);

  const newsMap = await readFile(
    publishedPath(dirs, 'sitemaps', 'news-1.xml'),
    'utf8',
  );
  assert.equal((newsMap.match(/<url>/g) ?? []).length, 51);
  assert.doesNotMatch(newsMap, /<lastmod>/);
  assert.match(archiveMap, /<lastmod>20[0-9]{2}-/);
  assert.equal(
    (await stat(publishedPath(dirs, 'ai-news'))).isDirectory(),
    true,
  );
});

test('references the static sitemap only when it is a regular non-symlink file', async () => {
  for (const [fixture, expected] of [
    ['present', true],
    ['absent', false],
  ]) {
    const dirs = await workspace({ staticSitemap: fixture });
    await publishIndexes({
      ...dirs,
      state: state([]),
    });
    const index = await readFile(
      publishedPath(dirs, 'sitemap.xml'),
      'utf8',
    );
    assert.equal(
      index.includes('https://ai-feeds.cc/sitemap-static.xml'),
      expected,
      fixture,
    );
    assert.match(
      index,
      /https:\/\/ai-feeds\.cc\/sitemaps\/[0-9a-f-]{36}\/archive\.xml/,
    );
  }

  const symlinkDirs = await workspace({ staticSitemap: 'symlink' });
  await assert.rejects(
    publishIndexes({
      ...symlinkDirs,
      state: state([]),
    }),
    /static sitemap|symlink|regular/i,
  );
});

test('publishes with a read-only site root and writes generated output only under state', async () => {
  const dirs = await workspace();
  await mkdir(path.join(dirs.siteRoot, 'i'));
  await chmod(dirs.siteRoot, 0o555);
  try {
    await publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/item', metadata('news', 'Item', '2026-07-20T00:00:00Z')],
      ]),
    });
  } finally {
    await chmod(dirs.siteRoot, 0o700);
  }

  assert.equal(
    await readFile(publishedPath(dirs, 'ai-news', 'index.html'), 'utf8')
      .then((html) => html.includes('/i/news/item')),
    true,
  );
  assert.equal((await readdir(dirs.siteRoot)).includes('ai-news'), false);
  assert.match(
    await readlink(path.join(dirs.stateDir, 'public', 'current')),
    /^generations\/[0-9a-f-]{36}$/,
  );
});

test('rejects unsafe or externally resolving current generation links', async (t) => {
  for (const [name, target, setup] of [
    ['absolute', '/tmp/outside-generation', async () => {}],
    ['parent traversal', '../outside-generation', async () => {}],
    [
      'external generation symlink',
      'generations/11111111-1111-4111-8111-111111111111',
      async (dirs) => {
        const generations = path.join(dirs.stateDir, 'public', 'generations');
        await mkdir(generations, { recursive: true });
        const outside = path.join(dirs.root, 'outside-generation');
        await mkdir(outside);
        await symlink(
          outside,
          path.join(generations, '11111111-1111-4111-8111-111111111111'),
        );
      },
    ],
  ]) {
    await t.test(name, async () => {
      const dirs = await workspace();
      await setup(dirs);
      const publicDir = path.join(dirs.stateDir, 'public');
      await mkdir(publicDir, { recursive: true });
      await symlink(target, path.join(publicDir, 'current'));
      await assert.rejects(
        publishIndexes({ ...dirs, state: state([]) }),
        /current|generation|symlink|unsafe/i,
      );
    });
  }
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
    publishedPath(dirs, 'ai-news', 'index.html'),
    'utf8',
  );
  const titles = [...html.matchAll(/class="archive-item"><a[^>]*>([^<]*)<\/a>/g)]
    .map((match) => match[1]);
  assert.deepEqual(titles, ['a date', 'b date', 'a invalid', 'z null']);
  const sitemap = await readFile(
    publishedPath(dirs, 'sitemaps', 'x-1.xml'),
    'utf8',
  );
  assert.equal((sitemap.match(/<lastmod>/g) ?? []).length, 0);
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
    publishedPath(dirs, 'sitemaps', 'hf-paper-1.xml'),
    'utf8',
  );
  const second = await readFile(
    publishedPath(dirs, 'sitemaps', 'hf-paper-2.xml'),
    'utf8',
  );
  assert.equal((first.match(/<url>/g) ?? []).length, 45_000);
  assert.equal((second.match(/<url>/g) ?? []).length, 1);
  const index = await readFile(
    publishedPath(dirs, 'sitemap.xml'),
    'utf8',
  );
  assert.match(index, /hf-paper-1\.xml/);
  assert.match(index, /hf-paper-2\.xml/);
  assert.doesNotMatch(index, /news-1\.xml|x-1\.xml|gh-1\.xml|ph-1\.xml/);
});

test('only strict generation UUID and allowlisted sitemap filenames are generated', async () => {
  const dirs = await workspace();
  const published = await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/item', metadata('news', 'News', null)],
      ['/i/x/item', metadata('x', 'X', null)],
      ['/i/gh/item', metadata('gh', 'GitHub', null)],
      ['/i/ph/item', metadata('ph', 'Product Hunt', null)],
      ['/i/paper/item', metadata('paper', 'Paper', null)],
    ]),
  });
  const index = await readFile(publishedPath(dirs, 'sitemap.xml'), 'utf8');
  const dynamicLocations = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .filter((location) => location.includes('/sitemaps/'));

  assert.equal(dynamicLocations.length, 6);
  for (const location of dynamicLocations) {
    const match = PUBLIC_SITEMAP_URL_RE.exec(location);
    assert.notEqual(match, null, location);
    assert.equal(match[1], published.generation);
    assert.doesNotMatch(location, /(?:\.\.|%|\\)/);
  }
  assert.deepEqual(
    dynamicLocations.map((location) => location.split('/').at(-1)),
    [
      'archive.xml',
      'news-1.xml',
      'x-1.xml',
      'gh-1.xml',
      'ph-1.xml',
      'hf-paper-1.xml',
    ],
  );
});

test('cached generation sitemap URLs remain immutable across later publications', async () => {
  const dirs = await workspace();
  const first = await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/a', metadata('news', 'A', '2026-07-20T00:00:00Z')],
    ]),
  });
  const firstGeneration = path.join(
    dirs.stateDir,
    'public',
    'generations',
    first.generation,
  );
  const firstIndex = await readFile(
    path.join(firstGeneration, 'sitemap.xml'),
    'utf8',
  );
  const firstShardUrl = `${SITE_BASE_FOR_TESTS}/sitemaps/${first.generation}/news-1.xml`;
  const firstShard = path.join(firstGeneration, 'sitemaps', 'news-1.xml');
  const firstShardBytes = await readFile(firstShard);
  assert.ok(firstIndex.includes(firstShardUrl));

  for (const [urlPath, title] of [
    ['/i/news/b', 'B'],
    ['/i/news/c', 'C'],
  ]) {
    await publishIndexes({
      ...dirs,
      state: state([
        [urlPath, metadata('news', title, '2026-07-20T00:00:00Z')],
      ]),
    });
  }

  assert.equal(
    await readFile(path.join(firstGeneration, 'sitemap.xml'), 'utf8'),
    firstIndex,
  );
  assert.deepEqual(await readFile(firstShard), firstShardBytes);
});

test('generation retention is bounded and collects only after 24 complete generations', async () => {
  const dirs = await workspace();
  const first = await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/item-0', metadata('news', 'Generation 0', null)],
    ]),
  });
  const generationsPath = path.join(dirs.stateDir, 'public', 'generations');
  const firstPath = path.join(generationsPath, first.generation);

  for (let index = 1; index < RETAINED_GENERATIONS; index += 1) {
    await publishIndexes({
      ...dirs,
      state: state([
        [
          `/i/news/item-${index}`,
          metadata('news', `Generation ${index}`, null),
        ],
      ]),
    });
  }
  assert.equal((await lstat(firstPath)).isDirectory(), true);
  assert.equal((await readdir(generationsPath)).length, RETAINED_GENERATIONS);

  await publishIndexes({
    ...dirs,
    state: state([
      [
        `/i/news/item-${RETAINED_GENERATIONS}`,
        metadata('news', `Generation ${RETAINED_GENERATIONS}`, null),
      ],
    ]),
  });
  await assert.rejects(lstat(firstPath), { code: 'ENOENT' });
  const retained = await readdir(generationsPath);
  const journal = JSON.parse(await readFile(
    path.join(dirs.stateDir, 'public', 'publication-journal.json'),
    'utf8',
  ));
  assert.equal(retained.length, RETAINED_GENERATIONS);
  assert.ok(retained.includes(journal.current));
  assert.ok(retained.includes(journal.previous));
  assert.ok(retained.every((name) => /^[0-9a-f-]{36}$/.test(name)));
});

test('fails closed for an unknown source without replacing a prior generation', async () => {
  const dirs = await workspace();
  const oldState = state([
    ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
  ]);
  await publishIndexes({ ...dirs, state: oldState });
  const oldIndex = await readFile(
    publishedPath(dirs, 'sitemap.xml'),
    'utf8',
  );
  const oldArchive = await readFile(
    publishedPath(dirs, 'ai-news', 'index.html'),
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
    await readFile(publishedPath(dirs, 'sitemap.xml'), 'utf8'),
    oldIndex,
  );
  assert.equal(
    await readFile(publishedPath(dirs, 'ai-news', 'index.html'), 'utf8'),
    oldArchive,
  );
});

test('does not change the live generation when activation preparation fails', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const paths = {
    archive: publishedPath(dirs, 'ai-news', 'index.html'),
    shard: publishedPath(dirs, 'sitemaps', 'news-1.xml'),
    index: publishedPath(dirs, 'sitemap.xml'),
  };
  const before = Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([name, file]) => [
      name,
      await readFile(file, 'utf8'),
    ]),
  ));
  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        afterPrepared() {
          throw new Error('injected activation failure');
        },
      },
    }),
    /injected activation failure/,
  );
  for (const [name, file] of Object.entries(paths)) {
    assert.equal(await readFile(file, 'utf8'), before[name]);
  }
});

test('recovers real SIGKILL crashes and retains current plus previous generations', async (t) => {
  for (const phase of ['afterPrepared', 'afterCurrentSwap']) {
    await t.test(phase, async () => {
      const dirs = await workspace();
      const oldState = state([
        ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
      ]);
      const newState = state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]);
      await publishIndexes({ ...dirs, state: oldState });
      const oldCurrent = await readlink(
        path.join(dirs.stateDir, 'public', 'current'),
      );
      const stateFile = path.join(dirs.root, `state-${phase}.json`);
      const readyFile = path.join(dirs.root, `ready-${phase}`);
      await writeFile(stateFile, JSON.stringify(newState));
      const fixture = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'fixtures',
        'publish-and-pause.mjs',
      );
      const child = spawn(process.execPath, [
        fixture,
        dirs.siteRoot,
        dirs.stateDir,
        stateFile,
        readyFile,
        phase,
      ], { stdio: 'ignore' });

      await waitForFile(readyFile, child);
      const duringCrash = await readlink(
        path.join(dirs.stateDir, 'public', 'current'),
      );
      assert.equal(
        duringCrash === oldCurrent,
        phase === 'afterPrepared',
      );
      assert.match(
        await readFile(publishedPath(dirs, 'ai-news', 'index.html'), 'utf8'),
        phase === 'afterPrepared' ? /Old/ : /New/,
      );
      await readFile(publishedPath(dirs, 'sitemap.xml'), 'utf8');
      child.kill('SIGKILL');
      const [, signal] = await once(child, 'exit');
      assert.equal(signal, 'SIGKILL');

      await readFile(publishedPath(dirs, 'ai-news', 'index.html'), 'utf8');
      await readFile(publishedPath(dirs, 'sitemap.xml'), 'utf8');
      await publishIndexes({ ...dirs, state: newState });

      const publicDir = path.join(dirs.stateDir, 'public');
      const journal = JSON.parse(await readFile(
        path.join(publicDir, 'publication-journal.json'),
        'utf8',
      ));
      assert.equal(journal.phase, 'stable');
      assert.notEqual(journal.current, journal.previous);
      assert.equal(
        await readlink(path.join(publicDir, 'current')),
        `generations/${journal.current}`,
      );
      const names = await readdir(path.join(publicDir, 'generations'));
      assert.ok(names.includes(journal.current));
      assert.ok(names.includes(journal.previous));
      assert.ok(names.length <= RETAINED_GENERATIONS);
      assert.ok(names.every((name) => /^[0-9a-f-]{36}$/.test(name)));
      assert.match(
        await readFile(publishedPath(dirs, 'ai-news', 'index.html'), 'utf8'),
        /New/,
      );
    });
  }
});

test('recovery GC fails closed before reading or deleting a replacement parent tree', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const movedState = path.join(dirs.root, 'moved-state');
  const replacementStage = path.join(
    dirs.stateDir,
    'public',
    'generations',
    '.stage.44444444-4444-4444-8444-444444444444',
  );
  let swapped = false;

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        async beforeGarbageCollection() {
          if (swapped) return;
          swapped = true;
          await rename(dirs.stateDir, movedState);
          await mkdir(replacementStage, { recursive: true });
          await writeFile(
            path.join(replacementStage, 'sentinel'),
            'replacement untouched',
          );
        },
      },
    }),
    /changed|unsafe.*directory|generation.*chain|recovery/i,
  );
  assert.equal(
    await readFile(path.join(replacementStage, 'sentinel'), 'utf8'),
    'replacement untouched',
  );
  assert.deepEqual(await readdir(replacementStage), ['sentinel']);

  await rm(dirs.stateDir, { recursive: true });
  await rename(movedState, dirs.stateDir);
});

test('no-op publication rejects static sitemap changes during recovery GC', async (t) => {
  for (const mutation of ['delete', 'regular', 'symlink']) {
    await t.test(mutation, async () => {
      const dirs = await workspace();
      const unchangedState = state([
        ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
      ]);
      await publishIndexes({ ...dirs, state: unchangedState });
      const publicDir = path.join(dirs.stateDir, 'public');
      const currentPath = path.join(publicDir, 'current');
      const generationsPath = path.join(publicDir, 'generations');
      const currentBefore = await readlink(currentPath);
      const generationsBefore = await readdir(generationsPath);
      const livePaths = [
        publishedPath(dirs, 'ai-news', 'index.html'),
        publishedPath(dirs, 'sitemap.xml'),
        publishedPath(dirs, 'sitemaps', 'news-1.xml'),
      ];
      const liveBefore = await Promise.all(
        livePaths.map((file) => readFile(file, 'utf8')),
      );
      const staticFile = path.join(dirs.siteRoot, 'sitemap-static.xml');
      const outside = path.join(dirs.root, 'outside-static.xml');
      await writeFile(outside, '<urlset></urlset>\n');
      let mutated = false;

      await assert.rejects(
        publishIndexes({
          ...dirs,
          state: unchangedState,
          hooks: {
            async beforeGarbageCollection() {
              if (mutated) return;
              mutated = true;
              await unlink(staticFile);
              if (mutation === 'regular') {
                await writeFile(staticFile, '<urlset>replacement</urlset>\n');
              } else if (mutation === 'symlink') {
                await symlink(outside, staticFile);
              }
            },
          },
        }),
        /static sitemap|symlink|regular|changed/i,
      );
      assert.equal(await readlink(currentPath), currentBefore);
      assert.deepEqual(await readdir(generationsPath), generationsBefore);
      assert.deepEqual(
        await Promise.all(livePaths.map((file) => readFile(file, 'utf8'))),
        liveBefore,
      );
    });
  }
});

test('changed publication rechecks the static sitemap after activation GC', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const staticFile = path.join(dirs.siteRoot, 'sitemap-static.xml');
  let garbageCollections = 0;

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        async beforeGarbageCollection() {
          garbageCollections += 1;
          if (garbageCollections === 2) {
            await unlink(staticFile);
          }
        },
      },
    }),
    /static sitemap|changed/i,
  );
  assert.equal(garbageCollections >= 2, true);
});

test('afterPrepared static sitemap deletion or replacement never activates the new generation', async (t) => {
  for (const mutation of ['delete', 'regular', 'symlink']) {
    await t.test(mutation, async () => {
      const dirs = await workspace();
      await publishIndexes({
        ...dirs,
        state: state([
          ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
        ]),
      });
      const currentPath = path.join(dirs.stateDir, 'public', 'current');
      const currentBefore = await readlink(currentPath);
      const livePaths = [
        publishedPath(dirs, 'ai-news', 'index.html'),
        publishedPath(dirs, 'sitemap.xml'),
        publishedPath(dirs, 'sitemaps', 'news-1.xml'),
      ];
      const liveBefore = await Promise.all(
        livePaths.map((file) => readFile(file, 'utf8')),
      );
      const staticFile = path.join(dirs.siteRoot, 'sitemap-static.xml');
      const outside = path.join(dirs.root, 'outside-static.xml');
      await writeFile(outside, '<urlset></urlset>\n');

      await assert.rejects(
        publishIndexes({
          ...dirs,
          state: state([
            ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
          ]),
          hooks: {
            async afterPrepared() {
              await unlink(staticFile);
              if (mutation === 'regular') {
                await writeFile(staticFile, '<urlset>replacement</urlset>\n');
              } else if (mutation === 'symlink') {
                await symlink(outside, staticFile);
              }
            },
          },
        }),
        /static sitemap|symlink|regular|changed/i,
      );
      assert.equal(await readlink(currentPath), currentBefore);
      assert.deepEqual(
        await Promise.all(livePaths.map((file) => readFile(file, 'utf8'))),
        liveBefore,
      );
    });
  }
});

test('a staging-generation failure leaves the entire previous generation untouched', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/x/old', metadata('x', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const archiveFile = publishedPath(dirs, 'ai-news', 'index.html');
  const sitemapFile = publishedPath(dirs, 'sitemap.xml');
  const shardFile = publishedPath(dirs, 'sitemaps', 'x-1.xml');
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
    (await readdir(path.join(dirs.stateDir, 'public', 'generations')))
      .some((name) => name.startsWith('.stage.')),
    false,
  );
});

test('a root sitemap staging failure leaves every live output untouched', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const paths = [
    publishedPath(dirs, 'ai-news', 'index.html'),
    publishedPath(dirs, 'sitemaps', 'news-1.xml'),
    publishedPath(dirs, 'sitemap.xml'),
  ];
  const before = await Promise.all(paths.map((file) => readFile(file, 'utf8')));

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        async beforeStageSitemapIndex(stageRoot) {
          await mkdir(path.join(stageRoot, 'sitemap.xml'));
        },
      },
    }),
    /EEXIST|already exists/i,
  );
  assert.deepEqual(
    await Promise.all(paths.map((file) => readFile(file, 'utf8'))),
    before,
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
    publishedPath(dirs, 'ai-news', 'index.html'),
    'utf8',
  );
  const sitemap = await readFile(
    publishedPath(dirs, 'sitemaps', 'gh-1.xml'),
    'utf8',
  );
  assert.match(`${archive}${sitemap}`, /\/i\/gh\/keep/);
  assert.doesNotMatch(`${archive}${sitemap}`, /\/i\/gh\/delete/);
});

test('skips rebuilding indexes when the public-state fingerprint is unchanged', async () => {
  const dirs = await workspace();
  const fixture = state([
    ['/i/gh/item', metadata('gh', 'Item', '2026-07-20T00:00:00Z')],
  ]);
  const first = await publishIndexes({ ...dirs, state: fixture });
  const firstLink = await readlink(
    path.join(dirs.stateDir, 'public', 'current'),
  );
  const publicDir = path.join(dirs.stateDir, 'public');
  const generationsDir = path.join(publicDir, 'generations');
  await mkdir(path.join(
    generationsDir,
    '.stage.22222222-2222-4222-8222-222222222222',
  ));
  await writeFile(
    path.join(
      publicDir,
      '.publication-journal.json.tmp.33333333-3333-4333-8333-333333333333',
    ),
    'orphan',
  );
  const second = await publishIndexes({ ...dirs, state: fixture });
  const generationNames = await readdir(generationsDir);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(
    await readlink(path.join(dirs.stateDir, 'public', 'current')),
    firstLink,
  );
  assert.deepEqual(generationNames, [first.generation]);
  assert.deepEqual(
    (await readdir(publicDir)).filter((name) => name.includes('.tmp.')),
    [],
  );
});

test('rejects an intermediate symlink in the configured site root', async () => {
  const base = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    'cc-index-site-link-',
  ));
  const actualParent = path.join(base, 'actual-site-parent');
  const linkedParent = path.join(base, 'linked-site-parent');
  const stateDir = path.join(base, 'state');
  await mkdir(path.join(actualParent, 'site'), { recursive: true });
  await mkdir(stateDir);
  await writeFile(
    path.join(actualParent, 'site', 'sitemap-static.xml'),
    '<urlset></urlset>\n',
  );
  await symlink(actualParent, linkedParent);

  await assert.rejects(
    publishIndexes({
      siteRoot: path.join(linkedParent, 'site'),
      stateDir,
      state: state([]),
    }),
    /symlink|unsafe.*directory/i,
  );
  assert.deepEqual(await readdir(path.join(actualParent, 'site')), [
    'sitemap-static.xml',
  ]);
});

test('rejects intermediate symlinks in the state/public root chain', async () => {
  const base = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    'cc-index-state-link-',
  ));
  const siteRoot = path.join(base, 'site');
  const actualParent = path.join(base, 'actual-state-parent');
  const linkedParent = path.join(base, 'linked-state-parent');
  await mkdir(siteRoot);
  await writeFile(
    path.join(siteRoot, 'sitemap-static.xml'),
    '<urlset></urlset>\n',
  );
  await mkdir(path.join(actualParent, 'state'), { recursive: true });
  await symlink(actualParent, linkedParent);

  await assert.rejects(
    publishIndexes({
      siteRoot,
      stateDir: path.join(linkedParent, 'state'),
      state: state([]),
    }),
    /symlink|unsafe.*directory/i,
  );
  assert.deepEqual(await readdir(path.join(actualParent, 'state')), []);

  const realState = path.join(base, 'real-state');
  const outsidePublic = path.join(base, 'outside-public');
  await mkdir(realState);
  await mkdir(outsidePublic);
  await writeFile(path.join(outsidePublic, 'sentinel'), 'unchanged');
  await symlink(outsidePublic, path.join(realState, 'public'));
  await assert.rejects(
    publishIndexes({
      siteRoot,
      stateDir: realState,
      state: state([]),
    }),
    /symlink|unsafe.*directory/i,
  );
  assert.deepEqual(await readdir(outsidePublic), ['sentinel']);
});

test('fails closed when a pinned site-root ancestor is swapped before commit', async () => {
  const base = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    'cc-index-swap-',
  ));
  const parent = path.join(base, 'owned-parent');
  const movedParent = path.join(base, 'moved-parent');
  const siteRoot = path.join(parent, 'site');
  const stateDir = path.join(base, 'state');
  await mkdir(siteRoot, { recursive: true });
  await mkdir(stateDir);
  await writeFile(
    path.join(siteRoot, 'sitemap-static.xml'),
    '<urlset></urlset>\n',
  );

  await assert.rejects(
    publishIndexes({
      siteRoot,
      stateDir,
      state: state([]),
      hooks: {
        async afterStageBuilt() {
          await rename(parent, movedParent);
          await symlink(movedParent, parent);
        },
      },
    }),
    /symlink|changed|unsafe.*directory|recovery/i,
  );
  const remaining = await readdir(path.join(movedParent, 'site'));
  assert.ok(remaining.includes('sitemap-static.xml'));
  assert.equal(remaining.includes('ai-news'), false);
  await rm(parent);
  await rename(movedParent, parent);
});

test('a state-root ancestor swap fails closed before current activation', async () => {
  const base = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    'cc-index-state-swap-',
  ));
  const siteRoot = path.join(base, 'site');
  const parent = path.join(base, 'owned-state-parent');
  const movedParent = path.join(base, 'moved-state-parent');
  const stateDir = path.join(parent, 'state');
  await mkdir(siteRoot);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(siteRoot, 'sitemap-static.xml'),
    '<urlset></urlset>\n',
  );
  await assert.rejects(
    publishIndexes({
      siteRoot,
      stateDir,
      state: state([]),
      hooks: {
        async afterStageBuilt() {
          await rename(parent, movedParent);
          await symlink(movedParent, parent);
        },
      },
    }),
    /symlink|changed|unsafe.*directory|recovery/i,
  );
  await rm(parent);
  await rename(movedParent, parent);
});

test('rejects a replaced current pointer without traversing its target', async () => {
  const dirs = await workspace();
  const current = path.join(dirs.stateDir, 'public', 'current');
  const displaced = path.join(dirs.root, 'displaced-current');
  const outside = path.join(dirs.root, 'outside-current');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/item', metadata('news', 'Item', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        async afterCurrentSwap() {
          await rename(current, displaced);
          await symlink(outside, current);
        },
      },
    }),
    /current|generation|symlink|recovery/i,
  );
  assert.equal((await lstat(current)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(
    await readFile(path.join(outside, 'sentinel'), 'utf8'),
    'unchanged',
  );
});

test('rejects a regular-to-symlink static sitemap swap before activation', async () => {
  const dirs = await workspace();
  await publishIndexes({
    ...dirs,
    state: state([
      ['/i/news/old', metadata('news', 'Old', '2026-07-19T00:00:00Z')],
    ]),
  });
  const paths = [
    publishedPath(dirs, 'ai-news', 'index.html'),
    publishedPath(dirs, 'sitemap.xml'),
    publishedPath(dirs, 'sitemaps', 'news-1.xml'),
  ];
  const before = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
  const staticFile = path.join(dirs.siteRoot, 'sitemap-static.xml');
  const outside = path.join(dirs.root, 'outside-static.xml');
  await writeFile(outside, '<urlset></urlset>\n');

  await assert.rejects(
    publishIndexes({
      ...dirs,
      state: state([
        ['/i/news/new', metadata('news', 'New', '2026-07-20T00:00:00Z')],
      ]),
      hooks: {
        async afterStageBuilt() {
          await unlink(staticFile);
          await symlink(outside, staticFile);
        },
      },
    }),
    /static sitemap|symlink|regular/i,
  );
  assert.deepEqual(
    await Promise.all(paths.map((file) => readFile(file, 'utf8'))),
    before,
  );
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
    (await readdir(publishedPath(dirs, 'ai-news', 'page'))).length,
    600,
  );
  const sitemap = await readFile(
    publishedPath(dirs, 'sitemaps', 'ph-1.xml'),
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
    paths: [
      '/',
      '/privacy.html',
      '/terms.html',
      '/contact.html',
      '/cc-prompts/',
      '/cc-prompts/best-practices.html',
      '/cc-prompts/common-workflows.html',
      '/cc-prompts/how-anthropic-teams-use-claude-code.html',
    ],
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
  assert.match(deploy, /set -euo pipefail/g);
  assert.equal(
    (deploy.match(/mktemp -d \/tmp\/cc-site-staging\.XXXXXX/g) ?? []).length,
    1,
  );
  assert.match(deploy, /trap .*EXIT/);
  assert.match(deploy, /sudo install -o www -g www -m 0644/);
  assert.match(deploy, /curl[^\n]*--fail[^\n]*--max-time/);
  assert.match(deploy, /\[\[ "\$code" == "200" \]\]/);
  assert.match(deploy, /robots\.txt/);
  assert.match(deploy, /sitemap-static\.xml/);
  for (const promptPath of [
    'cc-prompts/index.html',
    'cc-prompts/best-practices.html',
    'cc-prompts/common-workflows.html',
    'cc-prompts/how-anthropic-teams-use-claude-code.html',
  ]) {
    const promptHtml = await readFile(path.join(CC_SITE, promptPath), 'utf8');
    for (const required of [
      '京ICP备2025123594号-2',
      '京公网安备11010802048455号',
      '/assets/gongan-icon.png',
      'support@ai-feeds.cc',
      '/privacy.html',
      '/terms.html',
      '/contact.html',
    ]) {
      assert.ok(
        promptHtml.includes(required),
        `${promptPath} footer missing ${required}`,
      );
    }
    assert.equal(
      (deploy.match(new RegExp(promptPath.replaceAll('.', '\\.'), 'g')) ?? [])
        .length >= (promptPath.endsWith('/index.html') ? 1 : 2),
      true,
      `${promptPath} must be explicitly listed and smoke tested`,
    );
    if (promptPath.endsWith('/index.html')) {
      assert.match(deploy, /\/cc-prompts\//);
    }
    await stat(path.join(CC_SITE, promptPath));
  }
  const operativeDeploy = deploy
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(operativeDeploy, /(^|[ /])sitemap\.xml([ \\\n]|$)/m);
  assert.doesNotMatch(operativeDeploy, /(^|[ /])(?:ai-news|sitemaps|i)([ /\\\n]|$)/m);

  for (const [verificationFile, bytes, digest] of [
    [
      '372c4ae2a3701bbe3b091dff54fb6d14.txt',
      32,
      '1f42e6168b957ed3d00eee2ff5e8d9e310996e0602268bdffbda6e1f6c888547',
    ],
    [
      'sogousiteverification.txt',
      10,
      '307e17cfe3aefe3236227ae7dd65dc140e01697649dcb50cd48acbf8e609a427',
    ],
    [
      'shenma-site-verification.txt',
      68,
      '6719f0568ed216f3c632a7347130d6a13335c2797c28933dc2776911e96864ab',
    ],
    [
      'baidu_verify_codeva-OHhjgzJndf.html',
      32,
      '48c98dd64434d9bd1634b1aaa3cbc1f8724b4fffc5ecc98899137b2ab1993f1b',
    ],
  ]) {
    const body = await readFile(path.join(CC_SITE, verificationFile));
    assert.equal(body.length, bytes, verificationFile);
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      digest,
      verificationFile,
    );
    assert.ok(deploy.includes(`${verificationFile}|${bytes}|${digest}`));
  }
});
