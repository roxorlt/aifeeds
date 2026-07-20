import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePageFile } from '../fs-safe.mjs';
import {
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
      const body = {
        watermark: after ? Number(url.searchParams.get('watermark')) : this.watermark,
        items,
        next_after_item_id: rows.length > limit
          ? items.at(-1).item_id
          : null,
      };
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-sync-test-'));
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
    ...overrides,
  };
}

async function body(urlPath, siteRoot) {
  return readFile(await resolvePageFile(urlPath, siteRoot), 'utf8');
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

  const startedAt = Date.now();
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
  assert.ok(Date.now() - startedAt < 200);
  assert.equal((await loadState(dirs.stateDir)).last_seq, 0);
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

  await runSync({ config: config(api, dirs), dryRun: true });

  assert.equal(await readFile(stateFilePath(dirs.stateDir), 'utf8'), stateBefore);
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
