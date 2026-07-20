import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const ITEM_PATH_RE = /^\/i\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/;
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

export function assertCanonicalPageUrl(urlPath) {
  if (typeof urlPath !== 'string' || !ITEM_PATH_RE.test(urlPath)) {
    throw new Error('unsafe or non-canonical item URL path');
  }

  const segments = urlPath.split('/');
  if (
    segments[0] !== ''
    || segments[1] !== 'i'
    || segments.length < 3
    || segments.slice(2).some((segment) => (
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.includes('\0')
      || segment.includes('\\')
    ))
  ) {
    throw new Error('unsafe item URL path segments');
  }
  return urlPath;
}

function pagePathInfo(urlPath, siteRoot) {
  const canonical = assertCanonicalPageUrl(urlPath);
  const root = path.resolve(siteRoot);
  const itemRoot = path.join(root, 'i');
  const pageParent = path.resolve(root, ...canonical.split('/').slice(1));
  if (
    pageParent === itemRoot
    || !pageParent.startsWith(`${itemRoot}${path.sep}`)
  ) {
    throw new Error('unsafe item path escapes site root');
  }
  return {
    file: path.join(pageParent, 'index.html'),
    itemRoot,
    pageParent,
  };
}

function assertSecureDirectory(entry, current) {
  if (entry.isSymbolicLink()) {
    throw new Error(`symlink page parent is unsafe: ${current}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`invalid page parent is not a directory: ${current}`);
  }
  if (entry.mode & 0o022) {
    // Deployment invariant for Task 10: /i is owned by aifeeds-sync and
    // neither group nor other may write it or any generated child directory.
    throw new Error(`page parent is group/other writable: ${current}`);
  }
  if (
    typeof process.getuid === 'function'
    && entry.uid !== process.getuid()
  ) {
    throw new Error(`page parent is not owned by the sync uid: ${current}`);
  }
}

async function inspectParentChain(info, { requireComplete }) {
  const relativeParent = path.relative(info.itemRoot, info.pageParent);
  const parts = relativeParent === '' ? [] : relativeParent.split(path.sep);
  const chain = [];
  let current = info.itemRoot;

  for (const part of ['', ...parts]) {
    if (part !== '') current = path.join(current, part);
    try {
      const entry = await lstat(current);
      assertSecureDirectory(entry, current);
      chain.push({
        path: current,
        dev: entry.dev,
        ino: entry.ino,
      });
    } catch (error) {
      if (error?.code === 'ENOENT' && !requireComplete) break;
      throw error;
    }
  }
  return chain;
}

function assertSameParentChain(expected, actual) {
  if (
    expected.length !== actual.length
    || expected.some((entry, index) => (
      entry.path !== actual[index].path
      || entry.dev !== actual[index].dev
      || entry.ino !== actual[index].ino
    ))
  ) {
    throw new Error('unsafe page parent changed during operation');
  }
}

async function syncDirectory(directory, expected) {
  const handle = await open(directory, DIRECTORY_OPEN_FLAGS);
  try {
    const entry = await handle.stat();
    if (
      !entry.isDirectory()
      || entry.dev !== expected.dev
      || entry.ino !== expected.ino
    ) {
      throw new Error('unsafe page parent changed before directory sync');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupTempIfStillSafe(tempPath, info, expectedChain) {
  try {
    const actualChain = await inspectParentChain(info, {
      requireComplete: true,
    });
    assertSameParentChain(expectedChain, actualChain);
    await unlink(tempPath);
  } catch {
    // Never follow a replaced parent merely to clean up a temporary file.
  }
}

export async function resolvePageFile(urlPath, siteRoot) {
  const info = pagePathInfo(urlPath, siteRoot);
  await inspectParentChain(info, { requireComplete: false });
  return info.file;
}

export async function hashPageFile(urlPath, siteRoot) {
  const info = pagePathInfo(urlPath, siteRoot);
  let expectedChain;
  try {
    expectedChain = await inspectParentChain(info, {
      requireComplete: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let handle;
  try {
    handle = await open(info.file, READ_OPEN_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null;
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) {
      throw new Error('unsafe page target is not a regular file');
    }
    const actualChain = await inspectParentChain(info, {
      requireComplete: true,
    });
    assertSameParentChain(expectedChain, actualChain);

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function writePageFileAtomic(
  urlPath,
  siteRoot,
  bytes,
  { hooks = {} } = {},
) {
  const info = pagePathInfo(urlPath, siteRoot);
  const initialChain = await inspectParentChain(info, {
    requireComplete: false,
  });
  if (initialChain.length === 0) {
    throw new Error('item root must be securely pre-provisioned');
  }
  await mkdir(info.pageParent, { recursive: true, mode: 0o755 });
  const expectedChain = await inspectParentChain(info, {
    requireComplete: true,
  });

  const tempPath = path.join(
    info.pageParent,
    `.${path.basename(info.file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, TEMP_OPEN_FLAGS, 0o644);
    await handle.writeFile(bytes);
    await hooks.afterTempWrite?.(tempPath);
    await handle.sync();
    await hooks.afterTempSync?.(tempPath);
    await handle.close();
    handle = null;

    await hooks.beforeRename?.(tempPath, info.file);
    const beforeRenameChain = await inspectParentChain(info, {
      requireComplete: true,
    });
    assertSameParentChain(expectedChain, beforeRenameChain);
    await rename(tempPath, info.file);
    await hooks.afterRename?.(tempPath, info.file);
    await syncDirectory(
      info.pageParent,
      expectedChain[expectedChain.length - 1],
    );
    await hooks.afterDirectorySync?.(info.pageParent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await cleanupTempIfStillSafe(tempPath, info, expectedChain);
    throw error;
  }
  return info.file;
}

export async function removePageFile(
  urlPath,
  siteRoot,
  { hooks = {} } = {},
) {
  const info = pagePathInfo(urlPath, siteRoot);
  let expectedChain;
  try {
    expectedChain = await inspectParentChain(info, {
      requireComplete: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  await hooks.beforeRemove?.(info.file);
  const beforeRemoveChain = await inspectParentChain(info, {
    requireComplete: true,
  });
  assertSameParentChain(expectedChain, beforeRemoveChain);
  try {
    await unlink(info.file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await hooks.afterRemove?.(info.file);
  await syncDirectory(
    info.pageParent,
    expectedChain[expectedChain.length - 1],
  );
  await hooks.afterDirectorySync?.(info.pageParent);
  return true;
}
