import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
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

import {
  assertCanonicalPageUrl,
  pageFileKey,
} from './fs-safe.mjs';

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
const PROCESS_START_FALLBACK = (
  `runtime:${Math.max(0, Math.round(Date.now() - process.uptime() * 1000))}`
);
const MAX_GUARD_ACQUIRE_ATTEMPTS = 8;

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
    && (
      value.schema === 1
      || (
        value.schema === 2
        && typeof value.process_start === 'string'
        && value.process_start !== ''
        && value.process_start.length <= 256
      )
    )
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

async function linuxProcessStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  let serialized;
  try {
    serialized = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const commandEnd = serialized.lastIndexOf(') ');
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = serialized
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  return /^[0-9]+$/.test(startTime ?? '')
    ? `linux-proc:${startTime}`
    : null;
}

async function processStartIdentity(pid) {
  const linuxIdentity = await linuxProcessStartIdentity(pid);
  if (linuxIdentity !== null) return linuxIdentity;
  return pid === process.pid ? PROCESS_START_FALLBACK : null;
}

async function newLockOwner(token, now) {
  return {
    schema: 2,
    pid: process.pid,
    hostname: getHostname(),
    process_start: await processStartIdentity(process.pid),
    created_at: now,
    token,
  };
}

async function lockOwnerStatus(owner) {
  if (owner.hostname !== getHostname()) return 'remote';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'live';
  }
  if (owner.schema === 2) {
    const actualStart = await processStartIdentity(owner.pid);
    const comparableStartIdentity = (
      (
        owner.process_start.startsWith('linux-proc:')
        && actualStart?.startsWith('linux-proc:')
      )
      || (
        owner.pid === process.pid
        && owner.process_start.startsWith('runtime:')
        && actualStart?.startsWith('runtime:')
      )
    );
    if (
      comparableStartIdentity
      && actualStart !== owner.process_start
    ) {
      return 'pid-reused';
    }
  }
  return 'live';
}

async function lockOwnerIsReclaimable(owner, now, staleAfterMs) {
  const status = await lockOwnerStatus(owner);
  if (status === 'dead' || status === 'pid-reused') return true;
  if (status === 'live') return false;
  const age = now - owner.created_at;
  return (
    Number.isSafeInteger(staleAfterMs)
    && staleAfterMs >= 0
    && age >= staleAfterMs
  );
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function createOwnedLock(
  stateDir,
  stateDirectory,
  token,
  now,
  hooks = {},
) {
  const file = lockFilePath(stateDir);
  const owner = await newLockOwner(token, now);
  const published = await publishOwnedLockFile(
    file,
    stateDir,
    stateDirectory,
    owner,
    hooks.afterMainCandidateSync,
  );
  if (!published) return null;

  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      const guard = await acquireLockGuard(
        stateDir,
        stateDirectory,
        Date.now(),
        DEFAULT_STALE_LOCK_MS,
        {},
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

async function reclaimLockFile(
  file,
  observed,
  stateDir,
  stateDirectory,
  label,
) {
  let beforeReclaim;
  try {
    beforeReclaim = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sameIdentity(observed.identity, beforeReclaim)) {
    return false;
  }
  const stalePath = path.join(
    stateDir,
    `.${path.basename(file)}.stale.${randomUUID()}`,
  );
  try {
    await rename(file, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await readLockOwner(stalePath);
  if (
    moved.owner.token !== observed.owner.token
    || !sameIdentity(observed.identity, moved.identity)
  ) {
    throw new Error(`${label} changed during crash recovery`);
  }
  await unlink(stalePath);
  await syncStateDirectory(stateDir, stateDirectory);
  return true;
}

async function createOwnedGuard(
  file,
  stateDir,
  stateDirectory,
  token,
  now,
  hooks = {},
) {
  const owner = await newLockOwner(token, now);
  const published = await publishOwnedLockFile(
    file,
    stateDir,
    stateDirectory,
    owner,
    hooks.afterGuardCandidateSync,
  );
  return published ? owner : null;
}

async function publishOwnedLockFile(
  file,
  stateDir,
  stateDirectory,
  owner,
  afterCandidateSync,
) {
  const candidate = path.join(
    stateDir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.candidate`,
  );
  let handle;
  try {
    handle = await open(candidate, TEMP_OPEN_FLAGS, 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
    await afterCandidateSync?.(candidate);
    await handle.close();
    handle = null;
    try {
      await link(candidate, file);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    await unlink(candidate);
    await syncStateDirectory(stateDir, stateDirectory);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(candidate).catch(() => {});
  }
}

async function acquireLockGuard(
  stateDir,
  stateDirectory,
  now,
  staleAfterMs,
  hooks = {},
) {
  const file = lockGuardFilePath(stateDir);
  const token = randomUUID();
  let owner;
  for (
    let attempt = 0;
    attempt < MAX_GUARD_ACQUIRE_ATTEMPTS;
    attempt += 1
  ) {
    owner = await createOwnedGuard(
      file,
      stateDir,
      stateDirectory,
      token,
      now,
      hooks,
    );
    if (owner) break;

    let observed;
    try {
      observed = await readLockOwner(file);
    } catch (error) {
      throw new Error(
        'cc sync lock operation guard has invalid metadata',
        { cause: error },
      );
    }
    if (!await lockOwnerIsReclaimable(
      observed.owner,
      now,
      staleAfterMs,
    )) {
      throw new Error(
        'cc sync lock operation guard exists; another lock operation is live',
      );
    }
    await reclaimLockFile(
      file,
      observed,
      stateDir,
      stateDirectory,
      'sync lock operation guard',
    );
  }
  if (!owner) {
    throw new Error(
      'cc sync lock operation guard changed repeatedly during acquisition',
    );
  }

  let released = false;
  return {
    owner,
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
    hooks = {},
  } = {},
) {
  const stateDirectory = await ensureSecureStateDirectory(stateDir);
  const guard = await acquireLockGuard(
    stateDir,
    stateDirectory,
    now,
    staleAfterMs,
    hooks,
  );
  try {
    const token = randomUUID();
    let owned = await createOwnedLock(
      stateDir,
      stateDirectory,
      token,
      now,
      hooks,
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
    if (!await lockOwnerIsReclaimable(
      observed.owner,
      now,
      staleAfterMs,
    )) {
      throw new Error(
        `cc sync already running (pid ${observed.owner.pid})`,
      );
    }
    await reclaimLockFile(
      file,
      observed,
      stateDir,
      stateDirectory,
      'sync lock',
    );

    owned = await createOwnedLock(
      stateDir,
      stateDirectory,
      token,
      now,
      hooks,
    );
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const seenFiles = new Set();
  for (const [urlPath, metadata] of Object.entries(value)) {
    if (!isCanonicalPageUrl(urlPath) || !validMetadata(metadata)) {
      return false;
    }
    const fileKey = pageFileKey(urlPath);
    if (seenFiles.has(fileKey)) return false;
    seenFiles.add(fileKey);
  }
  return true;
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

function validPending(value, afterItemId, requestLimit) {
  if (value === null) return true;
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray(value.items)
    || value.items.length > requestLimit
    || !(
      value.next_after_item_id === null
      || typeof value.next_after_item_id === 'string'
    )
  ) {
    return false;
  }

  const seenFiles = new Set();
  let previousItemId = afterItemId;
  for (const item of value.items) {
    if (
      !validPendingBootstrapPage(item)
      || item.item_id <= previousItemId
    ) {
      return false;
    }
    const fileKey = pageFileKey(item.url_path);
    if (seenFiles.has(fileKey)) return false;
    seenFiles.add(fileKey);
    previousItemId = item.item_id;
  }
  return (
    value.next_after_item_id === null
    || (
      value.items.length === requestLimit
      && value.items.length > 0
      && value.next_after_item_id === value.items.at(-1).item_id
    )
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
      || !Number.isSafeInteger(bootstrap.request_limit)
      || bootstrap.request_limit < 1
      || bootstrap.request_limit > 500
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
      || !validPending(
        bootstrap.pending,
        bootstrap.after_item_id,
        bootstrap.request_limit,
      )
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
