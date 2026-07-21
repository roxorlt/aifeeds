#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SyncClient } from './client.mjs';
import { assertSecureConfig, loadConfig } from './config.mjs';
import {
  assertCanonicalPageUrl,
  hashPageFile,
  removePageFile,
  resolvePageFile,
  writePageFileAtomic,
} from './fs-safe.mjs';
import {
  acquireSyncLock,
  createEmptyState,
  loadState,
  saveState,
} from './state.mjs';
import { publishIndexes } from './publish-indexes.mjs';

const HASH_RE = /^[0-9a-f]{64}$/;
const dryRunLocks = new Set();

function clone(value) {
  return structuredClone(value);
}

function metadataFromItem(item) {
  return {
    hash: item.content_hash,
    source: item.source,
    title: item.title,
    published_at: item.published_at,
  };
}

function assertPageItem(item, context) {
  if (
    !item
    || typeof item !== 'object'
    || typeof item.item_id !== 'string'
    || item.item_id === ''
    || typeof item.source !== 'string'
    || typeof item.url_path !== 'string'
    || !HASH_RE.test(item.content_hash)
    || typeof item.title !== 'string'
    || !(item.published_at === null || typeof item.published_at === 'string')
  ) {
    throw new Error(`invalid ${context} page item`);
  }
  try {
    assertCanonicalPageUrl(item.url_path);
  } catch (error) {
    throw new Error(`invalid ${context} page item URL`, { cause: error });
  }
}

function assertChangeItem(item, afterSeq) {
  if (
    !item
    || typeof item !== 'object'
    || !Number.isSafeInteger(item.seq)
    || item.seq <= afterSeq
    || !['upsert', 'delete'].includes(item.op)
    || typeof item.item_id !== 'string'
    || item.item_id === ''
    || typeof item.source !== 'string'
    || typeof item.url_path !== 'string'
    || typeof item.title !== 'string'
    || !(item.published_at === null || typeof item.published_at === 'string')
    || (
      item.op === 'upsert'
        ? !HASH_RE.test(item.content_hash)
        : item.content_hash !== null
    )
  ) {
    throw new Error('invalid changes item');
  }
  try {
    assertCanonicalPageUrl(item.url_path);
  } catch (error) {
    throw new Error('invalid changes item URL', { cause: error });
  }
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function prepareBatch(items, client, config) {
  const batchFiles = new Map();
  for (const item of items) {
    const file = await resolvePageFile(item.url_path, config.siteRoot);
    const existingUrl = batchFiles.get(file);
    if (existingUrl !== undefined && existingUrl !== item.url_path) {
      throw new Error(`page path collision in sync batch: ${item.url_path}`);
    }
    batchFiles.set(file, item.url_path);
  }

  return mapLimit(items, config.concurrency, async (item) => {
    if (item.op === 'delete') return { item, bytes: null };
    const bytes = await client.page({
      itemId: item.item_id,
      contentHash: item.content_hash,
    });
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== item.content_hash) {
      throw new Error(
        `page hash mismatch for ${item.item_id}: expected ${item.content_hash}, got ${actualHash}`,
      );
    }
    return { item, bytes };
  });
}

async function applyPreparedBatch({
  prepared,
  state,
  config,
  dryRun,
  bootstrapPages = null,
}) {
  const nextState = clone(state);
  for (const { item, bytes } of prepared) {
    if (item.op === 'delete') {
      if (!dryRun) {
        await removePageFile(item.url_path, config.siteRoot);
      }
      delete nextState.pages[item.url_path];
      continue;
    }

    const maySkipWrite = (
      await hashPageFile(item.url_path, config.siteRoot)
    ) === item.content_hash;
    if (!dryRun && !maySkipWrite) {
      await writePageFileAtomic(
        item.url_path,
        config.siteRoot,
        bytes,
      );
    }
    const metadata = metadataFromItem(item);
    nextState.pages[item.url_path] = metadata;
    if (bootstrapPages) bootstrapPages[item.url_path] = metadata;
  }
  return nextState;
}

function assertBootstrapResponse(
  body,
  expectedWatermark,
  afterItemId,
  requestedLimit,
) {
  if (
    !body
    || typeof body !== 'object'
    || !Number.isSafeInteger(body.watermark)
    || body.watermark < 0
    || !Array.isArray(body.items)
    || body.items.length > requestedLimit
    || !(
      body.next_after_item_id === null
      || typeof body.next_after_item_id === 'string'
    )
    || (
      expectedWatermark !== null
      && body.watermark !== expectedWatermark
    )
  ) {
    throw new Error('invalid bootstrap response');
  }

  let previousItemId = afterItemId;
  for (const item of body.items) {
    try {
      assertPageItem(item, 'bootstrap');
    } catch (error) {
      throw new Error('invalid bootstrap response item', { cause: error });
    }
    if (item.item_id <= previousItemId) {
      throw new Error('invalid bootstrap response item ordering');
    }
    previousItemId = item.item_id;
  }

  if (body.next_after_item_id !== null) {
    if (
      body.items.length === 0
      || body.items.length < requestedLimit
      || body.next_after_item_id !== body.items.at(-1).item_id
    ) {
      throw new Error('invalid bootstrap response cursor');
    }
  }
}

async function beginBootstrap(state, config, dryRun) {
  const nextState = clone(state);
  nextState.bootstrap = {
    request_limit: config.pageLimit,
    watermark: null,
    after_item_id: '',
    pages: {},
    pending: null,
  };
  if (!dryRun) await saveState(config.stateDir, nextState);
  return nextState;
}

async function runBootstrap({
  state,
  client,
  config,
  dryRun,
  restart,
}) {
  let current = restart || state.bootstrap === null
    ? await beginBootstrap(state, config, dryRun)
    : state;

  while (current.bootstrap.after_item_id !== null) {
    const requestLimit = current.bootstrap.request_limit;
    if (current.bootstrap.pending === null) {
      const afterItemId = current.bootstrap.after_item_id;
      const expectedWatermark = afterItemId === ''
        ? null
        : current.bootstrap.watermark;
      const body = await client.bootstrap({
        afterItemId,
        limit: requestLimit,
        watermark: expectedWatermark,
      });
      assertBootstrapResponse(
        body,
        expectedWatermark,
        afterItemId,
        requestLimit,
      );

      const withPending = clone(current);
      withPending.bootstrap.watermark = body.watermark;
      withPending.bootstrap.pending = {
        items: clone(body.items),
        next_after_item_id: body.next_after_item_id,
      };
      if (!dryRun) await saveState(config.stateDir, withPending);
      current = withPending;
    }

    const pending = current.bootstrap.pending;
    assertBootstrapResponse(
      {
        watermark: current.bootstrap.watermark,
        items: pending.items,
        next_after_item_id: pending.next_after_item_id,
      },
      current.bootstrap.watermark,
      current.bootstrap.after_item_id,
      requestLimit,
    );
    const items = pending.items.map((item) => ({ ...item, op: 'upsert' }));
    const prepared = await prepareBatch(items, client, config);
    const bootstrapPages = clone(current.bootstrap.pages);
    let nextState = await applyPreparedBatch({
      prepared,
      state: current,
      config,
      dryRun,
      bootstrapPages,
    });
    nextState.bootstrap.pages = bootstrapPages;
    nextState.bootstrap.after_item_id = pending.next_after_item_id;
    nextState.bootstrap.pending = null;
    if (!dryRun) await saveState(config.stateDir, nextState);
    current = nextState;
  }

  const remotePages = current.bootstrap.pages;
  const stalePaths = Object.keys(current.pages)
    .filter((urlPath) => !Object.hasOwn(remotePages, urlPath));
  if (!dryRun) {
    await mapLimit(stalePaths, config.concurrency, (urlPath) => (
      removePageFile(urlPath, config.siteRoot)
    ));
  }

  const completed = clone(current);
  completed.last_seq = current.bootstrap.watermark;
  completed.bootstrap = null;
  completed.pages = clone(remotePages);
  if (!dryRun) await saveState(config.stateDir, completed);
  return completed;
}

function assertChangesResponse(body, afterSeq) {
  if (
    !body
    || typeof body !== 'object'
    || !Array.isArray(body.items)
    || !Number.isSafeInteger(body.next_after_seq)
    || body.next_after_seq < afterSeq
  ) {
    throw new Error('invalid changes response');
  }

  let previous = afterSeq;
  for (const item of body.items) {
    assertChangeItem(item, previous);
    previous = item.seq;
  }
  if (
    body.next_after_seq !== (
      body.items.length > 0 ? body.items.at(-1).seq : afterSeq
    )
  ) {
    throw new Error('changes cursor does not match batch');
  }
}

async function runChanges({ state, client, config, dryRun }) {
  let current = state;
  while (true) {
    const afterSeq = current.last_seq;
    const body = await client.changes({
      afterSeq,
      limit: config.pageLimit,
    });
    assertChangesResponse(body, afterSeq);
    if (body.items.length === 0) return current;

    const prepared = await prepareBatch(body.items, client, config);
    const nextState = await applyPreparedBatch({
      prepared,
      state: current,
      config,
      dryRun,
    });
    nextState.last_seq = body.next_after_seq;
    if (!dryRun) await saveState(config.stateDir, nextState);
    current = nextState;
  }
}

function validateRuntimeConfig(config) {
  assertSecureConfig(config);
  if (
    !config
    || typeof config.baseUrl !== 'string'
    || typeof config.secret !== 'string'
    || config.secret.length === 0
    || typeof config.siteRoot !== 'string'
    || typeof config.stateDir !== 'string'
    || !Number.isSafeInteger(config.concurrency)
    || config.concurrency < 1
    || !Number.isSafeInteger(config.pageLimit)
    || config.pageLimit < 1
    || config.pageLimit > 500
    || !Number.isSafeInteger(config.requestTimeoutMs)
    || config.requestTimeoutMs < 1
  ) {
    throw new Error('invalid cc sync configuration');
  }
}

async function runSyncUnlocked({
  config,
  dryRun,
  full,
  client,
  publisher,
}) {
  const loaded = await loadState(config.stateDir);
  const state = loaded ?? createEmptyState();
  const needsBootstrap = full || loaded === null || state.bootstrap !== null;
  const afterBootstrap = needsBootstrap
    ? await runBootstrap({
      state,
      client,
      config,
      dryRun,
      restart: full || loaded === null,
    })
    : state;
  const finalState = await runChanges({
    state: afterBootstrap,
    client,
    config,
    dryRun,
  });
  if (!dryRun) {
    await publisher({
      siteRoot: config.siteRoot,
      stateDir: config.stateDir,
      state: finalState,
    });
  }
  return finalState;
}

export async function runSync({
  config,
  dryRun = false,
  full = false,
  client = new SyncClient(config),
  publisher = publishIndexes,
}) {
  validateRuntimeConfig(config);
  const operation = () => runSyncUnlocked({
    config,
    dryRun,
    full,
    client,
    publisher,
  });

  if (dryRun) {
    if (dryRunLocks.has(config.stateDir)) {
      throw new Error('cc sync dry-run already running for this state');
    }
    dryRunLocks.add(config.stateDir);
    try {
      return await operation();
    } finally {
      dryRunLocks.delete(config.stateDir);
    }
  }

  const lock = await acquireSyncLock(config.stateDir);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

export function parseCliArgs(args) {
  const options = { dryRun: false, full: false };
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--full') options.full = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  await runSync({
    config: loadConfig(),
    ...options,
  });
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
