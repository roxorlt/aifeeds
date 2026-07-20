#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);

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
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, identity: before };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicInstall({ destination, gid, mode, source, uid }) {
  if (
    !path.isAbsolute(destination)
    || !path.isAbsolute(source)
    || !Number.isInteger(uid)
    || !Number.isInteger(gid)
    || !Number.isInteger(mode)
  ) {
    throw new Error('invalid atomic install arguments');
  }
  const existing = await lstatOptional(destination);
  if (existing !== null) requireRegular(existing, 'atomic install destination');
  const { bytes } = await readPinned(source, 'atomic install source');
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.aifeeds-install.${randomUUID()}`);
  const handle = await open(temporary, 'wx', mode);
  let candidateIdentity;
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.chown(uid, gid);
    await handle.sync();
    candidateIdentity = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { bytes, identity: candidateIdentity };
}

function fileIdentity(identity, bytes) {
  return {
    dev: identity.dev,
    digest: createHash('sha256').update(bytes).digest('hex'),
    gid: identity.gid,
    ino: identity.ino,
    mode: identity.mode & 0o7777,
    size: identity.size,
    uid: identity.uid,
  };
}

function pathTransactionNames(destination, name, transaction) {
  if (
    !path.isAbsolute(destination)
    || !/^[a-z]+$/.test(name)
    || !/^[0-9a-f]{64}$/.test(transaction)
  ) {
    throw new Error('invalid deployment path transaction arguments');
  }
  const directory = path.dirname(destination);
  const transactionDirectory = path.join(
    directory,
    `.aifeeds-deploy.${transaction}.${name}`,
  );
  return {
    candidate: path.join(transactionDirectory, 'candidate'),
    current: path.join(transactionDirectory, 'current'),
    destination,
    directory,
    old: path.join(transactionDirectory, 'old'),
    receipt: path.join(transactionDirectory, 'receipt.jsonl'),
    transactionDirectory,
  };
}

function symlinkIdentity(identity, target) {
  return {
    dev: identity.dev,
    digest: createHash('sha256').update(target).digest('hex'),
    gid: identity.gid,
    ino: identity.ino,
    target,
    type: 'symlink',
    uid: identity.uid,
  };
}

function regularIdentity(identity, bytes) {
  return {
    ...fileIdentity(identity, bytes),
    type: 'file',
  };
}

function identityMatches(actual, expected) {
  if (actual?.type !== expected?.type) return false;
  const fields = actual.type === 'file'
    ? ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'digest']
    : ['dev', 'ino', 'uid', 'gid', 'target', 'digest'];
  return fields.every((field) => actual[field] === expected[field]);
}

async function inspectRegular(file, label) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { handle, identity: regularIdentity(before, bytes) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function inspectSymlink(file, label) {
  const identity = await lstat(file);
  if (!identity.isSymbolicLink()) throw new Error(`${label} must be a symlink`);
  const target = await readlink(file);
  return symlinkIdentity(identity, target);
}

async function inspectOptional(file, type, label) {
  const identity = await lstatOptional(file);
  if (identity === null) return null;
  if (type === 'file') {
    const pinned = await inspectRegular(file, label);
    await pinned.handle.close();
    return pinned.identity;
  }
  return inspectSymlink(file, label);
}

async function appendReceipt(receipt, event) {
  const handle = await open(receipt, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseReceipt(names, serialized) {
  const lines = serialized.split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('invalid empty deployment receipt');
  const header = JSON.parse(lines[0]);
  if (
    header.schema !== 1
    || header.destination !== names.destination
    || header.transactionDirectory !== names.transactionDirectory
    || (header.type !== 'file' && header.type !== 'symlink')
  ) {
    throw new Error('invalid deployment transaction receipt');
  }
  const events = lines.slice(1).map((line) => JSON.parse(line));
  for (const event of events) {
    if (event.candidate) header.candidate = event.candidate;
  }
  return { events, header };
}

async function readReceipt(names) {
  return parseReceipt(names, await readFile(names.receipt, 'utf8'));
}

async function createTransactionDirectory(names) {
  await mkdir(names.transactionDirectory, { mode: 0o700 });
  await chmod(names.transactionDirectory, 0o700);
  await syncDirectory(names.directory);
}

async function cleanupTransaction(names) {
  for (const artifact of [
    names.candidate,
    names.current,
    names.old,
    names.receipt,
  ]) {
    await unlink(artifact).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  await syncDirectory(names.transactionDirectory);
  await rmdir(names.transactionDirectory);
  await syncDirectory(names.directory);
}

async function publishNoReplace(source, destination, directory, type) {
  try {
    if (type === 'symlink') {
      try {
        await link(source, destination);
      } catch (error) {
        if (
          process.platform !== 'darwin'
          || (error?.code !== 'ENOENT' && error?.code !== 'EPERM')
        ) {
          throw error;
        }
        await execFile('/bin/ln', ['-P', '--', source, destination]);
      }
    } else {
      await link(source, destination);
    }
  } catch (error) {
    if (
      error?.code === 'EEXIST'
      || await lstatOptional(destination) !== null
    ) {
      throw new Error('deployment transaction conflict: live destination already exists');
    }
    throw error;
  }
  await syncDirectory(directory);
}

async function settlePublishedCandidate(names, type) {
  if (type !== 'symlink') return;
  await unlink(names.candidate).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await syncDirectory(names.transactionDirectory);
}

async function restoreMovedNoReplace(moved, names) {
  try {
    const identity = await lstat(moved);
    if (identity.isSymbolicLink()) {
      await symlink(await readlink(moved), names.destination);
    } else {
      await link(moved, names.destination);
    }
    await syncDirectory(names.directory);
    await unlink(moved);
    await syncDirectory(names.transactionDirectory);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `deployment transaction conflict: live destination and preserved object coexist; `
        + `preserved=${moved}`,
      );
    }
    throw error;
  }
}

async function moveAndVerifyExpected({ expected, hooks, names, type }) {
  let opened = null;
  let observed;
  try {
    if (type === 'file') {
      opened = await inspectRegular(names.destination, 'live deployment file');
      observed = opened.identity;
    } else {
      observed = await inspectSymlink(names.destination, 'live deployment link');
    }
    await hooks?.afterLiveOpen?.(names.destination);
    await rename(names.destination, names.old);
    await syncDirectory(names.directory);
    await syncDirectory(names.transactionDirectory);
    await appendReceipt(names.receipt, { phase: 'old-moved' });
    await hooks?.afterOldMove?.(names.old);
    const moved = await inspectOptional(names.old, type, 'moved deployment object');
    if (
      !identityMatches(observed, expected)
      || !identityMatches(moved, observed)
    ) {
      await restoreMovedNoReplace(names.old, names);
      throw new Error(
        'deployment transaction conflict: live object changed before quarantine',
      );
    }
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function resumeInstall(names) {
  const { events, header } = await readReceipt(names);
  const live = await inspectOptional(
    names.destination,
    header.type,
    'live deployment object',
  );
  if (live !== null) {
    if (identityMatches(live, header.candidate)) {
      if (!events.some(({ phase }) => phase === 'candidate-published')) {
        await appendReceipt(names.receipt, {
          candidate: live,
          phase: 'candidate-published',
        });
      }
      await settlePublishedCandidate(names, header.type);
      return header.candidate;
    }
    if (!identityMatches(live, header.expected)) {
      throw new Error('deployment transaction conflict: live object is operator-managed');
    }
  }
  if (live !== null && header.expected !== null) {
    await moveAndVerifyExpected({
      expected: header.expected,
      hooks: {},
      names,
      type: header.type,
    });
  } else if (live === null && header.expected !== null) {
    const quarantined = await inspectOptional(
      names.old,
      header.type,
      'quarantined deployment object',
    );
    if (!identityMatches(quarantined, header.expected)) {
      throw new Error('deployment transaction conflict: expected quarantine is missing');
    }
  } else if (live !== null) {
    throw new Error('deployment transaction conflict: expected an absent destination');
  }
  await publishNoReplace(
    names.candidate,
    names.destination,
    names.directory,
    header.type,
  );
  const published = await inspectOptional(
    names.destination,
    header.type,
    'published deployment candidate',
  );
  await appendReceipt(names.receipt, {
    candidate: published,
    phase: 'candidate-published',
  });
  await settlePublishedCandidate(names, header.type);
  return published;
}

async function prepareReceipt({
  candidate,
  expected,
  hooks,
  names,
  type,
}) {
  await hooks?.beforeReceiptWrite?.();
  const header = {
    candidate,
    destination: names.destination,
    expected,
    schema: 1,
    transactionDirectory: names.transactionDirectory,
    type,
  };
  const handle = await open(names.receipt, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(header)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(names.transactionDirectory);
}

export async function installFileTransaction({
  backups,
  destination,
  gid,
  hooks = {},
  mode,
  name,
  source,
  transaction,
  uid,
}) {
  const names = pathTransactionNames(destination, name, transaction);
  await createTransactionDirectory(names);
  let receiptWritten = false;
  try {
    const { bytes } = await readPinned(source, 'deployment transaction source');
    const candidateHandle = await open(names.candidate, 'wx', mode);
    let candidate;
    try {
      await candidateHandle.writeFile(bytes);
      await candidateHandle.chmod(mode);
      await candidateHandle.chown(uid, gid);
      await candidateHandle.sync();
      candidate = regularIdentity(await candidateHandle.stat(), bytes);
    } finally {
      await candidateHandle.close();
    }
    await syncDirectory(names.transactionDirectory);
    const expectedMetadata = JSON.parse(
      await readFile(path.join(backups, `${name}.json`), 'utf8'),
    );
    const expected = expectedMetadata.existed === true
      ? { ...expectedMetadata, type: 'file' }
      : null;
    await prepareReceipt({
      candidate,
      expected,
      hooks,
      names,
      type: 'file',
    });
    receiptWritten = true;
    if (expected !== null) {
      await moveAndVerifyExpected({
        expected,
        hooks,
        names,
        type: 'file',
      });
    }
    await publishNoReplace(names.candidate, destination, names.directory, 'file');
    const published = await inspectOptional(
      destination,
      'file',
      'published deployment candidate',
    );
    await appendReceipt(names.receipt, {
      candidate: published,
      phase: 'candidate-published',
    });
    return published;
  } catch (error) {
    if (!receiptWritten) {
      await cleanupTransaction(names).catch(() => {});
    }
    throw error;
  }
}

export async function recoverFileTransaction({ destination, name, transaction }) {
  const names = pathTransactionNames(destination, name, transaction);
  const receipt = await lstatOptional(names.receipt);
  if (receipt === null) return null;
  return resumeInstall(names);
}

export async function installSymlinkTransaction({
  destination,
  hooks = {},
  name,
  target,
  transaction,
}) {
  if (target.length === 0 || path.isAbsolute(target)) {
    throw new Error('invalid deployment symlink target');
  }
  const names = pathTransactionNames(destination, name, transaction);
  const oldIdentity = await lstatOptional(destination);
  let expected = null;
  if (oldIdentity !== null) {
    expected = await inspectSymlink(destination, 'existing deployment link');
  }
  await createTransactionDirectory(names);
  let receiptWritten = false;
  try {
    await symlink(target, names.candidate);
    const candidate = await inspectSymlink(
      names.candidate,
      'deployment link candidate',
    );
    await syncDirectory(names.transactionDirectory);
    await prepareReceipt({
      candidate,
      expected,
      hooks,
      names,
      type: 'symlink',
    });
    receiptWritten = true;
    if (expected !== null) {
      await moveAndVerifyExpected({
        expected,
        hooks,
        names,
        type: 'symlink',
      });
    }
    await publishNoReplace(names.candidate, destination, names.directory, 'symlink');
    await hooks?.afterLivePublishBeforeReceipt?.(destination);
    const published = await inspectOptional(
      destination,
      'symlink',
      'published deployment candidate',
    );
    await appendReceipt(names.receipt, {
      candidate: published,
      phase: 'candidate-published',
    });
    await settlePublishedCandidate(names, 'symlink');
    return published;
  } catch (error) {
    if (!receiptWritten) {
      await cleanupTransaction(names).catch(() => {});
    }
    throw error;
  }
}

export async function recoverSymlinkTransaction({
  destination,
  name,
  transaction,
}) {
  const names = pathTransactionNames(destination, name, transaction);
  const receipt = await lstatOptional(names.receipt);
  if (receipt === null) return null;
  return resumeInstall(names);
}

export async function rollbackPathTransaction({
  destination,
  hooks = {},
  name,
  transaction,
}) {
  const names = pathTransactionNames(destination, name, transaction);
  const receiptIdentity = await lstatOptional(names.receipt);
  if (receiptIdentity === null) return;
  const { header } = await readReceipt(names);
  const liveIdentity = await lstatOptional(destination);
  if (liveIdentity !== null) {
    let opened = null;
    let observed;
    try {
      if (header.type === 'file') {
        opened = await inspectRegular(destination, 'rollback live object');
        observed = opened.identity;
      } else {
        observed = await inspectSymlink(destination, 'rollback live object');
      }
      if (!identityMatches(observed, header.candidate)) {
        throw new Error('rollback conflict: live object changed after deployment');
      }
      await hooks.afterLiveOpen?.(destination);
      await rename(destination, names.current);
      await syncDirectory(names.directory);
      await syncDirectory(names.transactionDirectory);
      const moved = await inspectOptional(
        names.current,
        header.type,
        'rollback moved candidate',
      );
      if (
        !identityMatches(moved, observed)
        || !identityMatches(moved, header.candidate)
      ) {
        await restoreMovedNoReplace(names.current, names);
        throw new Error('rollback conflict: live object changed during rollback');
      }
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
  if (header.expected !== null) {
    const old = await inspectOptional(
      names.old,
      header.type,
      'rollback old object',
    );
    if (!identityMatches(old, header.expected)) {
      throw new Error('rollback conflict: old deployment object changed');
    }
    await publishNoReplace(
      names.old,
      destination,
      names.directory,
      header.type,
    );
  }
  await cleanupTransaction(names);
}

export async function finalizePathTransaction({
  destination,
  name,
  transaction,
}) {
  const names = pathTransactionNames(destination, name, transaction);
  const receiptIdentity = await lstatOptional(names.receipt);
  if (receiptIdentity === null) return;
  const { header } = await readReceipt(names);
  const live = await inspectOptional(
    destination,
    header.type,
    'final live deployment object',
  );
  if (!identityMatches(live, header.candidate)) {
    throw new Error('deployment transaction conflict: final live object changed');
  }
  await cleanupTransaction(names);
}

const GLOBAL_TRANSACTION_NAMES = ['opt', 'service', 'timer', 'env'];

function globalTransactionSpecs(destinations, transaction) {
  if (
    !Array.isArray(destinations)
    || destinations.length !== GLOBAL_TRANSACTION_NAMES.length
    || destinations.some((destination) => !path.isAbsolute(destination))
    || new Set(destinations).size !== destinations.length
  ) {
    throw new Error('invalid global deployment destinations');
  }
  return GLOBAL_TRANSACTION_NAMES.map((name, index) => ({
    name,
    names: pathTransactionNames(destinations[index], name, transaction),
  }));
}

function numericIdentity(identity) {
  return {
    dev: identity.dev,
    ino: identity.ino,
  };
}

function recordedIdentityMatches(actual, expected) {
  return (
    Number.isSafeInteger(expected?.dev)
    && Number.isSafeInteger(expected?.ino)
    && actual.dev === expected.dev
    && actual.ino === expected.ino
  );
}

async function readSecureRegular(file, uid, gid, mode, label) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== uid
      || before.gid !== gid
      || (before.mode & 0o7777) !== mode
    ) {
      throw new Error(`${label} has unsafe identity or mode`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, identity: before };
  } finally {
    await handle.close();
  }
}

async function inspectCommittedTransaction({
  entry = null,
  gid,
  spec,
  transaction,
  uid,
}) {
  const transactionIdentity = await lstatOptional(spec.names.transactionDirectory);
  const receiptIdentity = await lstatOptional(spec.names.receipt);
  if (transactionIdentity === null) {
    if (receiptIdentity !== null) {
      throw new Error('global deployment receipt escaped its transaction directory');
    }
    return { finalized: true, spec };
  }
  if (
    !transactionIdentity.isDirectory()
    || transactionIdentity.isSymbolicLink()
    || transactionIdentity.uid !== uid
    || transactionIdentity.gid !== gid
    || (transactionIdentity.mode & 0o7777) !== 0o700
  ) {
    throw new Error('global deployment transaction directory is unsafe');
  }
  const allowed = new Set(['candidate', 'current', 'old', 'receipt.jsonl']);
  if ((await readdir(spec.names.transactionDirectory)).some((name) => !allowed.has(name))) {
    throw new Error('global deployment transaction has an unexpected artifact');
  }
  if (
    entry !== null
    && !recordedIdentityMatches(transactionIdentity, entry.transaction_identity)
  ) {
    throw new Error('global deployment transaction identity mismatch');
  }
  if (receiptIdentity === null) {
    return {
      finalized: false,
      receiptMissing: true,
      spec,
      transactionIdentity,
    };
  }
  const receipt = await readSecureRegular(
    spec.names.receipt,
    uid,
    gid,
    0o600,
    'global deployment receipt',
  );
  const parsed = parseReceipt(spec.names, receipt.bytes.toString('utf8'));
  if (
    !parsed.events.some(({ phase }) => phase === 'candidate-published')
    || parsed.header.type !== (spec.name === 'opt' ? 'symlink' : 'file')
  ) {
    throw new Error('global deployment receipt is not candidate-published');
  }
  const live = await inspectOptional(
    spec.names.destination,
    parsed.header.type,
    'globally committed live object',
  );
  if (!identityMatches(live, parsed.header.candidate)) {
    throw new Error('global deployment live identity mismatch');
  }
  const receiptDigest = createHash('sha256').update(receipt.bytes).digest('hex');
  if (
    entry !== null
    && (
      entry.name !== spec.name
      || entry.destination !== spec.names.destination
      || entry.receipt !== spec.names.receipt
      || entry.receipt_digest !== receiptDigest
      || !recordedIdentityMatches(receipt.identity, entry.receipt_identity)
      || !identityMatches(parsed.header.candidate, entry.candidate)
      || entry.transaction !== transaction
    )
  ) {
    throw new Error('global deployment marker and receipt mismatch');
  }
  return {
    candidate: parsed.header.candidate,
    finalized: false,
    receiptDigest,
    receiptIdentity: receipt.identity,
    spec,
    transactionIdentity,
  };
}

function assertGlobalPaths({ journal, manifest, release }) {
  if (
    !path.isAbsolute(journal)
    || path.basename(journal) !== '.deployment-committed.json'
    || !path.isAbsolute(release)
    || path.dirname(journal) !== path.dirname(release)
    || !/^[0-9a-f]{64}$/.test(manifest)
    || path.basename(release) !== manifest
  ) {
    throw new Error('invalid global deployment journal paths');
  }
}

export async function commitGlobalDeployment({
  destinations,
  gid,
  journal,
  manifest,
  release,
  uid,
}) {
  assertGlobalPaths({ journal, manifest, release });
  if (
    !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
    || await lstatOptional(journal) !== null
  ) {
    throw new Error('invalid global deployment commit arguments');
  }
  const releaseIdentity = await lstat(release);
  if (
    !releaseIdentity.isDirectory()
    || releaseIdentity.isSymbolicLink()
    || releaseIdentity.uid !== uid
    || releaseIdentity.gid !== gid
    || (releaseIdentity.mode & 0o7777) !== 0o755
  ) {
    throw new Error('global deployment release is unsafe');
  }
  const specs = globalTransactionSpecs(destinations, manifest);
  const snapshots = [];
  for (const spec of specs) {
    const snapshot = await inspectCommittedTransaction({
      gid,
      spec,
      transaction: manifest,
      uid,
    });
    if (snapshot.finalized || snapshot.receiptMissing) {
      throw new Error('global deployment commit requires all four receipts');
    }
    snapshots.push(snapshot);
  }
  const marker = {
    manifest,
    release,
    schema: 1,
    transactions: snapshots.map((snapshot) => ({
      candidate: snapshot.candidate,
      destination: snapshot.spec.names.destination,
      name: snapshot.spec.name,
      receipt: snapshot.spec.names.receipt,
      receipt_digest: snapshot.receiptDigest,
      receipt_identity: numericIdentity(snapshot.receiptIdentity),
      transaction: manifest,
      transaction_identity: numericIdentity(snapshot.transactionIdentity),
    })),
  };
  const candidate = path.join(
    path.dirname(journal),
    `.deployment-committed.${randomUUID()}.candidate`,
  );
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`);
    await handle.chown(uid, gid);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await publishNoReplace(candidate, journal, path.dirname(journal), 'file');
    await unlink(candidate);
    await syncDirectory(path.dirname(journal));
  } catch (error) {
    await unlink(candidate).catch(() => {});
    throw error;
  }
  return marker;
}

async function readGlobalDeployment({
  destinations,
  gid,
  journal,
  releases,
  uid,
}) {
  if (
    !path.isAbsolute(releases)
    || path.dirname(journal) !== releases
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid committed deployment recovery arguments');
  }
  const markerFile = await readSecureRegular(
    journal,
    uid,
    gid,
    0o600,
    'global deployment marker',
  );
  const marker = JSON.parse(markerFile.bytes.toString('utf8'));
  if (
    marker.schema !== 1
    || !/^[0-9a-f]{64}$/.test(marker.manifest)
    || marker.release !== path.join(releases, marker.manifest)
    || !Array.isArray(marker.transactions)
    || marker.transactions.length !== GLOBAL_TRANSACTION_NAMES.length
  ) {
    throw new Error('invalid global deployment marker');
  }
  assertGlobalPaths({
    journal,
    manifest: marker.manifest,
    release: marker.release,
  });
  const specs = globalTransactionSpecs(destinations, marker.manifest);
  const snapshots = [];
  for (let index = 0; index < specs.length; index += 1) {
    const entry = marker.transactions[index];
    if (
      entry?.name !== GLOBAL_TRANSACTION_NAMES[index]
      || entry.destination !== specs[index].names.destination
      || entry.receipt !== specs[index].names.receipt
      || entry.transaction !== marker.manifest
      || !/^[0-9a-f]{64}$/.test(entry.receipt_digest ?? '')
    ) {
      throw new Error('invalid global deployment marker transaction');
    }
    const snapshot = await inspectCommittedTransaction({
      entry,
      gid,
      spec: specs[index],
      transaction: marker.manifest,
      uid,
    });
    if (snapshot.finalized || snapshot.receiptMissing) {
      const live = await inspectOptional(
        specs[index].names.destination,
        entry.candidate?.type,
        'globally committed finalized object',
      );
      if (!identityMatches(live, entry.candidate)) {
        throw new Error('global deployment finalized live identity mismatch');
      }
    }
    snapshots.push(snapshot);
  }
  return { marker, snapshots };
}

async function removeGlobalJournal(journal) {
  await unlink(journal);
  await syncDirectory(path.dirname(journal));
}

export async function recoverCommittedDeployment(options) {
  const { journal } = options;
  const committed = await readGlobalDeployment(options);
  for (const snapshot of committed.snapshots) {
    if (snapshot.finalized) continue;
    if (snapshot.receiptMissing) {
      await cleanupTransaction(snapshot.spec.names);
    } else {
      await finalizePathTransaction({
        destination: snapshot.spec.names.destination,
        name: snapshot.spec.name,
        transaction: committed.marker.manifest,
      });
    }
  }
  const verified = await readGlobalDeployment(options);
  if (verified.snapshots.some(({ finalized }) => !finalized)) {
    throw new Error('committed deployment finalization remains incomplete');
  }
  await removeGlobalJournal(journal);
}

export async function clearCommittedDeployment(options) {
  const committed = await readGlobalDeployment(options);
  if (committed.snapshots.some(({ finalized }) => !finalized)) return 'pending';
  await removeGlobalJournal(options.journal);
  return 'cleared';
}

export async function captureFile({ backups, destination, name }) {
  if (!path.isAbsolute(backups) || !path.isAbsolute(destination) || !/^[a-z]+$/.test(name)) {
    throw new Error('invalid capture arguments');
  }
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const identity = await lstatOptional(destination);
  const metadataFile = path.join(backups, `${name}.json`);
  if (identity === null) {
    await writeFile(metadataFile, '{"existed":false}\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  const pinned = await readPinned(destination, 'deployment file');
  const backupFile = path.join(backups, `${name}.file`);
  await writeFile(backupFile, pinned.bytes, { flag: 'wx', mode: 0o600 });
  const metadata = {
    dev: pinned.identity.dev,
    digest: createHash('sha256').update(pinned.bytes).digest('hex'),
    existed: true,
    gid: pinned.identity.gid,
    ino: pinned.identity.ino,
    mode: pinned.identity.mode & 0o7777,
    size: pinned.identity.size,
    uid: pinned.identity.uid,
  };
  await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

export async function restoreFile({ backups, destination, name }) {
  const metadata = JSON.parse(await readFile(path.join(backups, `${name}.json`), 'utf8'));
  if (metadata.existed === true) {
    await atomicInstall({
      destination,
      gid: metadata.gid,
      mode: metadata.mode,
      source: path.join(backups, `${name}.file`),
      uid: metadata.uid,
    });
    return;
  }
  if (metadata.existed !== false) throw new Error('invalid deployment backup metadata');
  const existing = await lstatOptional(destination);
  if (existing !== null) {
    requireRegular(existing, 'rollback removal target');
    await unlink(destination);
    await syncDirectory(path.dirname(destination));
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'capture' && args.length === 3) {
      await captureFile({ destination: args[0], backups: args[1], name: args[2] });
    } else if (command === 'install' && args.length === 5) {
      await atomicInstall({
        source: args[0],
        destination: args[1],
        mode: Number.parseInt(args[2], 8),
        uid: Number(args[3]),
        gid: Number(args[4]),
      });
    } else if (command === 'install-transaction' && args.length === 8) {
      await installFileTransaction({
        source: args[0],
        destination: args[1],
        mode: Number.parseInt(args[2], 8),
        uid: Number(args[3]),
        gid: Number(args[4]),
        backups: args[5],
        name: args[6],
        transaction: args[7],
      });
    } else if (command === 'recover-file' && args.length === 3) {
      await recoverFileTransaction({
        destination: args[0],
        name: args[1],
        transaction: args[2],
      });
    } else if (command === 'install-symlink-transaction' && args.length === 4) {
      await installSymlinkTransaction({
        destination: args[0],
        target: args[1],
        name: args[2],
        transaction: args[3],
      });
    } else if (command === 'recover-symlink' && args.length === 3) {
      await recoverSymlinkTransaction({
        destination: args[0],
        name: args[1],
        transaction: args[2],
      });
    } else if (command === 'rollback-path' && args.length === 3) {
      await rollbackPathTransaction({
        destination: args[0],
        name: args[1],
        transaction: args[2],
      });
    } else if (command === 'finalize-path' && args.length === 3) {
      await finalizePathTransaction({
        destination: args[0],
        name: args[1],
        transaction: args[2],
      });
    } else if (command === 'commit-global' && args.length === 9) {
      await commitGlobalDeployment({
        journal: args[0],
        release: args[1],
        manifest: args[2],
        uid: Number(args[3]),
        gid: Number(args[4]),
        destinations: args.slice(5),
      });
    } else if (
      (command === 'recover-global' || command === 'clear-global')
      && args.length === 8
    ) {
      const options = {
        journal: args[0],
        releases: args[1],
        uid: Number(args[2]),
        gid: Number(args[3]),
        destinations: args.slice(4),
      };
      if (command === 'recover-global') {
        await recoverCommittedDeployment(options);
      } else {
        process.stdout.write(`${await clearCommittedDeployment(options)}\n`);
      }
    } else if (command === 'restore' && args.length === 3) {
      await restoreFile({ destination: args[0], backups: args[1], name: args[2] });
    } else {
      throw new Error('invalid deployment file transaction command');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
