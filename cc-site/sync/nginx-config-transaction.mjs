#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicInstall } from './deployment-file-transaction.mjs';
import { injectManagedInclude } from './nginx-vhost-editor.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function lstatOptional(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireRegular(identity, label) {
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
}

async function readPinned(file, label) {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    requireRegular(before, label);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`${label} changed while read`);
    }
    return { bytes, identity: before };
  } finally {
    await handle.close();
  }
}

async function writeSynced(file, bytes, mode = 0o600) {
  const handle = await open(file, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function metadataFor(identity, bytes, existed = true) {
  return existed ? {
    dev: identity.dev,
    digest: digest(bytes),
    existed: true,
    gid: identity.gid,
    ino: identity.ino,
    mode: identity.mode & 0o7777,
    uid: identity.uid,
  } : { existed: false };
}

async function sameOriginal(file, metadata) {
  const identity = await lstatOptional(file);
  if (metadata.existed === false) return identity === null;
  if (identity === null) return false;
  requireRegular(identity, 'Nginx transaction file');
  const bytes = await readFile(file);
  return (
    identity.dev === metadata.dev
    && identity.ino === metadata.ino
    && identity.uid === metadata.uid
    && identity.gid === metadata.gid
    && (identity.mode & 0o7777) === metadata.mode
    && digest(bytes) === metadata.digest
  );
}

async function currentDigest(file) {
  const identity = await lstatOptional(file);
  if (identity === null) return null;
  requireRegular(identity, 'Nginx transaction current file');
  return digest(await readFile(file));
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareNginxTransaction({
  defaultGid,
  defaultUid,
  snippet,
  snippetSource,
  transaction,
  vhost,
}) {
  if (
    ![snippet, snippetSource, transaction, vhost].every(path.isAbsolute)
    || !Number.isInteger(defaultUid)
    || !Number.isInteger(defaultGid)
  ) {
    throw new Error('invalid Nginx transaction arguments');
  }
  await mkdir(transaction, { mode: 0o700 });
  const vhostOriginal = await readPinned(vhost, 'Nginx vhost');
  const snippetIdentity = await lstatOptional(snippet);
  const snippetOriginal = snippetIdentity === null
    ? null
    : await readPinned(snippet, 'Nginx snippet');
  const snippetCandidate = await readPinned(snippetSource, 'Nginx snippet source');
  const vhostCandidate = Buffer.from(
    injectManagedInclude(vhostOriginal.bytes.toString('utf8')),
    'utf8',
  );
  await writeSynced(path.join(transaction, 'vhost.original'), vhostOriginal.bytes);
  if (snippetOriginal !== null) {
    await writeSynced(path.join(transaction, 'snippet.original'), snippetOriginal.bytes);
  }
  await writeSynced(path.join(transaction, 'vhost.candidate'), vhostCandidate);
  await writeSynced(path.join(transaction, 'snippet.candidate'), snippetCandidate.bytes);
  const metadata = {
    snippet,
    snippetCandidateDigest: digest(snippetCandidate.bytes),
    snippetOriginal: snippetOriginal === null
      ? metadataFor(null, null, false)
      : metadataFor(snippetOriginal.identity, snippetOriginal.bytes),
    snippetTarget: snippetOriginal === null ? {
      gid: defaultGid,
      mode: 0o644,
      uid: defaultUid,
    } : {
      gid: snippetOriginal.identity.gid,
      mode: snippetOriginal.identity.mode & 0o7777,
      uid: snippetOriginal.identity.uid,
    },
    vhost,
    vhostCandidateDigest: digest(vhostCandidate),
    vhostOriginal: metadataFor(vhostOriginal.identity, vhostOriginal.bytes),
  };
  await writeSynced(
    path.join(transaction, 'metadata.json'),
    Buffer.from(`${JSON.stringify(metadata)}\n`),
  );
  await syncDirectory(transaction);
}

async function readMetadata(transaction) {
  return JSON.parse(await readFile(path.join(transaction, 'metadata.json'), 'utf8'));
}

export async function commitNginxTransaction({ transaction }) {
  const metadata = await readMetadata(transaction);
  if (!await sameOriginal(metadata.vhost, metadata.vhostOriginal)) {
    throw new Error('Nginx vhost changed before commit');
  }
  if (!await sameOriginal(metadata.snippet, metadata.snippetOriginal)) {
    throw new Error('Nginx snippet changed before commit');
  }
  await atomicInstall({
    destination: metadata.snippet,
    gid: metadata.snippetTarget.gid,
    mode: metadata.snippetTarget.mode,
    source: path.join(transaction, 'snippet.candidate'),
    uid: metadata.snippetTarget.uid,
  });
  if (!await sameOriginal(metadata.vhost, metadata.vhostOriginal)) {
    throw new Error('Nginx vhost changed before commit');
  }
  await atomicInstall({
    destination: metadata.vhost,
    gid: metadata.vhostOriginal.gid,
    mode: metadata.vhostOriginal.mode,
    source: path.join(transaction, 'vhost.candidate'),
    uid: metadata.vhostOriginal.uid,
  });
}

async function rollbackOne({
  candidateDigest,
  destination,
  label,
  original,
  originalFile,
}) {
  const current = await currentDigest(destination);
  if (original.existed === false) {
    if (current === null) return;
    if (current !== candidateDigest) throw new Error(`rollback conflict: ${label}`);
    await unlink(destination);
    await syncDirectory(path.dirname(destination));
    return;
  }
  if (current === original.digest) return;
  if (current !== candidateDigest) throw new Error(`rollback conflict: ${label}`);
  await atomicInstall({
    destination,
    gid: original.gid,
    mode: original.mode,
    source: originalFile,
    uid: original.uid,
  });
}

export async function rollbackNginxTransaction({ transaction }) {
  const metadata = await readMetadata(transaction);
  const errors = [];
  for (const entry of [
    {
      candidateDigest: metadata.vhostCandidateDigest,
      destination: metadata.vhost,
      label: 'vhost',
      original: metadata.vhostOriginal,
      originalFile: path.join(transaction, 'vhost.original'),
    },
    {
      candidateDigest: metadata.snippetCandidateDigest,
      destination: metadata.snippet,
      label: 'snippet',
      original: metadata.snippetOriginal,
      originalFile: path.join(transaction, 'snippet.original'),
    },
  ]) {
    try {
      await rollbackOne(entry);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'prepare' && args.length === 6) {
      await prepareNginxTransaction({
        vhost: args[0],
        snippet: args[1],
        snippetSource: args[2],
        transaction: args[3],
        defaultUid: Number(args[4]),
        defaultGid: Number(args[5]),
      });
    } else if (command === 'commit' && args.length === 1) {
      await commitNginxTransaction({ transaction: args[0] });
    } else if (command === 'rollback' && args.length === 1) {
      await rollbackNginxTransaction({ transaction: args[0] });
    } else {
      throw new Error('invalid Nginx transaction command');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
