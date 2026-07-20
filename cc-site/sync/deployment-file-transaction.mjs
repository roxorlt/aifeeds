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
const GLOBAL_JOURNAL_PUBLISH_CANDIDATE =
  /^\.(preparing|committed)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate$/;
const GLOBAL_JOURNAL_UPDATE_CANDIDATE =
  /^\.preparing-update\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.temporary$/;

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
  const names = (await readdir(journalDirectory)).sort();
  if (names.some((name) => (
    !GLOBAL_JOURNAL_PUBLISH_CANDIDATE.test(name)
    && !GLOBAL_JOURNAL_UPDATE_CANDIDATE.test(name)
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
  const updateCandidates = names.filter((name) => (
    GLOBAL_JOURNAL_UPDATE_CANDIDATE.test(name)
  ));
  if (
    updateCandidates.length > 1
    || (phase !== 'preparing' && updateCandidates.length > 0)
    || (updateCandidates.length > 0 && candidates.length > 0)
    || (updateCandidates.length > 0 && canonicalIdentity.nlink !== 1)
  ) {
    throw new Error('global journal candidate directory has unsafe update state');
  }
  if (updateCandidates.length === 1) {
    const update = path.join(journalDirectory, updateCandidates[0]);
    const updateIdentity = await validateGlobalJournalFile(
      update,
      uid,
      gid,
      'global journal update candidate',
    );
    if (updateIdentity.nlink !== 1) {
      throw new Error('global journal update candidate has unsafe links');
    }
    await unlink(update);
    await syncDirectory(journalDirectory);
  }
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
  if (await lstatOptional(canonical) !== null) {
    throw new Error('global journal marker already exists');
  }
  const candidate = path.join(
    journalDirectory,
    `.${phase}.${randomUUID()}.candidate`,
  );
  const handle = await open(candidate, 'wx', 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`);
    await handle.chown(uid, gid);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(journalDirectory);
  try {
    await link(candidate, canonical);
    await syncDirectory(path.dirname(canonical));
    published = true;
    const canonicalIdentity = await validateGlobalJournalFile(
      canonical,
      uid,
      gid,
      'global journal marker',
    );
    const candidateIdentity = await validateGlobalJournalFile(
      candidate,
      uid,
      gid,
      'global journal candidate',
    );
    if (
      canonicalIdentity.nlink !== 2
      || candidateIdentity.nlink !== 2
      || canonicalIdentity.dev !== candidateIdentity.dev
      || canonicalIdentity.ino !== candidateIdentity.ino
    ) {
      throw new Error('global journal publication inode mismatch');
    }
    await hooks.afterMarkerPublishBeforeCandidateUnlink?.({
      candidate,
      canonical,
    });
    await unlink(candidate);
    await syncDirectory(journalDirectory);
    const settled = await validateGlobalJournalFile(
      canonical,
      uid,
      gid,
      'global journal marker',
    );
    if (settled.nlink !== 1) {
      throw new Error('global journal marker did not settle to one link');
    }
    return settled;
  } catch (error) {
    if (!published) await unlink(candidate).catch(() => {});
    throw error;
  }
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
  const marker = {
    manifest,
    nginx_transaction: nginxTransaction,
    phase: 'preparing',
    release,
    runtime,
    schema: 2,
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

async function replacePreparingMarker({
  expectedIdentity,
  gid,
  journalDirectory,
  marker,
  preparingJournal,
  uid,
}) {
  const candidate = path.join(
    journalDirectory,
    `.preparing-update.${randomUUID()}.temporary`,
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
  await syncDirectory(journalDirectory);
  const current = await lstat(preparingJournal);
  if (
    current.dev !== expectedIdentity.dev
    || current.ino !== expectedIdentity.ino
  ) {
    throw new Error('global preparing marker changed before update');
  }
  await rename(candidate, preparingJournal);
  await syncDirectory(path.dirname(preparingJournal));
  await syncDirectory(journalDirectory);
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
    expectedIdentity: markerFile.identity,
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
    || !/^[0-9a-f]{64}$/.test(marker.manifest ?? '')
    || marker.release !== path.join(releases, marker.manifest)
    || !path.isAbsolute(marker.nginx_transaction ?? '')
    || /[\u0000-\u001f\u007f]/.test(marker.nginx_transaction)
    || !validPreparingRuntime(marker.runtime)
    || !Array.isArray(marker.transactions)
    || marker.transactions.length !== GLOBAL_TRANSACTION_NAMES.length
  ) {
    throw new Error('invalid global preparing marker');
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

export async function recoverGlobalDeployment({
  committedJournal,
  destinations,
  gid,
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
  const preparing = await lstatOptional(preparingJournal);
  const committed = await lstatOptional(committedJournal);
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
      if (
        verifiedCommitted.marker.schema !== 2
        || verifiedCommitted.marker.preparing_digest !== verifiedPreparing.digest
        || verifiedCommitted.marker.manifest !== verifiedPreparing.marker.manifest
        || verifiedCommitted.marker.release !== verifiedPreparing.marker.release
      ) {
        throw new Error('committed and preparing deployment markers mismatch');
      }
      await removeGlobalJournal(
        preparingJournal,
        verifiedPreparing.markerIdentity,
      );
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
    await rollbackPreparingDeployment(verifiedPreparing, uid, gid);
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

export async function completePreparingDeployment({
  committedJournal,
  destinations,
  gid,
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
  for (let index = 0; index < preparing.specs.length; index += 1) {
    const spec = preparing.specs[index];
    const entry = preparing.marker.transactions[index];
    if (await lstatOptional(spec.names.transactionDirectory) !== null) {
      throw new Error('preparing rollback transaction remains incomplete');
    }
    const live = await inspectOptional(
      spec.names.destination,
      entry.type,
      'completed preparing rollback live object',
    );
    if (!optionalIdentityMatches(live, entry.expected)) {
      throw new Error('preparing rollback live object mismatch');
    }
  }
  await removeGlobalJournal(preparingJournal, preparing.markerIdentity);
  return 'cleared';
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
  const preparingCurrent = await lstat(preparingJournal);
  if (
    preparingCurrent.dev !== verifiedPreparing.markerIdentity.dev
    || preparingCurrent.ino !== verifiedPreparing.markerIdentity.ino
  ) {
    throw new Error('global preparing marker changed during commit');
  }
  await unlink(preparingJournal);
  await syncDirectory(releases);
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
  return { marker, markerIdentity: markerFile.identity, snapshots };
}

async function removeGlobalJournal(journal, expectedIdentity = null) {
  if (expectedIdentity !== null) {
    const current = await lstat(journal);
    if (
      current.dev !== expectedIdentity.dev
      || current.ino !== expectedIdentity.ino
    ) {
      throw new Error('global deployment marker changed before removal');
    }
  }
  await unlink(journal);
  await syncDirectory(path.dirname(journal));
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
  await removeGlobalJournal(committedJournal, verified.markerIdentity);
}

export async function clearCommittedDeployment(options) {
  const committed = await readGlobalDeployment(options);
  if (committed.snapshots.some(({ finalized }) => !finalized)) return 'pending';
  await removeGlobalJournal(
    options.committedJournal,
    committed.markerIdentity,
  );
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
      (command === 'recover-global' || command === 'complete-preparing')
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
      } else {
        process.stdout.write(`${await completePreparingDeployment(options)}\n`);
      }
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
