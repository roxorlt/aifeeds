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
  rm,
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

function optionalIdentityMatches(actual, expected) {
  return (
    (actual === null && expected === null)
    || (actual !== null && expected !== null && identityMatches(actual, expected))
  );
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
    await hooks.afterReceiptPrepared?.({
      candidate,
      expected,
      names,
      type: 'file',
    });
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
    await hooks.afterReceiptPrepared?.({
      candidate,
      expected,
      names,
      type: 'symlink',
    });
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
const PREPARING_RECOVERY_STEPS = new Set([
  'candidate_timer_stop',
  'candidate_timer_disable',
  'candidate_service_stop',
  'nginx_rollback',
  'paths_rollback',
  'daemon_reload',
  'restore_service',
  'restore_timer_enablement',
  'restore_timer_activity',
]);

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

const GLOBAL_JOURNAL_PHASES = new Set(['preparing', 'committed']);
const DEPLOYMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GLOBAL_JOURNAL_PUBLISH_CANDIDATE =
  /^\.(preparing|committed)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate$/;
const MARKER_MUTATION_RECORD_RE =
  /^\.marker-mutation\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const MARKER_MUTATION_IDENTITY_RE =
  /^\.marker-mutation\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.identity\.json$/;
const MARKER_MUTATION_CANDIDATE_RE =
  /^\.marker-mutation\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.candidate$/;
const MARKER_MUTATION_QUARANTINE_RE =
  /^\.marker-mutation\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.quarantine$/;
const SNAPSHOT_CLEANUP_RECEIPT_RE =
  /^\.snapshot-cleanup\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

function assertGlobalJournalLocation({
  canonical,
  gid,
  journalDirectory,
  phase,
  uid,
}) {
  if (
    !path.isAbsolute(canonical)
    || !path.isAbsolute(journalDirectory)
    || path.dirname(journalDirectory) !== path.dirname(canonical)
    || path.basename(journalDirectory) !== '.deployment-journal'
    || !GLOBAL_JOURNAL_PHASES.has(phase)
    || path.basename(canonical) !== `.deployment-${phase}.json`
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid global journal location');
  }
}

function assertSnapshotCleanupReceiptLocation({
  canonical,
  gid,
  journalDirectory,
  uid,
}) {
  if (
    !path.isAbsolute(canonical)
    || !path.isAbsolute(journalDirectory)
    || path.dirname(canonical) !== journalDirectory
    || path.basename(journalDirectory) !== '.deployment-journal'
    || !SNAPSHOT_CLEANUP_RECEIPT_RE.test(path.basename(canonical))
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid snapshot cleanup receipt location');
  }
}

async function validateGlobalJournalDirectory(journalDirectory, uid, gid) {
  const identity = await lstat(journalDirectory);
  if (
    !identity.isDirectory()
    || identity.isSymbolicLink()
    || identity.uid !== uid
    || identity.gid !== gid
    || (identity.mode & 0o7777) !== 0o700
  ) {
    throw new Error('global journal candidate directory is unsafe');
  }
}

async function validateGlobalJournalFile(file, uid, gid, label) {
  const identity = await lstat(file);
  if (
    !identity.isFile()
    || identity.isSymbolicLink()
    || identity.uid !== uid
    || identity.gid !== gid
    || (identity.mode & 0o7777) !== 0o600
  ) {
    throw new Error(`${label} must be a root-private regular file`);
  }
  return identity;
}

export async function recoverGlobalJournalCandidate({
  canonical,
  gid,
  journalDirectory,
  phase,
  uid,
}) {
  assertGlobalJournalLocation({
    canonical,
    gid,
    journalDirectory,
    phase,
    uid,
  });
  await validateGlobalJournalDirectory(journalDirectory, uid, gid);
  await recoverMarkerMutations({ gid, journalDirectory, uid });
  const names = (await readdir(journalDirectory)).sort();
  if (names.some((name) => (
    !GLOBAL_JOURNAL_PUBLISH_CANDIDATE.test(name)
    && !SNAPSHOT_CLEANUP_RECEIPT_RE.test(name)
  ))) {
    throw new Error('global journal candidate directory has an unexpected entry');
  }
  const canonicalIdentity = await validateGlobalJournalFile(
    canonical,
    uid,
    gid,
    'global journal marker',
  );
  const candidates = names.filter((name) => (
    GLOBAL_JOURNAL_PUBLISH_CANDIDATE.test(name)
  ));
  if (candidates.some((name) => !name.startsWith(`.${phase}.`))) {
    throw new Error('global journal candidate belongs to an unexpected phase');
  }
  if (canonicalIdentity.nlink === 1 && candidates.length === 0) {
    return canonicalIdentity;
  }
  if (canonicalIdentity.nlink !== 2 || candidates.length !== 1) {
    throw new Error('global journal marker has an unsafe candidate link count');
  }
  const candidate = path.join(journalDirectory, candidates[0]);
  const candidateIdentity = await validateGlobalJournalFile(
    candidate,
    uid,
    gid,
    'global journal candidate',
  );
  if (
    candidateIdentity.nlink !== 2
    || candidateIdentity.dev !== canonicalIdentity.dev
    || candidateIdentity.ino !== canonicalIdentity.ino
  ) {
    throw new Error('global journal candidate inode mismatch');
  }
  await unlink(candidate);
  await syncDirectory(journalDirectory);
  const recovered = await validateGlobalJournalFile(
    canonical,
    uid,
    gid,
    'global journal marker',
  );
  if (
    recovered.nlink !== 1
    || recovered.dev !== canonicalIdentity.dev
    || recovered.ino !== canonicalIdentity.ino
  ) {
    throw new Error('global journal candidate recovery changed the marker');
  }
  return recovered;
}

export async function publishGlobalJournalMarker({
  canonical,
  gid,
  hooks = {},
  journalDirectory,
  marker,
  phase,
  uid,
}) {
  assertGlobalJournalLocation({
    canonical,
    gid,
    journalDirectory,
    phase,
    uid,
  });
  if (marker?.phase !== phase || marker?.schema !== 2) {
    throw new Error('invalid global journal marker');
  }
  await validateGlobalJournalDirectory(journalDirectory, uid, gid);
  await recoverMarkerMutations({ gid, journalDirectory, uid });
  if (await lstatOptional(canonical) !== null) {
    throw new Error('global journal marker already exists');
  }
  const operation = randomUUID();
  const paths = markerMutationPaths(journalDirectory, operation);
  const targetContent = `${JSON.stringify(marker)}\n`;
  const record = {
    action: 'create',
    canonical,
    expected: null,
    location: 'global',
    operation_id: operation,
    phase,
    schema: 1,
    target_content: targetContent,
    target_digest: createHash('sha256').update(targetContent).digest('hex'),
    target_size: Buffer.byteLength(targetContent),
  };
  await writePrivateJson(paths.record, record, uid, gid);
  await hooks.afterMutationRecordSync?.({
    action: record.action,
    candidate: paths.candidate,
    canonical,
    location: record.location,
    quarantine: null,
    record: paths.record,
  });
  return resumeMarkerMutation({
    gid,
    hooks,
    journalDirectory,
    paths,
    record,
    uid,
  });
}

async function ensureGlobalJournalDirectory({
  gid,
  journalDirectory,
  releases,
  uid,
}) {
  if (
    !path.isAbsolute(releases)
    || path.dirname(journalDirectory) !== releases
    || path.basename(journalDirectory) !== '.deployment-journal'
  ) {
    throw new Error('invalid global journal directory paths');
  }
  const releasesIdentity = await lstat(releases);
  if (
    !releasesIdentity.isDirectory()
    || releasesIdentity.isSymbolicLink()
    || releasesIdentity.uid !== uid
    || releasesIdentity.gid !== gid
    || (releasesIdentity.mode & 0o7777) !== 0o755
  ) {
    throw new Error('global journal release root is unsafe');
  }
  const existing = await lstatOptional(journalDirectory);
  if (existing === null) {
    await mkdir(journalDirectory, { mode: 0o700 });
    await chown(journalDirectory, uid, gid);
    await chmod(journalDirectory, 0o700);
    await syncDirectory(releases);
  }
  await validateGlobalJournalDirectory(journalDirectory, uid, gid);
}

function validPreparingRuntime(runtime) {
  return (
    runtime !== null
    && typeof runtime === 'object'
    && new Set(['active', 'activating', 'inactive']).has(runtime.service_active)
    && new Set(['active', 'inactive']).has(runtime.timer_active)
    && new Set(['enabled', 'disabled', 'not-found']).has(runtime.timer_enabled)
  );
}

function validPreparingRecovery(recovery) {
  if (recovery === null || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return false;
  }
  return Object.entries(recovery).every(([step, state]) => (
    PREPARING_RECOVERY_STEPS.has(step)
    && (state === 'attempted' || state === 'completed')
  ));
}

function snapshotIdentity(identity) {
  return {
    dev: identity.dev,
    gid: identity.gid,
    ino: identity.ino,
    mode: identity.mode & 0o7777,
    uid: identity.uid,
  };
}

function snapshotIdentityMatches(identity, expected) {
  return (
    identity !== null
    && identity.isDirectory()
    && !identity.isSymbolicLink()
    && identity.dev === expected.dev
    && identity.ino === expected.ino
    && identity.uid === expected.uid
    && identity.gid === expected.gid
    && (identity.mode & 0o7777) === expected.mode
  );
}

function snapshotDirectoryIdentityArguments(snapshot) {
  return [
    String(snapshot.dev),
    String(snapshot.ino),
    String(snapshot.uid),
    String(snapshot.gid),
    String(snapshot.mode),
  ];
}

async function runLinuxFsHelper(args) {
  const python = process.env.AIFEEDS_PYTHON_BIN ?? '/usr/bin/python3';
  const helper = process.env.AIFEEDS_FIXED_LINUX_FS_HELPER
    ?? path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'deployment-linux-fs.py',
    );
  if (
    !path.isAbsolute(python)
    || !path.isAbsolute(helper)
    || !Array.isArray(args)
    || args.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error('invalid Linux filesystem helper invocation');
  }
  await execFile(python, [helper, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function assertSnapshotPath(snapshot, nginxTransaction) {
  const parent = path.dirname(snapshot);
  const managedParent = (
    path.basename(parent) === 'aifeeds-cc-deploy-snapshots'
    && path.basename(path.dirname(parent)) === 'lib'
    && path.basename(path.dirname(path.dirname(parent))) === 'var'
  );
  const legacyParent = (
    path.basename(parent) === 'tmp'
    && path.basename(path.dirname(parent)) === 'var'
  );
  if (
    !path.isAbsolute(snapshot)
    || !/^aifeeds-cc-root-snapshot\.[A-Za-z0-9]{6}$/.test(path.basename(snapshot))
    || (!managedParent && !legacyParent)
    || nginxTransaction !== path.join(snapshot, '.rollback', 'nginx')
  ) {
    throw new Error('invalid preparing snapshot path');
  }
  return { kind: managedParent ? 'managed' : 'legacy', parent };
}

async function validateSnapshotParent(snapshot) {
  const inspected = assertSnapshotPath(
    snapshot.path,
    path.join(snapshot.path, '.rollback', 'nginx'),
  );
  const identity = await lstat(inspected.parent);
  const expectedMode = inspected.kind === 'managed' ? 0o700 : 0o1777;
  if (
    !identity.isDirectory()
    || identity.isSymbolicLink()
    || identity.uid !== snapshot.uid
    || identity.gid !== snapshot.gid
    || (identity.mode & 0o7777) !== expectedMode
  ) {
    throw new Error(`preparing ${inspected.kind} snapshot parent is unsafe`);
  }
  return inspected;
}

async function inspectPreparingSnapshot({ gid, nginxTransaction, uid }) {
  const snapshot = path.dirname(path.dirname(nginxTransaction));
  const { kind, parent } = assertSnapshotPath(snapshot, nginxTransaction);
  const parentIdentity = await lstat(parent);
  const expectedParentMode = kind === 'managed' ? 0o700 : 0o1777;
  if (
    !parentIdentity.isDirectory()
    || parentIdentity.isSymbolicLink()
    || parentIdentity.uid !== uid
    || parentIdentity.gid !== gid
    || (parentIdentity.mode & 0o7777) !== expectedParentMode
  ) {
    throw new Error('preparing snapshot parent is unsafe');
  }
  const identity = await lstat(snapshot);
  if (
    !identity.isDirectory()
    || identity.isSymbolicLink()
    || identity.uid !== uid
    || identity.gid !== gid
    || (identity.mode & 0o7777) !== 0o755
  ) {
    throw new Error('preparing snapshot root is unsafe');
  }
  return {
    cleanup: null,
    parent,
    path: snapshot,
    ...snapshotIdentity(identity),
  };
}

function validPreparingSnapshot(snapshot, nginxTransaction, journalDirectory) {
  if (
    snapshot === null
    || typeof snapshot !== 'object'
    || snapshot.parent !== path.dirname(snapshot.path ?? '')
    || !Number.isSafeInteger(snapshot.dev)
    || !Number.isSafeInteger(snapshot.ino)
    || !Number.isSafeInteger(snapshot.uid)
    || !Number.isSafeInteger(snapshot.gid)
    || snapshot.mode !== 0o755
  ) {
    return false;
  }
  try {
    assertSnapshotPath(snapshot.path, nginxTransaction);
  } catch {
    return false;
  }
  if (snapshot.cleanup === null) return true;
  return (
    typeof snapshot.cleanup === 'object'
    && snapshot.cleanup.state === 'planned'
    && snapshot.cleanup.quarantine === path.join(
      snapshot.parent,
      `${path.basename(snapshot.path)}.cleanup.${snapshot.cleanup.deployment_id}`,
    )
    && DEPLOYMENT_ID_RE.test(snapshot.cleanup.deployment_id ?? '')
    && snapshot.cleanup.receipt === path.join(
      journalDirectory,
      `.snapshot-cleanup.${snapshot.cleanup.deployment_id}.json`,
    )
    && (
      snapshot.cleanup.preparing_digest === undefined
      || /^[0-9a-f]{64}$/.test(snapshot.cleanup.preparing_digest)
    )
  );
}

async function validatePreparingSnapshot(snapshot) {
  await validateSnapshotParent(snapshot);
  const canonical = await lstatOptional(snapshot.path);
  if (snapshot.cleanup === null) {
    if (!snapshotIdentityMatches(canonical, snapshot)) {
      throw new Error('preparing snapshot identity mismatch');
    }
    return 'canonical';
  }
  const quarantine = await lstatOptional(snapshot.cleanup.quarantine);
  const canonicalMatches = snapshotIdentityMatches(canonical, snapshot);
  const quarantineMatches = snapshotIdentityMatches(quarantine, snapshot);
  if (canonicalMatches === quarantineMatches) {
    throw new Error('preparing snapshot cleanup identity is ambiguous');
  }
  if (
    (canonical !== null && !canonicalMatches)
    || (quarantine !== null && !quarantineMatches)
  ) {
    throw new Error('preparing snapshot cleanup path was replaced');
  }
  return canonicalMatches ? 'canonical' : 'quarantine';
}

function snapshotCleanupReceiptBase(snapshot) {
  return {
    canonical: snapshot.path,
    deployment_id: snapshot.cleanup.deployment_id,
    identity: {
      dev: snapshot.dev,
      gid: snapshot.gid,
      ino: snapshot.ino,
      mode: snapshot.mode,
      uid: snapshot.uid,
    },
    quarantine: snapshot.cleanup.quarantine,
  };
}

function snapshotCleanupReceiptDigest(receipt) {
  return createHash('sha256')
    .update(`${JSON.stringify(receipt)}\n`)
    .digest('hex');
}

function snapshotCleanupReceipt(snapshot, phase = 'planned') {
  const base = snapshotCleanupReceiptBase(snapshot);
  const planned = {
    ...base,
    phase: 'planned',
    schema: 2,
  };
  if (phase === 'planned') return planned;
  const deleting = {
    ...base,
    phase: 'deleting',
    planned_digest: snapshotCleanupReceiptDigest(planned),
    schema: 2,
  };
  if (phase === 'deleting') return deleting;
  if (phase === 'deleted') {
    return {
      ...base,
      deleting_digest: snapshotCleanupReceiptDigest(deleting),
      phase: 'deleted',
      planned_digest: deleting.planned_digest,
      schema: 2,
    };
  }
  throw new Error('invalid snapshot cleanup receipt phase');
}

function snapshotCleanupReceiptPhase(receipt, snapshot) {
  for (const phase of ['planned', 'deleting', 'deleted']) {
    const expected = snapshotCleanupReceipt(snapshot, phase);
    if (JSON.stringify(receipt) === JSON.stringify(expected)) return phase;
  }
  return null;
}

function snapshotCleanupReceiptMatches(receipt, snapshot) {
  return snapshotCleanupReceiptPhase(receipt, snapshot) === 'planned';
}

async function readSnapshotCleanupReceipt(snapshot, uid, gid, label) {
  const file = await readSecureRegular(
    snapshot.cleanup.receipt,
    uid,
    gid,
    0o600,
    label,
  );
  const receipt = JSON.parse(file.bytes.toString('utf8'));
  const phase = snapshotCleanupReceiptPhase(receipt, snapshot);
  if (phase === null) {
    throw new Error('snapshot cleanup receipt mismatch');
  }
  return { file, phase, receipt };
}

async function ensureSnapshotCleanupReceipt(snapshot, uid, gid, hooks = {}) {
  const expected = snapshotCleanupReceipt(snapshot, 'planned');
  const receipt = snapshot.cleanup.receipt;
  const journalDirectory = path.dirname(receipt);
  await recoverMarkerMutations({ gid, hooks, journalDirectory, uid });
  const existing = await lstatOptional(receipt);
  if (existing === null) {
    await mutateGlobalJournalMarker({
      canonical: receipt,
      expectedFile: null,
      gid,
      hooks,
      journalDirectory,
      location: 'snapshot-cleanup',
      marker: expected,
      phase: 'snapshot-cleanup',
      uid,
    });
  }
  const current = await readSnapshotCleanupReceipt(
    snapshot,
    uid,
    gid,
    'snapshot cleanup receipt',
  );
  if (current.phase !== 'planned') {
    throw new Error('snapshot cleanup receipt advanced before marker removal');
  }
}

async function removeBoundSnapshot(snapshot) {
  const location = await validatePreparingSnapshot(snapshot);
  if (location === 'canonical') {
    await runLinuxFsHelper([
      'move-directory-no-replace',
      snapshot.path,
      snapshot.cleanup.quarantine,
      ...snapshotDirectoryIdentityArguments(snapshot),
    ]);
    const moved = await lstatOptional(snapshot.cleanup.quarantine);
    if (!snapshotIdentityMatches(moved, snapshot)) {
      throw new Error('snapshot changed during cleanup quarantine');
    }
  }
}

async function replaceSnapshotCleanupReceipt({
  expectedFile,
  gid,
  hooks = {},
  journalDirectory,
  receipt,
  snapshot,
  uid,
}) {
  return mutateGlobalJournalMarker({
    canonical: snapshot.cleanup.receipt,
    expectedFile,
    gid,
    hooks,
    journalDirectory,
    location: 'snapshot-cleanup',
    marker: receipt,
    phase: 'snapshot-cleanup',
    uid,
  });
}

async function removeSnapshotCleanupReceipt({
  expectedFile,
  gid,
  hooks = {},
  journalDirectory,
  snapshot,
  uid,
}) {
  return mutateGlobalJournalMarker({
    canonical: snapshot.cleanup.receipt,
    expectedFile,
    gid,
    hooks,
    journalDirectory,
    location: 'snapshot-cleanup',
    marker: null,
    phase: 'snapshot-cleanup',
    uid,
  });
}

async function transitionSnapshotCleanupReceipt({
  from,
  gid,
  hooks = {},
  journalDirectory,
  snapshot,
  to,
  uid,
}) {
  const current = await readSnapshotCleanupReceipt(
    snapshot,
    uid,
    gid,
    'snapshot cleanup receipt transition source',
  );
  if (current.phase === to) return current;
  if (current.phase !== from) {
    throw new Error('snapshot cleanup receipt phase transition mismatch');
  }
  await replaceSnapshotCleanupReceipt({
    expectedFile: current.file,
    gid,
    hooks,
    journalDirectory,
    receipt: snapshotCleanupReceipt(snapshot, to),
    snapshot,
    uid,
  });
  return readSnapshotCleanupReceipt(
    snapshot,
    uid,
    gid,
    'snapshot cleanup receipt transition result',
  );
}

async function assertSnapshotQuarantine(snapshot) {
  const quarantine = await lstatOptional(snapshot.cleanup.quarantine);
  if (!snapshotIdentityMatches(quarantine, snapshot)) {
    throw new Error('snapshot cleanup quarantine identity mismatch');
  }
  if (await lstatOptional(snapshot.path) !== null) {
    throw new Error('snapshot canonical path was replaced during cleanup');
  }
}

async function emptySnapshotQuarantine(snapshot) {
  await assertSnapshotQuarantine(snapshot);
  await runLinuxFsHelper([
    'empty-directory-bound',
    snapshot.cleanup.quarantine,
    ...snapshotDirectoryIdentityArguments(snapshot),
  ]);
  await assertSnapshotQuarantine(snapshot);
}

async function finishSnapshotCleanup(snapshot, uid, gid, hooks = {}) {
  const journalDirectory = path.dirname(snapshot.cleanup.receipt);
  let current = await readSnapshotCleanupReceipt(
    snapshot,
    uid,
    gid,
    'snapshot cleanup receipt',
  );
  if (current.phase === 'planned') {
    await assertSnapshotQuarantine(snapshot);
    current = await transitionSnapshotCleanupReceipt({
      from: 'planned',
      gid,
      hooks,
      journalDirectory,
      snapshot,
      to: 'deleting',
      uid,
    });
  }
  if (current.phase === 'deleting') {
    await emptySnapshotQuarantine(snapshot);
    current = await transitionSnapshotCleanupReceipt({
      from: 'deleting',
      gid,
      hooks,
      journalDirectory,
      snapshot,
      to: 'deleted',
      uid,
    });
  }
  if (current.phase !== 'deleted') {
    throw new Error('snapshot cleanup receipt did not reach deleted phase');
  }
  if (await lstatOptional(snapshot.path) !== null) {
    throw new Error('snapshot canonical path was replaced during cleanup');
  }
  const quarantine = await lstatOptional(snapshot.cleanup.quarantine);
  if (quarantine !== null) {
    if (!snapshotIdentityMatches(quarantine, snapshot)) {
      throw new Error('snapshot cleanup quarantine identity mismatch');
    }
    await runLinuxFsHelper([
      'remove-empty-directory-bound',
      snapshot.cleanup.quarantine,
      ...snapshotDirectoryIdentityArguments(snapshot),
    ]);
  }
  await hooks.afterSnapshotQuarantineRemovalBeforeReceiptUnlink?.({
    receipt: snapshot.cleanup.receipt,
    snapshot,
  });
  current = await readSnapshotCleanupReceipt(
    snapshot,
    uid,
    gid,
    'deleted snapshot cleanup receipt',
  );
  if (current.phase !== 'deleted') {
    throw new Error('snapshot cleanup receipt changed before removal');
  }
  await removeSnapshotCleanupReceipt({
    expectedFile: current.file,
    gid,
    hooks,
    journalDirectory,
    snapshot,
    uid,
  });
}

async function inspectExpectedDestination(destination, type) {
  const identity = await lstatOptional(destination);
  if (identity === null) return null;
  if (type === 'symlink') {
    return inspectSymlink(destination, 'preparing deployment destination');
  }
  requireRegular(identity, 'preparing deployment destination');
  const inspected = await inspectRegular(
    destination,
    'preparing deployment destination',
  );
  await inspected.handle.close();
  return inspected.identity;
}

export async function prepareGlobalDeployment({
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  manifest,
  nginxTransaction,
  preparingJournal,
  release,
  releases,
  runtime,
  uid,
}) {
  assertGlobalPaths({
    journal: committedJournal,
    manifest,
    release,
  });
  if (
    path.dirname(preparingJournal) !== releases
    || path.basename(preparingJournal) !== '.deployment-preparing.json'
    || path.dirname(committedJournal) !== releases
    || !path.isAbsolute(nginxTransaction)
    || !validPreparingRuntime(runtime)
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
    || await lstatOptional(preparingJournal) !== null
    || await lstatOptional(committedJournal) !== null
  ) {
    throw new Error('invalid global preparing deployment arguments');
  }
  await ensureGlobalJournalDirectory({
    gid,
    journalDirectory,
    releases,
    uid,
  });
  if ((await readdir(journalDirectory)).length !== 0) {
    throw new Error('global journal candidate directory is not empty');
  }
  const specs = globalTransactionSpecs(destinations, manifest);
  const transactions = [];
  for (const spec of specs) {
    if (await lstatOptional(spec.names.transactionDirectory) !== null) {
      throw new Error('orphan deployment transaction exists before preparing');
    }
    const type = spec.name === 'opt' ? 'symlink' : 'file';
    transactions.push({
      destination: spec.names.destination,
      expected: await inspectExpectedDestination(spec.names.destination, type),
      name: spec.name,
      receipt: spec.names.receipt,
      state: 'planned',
      transaction: spec.names.transactionDirectory,
      type,
    });
  }
  const deploymentId = randomUUID();
  const marker = {
    deployment_id: deploymentId,
    manifest,
    nginx_transaction: nginxTransaction,
    phase: 'preparing',
    recovery: {},
    release,
    runtime,
    schema: 2,
    snapshot: await inspectPreparingSnapshot({
      gid,
      nginxTransaction,
      uid,
    }),
    transactions,
  };
  await publishGlobalJournalMarker({
    canonical: preparingJournal,
    gid,
    hooks,
    journalDirectory,
    marker,
    phase: 'preparing',
    uid,
  });
  return marker;
}

function markerCasSnapshot(markerFile) {
  return {
    ctimeMs: markerFile.identity.ctimeMs,
    dev: markerFile.identity.dev,
    digest: createHash('sha256').update(markerFile.bytes).digest('hex'),
    gid: markerFile.identity.gid,
    ino: markerFile.identity.ino,
    mode: markerFile.identity.mode & 0o7777,
    mtimeMs: markerFile.identity.mtimeMs,
    size: markerFile.identity.size,
    uid: markerFile.identity.uid,
  };
}

function markerSnapshotMatches(actual, expected, includeTimes = true) {
  const fields = ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'digest'];
  if (includeTimes) fields.push('ctimeMs', 'mtimeMs');
  return fields.every((field) => actual[field] === expected[field]);
}

function markerMutationPaths(journalDirectory, operationId) {
  return {
    candidate: path.join(
      journalDirectory,
      `.marker-mutation.${operationId}.candidate`,
    ),
    identity: path.join(
      journalDirectory,
      `.marker-mutation.${operationId}.identity.json`,
    ),
    quarantine: path.join(
      journalDirectory,
      `.marker-mutation.${operationId}.quarantine`,
    ),
    record: path.join(
      journalDirectory,
      `.marker-mutation.${operationId}.json`,
    ),
  };
}

function validMarkerCasSnapshot(snapshot, uid, gid) {
  return (
    snapshot !== null
    && typeof snapshot === 'object'
    && Number.isSafeInteger(snapshot.dev)
    && Number.isSafeInteger(snapshot.ino)
    && Number.isSafeInteger(snapshot.size)
    && Number.isSafeInteger(snapshot.uid)
    && Number.isSafeInteger(snapshot.gid)
    && Number.isSafeInteger(snapshot.mode)
    && Number.isFinite(snapshot.ctimeMs)
    && Number.isFinite(snapshot.mtimeMs)
    && snapshot.uid === uid
    && snapshot.gid === gid
    && snapshot.mode === 0o600
    && typeof snapshot.digest === 'string'
    && /^[0-9a-f]{64}$/.test(snapshot.digest)
  );
}

function markerBoundIdentity(snapshot) {
  return {
    dev: snapshot.dev,
    digest: snapshot.digest,
    gid: snapshot.gid,
    ino: snapshot.ino,
    mode: snapshot.mode,
    size: snapshot.size,
    uid: snapshot.uid,
  };
}

function validMarkerBoundIdentity(identity, uid, gid) {
  return (
    identity !== null
    && typeof identity === 'object'
    && Number.isSafeInteger(identity.dev)
    && Number.isSafeInteger(identity.ino)
    && Number.isSafeInteger(identity.size)
    && identity.uid === uid
    && identity.gid === gid
    && identity.mode === 0o600
    && typeof identity.digest === 'string'
    && /^[0-9a-f]{64}$/.test(identity.digest)
  );
}

function markerBoundIdentityMatches(actual, expected) {
  return ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'digest']
    .every((field) => actual?.[field] === expected?.[field]);
}

async function readMarkerPathOptional(file, uid, gid, label) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.uid !== uid
      || before.gid !== gid
      || (before.mode & 0o7777) !== 0o600
      || (before.nlink !== 1 && before.nlink !== 2)
    ) {
      throw new Error(`${label} has unsafe identity, links, or mode`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.ctimeMs !== before.ctimeMs
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    const pathname = await lstatOptional(file);
    if (
      pathname === null
      || pathname.isSymbolicLink()
      || pathname.dev !== before.dev
      || pathname.ino !== before.ino
    ) {
      throw new Error(`${label} pathname changed while it was read`);
    }
    return {
      bytes,
      identity: before,
      snapshot: markerCasSnapshot({ bytes, identity: before }),
    };
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(file, value, uid, gid) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.chown(uid, gid);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writeGlobalMarkerCandidate({ candidate, content, gid, uid }) {
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.chown(uid, gid);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(candidate));
}

function assertMarkerMutationCanonical({
  canonical,
  gid,
  journalDirectory,
  location,
  phase,
  uid,
}) {
  if (location === 'global') {
    assertGlobalJournalLocation({
      canonical,
      gid,
      journalDirectory,
      phase,
      uid,
    });
  } else if (location === 'snapshot-cleanup') {
    if (phase !== 'snapshot-cleanup') {
      throw new Error('invalid snapshot cleanup marker mutation phase');
    }
    assertSnapshotCleanupReceiptLocation({
      canonical,
      gid,
      journalDirectory,
      uid,
    });
  } else {
    throw new Error('invalid marker mutation location');
  }
}

function validateMarkerMutationLocation(record, journalDirectory, uid, gid) {
  if (
    record?.schema !== 1
    || !DEPLOYMENT_ID_RE.test(record.operation_id ?? '')
    || !['create', 'replace', 'delete'].includes(record.action)
    || (
      record.action === 'create'
        ? record.expected !== null
        : !validMarkerCasSnapshot(record.expected, uid, gid)
    )
  ) {
    throw new Error('invalid marker mutation operation record');
  }
  assertMarkerMutationCanonical({
    canonical: record.canonical,
    gid,
    journalDirectory,
    location: record.location,
    phase: record.phase,
    uid,
  });
  if (record.action === 'create' || record.action === 'replace') {
    if (
      typeof record.target_content !== 'string'
      || record.target_content.length === 0
      || Buffer.byteLength(record.target_content) !== record.target_size
      || createHash('sha256').update(record.target_content).digest('hex')
        !== record.target_digest
    ) {
      throw new Error('invalid marker mutation replacement content');
    }
  } else if (
    record.target_content !== null
    || record.target_digest !== null
    || record.target_size !== 0
  ) {
    throw new Error('invalid marker mutation deletion record');
  }
}

async function readMarkerMutationRecord(file, journalDirectory, uid, gid) {
  const pinned = await readSecureRegular(
    file,
    uid,
    gid,
    0o600,
    'marker mutation operation record',
  );
  let record;
  try {
    record = JSON.parse(pinned.bytes.toString('utf8'));
  } catch {
    throw new Error('invalid marker mutation operation record JSON');
  }
  validateMarkerMutationLocation(record, journalDirectory, uid, gid);
  if (path.basename(file) !== `.marker-mutation.${record.operation_id}.json`) {
    throw new Error('marker mutation operation record name mismatch');
  }
  return record;
}

async function readMarkerMutationIdentity(
  file,
  operationId,
  journalDirectory,
  uid,
  gid,
) {
  const pinned = await readSecureRegular(
    file,
    uid,
    gid,
    0o600,
    'marker mutation identity receipt',
  );
  let identity;
  try {
    identity = JSON.parse(pinned.bytes.toString('utf8'));
  } catch {
    throw new Error('invalid marker mutation identity receipt JSON');
  }
  if (
    identity?.schema !== 1
    || identity.operation_id !== operationId
    || !['create', 'replace', 'delete'].includes(identity.action)
    || !path.isAbsolute(identity.canonical ?? '')
    || !validMarkerBoundIdentity(identity.bound, uid, gid)
  ) {
    throw new Error('invalid marker mutation identity receipt');
  }
  assertMarkerMutationCanonical({
    canonical: identity.canonical,
    gid,
    journalDirectory,
    location: identity.location,
    phase: identity.phase,
    uid,
  });
  if (path.basename(file) !== `.marker-mutation.${operationId}.identity.json`) {
    throw new Error('marker mutation identity receipt name mismatch');
  }
  return identity;
}

function markerMutationIdentityRecord(record, bound) {
  return {
    action: record.action,
    bound,
    canonical: record.canonical,
    location: record.location,
    operation_id: record.operation_id,
    phase: record.phase,
    schema: 1,
  };
}

function identityMatchesRecord(identity, record) {
  return (
    identity.action === record.action
    && identity.canonical === record.canonical
    && identity.location === record.location
    && identity.operation_id === record.operation_id
    && identity.phase === record.phase
  );
}

async function syncMarkerDirectories(canonical, journalDirectory) {
  const canonicalDirectory = path.dirname(canonical);
  await syncDirectory(canonicalDirectory);
  if (canonicalDirectory !== journalDirectory) {
    await syncDirectory(journalDirectory);
  }
}

async function inspectMarkerMutationState(record, paths, uid, gid) {
  const [canonical, candidate, quarantine] = await Promise.all([
    readMarkerPathOptional(
      record.canonical,
      uid,
      gid,
      'marker mutation canonical',
    ),
    readMarkerPathOptional(
      paths.candidate,
      uid,
      gid,
      'marker mutation candidate',
    ),
    readMarkerPathOptional(
      paths.quarantine,
      uid,
      gid,
      'marker mutation quarantine',
    ),
  ]);
  return { candidate, canonical, quarantine };
}

function requireSnapshotMatch(actual, expected, message, includeTimes = true) {
  if (actual === null || !markerSnapshotMatches(actual.snapshot, expected, includeTimes)) {
    throw new Error(message);
  }
}

function requireBoundMatch(actual, expected, message) {
  if (
    actual === null
    || !markerBoundIdentityMatches(markerBoundIdentity(actual.snapshot), expected)
  ) {
    throw new Error(message);
  }
}

async function finishMarkerMutationEvidence({
  gid,
  identity,
  journalDirectory,
  paths,
  record,
  uid,
}) {
  await unlink(paths.record);
  await syncDirectory(journalDirectory);
  await recoverTerminalMarkerMutationIdentity({
    gid,
    identity,
    journalDirectory,
    paths,
    uid,
  });
}

async function resumeMarkerMutation({
  gid,
  hooks = {},
  identity = null,
  journalDirectory,
  paths,
  record,
  uid,
}) {
  for (let pass = 0; pass < 12; pass += 1) {
    const state = await inspectMarkerMutationState(record, paths, uid, gid);
    if (record.action === 'delete') {
      if (state.candidate !== null) {
        throw new Error('delete marker mutation has an unexpected candidate');
      }
      if (state.quarantine === null && state.canonical !== null) {
        if (identity !== null) {
          throw new Error('deleted marker canonical was replaced after removal');
        }
        requireSnapshotMatch(
          state.canonical,
          record.expected,
          'global marker changed before CAS quarantine',
        );
        await hooks.beforeMarkerRename?.({
          candidate: null,
          canonical: record.canonical,
          quarantine: paths.quarantine,
        });
        const beforeLink = await readMarkerPathOptional(
          record.canonical,
          uid,
          gid,
          'global marker CAS source',
        );
        requireSnapshotMatch(
          beforeLink,
          record.expected,
          'global marker changed before CAS quarantine',
        );
        if (await lstatOptional(paths.quarantine) !== null) {
          throw new Error('global marker quarantine conflict');
        }
        await link(record.canonical, paths.quarantine);
        await syncDirectory(journalDirectory);
        const linkedCanonical = await readMarkerPathOptional(
          record.canonical,
          uid,
          gid,
          'linked marker CAS source',
        );
        const linkedQuarantine = await readMarkerPathOptional(
          paths.quarantine,
          uid,
          gid,
          'linked marker quarantine',
        );
        if (
          linkedCanonical?.identity.nlink !== 2
          || linkedQuarantine?.identity.nlink !== 2
          || linkedCanonical.identity.dev !== linkedQuarantine.identity.dev
          || linkedCanonical.identity.ino !== linkedQuarantine.identity.ino
          || !markerSnapshotMatches(
            linkedCanonical.snapshot,
            record.expected,
            false,
          )
        ) {
          throw new Error('global marker changed during CAS quarantine link');
        }
        await unlink(record.canonical);
        await syncMarkerDirectories(record.canonical, journalDirectory);
        await hooks.afterMarkerQuarantineSync?.({
          action: record.action,
          candidate: null,
          canonical: record.canonical,
          location: record.location,
          quarantine: paths.quarantine,
        });
        continue;
      }
      if (state.quarantine !== null) {
        requireSnapshotMatch(
          state.quarantine,
          record.expected,
          'global marker quarantine changed during deletion',
          false,
        );
        if (state.canonical !== null) {
          if (
            state.canonical.identity.dev === state.quarantine.identity.dev
            && state.canonical.identity.ino === state.quarantine.identity.ino
            && state.canonical.identity.nlink === 2
            && state.quarantine.identity.nlink === 2
          ) {
            await unlink(record.canonical);
            await syncMarkerDirectories(record.canonical, journalDirectory);
            await hooks.afterMarkerQuarantineSync?.({
              action: record.action,
              candidate: null,
              canonical: record.canonical,
              location: record.location,
              quarantine: paths.quarantine,
            });
            continue;
          }
          throw new Error('global marker canonical conflict during deletion');
        }
        if (identity === null) {
          identity = markerMutationIdentityRecord(
            record,
            markerBoundIdentity(state.quarantine.snapshot),
          );
          await writePrivateJson(paths.identity, identity, uid, gid);
        } else {
          if (!identityMatchesRecord(identity, record)) {
            throw new Error('marker mutation identity does not match deletion');
          }
          requireBoundMatch(
            state.quarantine,
            identity.bound,
            'global marker deletion quarantine identity mismatch',
          );
        }
        await hooks.beforeMarkerUnlink?.({
          candidate: null,
          canonical: record.canonical,
          quarantine: paths.quarantine,
        });
        if (await lstatOptional(record.canonical) !== null) {
          throw new Error('global marker canonical was replaced before removal');
        }
        const beforeUnlink = await readMarkerPathOptional(
          paths.quarantine,
          uid,
          gid,
          'global marker quarantine before removal',
        );
        requireBoundMatch(
          beforeUnlink,
          identity.bound,
          'global marker deletion quarantine changed before removal',
        );
        await unlink(paths.quarantine);
        await syncDirectory(journalDirectory);
        await hooks.afterMarkerQuarantineRemovalSync?.({
          action: record.action,
          candidate: null,
          canonical: record.canonical,
          location: record.location,
          quarantine: paths.quarantine,
        });
        continue;
      }
      if (state.canonical !== null) {
        throw new Error('deleted marker canonical was replaced after removal');
      }
      if (identity === null || !identityMatchesRecord(identity, record)) {
        throw new Error('marker deletion has no durable completion identity');
      }
      await finishMarkerMutationEvidence({
        gid,
        identity,
        journalDirectory,
        paths,
        record,
        uid,
      });
      return null;
    }

    const creating = record.action === 'create';
    if (identity === null) {
      if (state.quarantine !== null) {
        throw new Error('marker replacement quarantine has no bound candidate');
      }
      if (creating) {
        if (state.canonical !== null) {
          throw new Error('global marker canonical exists before creation');
        }
      } else {
        requireSnapshotMatch(
          state.canonical,
          record.expected,
          'global marker changed before candidate binding',
        );
      }
      if (state.candidate === null) {
        await writeGlobalMarkerCandidate({
          candidate: paths.candidate,
          content: record.target_content,
          gid,
          uid,
        });
      }
      const candidate = await readMarkerPathOptional(
        paths.candidate,
        uid,
        gid,
        'global marker candidate',
      );
      if (
        candidate === null
        || candidate.identity.nlink !== 1
        || candidate.snapshot.digest !== record.target_digest
        || candidate.snapshot.size !== record.target_size
      ) {
        throw new Error('global marker candidate content mismatch');
      }
      identity = markerMutationIdentityRecord(
        record,
        markerBoundIdentity(candidate.snapshot),
      );
      await writePrivateJson(paths.identity, identity, uid, gid);
      await hooks.afterMarkerCandidateSync?.({
        action: record.action,
        candidate: paths.candidate,
        canonical: record.canonical,
        location: record.location,
        quarantine: paths.quarantine,
      });
      continue;
    }
    if (!identityMatchesRecord(identity, record)) {
      throw new Error('marker mutation identity does not match operation record');
    }
    if (state.candidate === null) {
      if (state.quarantine !== null) {
        throw new Error('published marker lost its bound candidate too early');
      }
      requireBoundMatch(
        state.canonical,
        identity.bound,
        'published marker changed after candidate removal',
      );
      if (state.canonical.identity.nlink !== 1) {
        throw new Error('published marker has unsafe final link count');
      }
      await finishMarkerMutationEvidence({
        gid,
        identity,
        journalDirectory,
        paths,
        record,
        uid,
      });
      return state.canonical;
    }
    requireBoundMatch(
      state.candidate,
      identity.bound,
      'global marker candidate identity mismatch',
    );
    if (creating && state.quarantine !== null) {
      throw new Error('marker creation has an unexpected quarantine');
    }
    if (state.quarantine === null) {
      if (creating && state.canonical === null) {
        if (state.candidate.identity.nlink !== 1) {
          throw new Error('global marker candidate has unsafe creation links');
        }
        await hooks.beforeMarkerLink?.({
          candidate: paths.candidate,
          canonical: record.canonical,
          quarantine: null,
        });
        if (await lstatOptional(record.canonical) !== null) {
          throw new Error('global marker conflict: canonical exists before creation');
        }
        const candidateBeforeLink = await readMarkerPathOptional(
          paths.candidate,
          uid,
          gid,
          'global marker candidate before creation',
        );
        requireBoundMatch(
          candidateBeforeLink,
          identity.bound,
          'global marker candidate changed before creation',
        );
        try {
          await link(paths.candidate, record.canonical);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw new Error('global marker conflict: canonical exists before creation');
          }
          throw error;
        }
        await syncMarkerDirectories(record.canonical, journalDirectory);
        await hooks.afterMarkerCanonicalPublishSync?.({
          action: record.action,
          candidate: paths.candidate,
          canonical: record.canonical,
          location: record.location,
          quarantine: null,
        });
        await hooks.afterMarkerPublishBeforeCandidateUnlink?.({
          candidate: paths.candidate,
          canonical: record.canonical,
        });
        continue;
      }
      if (!creating && state.canonical !== null && markerSnapshotMatches(
        state.canonical.snapshot,
        record.expected,
      )) {
        if (state.candidate.identity.nlink !== 1) {
          throw new Error('global marker candidate has unsafe pre-publish links');
        }
        await hooks.beforeMarkerRename?.({
          candidate: paths.candidate,
          canonical: record.canonical,
          quarantine: paths.quarantine,
        });
        const beforeLink = await readMarkerPathOptional(
          record.canonical,
          uid,
          gid,
          'global marker CAS source',
        );
        requireSnapshotMatch(
          beforeLink,
          record.expected,
          'global marker changed before CAS quarantine',
        );
        if (await lstatOptional(paths.quarantine) !== null) {
          throw new Error('global marker quarantine conflict');
        }
        await link(record.canonical, paths.quarantine);
        await syncDirectory(journalDirectory);
        const linkedCanonical = await readMarkerPathOptional(
          record.canonical,
          uid,
          gid,
          'linked marker CAS source',
        );
        const linkedQuarantine = await readMarkerPathOptional(
          paths.quarantine,
          uid,
          gid,
          'linked marker quarantine',
        );
        if (
          linkedCanonical?.identity.nlink !== 2
          || linkedQuarantine?.identity.nlink !== 2
          || linkedCanonical.identity.dev !== linkedQuarantine.identity.dev
          || linkedCanonical.identity.ino !== linkedQuarantine.identity.ino
          || !markerSnapshotMatches(
            linkedCanonical.snapshot,
            record.expected,
            false,
          )
        ) {
          throw new Error('global marker changed during CAS quarantine link');
        }
        await unlink(record.canonical);
        await syncMarkerDirectories(record.canonical, journalDirectory);
        await hooks.afterMarkerQuarantineSync?.({
          action: record.action,
          candidate: paths.candidate,
          canonical: record.canonical,
          location: record.location,
          quarantine: paths.quarantine,
        });
        continue;
      }
      if (state.canonical !== null && markerBoundIdentityMatches(
        markerBoundIdentity(state.canonical.snapshot),
        identity.bound,
      )) {
        if (
          state.canonical.identity.dev !== state.candidate.identity.dev
          || state.canonical.identity.ino !== state.candidate.identity.ino
          || state.canonical.identity.nlink !== 2
          || state.candidate.identity.nlink !== 2
        ) {
          throw new Error('published marker candidate link mismatch');
        }
        await hooks.beforeMarkerUnlink?.({
          candidate: paths.candidate,
          canonical: record.canonical,
          quarantine: paths.quarantine,
        });
        const canonicalBeforeCandidateRemoval = await readMarkerPathOptional(
          record.canonical,
          uid,
          gid,
          'published global marker before candidate removal',
        );
        const candidateBeforeRemoval = await readMarkerPathOptional(
          paths.candidate,
          uid,
          gid,
          'global marker candidate before removal',
        );
        requireBoundMatch(
          canonicalBeforeCandidateRemoval,
          identity.bound,
          'published marker changed before candidate removal',
        );
        requireBoundMatch(
          candidateBeforeRemoval,
          identity.bound,
          'marker candidate changed before removal',
        );
        if (
          canonicalBeforeCandidateRemoval.identity.dev
            !== candidateBeforeRemoval.identity.dev
          || canonicalBeforeCandidateRemoval.identity.ino
            !== candidateBeforeRemoval.identity.ino
          || canonicalBeforeCandidateRemoval.identity.nlink !== 2
          || candidateBeforeRemoval.identity.nlink !== 2
        ) {
          throw new Error('marker candidate unlink inode mismatch');
        }
        await unlink(paths.candidate);
        await syncDirectory(journalDirectory);
        await hooks.afterMarkerCandidateRemovalSync?.({
          action: record.action,
          candidate: paths.candidate,
          canonical: record.canonical,
          location: record.location,
          quarantine: paths.quarantine,
        });
        continue;
      }
      throw new Error(
        creating
          ? 'global marker canonical conflict during creation'
          : 'global marker canonical conflict during replacement',
      );
    }
    requireSnapshotMatch(
      state.quarantine,
      record.expected,
      'global marker quarantine identity mismatch',
      false,
    );
    if (state.canonical !== null) {
      if (
        state.canonical.identity.dev === state.quarantine.identity.dev
        && state.canonical.identity.ino === state.quarantine.identity.ino
        && state.canonical.identity.nlink === 2
        && state.quarantine.identity.nlink === 2
      ) {
        await unlink(record.canonical);
        await syncMarkerDirectories(record.canonical, journalDirectory);
        await hooks.afterMarkerQuarantineSync?.({
          action: record.action,
          candidate: paths.candidate,
          canonical: record.canonical,
          location: record.location,
          quarantine: paths.quarantine,
        });
        continue;
      }
      requireBoundMatch(
        state.canonical,
        identity.bound,
        'published global marker identity mismatch',
      );
      if (
        state.canonical.identity.dev !== state.candidate.identity.dev
        || state.canonical.identity.ino !== state.candidate.identity.ino
        || state.canonical.identity.nlink !== 2
        || state.candidate.identity.nlink !== 2
      ) {
        throw new Error('global marker candidate publication mismatch');
      }
      await hooks.beforeMarkerUnlink?.({
        candidate: paths.candidate,
        canonical: record.canonical,
        quarantine: paths.quarantine,
      });
      const beforeUnlinkCanonical = await readMarkerPathOptional(
        record.canonical,
        uid,
        gid,
        'published global marker before quarantine removal',
      );
      const beforeUnlinkCandidate = await readMarkerPathOptional(
        paths.candidate,
        uid,
        gid,
        'global marker candidate before quarantine removal',
      );
      const beforeUnlinkQuarantine = await readMarkerPathOptional(
        paths.quarantine,
        uid,
        gid,
        'global marker quarantine before removal',
      );
      requireBoundMatch(
        beforeUnlinkCanonical,
        identity.bound,
        'published marker changed before quarantine removal',
      );
      requireBoundMatch(
        beforeUnlinkCandidate,
        identity.bound,
        'marker candidate changed before quarantine removal',
      );
      requireSnapshotMatch(
        beforeUnlinkQuarantine,
        record.expected,
        'marker quarantine changed before removal',
        false,
      );
      await unlink(paths.quarantine);
      await syncDirectory(journalDirectory);
      await hooks.afterMarkerQuarantineRemovalSync?.({
        action: record.action,
        candidate: paths.candidate,
        canonical: record.canonical,
        location: record.location,
        quarantine: paths.quarantine,
      });
      continue;
    }
    if (state.candidate.identity.nlink !== 1) {
      throw new Error('marker candidate has unsafe link count before publication');
    }
    await hooks.beforeMarkerLink?.({
      candidate: paths.candidate,
      canonical: record.canonical,
      quarantine: paths.quarantine,
    });
    if (await lstatOptional(record.canonical) !== null) {
      throw new Error('global marker conflict: canonical exists before publication');
    }
    const candidateBeforeLink = await readMarkerPathOptional(
      paths.candidate,
      uid,
      gid,
      'global marker candidate before publication',
    );
    requireBoundMatch(
      candidateBeforeLink,
      identity.bound,
      'global marker candidate changed before publication',
    );
    if (candidateBeforeLink.identity.nlink !== 1) {
      throw new Error('global marker candidate has unsafe publication links');
    }
    try {
      await link(paths.candidate, record.canonical);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('global marker conflict: canonical exists before publication');
      }
      throw error;
    }
    await syncMarkerDirectories(record.canonical, journalDirectory);
    await hooks.afterMarkerCanonicalPublishSync?.({
      action: record.action,
      candidate: paths.candidate,
      canonical: record.canonical,
      location: record.location,
      quarantine: paths.quarantine,
    });
  }
  throw new Error('marker mutation recovery did not converge');
}

async function recoverTerminalMarkerMutationIdentity({
  gid,
  identity,
  journalDirectory,
  paths,
  uid,
}) {
  const candidate = await lstatOptional(paths.candidate);
  const quarantine = await lstatOptional(paths.quarantine);
  if (candidate !== null || quarantine !== null) {
    throw new Error('terminal marker mutation identity has unexpected artifacts');
  }
  const canonical = await readMarkerPathOptional(
    identity.canonical,
    uid,
    gid,
    'terminal marker mutation canonical',
  );
  if (identity.action === 'create' || identity.action === 'replace') {
    requireBoundMatch(
      canonical,
      identity.bound,
      'terminal published marker identity mismatch',
    );
    if (canonical.identity.nlink !== 1) {
      throw new Error('terminal published marker has unsafe links');
    }
  } else if (canonical !== null) {
    throw new Error('terminal deleted marker canonical was replaced');
  }
  await unlink(paths.identity);
  await syncDirectory(journalDirectory);
}

async function recoverMarkerMutations({ gid, hooks = {}, journalDirectory, uid }) {
  const names = (await readdir(journalDirectory)).sort();
  const markerArtifacts = names.filter((name) => (
    name.startsWith('.marker-') || name.startsWith('.mutation-')
  ));
  if (markerArtifacts.length === 0) return;
  const classified = markerArtifacts.map((name) => {
    for (const [kind, expression] of [
      ['record', MARKER_MUTATION_RECORD_RE],
      ['identity', MARKER_MUTATION_IDENTITY_RE],
      ['candidate', MARKER_MUTATION_CANDIDATE_RE],
      ['quarantine', MARKER_MUTATION_QUARANTINE_RE],
    ]) {
      const match = expression.exec(name);
      if (match) return { id: match[1], kind, name };
    }
    throw new Error('global journal contains an unknown marker mutation artifact');
  });
  const operationIds = new Set(classified.map(({ id }) => id));
  if (operationIds.size !== 1) {
    throw new Error('global journal contains multiple marker mutations');
  }
  const [operationId] = operationIds;
  for (const kind of ['record', 'identity', 'candidate', 'quarantine']) {
    if (classified.filter((entry) => entry.kind === kind).length > 1) {
      throw new Error(`global journal contains multiple marker mutation ${kind} files`);
    }
  }
  const paths = markerMutationPaths(journalDirectory, operationId);
  const hasRecord = classified.some(({ kind }) => kind === 'record');
  const hasIdentity = classified.some(({ kind }) => kind === 'identity');
  let identity = null;
  if (hasIdentity) {
    identity = await readMarkerMutationIdentity(
      paths.identity,
      operationId,
      journalDirectory,
      uid,
      gid,
    );
  }
  if (!hasRecord) {
    if (identity === null || classified.length !== 1) {
      throw new Error('orphan marker mutation artifact has no operation record');
    }
    await recoverTerminalMarkerMutationIdentity({
      gid,
      identity,
      journalDirectory,
      paths,
      uid,
    });
    return;
  }
  const record = await readMarkerMutationRecord(
    paths.record,
    journalDirectory,
    uid,
    gid,
  );
  if (record.operation_id !== operationId) {
    throw new Error('marker mutation operation id mismatch');
  }
  if (identity !== null && !identityMatchesRecord(identity, record)) {
    throw new Error('marker mutation identity receipt mismatch');
  }
  await resumeMarkerMutation({
    gid,
    hooks,
    identity,
    journalDirectory,
    paths,
    record,
    uid,
  });
}

export async function recoverGlobalMarkerMutations({
  gid,
  hooks = {},
  journalDirectory,
  uid,
}) {
  await validateGlobalJournalDirectory(journalDirectory, uid, gid);
  await recoverMarkerMutations({ gid, hooks, journalDirectory, uid });
}

async function mutateGlobalJournalMarker({
  canonical,
  expectedFile,
  gid,
  hooks = {},
  journalDirectory,
  location = 'global',
  marker = null,
  phase,
  uid,
}) {
  if (location === 'global') {
    assertGlobalJournalLocation({
      canonical,
      gid,
      journalDirectory,
      phase,
      uid,
    });
  } else if (location === 'snapshot-cleanup') {
    assertSnapshotCleanupReceiptLocation({
      canonical,
      gid,
      journalDirectory,
      uid,
    });
  } else {
    throw new Error('invalid marker CAS location');
  }
  await validateGlobalJournalDirectory(journalDirectory, uid, gid);
  const operation = randomUUID();
  const paths = markerMutationPaths(journalDirectory, operation);
  const creating = expectedFile === null;
  if (creating && marker === null) {
    throw new Error('marker creation requires target content');
  }
  const expected = creating ? null : markerCasSnapshot(expectedFile);
  const targetContent = marker === null ? null : `${JSON.stringify(marker)}\n`;
  const record = {
    action: creating ? 'create' : marker === null ? 'delete' : 'replace',
    canonical,
    expected,
    location,
    operation_id: operation,
    phase,
    schema: 1,
    target_content: targetContent,
    target_digest: targetContent === null
      ? null
      : createHash('sha256').update(targetContent).digest('hex'),
    target_size: targetContent === null ? 0 : Buffer.byteLength(targetContent),
  };
  await writePrivateJson(paths.record, record, uid, gid);
  await hooks.afterMutationRecordSync?.({
    action: record.action,
    candidate: marker === null ? null : paths.candidate,
    canonical,
    location: record.location,
    quarantine: paths.quarantine,
    record: paths.record,
  });
  return resumeMarkerMutation({
    gid,
    hooks,
    journalDirectory,
    paths,
    record,
    uid,
  });
}

async function replacePreparingMarker({
  expectedFile,
  gid,
  hooks = {},
  journalDirectory,
  marker,
  preparingJournal,
  uid,
}) {
  return mutateGlobalJournalMarker({
    canonical: preparingJournal,
    expectedFile,
    gid,
    hooks,
    journalDirectory,
    marker,
    phase: 'preparing',
    uid,
  });
}

export async function recordPreparingRecoveryStep({
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  preparingJournal,
  releases,
  state,
  step,
  uid,
}) {
  if (
    !PREPARING_RECOVERY_STEPS.has(step)
    || (state !== 'attempted' && state !== 'completed')
  ) {
    throw new Error('invalid preparing recovery step');
  }
  const preparing = await readPreparingDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  const current = preparing.marker.recovery[step];
  if (current === 'completed') return 'completed';
  if (state === 'attempted') {
    if (current === 'attempted') {
      throw new Error(`ambiguous preparing recovery step: ${step}`);
    }
  } else if (current !== 'attempted') {
    throw new Error(`preparing recovery step was not attempted: ${step}`);
  }
  preparing.marker.recovery[step] = state;
  await replacePreparingMarker({
    expectedFile: preparing.markerFile,
    gid,
    hooks,
    journalDirectory,
    marker: preparing.marker,
    preparingJournal,
    uid,
  });
  return state;
}

function receiptHeaderDigest(bytes) {
  const newline = bytes.indexOf(0x0a);
  const end = newline === -1 ? bytes.length : newline + 1;
  return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
}

export async function armPreparingTransaction({
  gid,
  journalDirectory,
  name,
  preparingJournal,
  uid,
}) {
  await recoverGlobalJournalCandidate({
    canonical: preparingJournal,
    gid,
    journalDirectory,
    phase: 'preparing',
    uid,
  });
  const markerFile = await readSecureRegular(
    preparingJournal,
    uid,
    gid,
    0o600,
    'global preparing marker',
  );
  const marker = JSON.parse(markerFile.bytes.toString('utf8'));
  if (marker.schema !== 2 || marker.phase !== 'preparing') {
    throw new Error('invalid global preparing marker');
  }
  const entry = marker.transactions?.find((transaction) => transaction.name === name);
  if (!entry || entry.state !== 'planned') {
    throw new Error('global preparing transaction is not planned');
  }
  const transactionIdentity = await lstat(entry.transaction);
  if (
    !transactionIdentity.isDirectory()
    || transactionIdentity.isSymbolicLink()
    || transactionIdentity.uid !== uid
    || transactionIdentity.gid !== gid
    || (transactionIdentity.mode & 0o7777) !== 0o700
  ) {
    throw new Error('global preparing transaction directory is unsafe');
  }
  const names = pathTransactionNames(entry.destination, entry.name, marker.manifest);
  if (
    names.transactionDirectory !== entry.transaction
    || names.receipt !== entry.receipt
  ) {
    throw new Error('global preparing transaction path mismatch');
  }
  const receipt = await readSecureRegular(
    entry.receipt,
    uid,
    gid,
    0o600,
    'global preparing receipt',
  );
  const parsed = parseReceipt(names, receipt.bytes.toString('utf8'));
  if (
    parsed.events.length !== 0
    || parsed.header.type !== entry.type
    || !optionalIdentityMatches(parsed.header.expected, entry.expected)
  ) {
    throw new Error('global preparing receipt does not match the plan');
  }
  entry.candidate = parsed.header.candidate;
  entry.receipt_header_digest = receiptHeaderDigest(receipt.bytes);
  entry.receipt_identity = numericIdentity(receipt.identity);
  entry.state = 'armed';
  entry.transaction_identity = numericIdentity(transactionIdentity);
  await replacePreparingMarker({
    expectedFile: markerFile,
    gid,
    journalDirectory,
    marker,
    preparingJournal,
    uid,
  });
  return entry;
}

async function findOrphanTransactions(destinations) {
  const found = [];
  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    const name = GLOBAL_TRANSACTION_NAMES[index];
    const pattern = new RegExp(
      `^\\.aifeeds-deploy\\.([0-9a-f]{64})\\.${name}$`,
    );
    let entries;
    try {
      entries = await readdir(path.dirname(destination));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (pattern.test(entry)) {
        found.push(path.join(path.dirname(destination), entry));
      }
    }
  }
  return found;
}

function validPlannedIdentity(identity, type) {
  if (identity === null) return true;
  if (identity?.type !== type) return false;
  if (
    !Number.isSafeInteger(identity.dev)
    || !Number.isSafeInteger(identity.ino)
    || !Number.isSafeInteger(identity.uid)
    || !Number.isSafeInteger(identity.gid)
    || typeof identity.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(identity.digest)
  ) {
    return false;
  }
  if (type === 'symlink') return typeof identity.target === 'string';
  return (
    Number.isSafeInteger(identity.size)
    && Number.isSafeInteger(identity.mode)
  );
}

async function readPreparingDeployment({
  committedJournal,
  destinations,
  gid,
  journalDirectory,
  preparingJournal,
  releases,
  uid,
}) {
  if (
    !path.isAbsolute(releases)
    || path.dirname(committedJournal) !== releases
    || path.basename(committedJournal) !== '.deployment-committed.json'
    || path.dirname(preparingJournal) !== releases
    || path.basename(preparingJournal) !== '.deployment-preparing.json'
    || path.dirname(journalDirectory) !== releases
    || path.basename(journalDirectory) !== '.deployment-journal'
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid preparing deployment recovery arguments');
  }
  await recoverGlobalJournalCandidate({
    canonical: preparingJournal,
    gid,
    journalDirectory,
    phase: 'preparing',
    uid,
  });
  const markerFile = await readSecureRegular(
    preparingJournal,
    uid,
    gid,
    0o600,
    'global preparing marker',
  );
  const marker = JSON.parse(markerFile.bytes.toString('utf8'));
  if (
    marker.schema !== 2
    || marker.phase !== 'preparing'
    || !DEPLOYMENT_ID_RE.test(marker.deployment_id ?? '')
    || !/^[0-9a-f]{64}$/.test(marker.manifest ?? '')
    || marker.release !== path.join(releases, marker.manifest)
    || !path.isAbsolute(marker.nginx_transaction ?? '')
    || /[\u0000-\u001f\u007f]/.test(marker.nginx_transaction)
    || !validPreparingRuntime(marker.runtime)
    || !validPreparingRecovery(marker.recovery)
    || !validPreparingSnapshot(
      marker.snapshot,
      marker.nginx_transaction,
      journalDirectory,
    )
    || !Array.isArray(marker.transactions)
    || marker.transactions.length !== GLOBAL_TRANSACTION_NAMES.length
  ) {
    throw new Error('invalid global preparing marker');
  }
  await validatePreparingSnapshot(marker.snapshot);
  const cleanupReceipts = (await readdir(journalDirectory))
    .filter((name) => SNAPSHOT_CLEANUP_RECEIPT_RE.test(name));
  if (marker.snapshot.cleanup === null) {
    if (cleanupReceipts.length !== 0) {
      throw new Error('unexpected snapshot cleanup receipt');
    }
  } else {
    const expectedReceipt = path.basename(marker.snapshot.cleanup.receipt);
    if (
      cleanupReceipts.length > 1
      || cleanupReceipts.some((name) => name !== expectedReceipt)
    ) {
      throw new Error('snapshot cleanup receipt does not match the marker');
    }
    if (cleanupReceipts.length === 1) {
      const receipt = await readSecureRegular(
        marker.snapshot.cleanup.receipt,
        uid,
        gid,
        0o600,
        'snapshot cleanup receipt',
      );
      if (!snapshotCleanupReceiptMatches(
        JSON.parse(receipt.bytes.toString('utf8')),
        marker.snapshot,
      )) {
        throw new Error('snapshot cleanup receipt mismatch');
      }
    }
  }
  assertGlobalPaths({
    journal: committedJournal,
    manifest: marker.manifest,
    release: marker.release,
  });
  const specs = globalTransactionSpecs(destinations, marker.manifest);
  for (let index = 0; index < specs.length; index += 1) {
    const entry = marker.transactions[index];
    const type = specs[index].name === 'opt' ? 'symlink' : 'file';
    if (
      entry?.name !== specs[index].name
      || entry.destination !== specs[index].names.destination
      || entry.transaction !== specs[index].names.transactionDirectory
      || entry.receipt !== specs[index].names.receipt
      || entry.type !== type
      || (entry.state !== 'planned' && entry.state !== 'armed')
      || !validPlannedIdentity(entry.expected, type)
      || (
        entry.state === 'armed'
        && (
          !validPlannedIdentity(entry.candidate, type)
          || !/^[0-9a-f]{64}$/.test(entry.receipt_header_digest ?? '')
          || !Number.isSafeInteger(entry.receipt_identity?.dev)
          || !Number.isSafeInteger(entry.receipt_identity?.ino)
          || !Number.isSafeInteger(entry.transaction_identity?.dev)
          || !Number.isSafeInteger(entry.transaction_identity?.ino)
        )
      )
    ) {
      throw new Error('invalid global preparing transaction');
    }
  }
  return {
    digest: createHash('sha256').update(markerFile.bytes).digest('hex'),
    marker,
    markerFile,
    markerIdentity: markerFile.identity,
    specs,
  };
}

async function inspectPreparingTransaction({
  entry,
  gid,
  spec,
  uid,
}) {
  const transactionIdentity = await lstatOptional(spec.names.transactionDirectory);
  if (transactionIdentity === null) {
    if (entry.state === 'armed') {
      throw new Error('armed preparing transaction directory is missing');
    }
    const live = await inspectOptional(
      spec.names.destination,
      entry.type,
      'preparing live object',
    );
    if (!optionalIdentityMatches(live, entry.expected)) {
      throw new Error('planned preparing live object changed');
    }
    return { absent: true, live };
  }
  if (
    !transactionIdentity.isDirectory()
    || transactionIdentity.isSymbolicLink()
    || transactionIdentity.uid !== uid
    || transactionIdentity.gid !== gid
    || (transactionIdentity.mode & 0o7777) !== 0o700
    || (
      entry.state === 'armed'
      && !recordedIdentityMatches(
        transactionIdentity,
        entry.transaction_identity,
      )
    )
  ) {
    throw new Error('global preparing transaction directory is unsafe');
  }
  const allowed = new Set(['candidate', 'current', 'old', 'receipt.jsonl']);
  if ((await readdir(spec.names.transactionDirectory)).some((name) => !allowed.has(name))) {
    throw new Error('global preparing transaction has an unexpected artifact');
  }
  const receiptIdentity = await lstatOptional(spec.names.receipt);
  let parsed = null;
  if (receiptIdentity !== null) {
    const receipt = await readSecureRegular(
      spec.names.receipt,
      uid,
      gid,
      0o600,
      'global preparing receipt',
    );
    parsed = parseReceipt(spec.names, receipt.bytes.toString('utf8'));
    if (
      parsed.header.type !== entry.type
      || !optionalIdentityMatches(parsed.header.expected, entry.expected)
      || parsed.events.some(({ phase }) => (
        phase !== 'old-moved' && phase !== 'candidate-published'
      ))
      || (
        entry.state === 'planned'
        && parsed.events.length !== 0
      )
      || (
        entry.state === 'armed'
        && (
          !identityMatches(parsed.header.candidate, entry.candidate)
          || receiptHeaderDigest(receipt.bytes) !== entry.receipt_header_digest
          || !recordedIdentityMatches(
            receipt.identity,
            entry.receipt_identity,
          )
        )
      )
    ) {
      throw new Error('global preparing marker and receipt mismatch');
    }
  } else if (entry.state === 'armed') {
    const live = await inspectOptional(
      spec.names.destination,
      entry.type,
      'partially cleaned preparing live object',
    );
    if (!optionalIdentityMatches(live, entry.expected)) {
      throw new Error('armed preparing receipt is missing before rollback');
    }
  }
  return { absent: false, parsed, transactionIdentity };
}

async function validatePreparingArtifact(file, expected, type, label) {
  const present = await lstatOptional(file);
  if (present === null) return;
  const actual = await inspectOptional(file, type, label);
  if (!identityMatches(actual, expected)) {
    throw new Error(`global preparing ${label} identity mismatch`);
  }
}

async function cleanRolledBackPreparingTransaction({ entry, spec }) {
  await validatePreparingArtifact(
    spec.names.candidate,
    entry.candidate,
    entry.type,
    'candidate artifact',
  );
  await validatePreparingArtifact(
    spec.names.current,
    entry.candidate,
    entry.type,
    'current artifact',
  );
  if (entry.expected === null) {
    if (await lstatOptional(spec.names.old) !== null) {
      throw new Error('global preparing rollback has an unexpected old artifact');
    }
  } else {
    await validatePreparingArtifact(
      spec.names.old,
      entry.expected,
      entry.type,
      'old artifact',
    );
  }
  await cleanupTransaction(spec.names);
}

async function rollbackPreparingDeployment(preparing, uid, gid) {
  for (let index = 0; index < preparing.specs.length; index += 1) {
    const spec = preparing.specs[index];
    const entry = preparing.marker.transactions[index];
    const inspected = await inspectPreparingTransaction({
      entry,
      gid,
      spec,
      uid,
    });
    if (inspected.absent) continue;
    const live = await inspectOptional(
      spec.names.destination,
      entry.type,
      'preparing rollback live object',
    );
    if (optionalIdentityMatches(live, entry.expected)) {
      if (entry.state === 'planned') {
        if (inspected.parsed !== null) {
          await validatePreparingArtifact(
            spec.names.candidate,
            inspected.parsed.header.candidate,
            entry.type,
            'planned candidate artifact',
          );
        }
        await cleanupTransaction(spec.names);
      } else {
        await cleanRolledBackPreparingTransaction({ entry, spec });
      }
      continue;
    }
    if (entry.state !== 'armed' || inspected.parsed === null) {
      throw new Error('unarmed preparing transaction changed its live object');
    }
    await rollbackPathTransaction({
      destination: spec.names.destination,
      name: spec.name,
      transaction: preparing.marker.manifest,
    });
    const restored = await inspectOptional(
      spec.names.destination,
      entry.type,
      'restored preparing live object',
    );
    if (!optionalIdentityMatches(restored, entry.expected)) {
      throw new Error('preparing rollback did not restore the expected object');
    }
  }
}

export async function rollbackPreparingPaths({
  committedJournal,
  destinations,
  gid,
  journalDirectory,
  preparingJournal,
  releases,
  uid,
}) {
  if (await lstatOptional(committedJournal) !== null) {
    throw new Error('cannot roll back preparing paths with a committed marker');
  }
  const preparing = await readPreparingDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  for (const required of [
    'candidate_timer_stop',
    'candidate_timer_disable',
    'candidate_service_stop',
  ]) {
    if (preparing.marker.recovery[required] !== 'completed') {
      throw new Error(`preparing recovery unit step is incomplete: ${required}`);
    }
  }
  await rollbackPreparingDeployment(preparing, uid, gid);
  return 'rolled-back';
}

async function recoverOrphanSnapshotCleanup({
  gid,
  journalDirectory,
  uid,
}) {
  const entries = await readdir(journalDirectory);
  const receipts = entries.filter((name) => SNAPSHOT_CLEANUP_RECEIPT_RE.test(name));
  if (receipts.length === 0) return;
  if (entries.some((name) => !SNAPSHOT_CLEANUP_RECEIPT_RE.test(name))) {
    throw new Error('snapshot cleanup receipt coexists with another journal artifact');
  }
  for (const name of receipts) {
    const receiptPath = path.join(journalDirectory, name);
    const receiptFile = await readSecureRegular(
      receiptPath,
      uid,
      gid,
      0o600,
      'orphan snapshot cleanup receipt',
    );
    const receipt = JSON.parse(receiptFile.bytes.toString('utf8'));
    const snapshot = {
      ...receipt.identity,
      cleanup: {
        deployment_id: receipt.deployment_id,
        quarantine: receipt.quarantine,
        receipt: receiptPath,
        state: 'planned',
      },
      parent: path.dirname(receipt.canonical ?? ''),
      path: receipt.canonical,
    };
    const phase = snapshotCleanupReceiptPhase(receipt, snapshot);
    const quarantine = await lstatOptional(snapshot.cleanup.quarantine);
    if (
      !DEPLOYMENT_ID_RE.test(receipt.deployment_id ?? '')
      || !validPreparingSnapshot(
        snapshot,
        path.join(snapshot.path, '.rollback', 'nginx'),
        journalDirectory,
      )
      || phase === null
      || await lstatOptional(snapshot.path) !== null
      || (
        phase !== 'deleted'
        && !snapshotIdentityMatches(quarantine, snapshot)
      )
      || (
        phase === 'deleted'
        && quarantine !== null
        && !snapshotIdentityMatches(quarantine, snapshot)
      )
    ) {
      throw new Error('orphan snapshot cleanup receipt is unsafe');
    }
    await finishSnapshotCleanup(snapshot, uid, gid);
  }
}

export async function recoverGlobalDeployment({
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  preparingJournal,
  releases,
  uid,
}) {
  if (
    path.dirname(committedJournal) !== releases
    || path.dirname(preparingJournal) !== releases
    || path.dirname(journalDirectory) !== releases
  ) {
    throw new Error('invalid global deployment recovery paths');
  }
  if (await lstatOptional(journalDirectory) !== null) {
    await validateGlobalJournalDirectory(journalDirectory, uid, gid);
    await recoverMarkerMutations({ gid, hooks, journalDirectory, uid });
  }
  const preparing = await lstatOptional(preparingJournal);
  const committed = await lstatOptional(committedJournal);
  if (
    preparing === null
    && await lstatOptional(journalDirectory) !== null
  ) {
    await validateGlobalJournalDirectory(journalDirectory, uid, gid);
    await recoverOrphanSnapshotCleanup({ gid, journalDirectory, uid });
  }
  if (committed !== null) {
    const verifiedCommitted = await readGlobalDeployment({
      committedJournal,
      destinations,
      gid,
      journalDirectory,
      releases,
      uid,
    });
    if (preparing !== null) {
      const verifiedPreparing = await readPreparingDeployment({
        committedJournal,
        destinations,
        gid,
        journalDirectory,
        preparingJournal,
        releases,
        uid,
      });
      const cleanupPreparingDigest =
        verifiedPreparing.marker.snapshot.cleanup?.preparing_digest;
      if (
        verifiedCommitted.marker.schema !== 2
        || verifiedCommitted.marker.deployment_id
          !== verifiedPreparing.marker.deployment_id
        || (
          verifiedCommitted.marker.preparing_digest !== verifiedPreparing.digest
          && verifiedCommitted.marker.preparing_digest !== cleanupPreparingDigest
        )
        || verifiedCommitted.marker.manifest !== verifiedPreparing.marker.manifest
        || verifiedCommitted.marker.release !== verifiedPreparing.marker.release
      ) {
        throw new Error('committed and preparing deployment markers mismatch');
      }
      await finishPreparingDeploymentCleanup({
        committedJournal,
        committedPreparingDigest: verifiedCommitted.marker.preparing_digest,
        destinations,
        gid,
        hooks,
        journalDirectory,
        preparing: verifiedPreparing,
        preparingJournal,
        releases,
        uid,
      });
    }
    await recoverCommittedDeployment({
      committedJournal,
      destinations,
      gid,
      journalDirectory,
      releases,
      uid,
    });
    return { phase: 'committed' };
  }
  if (preparing !== null) {
    const verifiedPreparing = await readPreparingDeployment({
      committedJournal,
      destinations,
      gid,
      journalDirectory,
      preparingJournal,
      releases,
      uid,
    });
    const ambiguous = Object.entries(verifiedPreparing.marker.recovery)
      .find(([, state]) => state === 'attempted');
    if (ambiguous) {
      throw new Error(`ambiguous preparing recovery step: ${ambiguous[0]}`);
    }
    return {
      manifest: verifiedPreparing.marker.manifest,
      nginx_transaction: verifiedPreparing.marker.nginx_transaction,
      phase: 'preparing',
      runtime: verifiedPreparing.marker.runtime,
    };
  }
  if (await lstatOptional(journalDirectory) !== null) {
    await validateGlobalJournalDirectory(journalDirectory, uid, gid);
    const entries = await readdir(journalDirectory);
    if (entries.length > 0) {
      throw new Error('global journal candidate has no canonical journal');
    }
  }
  const orphans = await findOrphanTransactions(destinations);
  if (orphans.length > 0) {
    throw new Error(`orphan deployment transaction has no valid journal: ${orphans[0]}`);
  }
  return { phase: 'none' };
}

async function finishPreparingDeploymentCleanup({
  committedJournal,
  committedPreparingDigest = null,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  preparing,
  preparingJournal,
  releases,
  uid,
}) {
  for (let index = 0; index < preparing.specs.length; index += 1) {
    const spec = preparing.specs[index];
    const entry = preparing.marker.transactions[index];
    if (
      committedPreparingDigest === null
      && await lstatOptional(spec.names.transactionDirectory) !== null
    ) {
      throw new Error('preparing rollback transaction remains incomplete');
    }
    if (committedPreparingDigest !== null && entry.state !== 'armed') {
      throw new Error('committed preparing cleanup requires armed transactions');
    }
    const live = await inspectOptional(
      spec.names.destination,
      entry.type,
      committedPreparingDigest === null
        ? 'completed preparing rollback live object'
        : 'committed preparing cleanup live object',
    );
    const expectedLive = committedPreparingDigest === null
      ? entry.expected
      : entry.candidate;
    if (!optionalIdentityMatches(live, expectedLive)) {
      throw new Error('preparing cleanup live object mismatch');
    }
  }
  let cleanupPreparing = preparing;
  if (cleanupPreparing.marker.snapshot.cleanup === null) {
    const deploymentId = cleanupPreparing.marker.deployment_id;
    cleanupPreparing.marker.snapshot.cleanup = {
      deployment_id: deploymentId,
      quarantine: path.join(
        cleanupPreparing.marker.snapshot.parent,
        `${path.basename(cleanupPreparing.marker.snapshot.path)}.cleanup.${deploymentId}`,
      ),
      receipt: path.join(
        journalDirectory,
        `.snapshot-cleanup.${deploymentId}.json`,
      ),
      state: 'planned',
    };
    if (committedPreparingDigest !== null) {
      cleanupPreparing.marker.snapshot.cleanup.preparing_digest =
        committedPreparingDigest;
    }
    await replacePreparingMarker({
      expectedFile: cleanupPreparing.markerFile,
      gid,
      journalDirectory,
      marker: cleanupPreparing.marker,
      preparingJournal,
      uid,
    });
    cleanupPreparing = await readPreparingDeployment({
      committedJournal,
      destinations,
      gid,
      journalDirectory,
      preparingJournal,
      releases,
      uid,
    });
  }
  if (
    (
      committedPreparingDigest === null
      && cleanupPreparing.marker.snapshot.cleanup.preparing_digest !== undefined
    )
    || (
      committedPreparingDigest !== null
      && cleanupPreparing.marker.snapshot.cleanup.preparing_digest
        !== committedPreparingDigest
    )
  ) {
    throw new Error('snapshot cleanup preparing digest mismatch');
  }
  await ensureSnapshotCleanupReceipt(
    cleanupPreparing.marker.snapshot,
    uid,
    gid,
    hooks,
  );
  await removeBoundSnapshot(cleanupPreparing.marker.snapshot);
  await removeGlobalJournal({
    expectedFile: cleanupPreparing.markerFile,
    gid,
    hooks,
    journal: preparingJournal,
    journalDirectory,
    phase: 'preparing',
    uid,
  });
  await hooks.afterMarkerRemovalBeforeSnapshotDelete?.({
    receipt: cleanupPreparing.marker.snapshot.cleanup.receipt,
    snapshot: cleanupPreparing.marker.snapshot,
  });
  await finishSnapshotCleanup(
    cleanupPreparing.marker.snapshot,
    uid,
    gid,
    hooks,
  );
  return 'cleared';
}

export async function completePreparingDeployment({
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  preparingJournal,
  releases,
  uid,
}) {
  if (await lstatOptional(committedJournal) !== null) {
    throw new Error('cannot complete preparing rollback with a committed marker');
  }
  const preparing = await readPreparingDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  return finishPreparingDeploymentCleanup({
    committedJournal,
    destinations,
    gid,
    hooks,
    journalDirectory,
    preparing,
    preparingJournal,
    releases,
    uid,
  });
}

export async function abortUnmodifiedPreparingDeployment({
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  preparingJournal,
  releases,
  uid,
}) {
  if (await lstatOptional(committedJournal) !== null) {
    throw new Error('cannot abort preparing deployment with a committed marker');
  }
  const preparing = await readPreparingDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  if (
    Object.keys(preparing.marker.recovery).length !== 0
    || preparing.marker.transactions.some(({ state }) => state !== 'planned')
    || await lstatOptional(preparing.marker.nginx_transaction) !== null
  ) {
    throw new Error('preparing deployment is not unmodified');
  }
  return finishPreparingDeploymentCleanup({
    committedJournal,
    destinations,
    gid,
    hooks,
    journalDirectory,
    preparing,
    preparingJournal,
    releases,
    uid,
  });
}

async function readSecureRegular(file, uid, gid, mode, label, nlink = 1) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== nlink
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
    || parsed.events.some(({ phase }) => (
      phase !== 'old-moved' && phase !== 'candidate-published'
    ))
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
    receiptHeaderDigest: receiptHeaderDigest(receipt.bytes),
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
  committedJournal,
  destinations,
  gid,
  hooks = {},
  journalDirectory,
  manifest,
  preparingJournal,
  release,
  releases,
  uid,
}) {
  assertGlobalPaths({ journal: committedJournal, manifest, release });
  if (
    path.dirname(preparingJournal) !== releases
    || path.basename(preparingJournal) !== '.deployment-preparing.json'
    || path.dirname(committedJournal) !== releases
    || path.dirname(journalDirectory) !== releases
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
    || await lstatOptional(committedJournal) !== null
  ) {
    throw new Error('invalid global deployment commit arguments');
  }
  const verifiedPreparing = await readPreparingDeployment({
    committedJournal,
    destinations,
    gid,
    journalDirectory,
    preparingJournal,
    releases,
    uid,
  });
  const preparing = verifiedPreparing.marker;
  if (
    preparing.manifest !== manifest
    || preparing.release !== release
  ) {
    throw new Error('invalid global preparing marker at commit');
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
  for (let index = 0; index < specs.length; index += 1) {
    const planned = preparing.transactions[index];
    if (
      planned?.name !== specs[index].name
      || planned.state !== 'armed'
      || planned.destination !== specs[index].names.destination
      || planned.transaction !== specs[index].names.transactionDirectory
      || planned.receipt !== specs[index].names.receipt
    ) {
      throw new Error('global commit requires four armed preparing transactions');
    }
    const snapshot = await inspectCommittedTransaction({
      gid,
      spec: specs[index],
      transaction: manifest,
      uid,
    });
    if (snapshot.finalized || snapshot.receiptMissing) {
      throw new Error('global deployment commit requires all four receipts');
    }
    if (
      !identityMatches(snapshot.candidate, planned.candidate)
      || snapshot.receiptHeaderDigest !== planned.receipt_header_digest
      || !recordedIdentityMatches(
        snapshot.receiptIdentity,
        planned.receipt_identity,
      )
      || !recordedIdentityMatches(
        snapshot.transactionIdentity,
        planned.transaction_identity,
      )
    ) {
      throw new Error('global commit receipt does not match the preparing marker');
    }
    snapshots.push(snapshot);
  }
  const marker = {
    deployment_id: preparing.deployment_id,
    manifest,
    phase: 'committed',
    preparing_digest: verifiedPreparing.digest,
    release,
    schema: 2,
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
  await publishGlobalJournalMarker({
    canonical: committedJournal,
    gid,
    hooks,
    journalDirectory,
    marker,
    phase: 'committed',
    uid,
  });
  await hooks.afterCommittedPublishBeforePreparingCleanup?.({
    committedJournal,
    preparingJournal,
  });
  await finishPreparingDeploymentCleanup({
    committedJournal,
    committedPreparingDigest: verifiedPreparing.digest,
    destinations,
    gid,
    hooks,
    journalDirectory,
    preparing: verifiedPreparing,
    preparingJournal,
    releases,
    uid,
  });
  return marker;
}

async function readGlobalDeployment({
  committedJournal,
  destinations,
  gid,
  journalDirectory,
  releases,
  uid,
}) {
  if (
    !path.isAbsolute(releases)
    || path.dirname(committedJournal) !== releases
    || path.dirname(journalDirectory) !== releases
    || !Number.isInteger(uid)
    || uid < 0
    || !Number.isInteger(gid)
    || gid < 0
  ) {
    throw new Error('invalid committed deployment recovery arguments');
  }
  if (await lstatOptional(journalDirectory) !== null) {
    await recoverGlobalJournalCandidate({
      canonical: committedJournal,
      gid,
      journalDirectory,
      phase: 'committed',
      uid,
    });
  } else {
    const legacy = await validateGlobalJournalFile(
      committedJournal,
      uid,
      gid,
      'global deployment marker',
    );
    if (legacy.nlink !== 1) {
      throw new Error('legacy global deployment marker has unsafe links');
    }
  }
  const markerFile = await readSecureRegular(
    committedJournal,
    uid,
    gid,
    0o600,
    'global deployment marker',
  );
  const marker = JSON.parse(markerFile.bytes.toString('utf8'));
  if (
    (marker.schema !== 1 && marker.schema !== 2)
    || (marker.schema === 2 && marker.phase !== 'committed')
    || (marker.schema === 2 && !DEPLOYMENT_ID_RE.test(marker.deployment_id ?? ''))
    || (
      marker.schema === 2
      && !/^[0-9a-f]{64}$/.test(marker.preparing_digest ?? '')
    )
    || !/^[0-9a-f]{64}$/.test(marker.manifest)
    || marker.release !== path.join(releases, marker.manifest)
    || !Array.isArray(marker.transactions)
    || marker.transactions.length !== GLOBAL_TRANSACTION_NAMES.length
  ) {
    throw new Error('invalid global deployment marker');
  }
  assertGlobalPaths({
    journal: committedJournal,
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
  return {
    marker,
    markerFile,
    markerIdentity: markerFile.identity,
    snapshots,
  };
}

async function removeGlobalJournal({
  expectedFile,
  gid,
  hooks = {},
  journal,
  journalDirectory,
  phase,
  uid,
}) {
  await mutateGlobalJournalMarker({
    canonical: journal,
    expectedFile,
    gid,
    hooks,
    journalDirectory,
    marker: null,
    phase,
    uid,
  });
}

export async function recoverCommittedDeployment(options) {
  const { committedJournal } = options;
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
  await removeGlobalJournal({
    expectedFile: verified.markerFile,
    gid: options.gid,
    journal: committedJournal,
    journalDirectory: options.journalDirectory,
    phase: 'committed',
    uid: options.uid,
  });
}

export async function clearCommittedDeployment(options) {
  const committed = await readGlobalDeployment(options);
  if (committed.snapshots.some(({ finalized }) => !finalized)) return 'pending';
  await removeGlobalJournal({
    expectedFile: committed.markerFile,
    gid: options.gid,
    hooks: options.hooks,
    journal: options.committedJournal,
    journalDirectory: options.journalDirectory,
    phase: 'committed',
    uid: options.uid,
  });
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
    } else if (
      command === 'install-transaction'
      && (args.length === 8 || args.length === 10)
    ) {
      await installFileTransaction({
        source: args[0],
        destination: args[1],
        mode: Number.parseInt(args[2], 8),
        uid: Number(args[3]),
        gid: Number(args[4]),
        backups: args[5],
        name: args[6],
        transaction: args[7],
        hooks: args.length === 10 ? {
          afterReceiptPrepared: async () => armPreparingTransaction({
            gid: Number(args[4]),
            journalDirectory: args[9],
            name: args[6],
            preparingJournal: args[8],
            uid: Number(args[3]),
          }),
        } : {},
      });
    } else if (command === 'recover-file' && args.length === 3) {
      await recoverFileTransaction({
        destination: args[0],
        name: args[1],
        transaction: args[2],
      });
    } else if (
      command === 'install-symlink-transaction'
      && (args.length === 4 || args.length === 8)
    ) {
      await installSymlinkTransaction({
        destination: args[0],
        target: args[1],
        name: args[2],
        transaction: args[3],
        hooks: args.length === 8 ? {
          afterReceiptPrepared: async () => armPreparingTransaction({
            gid: Number(args[7]),
            journalDirectory: args[5],
            name: args[2],
            preparingJournal: args[4],
            uid: Number(args[6]),
          }),
        } : {},
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
    } else if (command === 'prepare-global' && args.length === 16) {
      await prepareGlobalDeployment({
        preparingJournal: args[0],
        committedJournal: args[1],
        journalDirectory: args[2],
        releases: args[3],
        release: args[4],
        manifest: args[5],
        nginxTransaction: args[6],
        uid: Number(args[7]),
        gid: Number(args[8]),
        destinations: args.slice(9, 13),
        runtime: {
          service_active: args[13],
          timer_active: args[14],
          timer_enabled: args[15],
        },
      });
    } else if (command === 'commit-global' && args.length === 12) {
      await commitGlobalDeployment({
        preparingJournal: args[0],
        committedJournal: args[1],
        journalDirectory: args[2],
        releases: args[3],
        release: args[4],
        manifest: args[5],
        uid: Number(args[6]),
        gid: Number(args[7]),
        destinations: args.slice(8),
      });
    } else if (
      (
        command === 'recover-global'
        || command === 'rollback-preparing'
        || command === 'complete-preparing'
        || command === 'abort-unmodified-preparing'
      )
      && args.length === 10
    ) {
      const options = {
        preparingJournal: args[0],
        committedJournal: args[1],
        journalDirectory: args[2],
        releases: args[3],
        uid: Number(args[4]),
        gid: Number(args[5]),
        destinations: args.slice(6),
      };
      if (command === 'recover-global') {
        const recovered = await recoverGlobalDeployment(options);
        if (recovered.phase === 'preparing') {
          process.stdout.write([
            recovered.phase,
            recovered.manifest,
            recovered.nginx_transaction,
            recovered.runtime.service_active,
            recovered.runtime.timer_active,
            recovered.runtime.timer_enabled,
          ].join('\t') + '\n');
        } else {
          process.stdout.write(`${recovered.phase}\n`);
        }
      } else if (command === 'rollback-preparing') {
        process.stdout.write(`${await rollbackPreparingPaths(options)}\n`);
      } else if (command === 'abort-unmodified-preparing') {
        process.stdout.write(`${await abortUnmodifiedPreparingDeployment(options)}\n`);
      } else {
        process.stdout.write(`${await completePreparingDeployment(options)}\n`);
      }
    } else if (command === 'recovery-step' && args.length === 12) {
      process.stdout.write(`${await recordPreparingRecoveryStep({
        preparingJournal: args[0],
        committedJournal: args[1],
        journalDirectory: args[2],
        releases: args[3],
        uid: Number(args[4]),
        gid: Number(args[5]),
        destinations: args.slice(6, 10),
        step: args[10],
        state: args[11],
      })}\n`);
    } else if (command === 'clear-global' && args.length === 9) {
      process.stdout.write(`${await clearCommittedDeployment({
        committedJournal: args[0],
        journalDirectory: args[1],
        releases: args[2],
        uid: Number(args[3]),
        gid: Number(args[4]),
        destinations: args.slice(5),
      })}\n`);
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
