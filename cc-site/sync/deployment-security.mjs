#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

export async function switchSymlink({ link, target }) {
  if (!path.isAbsolute(link) || target.length === 0 || path.isAbsolute(target)) {
    throw new Error('invalid live symlink arguments');
  }
  const temporary = `${link}.new.${process.pid}`;
  try {
    await symlink(target, temporary);
    await rename(temporary, link);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  if (await readlink(link) !== target) throw new Error('live symlink verification failed');
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

async function validateReleaseTree(root, allowedUid) {
  const walkTree = async (entry) => {
    const identity = await lstat(entry);
    if (identity.uid !== allowedUid || (identity.mode & 0o022) !== 0) {
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

export async function garbageCollectReleases({
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
    || !Number.isInteger(keep)
    || keep < 1
    || keep > 10
  ) {
    throw new Error('invalid release garbage collection arguments');
  }
  const releasesIdentity = await lstat(releases);
  if (
    !releasesIdentity.isDirectory()
    || releasesIdentity.isSymbolicLink()
    || releasesIdentity.uid !== allowedUid
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
      const identity = await validateReleaseTree(candidate, allowedUid);
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
    await validateReleaseTree(candidatePath, allowedUid);
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
      } else if (command === 'switch-symlink' && args.length === 2) {
        await switchSymlink({ link: args[0], target: args[1] });
      } else if (command === 'validate-chain' && args.length === 4) {
        await validateDirectoryChain({
          boundary: args[0],
          logicalPath: args[1],
          allowedUids: args[2].split(',').map(Number),
          allowMissing: args[3] === 'true',
        });
      } else if (command === 'validate-item-tree' && args.length === 1) {
        await validateItemTree(args[0]);
      } else if (command === 'gc-releases' && args.length === 4) {
        await garbageCollectReleases({
          releases: args[0],
          liveLink: args[1],
          keep: Number(args[2]),
          allowedUid: Number(args[3]),
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
