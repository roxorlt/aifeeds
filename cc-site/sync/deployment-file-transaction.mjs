#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.chown(uid, gid);
    await handle.sync();
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
