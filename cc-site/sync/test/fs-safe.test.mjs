import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../config.mjs';
import {
  removePageFile,
  resolvePageFile,
  writePageFileAtomic,
} from '../fs-safe.mjs';

async function siteRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-fs-safe-'));
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'i'), { recursive: true });
  return { root, site };
}

test('maps canonical Worker item URLs to decoded filesystem paths', async () => {
  const { site } = await siteRoot();
  assert.equal(
    await resolvePageFile('/i/x/123', site),
    path.join(site, 'i', 'x', '123', 'index.html'),
  );
  assert.equal(
    await resolvePageFile(
      '/i/news/blog%3Aopenai%3Aitem-1',
      site,
    ),
    path.join(
      site,
      'i',
      'news',
      'blog:openai:item-1',
      'index.html',
    ),
  );
  assert.equal(
    await resolvePageFile(
      '/i/news/podcast%3Axiaoyuzhou%3Aabc-123',
      site,
    ),
    path.join(
      site,
      'i',
      'news',
      'podcast:xiaoyuzhou:abc-123',
      'index.html',
    ),
  );
});

test('rejects non-canonical aliases, traversal, separators, and repeated encoding', async () => {
  const { site } = await siteRoot();
  const rejected = [
    '/other/x/123',
    '/i/x/<123>',
    '/i/x/../secret',
    '/i/x/./secret',
    '/i/x//123',
    '/i/x/%00bad',
    '/i/x/%5Csecret',
    '/i/x/%252e%252e/secret',
    '/i/news/a%2Fb',
    '/i/news/blog:openai:item-1',
    '/i/news/%61',
    '/i/news/blog%3aopenai',
    '/i/../../outside',
    '/i/x/%',
  ];
  for (const urlPath of rejected) {
    await assert.rejects(
      resolvePageFile(urlPath, site),
      /unsafe|invalid/i,
      urlPath,
    );
  }
});

test('rejects a symlink anywhere in an existing page parent chain', async () => {
  const { root, site } = await siteRoot();
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(site, 'i', 'linked'));

  await assert.rejects(
    resolvePageFile('/i/linked/page', site),
    /symlink/i,
  );
});

test('an interrupted atomic page rename preserves the previous file', async () => {
  const { site } = await siteRoot();
  const file = await resolvePageFile('/i/news/atomic', site);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'old');

  await assert.rejects(
    writePageFileAtomic('/i/news/atomic', site, Buffer.from('new'), {
      hooks: {
        beforeRename() {
          throw new Error('simulated interruption');
        },
      },
    }),
    /simulated interruption/,
  );
  assert.equal(await readFile(file, 'utf8'), 'old');
});

test('atomic page writes sync temp bytes and the parent directory in order', async () => {
  const { site } = await siteRoot();
  const calls = [];
  await writePageFileAtomic('/i/news/durable', site, Buffer.from('durable'), {
    hooks: {
      afterTempWrite() {
        calls.push('write');
      },
      afterTempSync() {
        calls.push('temp-sync');
      },
      beforeRename() {
        calls.push('before-rename');
      },
      afterRename() {
        calls.push('rename');
      },
      afterDirectorySync() {
        calls.push('dir-sync');
      },
    },
  });
  assert.deepEqual(calls, [
    'write',
    'temp-sync',
    'before-rename',
    'rename',
    'dir-sync',
  ]);
});

test('new multi-level page directories and their parents are synced in order', async () => {
  const { site } = await siteRoot();
  const calls = [];
  await writePageFileAtomic(
    '/i/source/item',
    site,
    Buffer.from('durable tree'),
    {
      hooks: {
        afterCreatedDirectorySync(directory) {
          calls.push(`created-sync:${path.relative(site, directory)}`);
        },
        afterTempWrite() {
          calls.push('temp-write');
        },
        afterDirectorySync(directory) {
          calls.push(`page-sync:${path.relative(site, directory)}`);
        },
      },
    },
  );
  assert.deepEqual(calls, [
    'created-sync:i/source',
    'created-sync:i',
    'created-sync:i/source/item',
    'created-sync:i/source',
    'temp-write',
    'page-sync:i/source/item',
  ]);
});

test('atomic page writes fail closed when a parent is swapped before rename', async () => {
  const { root, site } = await siteRoot();
  const outside = path.join(root, 'outside');
  const moved = path.join(root, 'moved-parent');
  await mkdir(outside);

  await assert.rejects(
    writePageFileAtomic('/i/news/swap', site, Buffer.from('trusted'), {
      hooks: {
        async beforeRename(tempPath) {
          const pageParent = path.dirname(tempPath);
          await rename(pageParent, moved);
          await writeFile(
            path.join(outside, path.basename(tempPath)),
            'attacker-controlled',
          );
          await symlink(outside, pageParent);
        },
      },
    }),
    /unsafe|symlink|changed/i,
  );
  await assert.rejects(
    readFile(path.join(outside, 'index.html'), 'utf8'),
    /ENOENT/,
  );
});

test('page deletion syncs its parent and fails closed on a parent swap', async () => {
  const { root, site } = await siteRoot();
  const file = await resolvePageFile('/i/news/delete', site);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'delete me');
  const calls = [];
  await removePageFile('/i/news/delete', site, {
    hooks: {
      beforeRemove() {
        calls.push('before-remove');
      },
      afterRemove() {
        calls.push('remove');
      },
      afterDirectorySync() {
        calls.push('dir-sync');
      },
    },
  });
  assert.deepEqual(calls, ['before-remove', 'remove', 'dir-sync']);

  const swapFile = await resolvePageFile('/i/news/delete-swap', site);
  await mkdir(path.dirname(swapFile), { recursive: true });
  await writeFile(swapFile, 'local');
  const outside = path.join(root, 'delete-outside');
  const moved = path.join(root, 'delete-moved');
  await mkdir(outside);
  await writeFile(path.join(outside, 'index.html'), 'outside');
  await assert.rejects(
    removePageFile('/i/news/delete-swap', site, {
      hooks: {
        async beforeRemove() {
          await rename(path.dirname(swapFile), moved);
          await symlink(outside, path.dirname(swapFile));
        },
      },
    }),
    /unsafe|symlink|changed/i,
  );
  assert.equal(
    await readFile(path.join(outside, 'index.html'), 'utf8'),
    'outside',
  );
});

test('page operations reject a group/other-writable item root', async () => {
  const { site } = await siteRoot();
  await chmod(path.join(site, 'i'), 0o777);
  await assert.rejects(
    writePageFileAtomic('/i/news/permissions', site, Buffer.from('unsafe')),
    /writable|permission/i,
  );
});

test('page writes require the item root to be pre-provisioned securely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-fs-provision-'));
  const site = path.join(root, 'site');
  await mkdir(site);
  await assert.rejects(
    writePageFileAtomic('/i/news/missing-root', site, Buffer.from('unsafe')),
    /item root|provision/i,
  );
});

test('config requires canonical absolute roots and an origin-only secure API URL', () => {
  const base = {
    CC_SYNC_SECRET: 'fixture',
    CC_SITE_ROOT: '/srv/ai-feeds.cc',
    CC_SYNC_STATE_DIR: '/var/lib/aifeeds-cc-sync',
  };
  assert.equal(loadConfig(base).baseUrl, 'https://api.ai-feeds.com');

  for (const overrides of [
    { CC_SITE_ROOT: 'relative/site' },
    { CC_SITE_ROOT: '/' },
    { CC_SITE_ROOT: '/srv/../site' },
    { CC_SYNC_STATE_DIR: 'relative/state' },
    { CC_SYNC_STATE_DIR: '/' },
    {
      CC_SYNC_STATE_DIR: '/srv/ai-feeds.cc',
    },
    {
      CC_SYNC_STATE_DIR: '/srv/ai-feeds.cc/.sync-state',
    },
    {
      CC_SITE_ROOT: '/var/lib/aifeeds-cc-sync/site',
    },
    { CC_SYNC_BASE_URL: 'https://api.ai-feeds.com/prefix' },
    { CC_SYNC_BASE_URL: 'http://api.ai-feeds.com' },
    {
      CC_SYNC_BASE_URL: 'http://127.0.0.1:8787',
      CC_SYNC_ALLOW_INSECURE_LOCALHOST: '0',
    },
    {
      CC_SYNC_BASE_URL: 'http://example.test',
      CC_SYNC_ALLOW_INSECURE_LOCALHOST: '1',
    },
  ]) {
    assert.throws(() => loadConfig({ ...base, ...overrides }), /path|root|URL|HTTPS/i);
  }

  assert.equal(
    loadConfig({
      ...base,
      CC_SYNC_BASE_URL: 'http://127.0.0.1:8787',
      CC_SYNC_ALLOW_INSECURE_LOCALHOST: '1',
    }).baseUrl,
    'http://127.0.0.1:8787',
  );
});
