import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { hostname as getHostname } from 'node:os';
import path from 'node:path';

import { assertCanonicalPageUrl } from './fs-safe.mjs';

const HASH_RE = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const TEMP_OPEN_FLAGS = (
  constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | NOFOLLOW
);
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | DIRECTORY | NOFOLLOW;
const READ_OPEN_FLAGS = constants.O_RDONLY | NOFOLLOW;
const LOCK_MAX_BYTES = 8 * 1024;
const DEFAULT_STALE_LOCK_MS = 6 * 60 * 60 * 1000;

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

export function lockFilePath(stateDir) {
  return path.join(stateDir, 'sync.lock');
}

function lockGuardFilePath(stateDir) {
  return path.join(stateDir, 'sync.lock.guard');
}

async function ensureSecureStateDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const entry = await lstat(stateDir);
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || (entry.mode & 0o022)
    || (
      typeof process.getuid === 'function'
      && entry.uid !== process.getuid()
    )
  ) {
    throw new Error('unsafe sync state directory ownership or permissions');
  }
  return entry;
}

async function syncStateDirectory(stateDir, expected) {
  const handle = await open(stateDir, DIRECTORY_OPEN_FLAGS);
  try {
    const entry = await handle.stat();
    if (
      !entry.isDirectory()
      || entry.dev !== expected.dev
      || entry.ino !== expected.ino
    ) {
      throw new Error('sync state directory changed during write');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validLockOwner(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.schema === 1
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.hostname === 'string'
    && value.hostname !== ''
    && Number.isSafeInteger(value.created_at)
    && value.created_at >= 0
    && typeof value.token === 'string'
    && value.token !== ''
    && value.token.length <= 256
  );
}

async function readLockOwner(file) {
  const handle = await open(file, READ_OPEN_FLAGS);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > LOCK_MAX_BYTES) {
      throw new Error('invalid sync lock file');
    }
    let owner;
    try {
      owner = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new Error('invalid sync lock metadata');
    }
    if (!validLockOwner(owner)) {
      throw new Error('invalid sync lock owner');
    }
    return {
      owner,
      identity: { dev: entry.dev, ino: entry.ino },
    };
  } finally {
    await handle.close();
  }
}

function ownerProcessIsLive(owner) {
  if (owner.hostname !== getHostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function createOwnedLock(stateDir, stateDirectory, token, now) {
  const file = lockFilePath(stateDir);
  let handle;
  try {
    handle = await open(file, TEMP_OPEN_FLAGS, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }

  const owner = {
    schema: 1,
    pid: process.pid,
    hostname: getHostname(),
    created_at: now,
    token,
  };
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
  await syncStateDirectory(stateDir, stateDirectory);

  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      const guard = await acquireLockGuard(
        stateDir,
        stateDirectory,
        Date.now(),
      );
      try {
        const current = await readLockOwner(file);
        if (current.owner.token !== token) {
          throw new Error(
            'sync lock ownership changed; refusing to delete it',
          );
        }
        await unlink(file);
        await syncStateDirectory(stateDir, stateDirectory);
        released = true;
      } finally {
        await guard.release();
      }
    },
  };
}

async function acquireLockGuard(stateDir, stateDirectory, now) {
  const file = lockGuardFilePath(stateDir);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(file, TEMP_OPEN_FLAGS, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'cc sync lock operation guard exists; refusing concurrent recovery',
      );
    }
    throw error;
  }
  const owner = {
    schema: 1,
    pid: process.pid,
    hostname: getHostname(),
    created_at: now,
    token,
  };
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
  await syncStateDirectory(stateDir, stateDirectory);

  let released = false;
  return {
    async release() {
      if (released) return;
      const current = await readLockOwner(file);
      if (current.owner.token !== token) {
        throw new Error(
          'sync lock operation guard ownership changed; refusing deletion',
        );
      }
      await unlink(file);
      await syncStateDirectory(stateDir, stateDirectory);
      released = true;
    },
  };
}

export async function acquireSyncLock(
  stateDir,
  {
    now = Date.now(),
    staleAfterMs = DEFAULT_STALE_LOCK_MS,
  } = {},
) {
  const stateDirectory = await ensureSecureStateDirectory(stateDir);
  const guard = await acquireLockGuard(stateDir, stateDirectory, now);
  try {
    const token = randomUUID();
    let owned = await createOwnedLock(
      stateDir,
      stateDirectory,
      token,
      now,
    );
    if (owned) return owned;

    const file = lockFilePath(stateDir);
    let observed;
    try {
      observed = await readLockOwner(file);
    } catch (error) {
      throw new Error(
        'cc sync lock exists with invalid metadata; refusing stale removal',
        { cause: error },
      );
    }
    const age = now - observed.owner.created_at;
    if (
      ownerProcessIsLive(observed.owner)
      || !Number.isSafeInteger(staleAfterMs)
      || staleAfterMs < 0
      || age < staleAfterMs
    ) {
      throw new Error(
        `cc sync already running (pid ${observed.owner.pid})`,
      );
    }

    const beforeReclaim = await lstat(file);
    if (!sameIdentity(observed.identity, beforeReclaim)) {
      throw new Error('cc sync lock changed while checking staleness');
    }
    const stalePath = path.join(
      stateDir,
      `.sync.lock.stale.${randomUUID()}`,
    );
    await rename(file, stalePath);
    const moved = await readLockOwner(stalePath);
    if (
      moved.owner.token !== observed.owner.token
      || !sameIdentity(observed.identity, moved.identity)
    ) {
      throw new Error('cc sync lock changed during stale reclamation');
    }
    await unlink(stalePath);
    await syncStateDirectory(stateDir, stateDirectory);

    owned = await createOwnedLock(stateDir, stateDirectory, token, now);
    if (!owned) {
      throw new Error(
        'cc sync already running after stale lock reclamation',
      );
    }
    return owned;
  } finally {
    await guard.release();
  }
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

function isCanonicalPageUrl(value) {
  try {
    assertCanonicalPageUrl(value);
    return true;
  } catch {
    return false;
  }
}

function validPages(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([urlPath, metadata]) => (
      isCanonicalPageUrl(urlPath) && validMetadata(metadata)
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
    && isCanonicalPageUrl(value.url_path)
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
  const stateDirectory = await ensureSecureStateDirectory(stateDir);
  const finalPath = stateFilePath(stateDir);
  const tempPath = path.join(
    stateDir,
    `.state.json.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle;
  try {
    handle = await open(tempPath, TEMP_OPEN_FLAGS, 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await hooks.afterTempWrite?.(tempPath);
    await handle.sync();
    await hooks.afterTempSync?.(tempPath);
    await handle.close();
    handle = null;
    await hooks.beforeRename?.(tempPath, finalPath);
    const beforeRename = await lstat(stateDir);
    if (
      beforeRename.isSymbolicLink()
      || beforeRename.dev !== stateDirectory.dev
      || beforeRename.ino !== stateDirectory.ino
    ) {
      throw new Error('sync state directory changed before rename');
    }
    await rename(tempPath, finalPath);
    await hooks.afterRename?.(tempPath, finalPath);
    await syncStateDirectory(stateDir, stateDirectory);
    await hooks.afterDirectorySync?.(stateDir);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
