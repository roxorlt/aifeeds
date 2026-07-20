import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SyncClient } from '../client.mjs';
import { resolvePageFile } from '../fs-safe.mjs';
import {
  acquireSyncLock,
  createEmptyState,
  loadState,
  saveState,
  stateFilePath,
} from '../state.mjs';
import { runSync } from '../sync.mjs';

const SECRET = 'local-sync-test-secret';
const H0 = createHash('sha256').update('<h1>zero</h1>').digest('hex');
const H1 = createHash('sha256').update('<h1>one</h1>').digest('hex');
const H2 = createHash('sha256').update('<h1>two</h1>').digest('hex');
const H3 = createHash('sha256').update('<h1>three</h1>').digest('hex');

function lockFilePath(stateDir) {
  return path.join(stateDir, 'sync.lock');
}

function lockGuardFilePath(stateDir) {
  return path.join(stateDir, 'sync.lock.guard');
}

function lockGuardOwnerFilePath(stateDir, token) {
  return path.join(
    lockGuardFilePath(stateDir),
    `owner-${token}.json`,
  );
}

async function writeGuardOwnerFixture(stateDir, owner) {
  await mkdir(lockGuardFilePath(stateDir), { mode: 0o700 });
  await writeFile(
    lockGuardOwnerFilePath(stateDir, owner.token),
    `${JSON.stringify(owner)}\n`,
  );
}

async function readGuardOwnerFixture(stateDir) {
  const names = await readdir(lockGuardFilePath(stateDir));
  assert.equal(names.length, 1);
  return JSON.parse(
    await readFile(
      path.join(lockGuardFilePath(stateDir), names[0]),
      'utf8',
    ),
  );
}

function metadata(itemId, urlPath, hash, overrides = {}) {
  return {
    item_id: itemId,
    source: 'news',
    url_path: urlPath,
    content_hash: hash,
    title: itemId,
    published_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

function change(seq, op, item, overrides = {}) {
  return {
    seq,
    item_id: item.item_id,
    op,
    source: item.source,
    url_path: item.url_path,
    content_hash: op === 'delete' ? null : item.content_hash,
    title: item.title,
    published_at: item.published_at,
    ...overrides,
  };
}

function strictEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .sort((left, right) => {
      if (left.key !== right.key) return left.key < right.key ? -1 : 1;
      if (left.value !== right.value) return left.value < right.value ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ key, value }) => `${strictEncode(key)}=${strictEncode(value)}`)
    .join('&');
}

function validSignature(request, url) {
  const timestamp = request.headers['x-cc-timestamp'];
  const signature = request.headers['x-cc-signature'];
  if (!/^(0|[1-9][0-9]*)$/.test(timestamp ?? '')) return false;
  const canonical = [
    timestamp,
    request.method.toUpperCase(),
    url.pathname,
    canonicalQuery(url),
    createHash('sha256').update('').digest('hex'),
  ].join('\n');
  return signature === createHmac('sha256', SECRET).update(canonical).digest('hex');
}

class SyncApiFixture {
  constructor({ watermark = 0, bootstrap = [], changes = [], pages = new Map() } = {}) {
    this.watermark = watermark;
    this.bootstrap = bootstrap;
    this.changes = changes;
    this.pages = pages;
    this.requests = [];
    this.onFirstBootstrap = null;
    this.failPath = null;
    this.corruptHashes = new Set();
    this.hangPath = null;
    this.hangBodyPath = null;
    this.bootstrapResponseTransform = null;
    this.firstBootstrapSeen = false;
  }

  async start() {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  handle(request, response) {
    const url = new URL(request.url, this.baseUrl);
    this.requests.push({
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      queryEntries: [...url.searchParams.entries()],
      signed: validSignature(request, url),
    });

    if (this.hangPath === url.pathname) return;
    if (this.failPath === url.pathname) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('unauthorized');
      return;
    }
    if (!validSignature(request, url)) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('unauthorized');
      return;
    }
    if (this.hangBodyPath === url.pathname) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      return;
    }

    if (url.pathname === '/api/cc-sync/bootstrap') {
      const after = url.searchParams.get('after_item_id') ?? '';
      const limit = Number(url.searchParams.get('limit'));
      const rows = this.bootstrap
        .filter((item) => item.item_id > after)
        .sort((left, right) => left.item_id.localeCompare(right.item_id));
      const items = rows.slice(0, limit);
      const rawBody = {
        watermark: after ? Number(url.searchParams.get('watermark')) : this.watermark,
        items,
        next_after_item_id: rows.length > limit
          ? items.at(-1).item_id
          : null,
      };
      const body = this.bootstrapResponseTransform
        ? this.bootstrapResponseTransform(rawBody, { after, limit })
        : rawBody;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      if (!this.firstBootstrapSeen) {
        this.firstBootstrapSeen = true;
        this.onFirstBootstrap?.(this);
      }
      return;
    }

    if (url.pathname === '/api/cc-sync/changes') {
      const after = Number(url.searchParams.get('after_seq'));
      const limit = Number(url.searchParams.get('limit'));
      const items = this.changes
        .filter((item) => item.seq > after)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        items,
        next_after_seq: items.length ? items.at(-1).seq : after,
      }));
      return;
    }

    if (url.pathname === '/api/cc-sync/page') {
      const itemId = url.searchParams.get('item_id');
      const hash = url.searchParams.get('content_hash');
      const html = this.pages.get(`${itemId}\0${hash}`);
      if (html === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      const bytes = this.corruptHashes.has(hash) ? `${html}corrupt` : html;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(bytes);
      return;
    }

    response.writeHead(404);
    response.end();
  }
}

async function workspace() {
  const root = await mkdtemp(path.join(
    await realpath(os.tmpdir()),
    'cc-sync-test-',
  ));
  const siteRoot = path.join(root, 'site');
  const stateDir = path.join(root, 'state');
  await mkdir(path.join(siteRoot, 'i'), { recursive: true });
  return { root, siteRoot, stateDir };
}

function config(api, dirs, overrides = {}) {
  return {
    baseUrl: api.baseUrl,
    secret: SECRET,
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    concurrency: 3,
    pageLimit: 1,
    requestTimeoutMs: 500,
    allowInsecureLocalhost: true,
    ...overrides,
  };
}

async function body(urlPath, siteRoot) {
  return readFile(await resolvePageFile(urlPath, siteRoot), 'utf8');
}

function streamingResponse(bytes, {
  status = 200,
  contentLength,
  chunkSize = 64 * 1024,
  contentType = 'application/octet-stream',
} = {}) {
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        // Oversize fixtures intentionally remain open so cancellation on
        // overflow is observable instead of racing a queued close.
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = { 'content-type': contentType };
  if (contentLength !== undefined) {
    headers['content-length'] = String(contentLength);
  }
  return {
    response: new Response(stream, { status, headers }),
    cancelled: () => cancelled,
  };
}

test('bootstrap freezes W, survives the item cursor race, and changes begin exactly at W', async (t) => {
  const dirs = await workspace();
  const b = metadata('blog:b', '/i/news/b', H1);
  const c = metadata('blog:c', '/i/news/c', H2);
  const a = metadata('blog:a', '/i/news/a', H3);
  const api = await new SyncApiFixture({
    watermark: 10,
    bootstrap: [b, c],
    pages: new Map([
      [`${b.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${c.item_id}\0${H2}`, '<h1>two</h1>'],
      [`${a.item_id}\0${H3}`, '<h1>three</h1>'],
    ]),
  }).start();
  t.after(() => api.close());
  api.onFirstBootstrap = (fixture) => {
    fixture.bootstrap.push(a);
    fixture.changes.push(change(11, 'upsert', a));
    fixture.watermark = 11;
  };

  await runSync({ config: config(api, dirs) });

  assert.equal(await body('/i/news/a', dirs.siteRoot), '<h1>three</h1>');
  assert.equal(await body('/i/news/b', dirs.siteRoot), '<h1>one</h1>');
  assert.equal(await body('/i/news/c', dirs.siteRoot), '<h1>two</h1>');
  const saved = await loadState(dirs.stateDir);
  assert.equal(saved.last_seq, 11);
  assert.equal(saved.bootstrap, null);
  assert.deepEqual(Object.keys(saved.pages).sort(), [
    '/i/news/a',
    '/i/news/b',
    '/i/news/c',
  ]);

  assert.ok(api.requests.every((request) => request.signed));
  const bootstrapRequests = api.requests.filter(
    (request) => request.pathname === '/api/cc-sync/bootstrap',
  );
  assert.equal(bootstrapRequests[0].query.watermark, '');
  assert.equal(bootstrapRequests[0].query.after_item_id, '');
  for (const request of bootstrapRequests.slice(1)) {
    assert.equal(request.query.watermark, '10');
  }
  const firstChanges = api.requests.find(
    (request) => request.pathname === '/api/cc-sync/changes',
  );
  assert.equal(firstChanges.query.after_seq, '10');
});

test('bootstrap resumes a persisted first page even when its frozen watermark is zero', async (t) => {
  const dirs = await workspace();
  const b = metadata('blog:b', '/i/news/b', H1);
  const c = metadata('blog:c', '/i/news/c', H2);
  const api = await new SyncApiFixture({
    watermark: 1,
    bootstrap: [b, c],
    pages: new Map([
      [`${b.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${c.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());

  const state = createEmptyState();
  state.bootstrap = {
    request_limit: 1,
    watermark: 0,
    after_item_id: '',
    pages: {},
    pending: {
      items: [b],
      next_after_item_id: b.item_id,
    },
  };
  await saveState(dirs.stateDir, state);

  await runSync({ config: config(api, dirs) });

  assert.equal(await body(b.url_path, dirs.siteRoot), '<h1>one</h1>');
  assert.equal(await body(c.url_path, dirs.siteRoot), '<h1>two</h1>');
  const firstBootstrap = api.requests.find(
    (request) => request.pathname === '/api/cc-sync/bootstrap',
  );
  assert.equal(firstBootstrap.query.after_item_id, b.item_id);
  assert.equal(firstBootstrap.query.watermark, '0');
});

test('bootstrap rejects malformed ordering, limits, cursors, and canonical paths', async (t) => {
  const a = metadata('blog:a', '/i/news/a', H1);
  const b = metadata('blog:b', '/i/news/b', H2);
  const scenarios = [
    {
      name: 'more items than requested',
      pageLimit: 1,
      transform: (body) => ({
        ...body,
        items: [a, b],
        next_after_item_id: b.item_id,
      }),
    },
    {
      name: 'descending item ids',
      pageLimit: 2,
      transform: (body) => ({
        ...body,
        items: [b, a],
        next_after_item_id: null,
      }),
    },
    {
      name: 'duplicate item ids',
      pageLimit: 2,
      transform: (body) => ({
        ...body,
        items: [a, a],
        next_after_item_id: null,
      }),
    },
    {
      name: 'cursor differs from final item',
      pageLimit: 1,
      transform: (body) => ({
        ...body,
        items: [a],
        next_after_item_id: 'blog:wrong',
      }),
    },
    {
      name: 'cursor accompanies an empty page',
      pageLimit: 1,
      transform: (body) => ({
        ...body,
        items: [],
        next_after_item_id: a.item_id,
      }),
    },
    {
      name: 'encoded URL alias',
      pageLimit: 1,
      transform: (body) => ({
        ...body,
        items: [{ ...a, url_path: '/i/news/%61' }],
        next_after_item_id: null,
      }),
    },
    {
      name: 'invalid content hash',
      pageLimit: 1,
      transform: (body) => ({
        ...body,
        items: [{ ...a, content_hash: 'not-a-sha256' }],
        next_after_item_id: null,
      }),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const dirs = await workspace();
      const api = await new SyncApiFixture({
        watermark: 3,
        bootstrap: [a, b],
      }).start();
      t.after(() => api.close());
      api.bootstrapResponseTransform = scenario.transform;

      await assert.rejects(
        runSync({
          config: config(api, dirs, { pageLimit: scenario.pageLimit }),
        }),
        /invalid bootstrap|canonical|unsafe/i,
      );
      const state = await loadState(dirs.stateDir);
      assert.equal(state.bootstrap.after_item_id, '');
      assert.equal(state.bootstrap.pending, null);
      assert.deepEqual(state.bootstrap.pages, {});
      assert.equal(
        api.requests.some((request) => (
          request.pathname === '/api/cc-sync/page'
        )),
        false,
      );
    });
  }
});

test('bootstrap rejects an item id that does not advance its persisted cursor', async (t) => {
  const dirs = await workspace();
  const a = metadata('blog:a', '/i/news/a', H1);
  const b = metadata('blog:b', '/i/news/b', H2);
  const api = await new SyncApiFixture({
    watermark: 3,
    bootstrap: [a, b],
  }).start();
  t.after(() => api.close());
  api.bootstrapResponseTransform = (body) => ({
    ...body,
    items: [a],
    next_after_item_id: null,
  });

  const state = createEmptyState();
  state.bootstrap = {
    request_limit: 2,
    watermark: 3,
    after_item_id: b.item_id,
    pages: {
      [b.url_path]: {
        hash: b.content_hash,
        source: b.source,
        title: b.title,
        published_at: b.published_at,
      },
    },
    pending: null,
  };
  await saveState(dirs.stateDir, state);

  await assert.rejects(
    runSync({ config: config(api, dirs) }),
    /invalid bootstrap/i,
  );
  assert.equal((await loadState(dirs.stateDir)).bootstrap.after_item_id, b.item_id);
});

test('bootstrap revalidates malformed pending metadata before crash-resume', async (t) => {
  const dirs = await workspace();
  const a = metadata('blog:a', '/i/news/a', H1);
  const b = metadata('blog:b', '/i/news/b', H2);
  const api = await new SyncApiFixture({
    pages: new Map([
      [`${a.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${b.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());

  const state = createEmptyState();
  state.bootstrap = {
    request_limit: 2,
    watermark: 0,
    after_item_id: '',
    pages: {},
    pending: {
      items: [b, a],
      next_after_item_id: null,
    },
  };
  await mkdir(dirs.stateDir, { recursive: true });
  await writeFile(
    stateFilePath(dirs.stateDir),
    `${JSON.stringify(state)}\n`,
  );

  await assert.rejects(
    runSync({ config: config(api, dirs, { pageLimit: 2 }) }),
    /invalid.*bootstrap/i,
  );
  assert.equal(
    api.requests.some((request) => request.pathname === '/api/cc-sync/page'),
    false,
  );
  assert.equal(
    JSON.parse(
      await readFile(stateFilePath(dirs.stateDir), 'utf8'),
    ).bootstrap.after_item_id,
    '',
  );
});

test('bootstrap restart reuses its persisted request limit', async (t) => {
  const dirs = await workspace();
  const c = metadata('blog:c', '/i/news/c', H1);
  const d = metadata('blog:d', '/i/news/d', H2);
  const api = await new SyncApiFixture({
    watermark: 4,
    bootstrap: [c, d],
    pages: new Map([
      [`${c.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${d.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());

  const state = createEmptyState();
  state.bootstrap = {
    request_limit: 2,
    watermark: 4,
    after_item_id: 'blog:b',
    pages: {},
    pending: null,
  };
  await saveState(dirs.stateDir, state);

  await runSync({
    config: config(api, dirs, { pageLimit: 1 }),
  });

  const request = api.requests.find(
    (entry) => entry.pathname === '/api/cc-sync/bootstrap',
  );
  assert.equal(request.query.limit, '2');
  assert.equal(await body(c.url_path, dirs.siteRoot), '<h1>one</h1>');
  assert.equal(await body(d.url_path, dirs.siteRoot), '<h1>two</h1>');
});

test('persisted bootstrap pending data is bounded by its own request limit', async () => {
  const dirs = await workspace();
  const a = metadata('blog:a', '/i/news/a', H1);
  const b = metadata('blog:b', '/i/news/b', H2);
  const state = createEmptyState();
  state.bootstrap = {
    request_limit: 1,
    watermark: 4,
    after_item_id: '',
    pages: {},
    pending: {
      items: [a, b],
      next_after_item_id: null,
    },
  };
  await mkdir(dirs.stateDir, { recursive: true });
  await writeFile(
    stateFilePath(dirs.stateDir),
    `${JSON.stringify(state)}\n`,
  );

  await assert.rejects(
    loadState(dirs.stateDir),
    /invalid.*bootstrap|request limit/i,
  );
});

test('second run is incremental, replays H1 to H2 by event hash, deletes, and skips same-hash rewrite', async (t) => {
  const dirs = await workspace();
  const x0 = metadata('x:1', '/i/x/1', H0, { source: 'x' });
  const y = metadata('x:2', '/i/x/2', H3, { source: 'x' });
  const api = await new SyncApiFixture({
    watermark: 0,
    bootstrap: [x0, y],
    pages: new Map([
      [`${x0.item_id}\0${H0}`, '<h1>zero</h1>'],
      [`${y.item_id}\0${H3}`, '<h1>three</h1>'],
      [`${x0.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${x0.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());
  await runSync({ config: config(api, dirs, { pageLimit: 10 }) });
  api.requests.length = 0;

  api.changes = [
    change(1, 'upsert', { ...x0, content_hash: H1 }),
    change(2, 'upsert', { ...x0, content_hash: H2 }),
    change(3, 'delete', y),
  ];
  await runSync({ config: config(api, dirs, { pageLimit: 10 }) });

  assert.equal(await body('/i/x/1', dirs.siteRoot), '<h1>two</h1>');
  await assert.rejects(lstat(await resolvePageFile('/i/x/2', dirs.siteRoot)), /ENOENT/);
  assert.equal((await loadState(dirs.stateDir)).last_seq, 3);
  assert.equal(
    api.requests.some((request) => request.pathname === '/api/cc-sync/bootstrap'),
    false,
  );
  assert.deepEqual(
    api.requests
      .filter((request) => request.pathname === '/api/cc-sync/page')
      .map((request) => request.query.content_hash),
    [H1, H2],
  );

  const file = await resolvePageFile('/i/x/1', dirs.siteRoot);
  const before = await stat(file);
  api.requests.length = 0;
  api.changes.push(change(4, 'upsert', { ...x0, content_hash: H2 }, {
    title: 'metadata changed',
  }));
  await runSync({ config: config(api, dirs, { pageLimit: 10 }) });
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(
    api.requests
      .filter((request) => request.pathname === '/api/cc-sync/page')
      .map((request) => request.query.content_hash),
    [H2],
  );
  assert.equal((await loadState(dirs.stateDir)).pages['/i/x/1'].title, 'metadata changed');
});

test('same-hash incremental and full sync repair a corrupt local page', async (t) => {
  const dirs = await workspace();
  const item = metadata('news:repair', '/i/news/repair', H1);
  const api = await new SyncApiFixture({
    watermark: 0,
    bootstrap: [item],
    pages: new Map([[`${item.item_id}\0${H1}`, '<h1>one</h1>']]),
  }).start();
  t.after(() => api.close());

  await runSync({ config: config(api, dirs) });
  const file = await resolvePageFile(item.url_path, dirs.siteRoot);
  await writeFile(file, '<h1>corrupt</h1>');
  api.changes = [change(1, 'upsert', item)];
  await runSync({ config: config(api, dirs) });
  assert.equal(await readFile(file, 'utf8'), '<h1>one</h1>');

  await writeFile(file, '<h1>corrupt again</h1>');
  api.watermark = 1;
  await runSync({ config: config(api, dirs), full: true });
  assert.equal(await readFile(file, 'utf8'), '<h1>one</h1>');
  assert.equal((await loadState(dirs.stateDir)).last_seq, 1);
});

test('encoded path aliases cannot overwrite or delete a canonical page', async (t) => {
  const canonical = metadata('news:canonical', '/i/news/a/b', H1);
  for (const operation of ['upsert', 'delete']) {
    await t.test(operation, async (t) => {
      const dirs = await workspace();
      const api = await new SyncApiFixture({
        bootstrap: [canonical],
        pages: new Map([
          [`${canonical.item_id}\0${H1}`, '<h1>one</h1>'],
        ]),
      }).start();
      t.after(() => api.close());
      await runSync({ config: config(api, dirs) });
      api.changes = [
        change(1, operation, {
          ...canonical,
          item_id: 'news:alias',
          url_path: '/i/news/a%2Fb',
        }),
      ];

      await assert.rejects(
        runSync({ config: config(api, dirs) }),
        /invalid changes|canonical|unsafe/i,
      );
      assert.equal(
        await body(canonical.url_path, dirs.siteRoot),
        '<h1>one</h1>',
      );
      assert.equal((await loadState(dirs.stateDir)).last_seq, 0);
    });
  }
});

test('--full rejects a persisted alias before cleanup can delete its canonical page', async (t) => {
  const dirs = await workspace();
  const canonical = metadata('news:canonical', '/i/news/a', H1);
  const canonicalFile = await resolvePageFile(canonical.url_path, dirs.siteRoot);
  await mkdir(path.dirname(canonicalFile), { recursive: true });
  await writeFile(canonicalFile, 'local-canonical');
  await mkdir(dirs.stateDir, { recursive: true });
  await writeFile(stateFilePath(dirs.stateDir), JSON.stringify({
    schema: 1,
    last_seq: 0,
    bootstrap: null,
    pages: {
      '/i/news/%61': {
        hash: H0,
        source: 'news',
        title: 'alias',
        published_at: null,
      },
    },
  }));
  const api = await new SyncApiFixture({
    bootstrap: [canonical],
    pages: new Map([
      [`${canonical.item_id}\0${H1}`, '<h1>one</h1>'],
    ]),
  }).start();
  t.after(() => api.close());

  await assert.rejects(
    runSync({ config: config(api, dirs), full: true }),
    /invalid.*state|canonical|unsafe/i,
  );
  assert.equal(await readFile(canonicalFile, 'utf8'), 'local-canonical');
  assert.equal(api.requests.length, 0);
});

test('a hash mismatch fails the whole batch and leaves its cursor and files unchanged', async (t) => {
  const dirs = await workspace();
  const good = metadata('news:good', '/i/news/good', H1);
  const bad = metadata('news:bad', '/i/news/bad', H2);
  const api = await new SyncApiFixture({
    changes: [change(1, 'upsert', good), change(2, 'upsert', bad)],
    pages: new Map([
      [`${good.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${bad.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());
  api.corruptHashes.add(H2);
  await saveState(dirs.stateDir, createEmptyState());

  await assert.rejects(
    runSync({ config: config(api, dirs, { pageLimit: 10 }) }),
    /hash mismatch/i,
  );

  assert.equal((await loadState(dirs.stateDir)).last_seq, 0);
  await assert.rejects(lstat(await resolvePageFile('/i/news/good', dirs.siteRoot)), /ENOENT/);
  await assert.rejects(lstat(await resolvePageFile('/i/news/bad', dirs.siteRoot)), /ENOENT/);
});

test('HMAC 401 and network timeout fail without advancing the cursor', async (t) => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const api = await new SyncApiFixture().start();
  t.after(() => api.close());

  api.failPath = '/api/cc-sync/changes';
  await assert.rejects(
    runSync({ config: config(api, dirs) }),
    /401|unauthorized/i,
  );
  assert.equal((await loadState(dirs.stateDir)).last_seq, 0);

  api.failPath = null;
  api.hangPath = '/api/cc-sync/changes';
  await assert.rejects(
    runSync({ config: config(api, dirs, { requestTimeoutMs: 30 }) }),
    /timeout|abort/i,
  );
  assert.equal((await loadState(dirs.stateDir)).last_seq, 0);
});

test('timeout covers a successful response whose body stalls after headers', async (t) => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const api = await new SyncApiFixture().start();
  t.after(() => api.close());
  api.hangBodyPath = '/api/cc-sync/changes';

  let guardTimer;
  try {
    await assert.rejects(
      Promise.race([
        runSync({ config: config(api, dirs, { requestTimeoutMs: 30 }) }),
        new Promise((_, reject) => {
          guardTimer = setTimeout(
            () => reject(new Error('regression deadline expired')),
            250,
          );
        }),
      ]),
      /timeout|abort/i,
    );
  } finally {
    clearTimeout(guardTimer);
  }
  assert.equal((await loadState(dirs.stateDir)).last_seq, 0);
});

test('client bounds declared and chunked JSON, page, and error bodies', async (t) => {
  const limits = {
    json: 1024 * 1024,
    page: 8 * 1024 * 1024,
    error: 8 * 1024,
  };
  const cases = [
    {
      name: 'declared JSON',
      limit: limits.json,
      bytes: Buffer.from('{"items":[],"next_after_seq":0}'),
      declared: true,
      invoke: (client) => client.changes({ afterSeq: 0, limit: 1 }),
      contentType: 'application/json',
    },
    {
      name: 'chunked JSON',
      limit: limits.json,
      bytes: Buffer.from(JSON.stringify({
        items: [],
        next_after_seq: 0,
        padding: 'x'.repeat(limits.json),
      })),
      invoke: (client) => client.changes({ afterSeq: 0, limit: 1 }),
      contentType: 'application/json',
    },
    {
      name: 'declared page',
      limit: limits.page,
      bytes: Buffer.from('<h1>small</h1>'),
      declared: true,
      invoke: (client) => client.page({
        itemId: 'news:oversized',
        contentHash: H1,
      }),
      contentType: 'text/html',
    },
    {
      name: 'chunked page',
      limit: limits.page,
      bytes: Buffer.alloc(limits.page + 1, 0x78),
      invoke: (client) => client.page({
        itemId: 'news:oversized',
        contentHash: H1,
      }),
      contentType: 'text/html',
    },
    {
      name: 'declared error',
      limit: limits.error,
      bytes: Buffer.from('unavailable'),
      declared: true,
      status: 503,
      invoke: (client) => client.changes({ afterSeq: 0, limit: 1 }),
      contentType: 'text/plain',
    },
    {
      name: 'chunked error',
      limit: limits.error,
      bytes: Buffer.alloc(limits.error + 1, 0x78),
      status: 503,
      invoke: (client) => client.changes({ afterSeq: 0, limit: 1 }),
      contentType: 'text/plain',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const streamed = streamingResponse(scenario.bytes, {
        status: scenario.status,
        contentLength: scenario.declared
          ? scenario.limit + 1
          : undefined,
        contentType: scenario.contentType,
      });
      const client = new SyncClient({
        baseUrl: 'https://api.ai-feeds.com',
        secret: SECRET,
        requestTimeoutMs: 1_000,
      }, {
        fetchImpl: async () => streamed.response,
      });
      await assert.rejects(
        scenario.invoke(client),
        /too large|size limit/i,
      );
      assert.equal(streamed.cancelled(), true);
    });
  }
});

test('an interrupted atomic state rename preserves the previous state', async () => {
  const dirs = await workspace();
  const oldState = createEmptyState();
  oldState.last_seq = 7;
  await saveState(dirs.stateDir, oldState);
  const original = await readFile(stateFilePath(dirs.stateDir), 'utf8');
  const calls = [];

  const nextState = structuredClone(oldState);
  nextState.last_seq = 8;
  await assert.rejects(
    saveState(dirs.stateDir, nextState, {
      hooks: {
        afterTempWrite(tempPath) {
          calls.push(['write', tempPath]);
        },
        beforeRename(tempPath, finalPath) {
          calls.push(['rename', tempPath, finalPath]);
          throw new Error('simulated interruption');
        },
      },
    }),
    /simulated interruption/,
  );

  assert.deepEqual(calls.map(([operation]) => operation), ['write', 'rename']);
  assert.equal(await readFile(stateFilePath(dirs.stateDir), 'utf8'), original);
  assert.equal((await loadState(dirs.stateDir)).last_seq, 7);
});

test('atomic state writes sync temp bytes and the state directory in order', async () => {
  const dirs = await workspace();
  const calls = [];
  await saveState(dirs.stateDir, createEmptyState(), {
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

test('an overlapping run cannot apply an older state snapshot', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const cfg = {
    baseUrl: 'http://127.0.0.1:1',
    secret: SECRET,
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    concurrency: 1,
    pageLimit: 10,
    requestTimeoutMs: 500,
    allowInsecureLocalhost: true,
  };
  const item = metadata('news:locked', '/i/news/locked', H1);
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstChangesCalls = 0;
  const firstClient = {
    async changes({ afterSeq }) {
      firstChangesCalls += 1;
      if (firstChangesCalls === 1) {
        markFirstEntered();
        await firstGate;
        return {
          items: [change(1, 'upsert', item)],
          next_after_seq: 1,
        };
      }
      return { items: [], next_after_seq: afterSeq };
    },
    async page() {
      return Buffer.from('<h1>one</h1>');
    },
  };
  const secondClient = {
    async changes({ afterSeq }) {
      return { items: [], next_after_seq: afterSeq };
    },
  };

  const firstRun = runSync({ config: cfg, client: firstClient });
  await firstEntered;
  const secondOutcome = await runSync({
    config: cfg,
    client: secondClient,
  }).then(
    () => null,
    (error) => error,
  );
  releaseFirst();
  await firstRun;

  assert.match(String(secondOutcome), /already running|lock/i);
  assert.equal((await loadState(dirs.stateDir)).last_seq, 1);
  assert.equal(await body(item.url_path, dirs.siteRoot), '<h1>one</h1>');
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);
});

test('new sync locks persist process-start identity', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());

  const lock = await acquireSyncLock(dirs.stateDir);
  const owner = JSON.parse(
    await readFile(lockFilePath(dirs.stateDir), 'utf8'),
  );
  assert.equal(owner.schema, 2);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.hostname, os.hostname());
  assert.equal(typeof owner.process_start, 'string');
  assert.notEqual(owner.process_start, '');
  await lock.release();
});

test('lock metadata is complete before guard and main paths become visible', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());

  await assert.rejects(
    acquireSyncLock(dirs.stateDir, {
      hooks: {
        afterGuardCandidateSync() {
          throw new Error('guard publication crash');
        },
      },
    }),
    /guard publication crash/,
  );
  await assert.rejects(lstat(lockGuardFilePath(dirs.stateDir)), /ENOENT/);
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);

  await assert.rejects(
    acquireSyncLock(dirs.stateDir, {
      hooks: {
        afterMainCandidateSync() {
          throw new Error('main publication crash');
        },
      },
    }),
    /main publication crash/,
  );
  await assert.rejects(lstat(lockGuardFilePath(dirs.stateDir)), /ENOENT/);
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);
});

test('an empty guard and an abandoned candidate do not wedge acquisition', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  await mkdir(lockGuardFilePath(dirs.stateDir), { mode: 0o700 });
  const abandonedCandidate = path.join(
    dirs.stateDir,
    '.sync.lock.guard.abandoned.candidate',
  );
  await mkdir(abandonedCandidate, { mode: 0o700 });
  await writeFile(
    path.join(abandonedCandidate, 'owner-abandoned.json'),
    'crash-left candidate metadata',
  );

  const lock = await acquireSyncLock(dirs.stateDir);
  assert.equal(
    JSON.parse(await readFile(lockFilePath(dirs.stateDir), 'utf8')).token,
    lock.owner.token,
  );
  await lock.release();
  await assert.rejects(lstat(lockGuardFilePath(dirs.stateDir)), /ENOENT/);
  assert.equal((await lstat(abandonedCandidate)).isDirectory(), true);
});

test('a dead guard left immediately after creation is crash-recoverable', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  await writeGuardOwnerFixture(dirs.stateDir, {
    schema: 2,
    pid: 999_999_999,
    hostname: os.hostname(),
    process_start: 'dead-guard-start',
    created_at: Date.now(),
    token: 'dead-guard',
  });

  const lock = await acquireSyncLock(dirs.stateDir);
  assert.notEqual(lock.owner.token, 'dead-guard');
  await lock.release();
  await assert.rejects(lstat(lockGuardFilePath(dirs.stateDir)), /ENOENT/);
});

test('a dead main lock left immediately after creation is crash-recoverable', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify({
    schema: 2,
    pid: 999_999_999,
    hostname: os.hostname(),
    process_start: 'dead-main-start',
    created_at: Date.now(),
    token: 'dead-main',
  }));

  const lock = await acquireSyncLock(dirs.stateDir);
  assert.notEqual(lock.owner.token, 'dead-main');
  await lock.release();
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);
});

test('a crash during release recovers both dead guard and main lock', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const deadOwner = {
    schema: 2,
    pid: 999_999_999,
    hostname: os.hostname(),
    process_start: 'dead-release-start',
    created_at: Date.now(),
  };
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify({
    ...deadOwner,
    token: 'dead-release-main',
  }));
  await writeGuardOwnerFixture(dirs.stateDir, {
    ...deadOwner,
    token: 'dead-release-guard',
  });

  const lock = await acquireSyncLock(dirs.stateDir);
  assert.notEqual(lock.owner.token, 'dead-release-main');
  await lock.release();
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);
  await assert.rejects(lstat(lockGuardFilePath(dirs.stateDir)), /ENOENT/);
});

test('same-host PID reuse is detected from process-start identity', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const first = await acquireSyncLock(dirs.stateDir);
  const currentOwner = JSON.parse(
    await readFile(lockFilePath(dirs.stateDir), 'utf8'),
  );
  await first.release();
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify({
    ...currentOwner,
    process_start: `${currentOwner.process_start}-reused`,
    created_at: Date.now(),
    token: 'pid-reused',
  }));

  const recovered = await acquireSyncLock(dirs.stateDir);
  assert.notEqual(recovered.owner.token, 'pid-reused');
  await recovered.release();
});

test('a delayed stale-guard reaper cannot remove a new live guard', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const staleGuard = {
    schema: 2,
    pid: 999_999_999,
    hostname: os.hostname(),
    process_start: 'stale-guard-start',
    created_at: Date.now(),
    token: 'stale-guard-race',
  };
  await writeGuardOwnerFixture(dirs.stateDir, staleGuard);

  let markStaleObserved;
  const staleObserved = new Promise((resolve) => {
    markStaleObserved = resolve;
  });
  let resumeDelayed;
  const delayedGate = new Promise((resolve) => {
    resumeDelayed = resolve;
  });
  const delayed = acquireSyncLock(dirs.stateDir, {
    hooks: {
      async afterGuardStaleObserved(owner) {
        if (owner.token !== staleGuard.token) return;
        markStaleObserved();
        await delayedGate;
      },
    },
  });
  await Promise.race([
    staleObserved,
    delayed.then(
      () => {
        throw new Error('delayed guard contender completed before observation');
      },
      (error) => {
        throw error;
      },
    ),
  ]);

  let markNewGuardPublished;
  const newGuardPublished = new Promise((resolve) => {
    markNewGuardPublished = resolve;
  });
  let resumeWinner;
  const winnerGate = new Promise((resolve) => {
    resumeWinner = resolve;
  });
  const winner = acquireSyncLock(dirs.stateDir, {
    hooks: {
      async afterGuardPublished() {
        markNewGuardPublished();
        await winnerGate;
      },
    },
  });
  await Promise.race([
    newGuardPublished,
    winner.then(
      () => {
        throw new Error('winner completed before publishing its guard');
      },
      (error) => {
        throw error;
      },
    ),
  ]);

  resumeDelayed();
  const delayedOutcome = await delayed.then(
    () => null,
    (error) => error,
  );
  assert.match(String(delayedOutcome), /guard|lock.*live|already running/i);
  const liveGuard = await readGuardOwnerFixture(dirs.stateDir);
  assert.notEqual(liveGuard.token, staleGuard.token);

  resumeWinner();
  const winnerLock = await winner;
  assert.equal(
    JSON.parse(await readFile(lockFilePath(dirs.stateDir), 'utf8')).token,
    winnerLock.owner.token,
  );
  await winnerLock.release();
});

test('stale-main recovery stays serialized beneath the live guard', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify({
    schema: 2,
    pid: 999_999_999,
    hostname: os.hostname(),
    process_start: 'stale-main-race-start',
    created_at: Date.now(),
    token: 'stale-main-race',
  }));

  let markMainObserved;
  const mainObserved = new Promise((resolve) => {
    markMainObserved = resolve;
  });
  let resumeRecovery;
  const recoveryGate = new Promise((resolve) => {
    resumeRecovery = resolve;
  });
  const recovery = acquireSyncLock(dirs.stateDir, {
    hooks: {
      async afterMainStaleObserved() {
        markMainObserved();
        await recoveryGate;
      },
    },
  });
  await Promise.race([
    mainObserved,
    recovery.then(
      () => {
        throw new Error('main recovery completed before stale observation');
      },
      (error) => {
        throw error;
      },
    ),
  ]);

  await assert.rejects(
    acquireSyncLock(dirs.stateDir),
    /guard|lock.*live|already running/i,
  );
  assert.equal(
    JSON.parse(await readFile(lockFilePath(dirs.stateDir), 'utf8')).token,
    'stale-main-race',
  );

  resumeRecovery();
  const recovered = await recovery;
  assert.notEqual(recovered.owner.token, 'stale-main-race');
  await recovered.release();
});

test('main-lock release remains serialized until its guard is released', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  let markMainRemoved;
  const mainRemoved = new Promise((resolve) => {
    markMainRemoved = resolve;
  });
  let resumeRelease;
  const releaseGate = new Promise((resolve) => {
    resumeRelease = resolve;
  });
  const owner = await acquireSyncLock(dirs.stateDir, {
    hooks: {
      async afterMainLockRemoved() {
        markMainRemoved();
        await releaseGate;
      },
    },
  });
  const release = owner.release();
  await Promise.race([
    mainRemoved,
    release.then(() => {
      throw new Error('release completed before guarded removal pause');
    }),
  ]);

  await assert.rejects(
    acquireSyncLock(dirs.stateDir),
    /guard|lock.*live|already running/i,
  );
  resumeRelease();
  await release;

  const successor = await acquireSyncLock(dirs.stateDir);
  await successor.release();
});

test('stale dead-owner locks are reclaimed but a live lock is never deleted', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const cfg = {
    baseUrl: 'http://127.0.0.1:1',
    secret: SECRET,
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    concurrency: 1,
    pageLimit: 10,
    requestTimeoutMs: 500,
    allowInsecureLocalhost: true,
  };
  const idleClient = {
    async changes({ afterSeq }) {
      return { items: [], next_after_seq: afterSeq };
    },
  };
  const stale = {
    schema: 1,
    pid: 999_999_999,
    hostname: os.hostname(),
    created_at: Date.now() - 24 * 60 * 60 * 1000,
    token: 'stale-fixture',
  };
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify(stale));
  await runSync({ config: cfg, client: idleClient });
  await assert.rejects(lstat(lockFilePath(dirs.stateDir)), /ENOENT/);

  const live = {
    ...stale,
    pid: process.pid,
    token: 'live-fixture',
  };
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify(live));
  await assert.rejects(
    runSync({ config: cfg, client: idleClient }),
    /already running|lock/i,
  );
  assert.equal(
    JSON.parse(await readFile(lockFilePath(dirs.stateDir), 'utf8')).token,
    live.token,
  );
});

test('stale recovery fails closed while another lock operation guard is live', async () => {
  const dirs = await workspace();
  await saveState(dirs.stateDir, createEmptyState());
  const stale = {
    schema: 1,
    pid: 999_999_999,
    hostname: os.hostname(),
    created_at: Date.now() - 24 * 60 * 60 * 1000,
    token: 'stale-main',
  };
  const liveGuard = {
    ...stale,
    pid: process.pid,
    token: 'live-guard',
  };
  await writeFile(lockFilePath(dirs.stateDir), JSON.stringify(stale));
  await writeGuardOwnerFixture(dirs.stateDir, liveGuard);
  const cfg = {
    baseUrl: 'http://127.0.0.1:1',
    secret: SECRET,
    siteRoot: dirs.siteRoot,
    stateDir: dirs.stateDir,
    concurrency: 1,
    pageLimit: 10,
    requestTimeoutMs: 500,
    allowInsecureLocalhost: true,
  };

  await assert.rejects(
    runSync({
      config: cfg,
      client: {
        async changes({ afterSeq }) {
          return { items: [], next_after_seq: afterSeq };
        },
      },
    }),
    /guard|lock operation|already running/i,
  );
  assert.equal(
    JSON.parse(await readFile(lockFilePath(dirs.stateDir), 'utf8')).token,
    stale.token,
  );
  assert.equal(
    (await readGuardOwnerFixture(dirs.stateDir)).token,
    liveGuard.token,
  );
});

test('--dry-run fetches and validates but writes neither pages nor state', async (t) => {
  const dirs = await workspace();
  const item = metadata('news:dry', '/i/news/dry', H1);
  const api = await new SyncApiFixture({
    changes: [change(1, 'upsert', item)],
    pages: new Map([[`${item.item_id}\0${H1}`, '<h1>one</h1>']]),
  }).start();
  t.after(() => api.close());
  await saveState(dirs.stateDir, createEmptyState());
  const stateBefore = await readFile(stateFilePath(dirs.stateDir), 'utf8');
  const directoryBefore = (await readdir(dirs.stateDir)).sort();

  await runSync({ config: config(api, dirs), dryRun: true });

  assert.equal(await readFile(stateFilePath(dirs.stateDir), 'utf8'), stateBefore);
  assert.deepEqual((await readdir(dirs.stateDir)).sort(), directoryBefore);
  await assert.rejects(lstat(await resolvePageFile('/i/news/dry', dirs.siteRoot)), /ENOENT/);
  assert.equal(
    api.requests.filter((request) => request.pathname === '/api/cc-sync/page').length,
    1,
  );
});

test('--full removes stale pages only after a fully successful bootstrap', async (t) => {
  const dirs = await workspace();
  const stale = metadata('news:stale', '/i/news/stale', H0);
  const fresh = metadata('news:fresh', '/i/news/fresh', H1);
  const broken = metadata('news:broken', '/i/news/broken', H2);
  const api = await new SyncApiFixture({
    watermark: 4,
    bootstrap: [fresh, broken],
    pages: new Map([
      [`${fresh.item_id}\0${H1}`, '<h1>one</h1>'],
      [`${broken.item_id}\0${H2}`, '<h1>two</h1>'],
    ]),
  }).start();
  t.after(() => api.close());

  const staleFile = await resolvePageFile(stale.url_path, dirs.siteRoot);
  await mkdir(path.dirname(staleFile), { recursive: true });
  await writeFile(staleFile, '<h1>zero</h1>');
  const state = createEmptyState();
  state.last_seq = 3;
  state.pages[stale.url_path] = {
    hash: stale.content_hash,
    source: stale.source,
    title: stale.title,
    published_at: stale.published_at,
  };
  await saveState(dirs.stateDir, state);

  api.corruptHashes.add(H2);
  await assert.rejects(
    runSync({ config: config(api, dirs, { pageLimit: 10 }), full: true }),
    /hash mismatch/i,
  );
  assert.equal(await readFile(staleFile, 'utf8'), '<h1>zero</h1>');
  assert.ok((await loadState(dirs.stateDir)).pages[stale.url_path]);

  api.corruptHashes.clear();
  await runSync({ config: config(api, dirs, { pageLimit: 10 }), full: true });
  await assert.rejects(lstat(staleFile), /ENOENT/);
  assert.deepEqual(Object.keys((await loadState(dirs.stateDir)).pages).sort(), [
    broken.url_path,
    fresh.url_path,
  ]);
});

test('successful sync publishes indexes from the committed live state', async () => {
  const dirs = await workspace();
  const item = metadata('news:indexed', '/i/news/indexed', H1);
  const api = { baseUrl: 'http://127.0.0.1:1' };
  const client = {
    async changes({ afterSeq }) {
      return afterSeq === 0
        ? { items: [change(1, 'upsert', item)], next_after_seq: 1 }
        : { items: [], next_after_seq: afterSeq };
    },
    async page() {
      return Buffer.from('<h1>one</h1>');
    },
  };
  await saveState(dirs.stateDir, createEmptyState());
  const calls = [];

  await runSync({
    config: config(api, dirs),
    client,
    publisher: async (input) => {
      calls.push(input);
      assert.deepEqual(input.state, await loadState(dirs.stateDir));
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].siteRoot, dirs.siteRoot);
  assert.equal(calls[0].stateDir, dirs.stateDir);
  assert.equal(calls[0].state.last_seq, 1);
  assert.ok(calls[0].state.pages[item.url_path]);
});

test('index publication failure fails sync after state commit and dry-run never publishes', async () => {
  const dirs = await workspace();
  const item = metadata('news:index-failure', '/i/news/index-failure', H1);
  const api = { baseUrl: 'http://127.0.0.1:1' };
  const client = {
    async changes({ afterSeq }) {
      return afterSeq === 0
        ? { items: [change(1, 'upsert', item)], next_after_seq: 1 }
        : { items: [], next_after_seq: afterSeq };
    },
    async page() {
      return Buffer.from('<h1>one</h1>');
    },
  };
  await saveState(dirs.stateDir, createEmptyState());

  await assert.rejects(
    runSync({
      config: config(api, dirs),
      client,
      publisher: async () => {
        throw new Error('injected index failure');
      },
    }),
    /injected index failure/,
  );
  assert.equal((await loadState(dirs.stateDir)).last_seq, 1);
  assert.equal(await body(item.url_path, dirs.siteRoot), '<h1>one</h1>');

  let dryRunPublished = false;
  await runSync({
    config: config(api, dirs),
    client,
    dryRun: true,
    publisher: async () => {
      dryRunPublished = true;
    },
  });
  assert.equal(dryRunPublished, false);
});
