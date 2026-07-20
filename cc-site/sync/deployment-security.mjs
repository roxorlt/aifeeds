#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function lstatOptional(entry) {
  try {
    return await lstat(entry);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function safeRelative(relative) {
  return (
    relative.length > 0
    && !path.posix.isAbsolute(relative)
    && !relative.includes('\\')
    && path.posix.normalize(relative) === relative
    && relative !== '..'
    && !relative.startsWith('../')
    && !relative.includes('/../')
    && !relative.startsWith('cc-site/server/')
    && !/(^|\/)\.env(?:\.|$)/.test(relative)
    && !relative.includes('.secrets')
  );
}

function parseManifest(contents) {
  const records = contents.split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64})  ([^\r\n]+)$/.exec(line);
    if (!match || !safeRelative(match[2])) {
      throw new Error('invalid payload manifest entry');
    }
    return { digest: match[1], relative: match[2] };
  });
  const names = records.map(({ relative }) => relative);
  if (records.length === 0 || new Set(names).size !== names.length) {
    throw new Error('invalid payload manifest entries');
  }
  if (names.join('\n') !== [...names].sort().join('\n')) {
    throw new Error('payload manifest must be path-sorted');
  }
  return records;
}

function parseAllowlist(contents) {
  const entries = contents.split('\n').filter(Boolean);
  if (
    entries.length === 0
    || new Set(entries).size !== entries.length
    || entries.some((entry) => !safeRelative(entry))
    || entries.join('\n') !== [...entries].sort().join('\n')
  ) {
    throw new Error('invalid payload allowlist');
  }
  return entries;
}

async function walk(root, relative = '') {
  const directory = relative ? path.join(root, ...relative.split('/')) : root;
  const children = await readdir(directory);
  const entries = [];
  for (const name of children.sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(root, ...childRelative.split('/'));
    const identity = await lstat(child);
    if (identity.isSymbolicLink()) {
      throw new Error(`payload entry must be a regular file or directory: ${childRelative}`);
    }
    if (identity.isDirectory()) {
      entries.push(...await walk(root, childRelative));
    } else if (identity.isFile()) {
      if (identity.nlink !== 1) {
        throw new Error(`payload entry must be a single-link regular file: ${childRelative}`);
      }
      entries.push(childRelative);
    } else {
      throw new Error(`payload entry must be a regular file or directory: ${childRelative}`);
    }
  }
  return entries;
}

export async function verifyPayload({ expectedManifestDigest, payload }) {
  if (!path.isAbsolute(payload) || !/^[0-9a-f]{64}$/.test(expectedManifestDigest)) {
    throw new Error('invalid payload verification arguments');
  }
  const rootIdentity = await lstat(payload);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    throw new Error('payload root must be a directory');
  }
  const manifestFile = path.join(payload, 'MANIFEST.sha256');
  const manifestIdentity = await lstat(manifestFile);
  if (!manifestIdentity.isFile() || manifestIdentity.isSymbolicLink() || manifestIdentity.nlink !== 1) {
    throw new Error('payload manifest must be a single-link regular file');
  }
  const manifestBytes = await readFile(manifestFile);
  if (sha256(manifestBytes) !== expectedManifestDigest) {
    throw new Error('payload manifest digest mismatch');
  }
  const records = parseManifest(manifestBytes.toString('utf8'));
  const allowlistFile = path.join(payload, 'cc-site', 'sync', 'payload-files.txt');
  const allowlist = parseAllowlist(await readFile(allowlistFile, 'utf8'));
  const expected = [...allowlist, 'deploy/cc-sync.env'].sort();
  const names = records.map(({ relative }) => relative);
  if (names.join('\n') !== expected.join('\n')) {
    throw new Error('payload manifest does not match the exact allowlist');
  }

  const actual = await walk(payload);
  const expectedActual = [...expected, 'MANIFEST.sha256'].sort();
  if (actual.join('\n') !== expectedActual.join('\n')) {
    throw new Error('unexpected payload entry');
  }
  for (const { digest, relative } of records) {
    const file = path.join(payload, ...relative.split('/'));
    const identity = await lstat(file);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new Error(`payload entry must be a regular file: ${relative}`);
    }
    if (identity.nlink !== 1) {
      throw new Error(`payload entry must be a single-link regular file: ${relative}`);
    }
    if (sha256(await readFile(file)) !== digest) {
      throw new Error(`payload digest mismatch: ${relative}`);
    }
  }
  return records;
}

export async function validateDirectoryChain({
  allowMissing,
  allowedUids,
  boundary,
  logicalPath,
}) {
  if (
    !path.isAbsolute(boundary)
    || !path.posix.isAbsolute(logicalPath)
    || path.posix.normalize(logicalPath) !== logicalPath
    || !Array.isArray(allowedUids)
    || allowedUids.length === 0
    || allowedUids.some((uid) => !Number.isInteger(uid) || uid < 0)
  ) {
    throw new Error('invalid managed directory chain arguments');
  }
  const components = logicalPath.split('/').filter(Boolean);
  let current = boundary;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let identity;
    try {
      identity = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) return;
      throw error;
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error(`managed directory chain contains a non-directory: ${logicalPath}`);
    }
    if (!allowedUids.includes(identity.uid)) {
      throw new Error(`managed directory chain has an unexpected owner: ${logicalPath}`);
    }
    if ((identity.mode & 0o022) !== 0) {
      throw new Error(`managed directory chain is group/other writable: ${logicalPath}`);
    }
  }
}

export async function validateItemTree(root) {
  if (!path.isAbsolute(root)) throw new Error('item root must be absolute');
  const walkTree = async (directory) => {
    const directoryIdentity = await lstat(directory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
      throw new Error('item tree entry must be a non-symlink directory');
    }
    for (const name of await readdir(directory)) {
      const child = path.join(directory, name);
      const identity = await lstat(child);
      if (identity.isSymbolicLink()) {
        throw new Error('item tree contains a symlink');
      }
      if (identity.isDirectory()) {
        await walkTree(child);
      } else if (identity.isFile()) {
        if (identity.nlink !== 1) {
          throw new Error('item tree file must be a single-link regular file');
        }
      } else {
        throw new Error('item tree contains a non-regular entry');
      }
    }
  };
  await walkTree(root);
}

const CURRENT_GENERATION_TARGET =
  /^generations\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRIVATE_GUARD_DIRECTORY =
  /^\.sync\.lock\.guard\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate$/;
const PRIVATE_OWNER_FILE = /^owner-[A-Za-z0-9_-]{1,256}\.json$/;
const PRIVATE_ROOT_FILE =
  /^(?:state\.json|sync\.lock|\.sync\.lock\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate|\.sync\.lock\.stale\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\.state\.json\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/;

export async function validateManagedRoot({ gid, kind, root, uid }) {
  if (
    !path.isAbsolute(root)
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
    || (kind !== 'state' && kind !== 'items')
  ) {
    throw new Error('invalid managed root validation arguments');
  }
  const stateDirectoryMode = (relative) => {
    if (relative === '' || relative === 'public' || relative.startsWith('public/')) {
      return 0o750;
    }
    if (relative === 'sync.lock.guard' || PRIVATE_GUARD_DIRECTORY.test(relative)) {
      return 0o700;
    }
    return null;
  };
  const stateFileMode = (relative) => {
    if (relative.startsWith('public/')) return 0o640;
    if (!relative.includes('/') && PRIVATE_ROOT_FILE.test(relative)) return 0o600;
    const parent = path.posix.dirname(relative);
    const basename = path.posix.basename(relative);
    if (
      (parent === 'sync.lock.guard' || PRIVATE_GUARD_DIRECTORY.test(parent))
      && PRIVATE_OWNER_FILE.test(basename)
    ) {
      return 0o600;
    }
    return null;
  };
  const walkManaged = async (directory, relative = '') => {
    const directoryIdentity = await lstat(directory);
    const requiredDirectoryMode = kind === 'items'
      ? 0o750
      : stateDirectoryMode(relative);
    if (
      requiredDirectoryMode === null
      || !directoryIdentity.isDirectory()
      || directoryIdentity.isSymbolicLink()
      || directoryIdentity.uid !== uid
      || directoryIdentity.gid !== gid
      || (directoryIdentity.mode & 0o7777) !== requiredDirectoryMode
    ) {
      throw new Error(`managed ${kind} directory has unsafe identity or mode`);
    }
    for (const name of await readdir(directory)) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(directory, name);
      const identity = await lstat(child);
      if (identity.isDirectory() && !identity.isSymbolicLink()) {
        await walkManaged(child, childRelative);
      } else if (identity.isFile() && !identity.isSymbolicLink()) {
        const requiredFileMode = kind === 'items'
          ? 0o640
          : stateFileMode(childRelative);
        if (identity.nlink !== 1) {
          throw new Error(`managed ${kind} file must be a single-link regular file`);
        }
        if (
          requiredFileMode === null
          || identity.uid !== uid
          || identity.gid !== gid
          || (identity.mode & 0o7777) !== requiredFileMode
        ) {
          throw new Error(`managed ${kind} file has unsafe identity or mode`);
        }
      } else if (
        kind === 'state'
        && childRelative === 'public/current'
        && identity.isSymbolicLink()
        && identity.uid === uid
        && identity.gid === gid
        && CURRENT_GENERATION_TARGET.test(await readlink(child))
      ) {
        // The publisher's sole managed link is relative and generation-scoped.
      } else {
        throw new Error(`managed ${kind} tree contains an unsafe entry`);
      }
    }
    return directoryIdentity;
  };
  return walkManaged(root);
}

export async function ensureManagedRoot({ gid, kind, root, uid }) {
  let identity = await lstatOptional(root);
  let created = false;
  try {
    if (identity === null) {
      await mkdir(root, { mode: 0o750 });
      created = true;
      await chown(root, uid, gid);
      await chmod(root, 0o750);
      await syncDirectory(path.dirname(root));
      identity = await lstat(root);
    }
    await validateManagedRoot({ gid, kind, root, uid });
  } catch (error) {
    if (created) {
      await rm(root, { recursive: true }).catch(() => {});
      await syncDirectory(path.dirname(root)).catch(() => {});
    }
    throw error;
  }
  return {
    created,
    dev: identity.dev,
    ino: identity.ino,
  };
}

export async function removeCreatedManagedRoot({
  dev,
  gid,
  ino,
  kind,
  root,
  uid,
}) {
  const identity = await lstatOptional(root);
  if (
    identity === null
    || !identity.isDirectory()
    || identity.isSymbolicLink()
    || identity.dev !== dev
    || identity.ino !== ino
  ) {
    throw new Error(`rollback conflict: created ${kind} root changed`);
  }
  await validateManagedRoot({ gid, kind, root, uid });
  const confirmed = await lstat(root);
  if (confirmed.dev !== dev || confirmed.ino !== ino) {
    throw new Error(`rollback conflict: created ${kind} root changed`);
  }
  await rm(root, { recursive: true });
  await syncDirectory(path.dirname(root));
}

export async function prepareDeploymentLock({
  boundary,
  gid,
  uid,
}) {
  if (
    !path.isAbsolute(boundary)
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid deployment lock arguments');
  }
  await validateDirectoryChain({
    allowMissing: false,
    allowedUids: [uid],
    boundary,
    logicalPath: '/run',
  });
  const run = path.join(boundary, 'run');
  const privateDirectory = path.join(run, 'aifeeds-cc-sync-deploy');
  let privateIdentity = await lstatOptional(privateDirectory);
  if (privateIdentity === null) {
    await mkdir(privateDirectory, { mode: 0o700 });
    await chown(privateDirectory, uid, gid);
    await chmod(privateDirectory, 0o700);
    privateIdentity = await lstat(privateDirectory);
  }
  if (
    !privateIdentity.isDirectory()
    || privateIdentity.isSymbolicLink()
    || privateIdentity.uid !== uid
    || privateIdentity.gid !== gid
    || (privateIdentity.mode & 0o7777) !== 0o700
  ) {
    throw new Error('deployment lock directory is unsafe');
  }

  const lockFile = path.join(privateDirectory, 'deployment.lock');
  let handle;
  let created = false;
  try {
    handle = await open(
      lockFile,
      fsConstants.O_RDWR
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new Error('deployment lock file is unsafe', { cause: error });
    }
    try {
      handle = await open(
        lockFile,
        fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      );
    } catch (openError) {
      throw new Error('deployment lock file is unsafe', { cause: openError });
    }
  }
  try {
    if (created) {
      await handle.chown(uid, gid);
      await handle.chmod(0o600);
      await handle.sync();
    }
    const identity = await handle.stat();
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || identity.uid !== uid
      || identity.gid !== gid
      || (identity.mode & 0o7777) !== 0o600
    ) {
      throw new Error('deployment lock file must be a root-owned regular 0600 file');
    }
  } finally {
    await handle.close();
  }
  return lockFile;
}

async function validateReleaseTree(root, allowedUid, allowedGid = null) {
  const walkTree = async (entry) => {
    const identity = await lstat(entry);
    if (
      identity.uid !== allowedUid
      || (allowedGid !== null && identity.gid !== allowedGid)
      || (identity.mode & 0o022) !== 0
    ) {
      throw new Error('release tree has unsafe ownership or permissions');
    }
    if (identity.isDirectory() && !identity.isSymbolicLink()) {
      for (const name of await readdir(entry)) {
        await walkTree(path.join(entry, name));
      }
      return identity;
    }
    if (
      !identity.isFile()
      || identity.isSymbolicLink()
      || identity.nlink !== 1
    ) {
      throw new Error('release tree contains an unsafe entry');
    }
    return identity;
  };
  return walkTree(root);
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function releaseExecutable(relative) {
  return new Set([
    'cc-site/deploy.sh',
    'cc-site/sync/deploy-to-cc.sh',
    'cc-site/sync/install-remote.sh',
  ]).has(relative);
}

const LIVE_RELEASE_TARGET =
  /^aifeeds-cc-sync-releases\/([0-9a-f]{64})\/cc-site\/sync$/;

export async function validateManagedLiveRelease({
  allowedGid,
  allowedUid,
  liveLink,
  releases,
}) {
  if (
    !path.isAbsolute(liveLink)
    || !path.isAbsolute(releases)
    || path.dirname(liveLink) !== path.dirname(releases)
    || path.basename(releases) !== 'aifeeds-cc-sync-releases'
    || !Number.isInteger(allowedUid)
    || allowedUid < 0
    || !Number.isInteger(allowedGid)
    || allowedGid < 0
  ) {
    throw new Error('invalid live release validation arguments');
  }
  const releasesIdentity = await lstat(releases);
  if (
    !releasesIdentity.isDirectory()
    || releasesIdentity.isSymbolicLink()
    || releasesIdentity.uid !== allowedUid
    || releasesIdentity.gid !== allowedGid
    || (releasesIdentity.mode & 0o7777) !== 0o755
  ) {
    throw new Error('live release root is unsafe');
  }
  const linkBefore = await lstat(liveLink);
  if (
    !linkBefore.isSymbolicLink()
    || linkBefore.uid !== allowedUid
    || linkBefore.gid !== allowedGid
  ) {
    throw new Error('live code path is not a managed symlink');
  }
  const target = await readlink(liveLink);
  const targetMatch = LIVE_RELEASE_TARGET.exec(target);
  if (!targetMatch) {
    throw new Error('live release target is unsafe');
  }
  const linkAfter = await lstat(liveLink);
  if (linkAfter.dev !== linkBefore.dev || linkAfter.ino !== linkBefore.ino) {
    throw new Error('live release target changed during validation');
  }

  const release = path.join(releases, targetMatch[1]);
  try {
    const releaseBefore = await lstat(release);
    await verifyBoundRelease({
      allowedGid,
      allowedUid,
      expectedManifestDigest: targetMatch[1],
      release,
      requireReleaseId: true,
    });
    const releaseAfter = await lstat(release);
    if (
      releaseAfter.dev !== releaseBefore.dev
      || releaseAfter.ino !== releaseBefore.ino
    ) {
      throw new Error('live release changed during validation');
    }
  } catch (error) {
    throw new Error('live release is damaged or incomplete', { cause: error });
  }
  return target;
}

function expectedReleaseDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}

async function readSingleLinkRegularFile(file, {
  allowedGid,
  allowedUid,
  expectedMode,
  label,
}) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const identityBefore = await handle.stat();
    if (
      !identityBefore.isFile()
      || identityBefore.nlink !== 1
      || identityBefore.uid !== allowedUid
      || identityBefore.gid !== allowedGid
      || (identityBefore.mode & 0o7777) !== expectedMode
    ) {
      throw new Error(`${label} identity or mode mismatch`);
    }
    const bytes = await handle.readFile();
    const identityAfter = await handle.stat();
    if (
      identityAfter.dev !== identityBefore.dev
      || identityAfter.ino !== identityBefore.ino
      || identityAfter.size !== identityBefore.size
      || identityAfter.mtimeMs !== identityBefore.mtimeMs
      || identityAfter.ctimeMs !== identityBefore.ctimeMs
    ) {
      throw new Error(`${label} changed during validation`);
    }
    return { bytes, identity: identityAfter };
  } finally {
    await handle.close();
  }
}

export async function verifyBoundRelease({
  allowedGid,
  allowedUid,
  expectedManifestDigest,
  release,
  requireReleaseId = true,
}) {
  if (
    !path.isAbsolute(release)
    || !Number.isInteger(allowedUid)
    || allowedUid < 0
    || !Number.isInteger(allowedGid)
    || allowedGid < 0
    || !/^[0-9a-f]{64}$/.test(expectedManifestDigest)
    || typeof requireReleaseId !== 'boolean'
  ) {
    throw new Error('invalid bound release verification arguments');
  }
  if (
    requireReleaseId
    && path.basename(release) !== expectedManifestDigest
  ) {
    throw new Error('release id does not match the manifest digest');
  }

  const rootBefore = await lstat(release);
  if (
    !rootBefore.isDirectory()
    || rootBefore.isSymbolicLink()
    || rootBefore.uid !== allowedUid
    || rootBefore.gid !== allowedGid
    || (rootBefore.mode & 0o7777) !== 0o755
  ) {
    throw new Error('release root identity or mode mismatch');
  }

  const manifestFile = path.join(release, 'MANIFEST.sha256');
  const { bytes: manifestBytes } = await readSingleLinkRegularFile(manifestFile, {
    allowedGid,
    allowedUid,
    expectedMode: 0o644,
    label: 'release manifest',
  });
  if (sha256(manifestBytes) !== expectedManifestDigest) {
    throw new Error('release manifest digest mismatch');
  }
  const records = parseManifest(manifestBytes.toString('utf8'));
  const recordByName = new Map(records.map((record) => [record.relative, record]));
  const allowlistRecord = recordByName.get('cc-site/sync/payload-files.txt');
  if (!allowlistRecord) {
    throw new Error('release manifest is missing its allowlist');
  }
  const allowlistFile = path.join(
    release,
    'cc-site',
    'sync',
    'payload-files.txt',
  );
  const { bytes: allowlistBytes } = await readSingleLinkRegularFile(allowlistFile, {
    allowedGid,
    allowedUid,
    expectedMode: 0o644,
    label: 'release allowlist',
  });
  if (sha256(allowlistBytes) !== allowlistRecord.digest) {
    throw new Error('release digest mismatch: cc-site/sync/payload-files.txt');
  }
  const allowlist = parseAllowlist(allowlistBytes.toString('utf8'));
  const manifestNames = records.map(({ relative }) => relative);
  const expectedManifestNames = [...allowlist, 'deploy/cc-sync.env'].sort();
  if (manifestNames.join('\n') !== expectedManifestNames.join('\n')) {
    throw new Error('release manifest does not match the exact allowlist');
  }

  const releaseRecords = records.filter(
    ({ relative }) => relative.startsWith('cc-site/'),
  );
  if (
    releaseRecords.length !== records.length - 1
    || !recordByName.has('deploy/cc-sync.env')
  ) {
    throw new Error('release manifest has an invalid environment record');
  }
  const expectedFiles = [
    'MANIFEST.sha256',
    ...releaseRecords.map(({ relative }) => relative),
  ].sort();
  const expectedDirectories = expectedReleaseDirectories(expectedFiles);
  const actualFiles = [];
  const actualDirectories = [];
  const actualDigests = new Map();

  const walkExact = async (directory, relative = '') => {
    const identity = await lstat(directory);
    if (
      !identity.isDirectory()
      || identity.isSymbolicLink()
      || identity.uid !== allowedUid
      || identity.gid !== allowedGid
      || (identity.mode & 0o7777) !== 0o755
    ) {
      throw new Error(`release directory identity or mode mismatch: ${relative || '.'}`);
    }
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childIdentity = await lstat(child);
      if (childIdentity.isDirectory() && !childIdentity.isSymbolicLink()) {
        actualDirectories.push(childRelative);
        await walkExact(child, childRelative);
        continue;
      }
      const expectedMode = releaseExecutable(childRelative) ? 0o755 : 0o644;
      const { bytes } = await readSingleLinkRegularFile(child, {
        allowedGid,
        allowedUid,
        expectedMode,
        label: `release file ${childRelative}`,
      });
      actualFiles.push(childRelative);
      actualDigests.set(childRelative, sha256(bytes));
    }
  };
  await walkExact(release);
  if (
    actualFiles.sort().join('\n') !== expectedFiles.join('\n')
    || actualDirectories.sort().join('\n') !== expectedDirectories.join('\n')
  ) {
    throw new Error('release path set does not match the exact allowlist');
  }
  for (const { digest, relative } of releaseRecords) {
    if (actualDigests.get(relative) !== digest) {
      throw new Error(`release digest mismatch: ${relative}`);
    }
  }
  if (actualDigests.get('MANIFEST.sha256') !== expectedManifestDigest) {
    throw new Error('release manifest digest mismatch');
  }
  const rootAfter = await lstat(release);
  if (
    rootAfter.dev !== rootBefore.dev
    || rootAfter.ino !== rootBefore.ino
  ) {
    throw new Error('release root changed during validation');
  }
  return expectedManifestDigest;
}

export async function verifyRelease({
  allowedGid,
  allowedUid,
  expectedManifestDigest,
  payload,
  release,
}) {
  if (
    !path.isAbsolute(payload)
    || !path.isAbsolute(release)
    || !Number.isInteger(allowedUid)
    || allowedUid < 0
    || !Number.isInteger(allowedGid)
    || allowedGid < 0
    || !/^[0-9a-f]{64}$/.test(expectedManifestDigest)
  ) {
    throw new Error('invalid release verification arguments');
  }
  const manifestBytes = await readFile(path.join(payload, 'MANIFEST.sha256'));
  if (sha256(manifestBytes) !== expectedManifestDigest) {
    throw new Error('release payload manifest digest mismatch');
  }
  return verifyBoundRelease({
    allowedGid,
    allowedUid,
    expectedManifestDigest,
    release,
    requireReleaseId: false,
  });
}

function releaseArtifactName(name) {
  return /^\.(?:stage|quarantine)\.[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name);
}

export async function cleanupReleaseArtifacts({
  allowedGid,
  allowedUid,
  releases,
}) {
  const removed = [];
  const skipped = [];
  for (const name of await readdir(releases)) {
    if (!releaseArtifactName(name)) continue;
    const candidate = path.join(releases, name);
    try {
      await validateReleaseTree(candidate, allowedUid, allowedGid);
      await rm(candidate, { recursive: true });
      removed.push(name);
    } catch {
      skipped.push(name);
    }
  }
  if (removed.length > 0) await syncDirectory(releases);
  return { removed: removed.sort(), skipped: skipped.sort() };
}

export async function createReleaseStage({
  allowedGid,
  allowedUid,
  manifestDigest,
  releases,
}) {
  if (
    !path.isAbsolute(releases)
    || !/^[0-9a-f]{64}$/.test(manifestDigest)
    || !Number.isInteger(allowedUid)
    || allowedUid < 0
    || !Number.isInteger(allowedGid)
    || allowedGid < 0
  ) {
    throw new Error('invalid release stage arguments');
  }
  await validateReleaseTree(releases, allowedUid, allowedGid);
  const stage = path.join(
    releases,
    `.stage.${manifestDigest}.${randomUUID()}`,
  );
  await mkdir(stage, { mode: 0o755 });
  await chown(stage, allowedUid, allowedGid);
  await chmod(stage, 0o755);
  await syncDirectory(releases);
  return stage;
}

function targetNamesRelease({ finalRelease, liveLink, liveTarget }) {
  const expected = `${path.basename(path.dirname(finalRelease))}`
    + `/${path.basename(finalRelease)}/cc-site/sync`;
  return path.dirname(finalRelease) === path.join(path.dirname(liveLink), path.basename(path.dirname(finalRelease)))
    && liveTarget === expected;
}

export async function publishRelease({
  allowedGid,
  allowedUid,
  expectedManifestDigest,
  finalRelease,
  liveLink,
  payload,
  stage,
}) {
  if (
    !path.isAbsolute(finalRelease)
    || !path.isAbsolute(liveLink)
    || !path.isAbsolute(stage)
    || path.dirname(stage) !== path.dirname(finalRelease)
    || path.basename(finalRelease) !== expectedManifestDigest
    || !path.basename(stage).startsWith(`.stage.${expectedManifestDigest}.`)
  ) {
    throw new Error('invalid release publication arguments');
  }
  await verifyRelease({
    allowedGid,
    allowedUid,
    expectedManifestDigest,
    payload,
    release: stage,
  });
  const finalIdentity = await lstatOptional(finalRelease);
  if (finalIdentity === null) {
    await rename(stage, finalRelease);
    await syncDirectory(path.dirname(finalRelease));
    await verifyBoundRelease({
      allowedGid,
      allowedUid,
      expectedManifestDigest,
      release: finalRelease,
      requireReleaseId: true,
    });
    return 'created';
  }

  try {
    await verifyRelease({
      allowedGid,
      allowedUid,
      expectedManifestDigest,
      payload,
      release: finalRelease,
    });
    await rm(stage, { recursive: true });
    await syncDirectory(path.dirname(finalRelease));
    return 'reused';
  } catch (verificationError) {
    const liveIdentity = await lstatOptional(liveLink);
    if (liveIdentity?.isSymbolicLink()) {
      const liveTarget = await readlink(liveLink);
      if (targetNamesRelease({ finalRelease, liveLink, liveTarget })) {
        throw new Error('damaged live release cannot be replaced', {
          cause: verificationError,
        });
      }
    }
    await validateReleaseTree(finalRelease, allowedUid, allowedGid);
  }

  const quarantine = path.join(
    path.dirname(finalRelease),
    `.quarantine.${expectedManifestDigest}.${randomUUID()}`,
  );
  await rename(finalRelease, quarantine);
  try {
    await rename(stage, finalRelease);
  } catch (error) {
    await rename(quarantine, finalRelease).catch(() => {});
    throw error;
  }
  await syncDirectory(path.dirname(finalRelease));
  await validateReleaseTree(quarantine, allowedUid, allowedGid);
  await rm(quarantine, { recursive: true });
  await syncDirectory(path.dirname(finalRelease));
  return 'replaced';
}

export async function garbageCollectReleases({
  allowedGid,
  allowedUid,
  keep,
  liveLink,
  releases,
}) {
  if (
    !path.isAbsolute(releases)
    || !path.isAbsolute(liveLink)
    || path.dirname(releases) !== path.dirname(liveLink)
    || !Number.isInteger(allowedUid)
    || allowedUid < 0
    || !Number.isInteger(allowedGid)
    || allowedGid < 0
    || !Number.isInteger(keep)
    || keep < 1
    || keep > 10
  ) {
    throw new Error('invalid release garbage collection arguments');
  }
  await cleanupReleaseArtifacts({ releases, allowedUid, allowedGid });
  const releasesIdentity = await lstat(releases);
  if (
    !releasesIdentity.isDirectory()
    || releasesIdentity.isSymbolicLink()
    || releasesIdentity.uid !== allowedUid
    || releasesIdentity.gid !== allowedGid
    || (releasesIdentity.mode & 0o022) !== 0
  ) {
    throw new Error('release root is unsafe');
  }
  const liveIdentity = await lstat(liveLink);
  if (!liveIdentity.isSymbolicLink()) {
    throw new Error('live release path must be a symlink');
  }
  const liveTarget = await readlink(liveLink);
  const livePrefix = path.basename(releases) + '/';
  const liveSuffix = '/cc-site/sync';
  if (!liveTarget.startsWith(livePrefix) || !liveTarget.endsWith(liveSuffix)) {
    throw new Error('live release target is unsafe');
  }
  const liveId = liveTarget.slice(livePrefix.length, -liveSuffix.length);
  if (!/^[0-9a-f]{64}$/.test(liveId)) {
    throw new Error('live release target is unsafe');
  }

  const safe = [];
  const skipped = [];
  for (const name of await readdir(releases)) {
    if (!/^[0-9a-f]{64}$/.test(name)) {
      skipped.push(name);
      continue;
    }
    const candidate = path.join(releases, name);
    try {
      await verifyBoundRelease({
        allowedGid,
        allowedUid,
        expectedManifestDigest: name,
        release: candidate,
        requireReleaseId: true,
      });
      const identity = await lstat(candidate);
      safe.push({
        dev: identity.dev,
        ino: identity.ino,
        mtimeMs: identity.mtimeMs,
        name,
      });
    } catch {
      skipped.push(name);
    }
  }
  if (!safe.some(({ name }) => name === liveId)) {
    throw new Error('live release tree is missing or unsafe');
  }

  const newestOld = safe
    .filter(({ name }) => name !== liveId)
    .sort((left, right) => (
      right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
    ))
    .slice(0, keep - 1)
    .map(({ name }) => name);
  const retained = new Set([liveId, ...newestOld]);
  const removable = safe
    .filter(({ name }) => !retained.has(name))
    .sort((left, right) => (
      left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)
    ));
  const removed = [];
  for (const candidate of removable) {
    const candidatePath = path.join(releases, candidate.name);
    const current = await lstat(candidatePath);
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== candidate.dev
      || current.ino !== candidate.ino
    ) {
      skipped.push(candidate.name);
      continue;
    }
    await verifyBoundRelease({
      allowedGid,
      allowedUid,
      expectedManifestDigest: candidate.name,
      release: candidatePath,
      requireReleaseId: true,
    });
    await rm(candidatePath, { recursive: true });
    removed.push(candidate.name);
  }
  return { removed, retained: [...retained].sort(), skipped: skipped.sort() };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('usage: deployment-security.mjs <command> [arguments]');
    process.exitCode = 2;
  } else {
    try {
      if (command === 'sha256' && args.length === 1) {
        process.stdout.write(`${sha256(await readFile(args[0]))}\n`);
      } else if (command === 'verify-payload' && args.length === 2) {
        await verifyPayload({ payload: args[0], expectedManifestDigest: args[1] });
      } else if (command === 'validate-chain' && args.length === 4) {
        await validateDirectoryChain({
          boundary: args[0],
          logicalPath: args[1],
          allowedUids: args[2].split(',').map(Number),
          allowMissing: args[3] === 'true',
        });
      } else if (command === 'validate-item-tree' && args.length === 1) {
        await validateItemTree(args[0]);
      } else if (command === 'ensure-managed-root' && args.length === 4) {
        const managedRoot = await ensureManagedRoot({
          root: args[0],
          uid: Number(args[1]),
          gid: Number(args[2]),
          kind: args[3],
        });
        process.stdout.write(
          `${managedRoot.created ? 1 : 0}\t${managedRoot.dev}\t${managedRoot.ino}\n`,
        );
      } else if (command === 'remove-created-root' && args.length === 6) {
        await removeCreatedManagedRoot({
          root: args[0],
          dev: Number(args[1]),
          ino: Number(args[2]),
          uid: Number(args[3]),
          gid: Number(args[4]),
          kind: args[5],
        });
      } else if (command === 'prepare-lock' && args.length === 3) {
        process.stdout.write(`${await prepareDeploymentLock({
          boundary: args[0],
          uid: Number(args[1]),
          gid: Number(args[2]),
        })}\n`);
      } else if (command === 'cleanup-release-artifacts' && args.length === 3) {
        await cleanupReleaseArtifacts({
          releases: args[0],
          allowedUid: Number(args[1]),
          allowedGid: Number(args[2]),
        });
      } else if (command === 'create-release-stage' && args.length === 4) {
        process.stdout.write(`${await createReleaseStage({
          releases: args[0],
          manifestDigest: args[1],
          allowedUid: Number(args[2]),
          allowedGid: Number(args[3]),
        })}\n`);
      } else if (command === 'verify-release' && args.length === 5) {
        process.stdout.write(`${await verifyRelease({
          release: args[0],
          payload: args[1],
          expectedManifestDigest: args[2],
          allowedUid: Number(args[3]),
          allowedGid: Number(args[4]),
        })}\n`);
      } else if (command === 'validate-live-release' && args.length === 4) {
        process.stdout.write(`${await validateManagedLiveRelease({
          liveLink: args[0],
          releases: args[1],
          allowedUid: Number(args[2]),
          allowedGid: Number(args[3]),
        })}\n`);
      } else if (command === 'publish-release' && args.length === 7) {
        process.stdout.write(`${await publishRelease({
          stage: args[0],
          finalRelease: args[1],
          liveLink: args[2],
          payload: args[3],
          expectedManifestDigest: args[4],
          allowedUid: Number(args[5]),
          allowedGid: Number(args[6]),
        })}\n`);
      } else if (command === 'gc-releases' && args.length === 5) {
        await garbageCollectReleases({
          releases: args[0],
          liveLink: args[1],
          keep: Number(args[2]),
          allowedUid: Number(args[3]),
          allowedGid: Number(args[4]),
        });
      } else {
        throw new Error('unsupported deployment security command');
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export { parseAllowlist, parseManifest, safeRelative, sha256 };
