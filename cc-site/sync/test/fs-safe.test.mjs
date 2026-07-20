import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolvePageFile,
  writePageFileAtomic,
} from '../fs-safe.mjs';

async function siteRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-fs-safe-'));
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'i'), { recursive: true });
  return { root, site };
}

test('maps a safe item URL to its index.html below CC_SITE_ROOT/i', async () => {
  const { site } = await siteRoot();
  assert.equal(
    await resolvePageFile('/i/x/123', site),
    path.join(site, 'i', 'x', '123', 'index.html'),
  );
});

test('rejects malformed, traversing, empty, NUL, backslash, and double-encoded paths', async () => {
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
