import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const HASH_RE = /^[0-9a-f]{64}$/;

export function createEmptyState() {
  return {
    schema: 1,
    last_seq: 0,
    bootstrap: null,
    pages: {},
  };
}

export function stateFilePath(stateDir) {
  return path.join(stateDir, 'state.json');
}

function validMetadata(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && HASH_RE.test(value.hash)
    && typeof value.source === 'string'
    && typeof value.title === 'string'
    && (value.published_at === null || typeof value.published_at === 'string'),
  );
}

function validPages(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([urlPath, metadata]) => (
      typeof urlPath === 'string' && validMetadata(metadata)
    )),
  );
}

function validPendingBootstrapPage(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.item_id === 'string'
    && value.item_id !== ''
    && typeof value.source === 'string'
    && typeof value.url_path === 'string'
    && HASH_RE.test(value.content_hash)
    && typeof value.title === 'string'
    && (value.published_at === null || typeof value.published_at === 'string'),
  );
}

function validPending(value) {
  return value === null || Boolean(
    value
    && typeof value === 'object'
    && Array.isArray(value.items)
    && value.items.every(validPendingBootstrapPage)
    && (
      value.next_after_item_id === null
      || typeof value.next_after_item_id === 'string'
    ),
  );
}

function assertState(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.schema !== 1
    || !Number.isSafeInteger(value.last_seq)
    || value.last_seq < 0
    || !validPages(value.pages)
  ) {
    throw new Error('invalid cc sync state');
  }
  if (value.bootstrap !== null) {
    const bootstrap = value.bootstrap;
    if (
      !bootstrap
      || typeof bootstrap !== 'object'
      || !(
        bootstrap.watermark === null
        || (
          Number.isSafeInteger(bootstrap.watermark)
          && bootstrap.watermark >= 0
        )
      )
      || !(
        bootstrap.after_item_id === null
        || typeof bootstrap.after_item_id === 'string'
      )
      || !validPages(bootstrap.pages)
      || !validPending(bootstrap.pending)
      || (
        bootstrap.watermark === null
        && (
          bootstrap.after_item_id !== ''
          || Object.keys(bootstrap.pages).length !== 0
          || bootstrap.pending !== null
        )
      )
      || (
        bootstrap.after_item_id === null
        && bootstrap.pending !== null
      )
    ) {
      throw new Error('invalid cc sync bootstrap state');
    }
  }
}

export async function loadState(stateDir) {
  let serialized;
  try {
    serialized = await readFile(stateFilePath(stateDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let state;
  try {
    state = JSON.parse(serialized);
  } catch {
    throw new Error('invalid cc sync state JSON');
  }
  assertState(state);
  return state;
}

export async function saveState(
  stateDir,
  state,
  { hooks = {} } = {},
) {
  assertState(state);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const finalPath = stateFilePath(stateDir);
  const tempPath = path.join(
    stateDir,
    `.state.json.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(state, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await hooks.afterTempWrite?.(tempPath);
    await hooks.beforeRename?.(tempPath, finalPath);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
