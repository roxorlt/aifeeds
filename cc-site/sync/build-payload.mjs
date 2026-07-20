#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'MANIFEST.sha256';

function parseAllowlist(contents) {
  const entries = contents.split('\n').filter(Boolean);
  if (entries.length === 0) throw new Error('payload allowlist is empty');
  if (new Set(entries).size !== entries.length) {
    throw new Error('payload allowlist contains duplicates');
  }
  if (entries.some((entry) => (
    path.posix.isAbsolute(entry)
    || entry.includes('\\')
    || path.posix.normalize(entry) !== entry
    || entry.startsWith('../')
    || entry.includes('/../')
  ))) {
    throw new Error('payload allowlist contains an unsafe path');
  }
  if (entries.some((entry) => (
    entry.startsWith('cc-site/server/')
    || /(^|\/)\.env(?:\.|$)/.test(entry)
    || entry.includes('.secrets')
  ))) {
    throw new Error('payload allowlist contains a forbidden path');
  }
  if (entries.join('\n') !== [...entries].sort().join('\n')) {
    throw new Error('payload allowlist must be sorted');
  }
  return entries;
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function requireSingleLinkRegular(file, label) {
  const identity = await lstat(file);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
}

export async function buildPayload({ envFile, payload, repoRoot }) {
  if (!path.isAbsolute(envFile) || !path.isAbsolute(payload) || !path.isAbsolute(repoRoot)) {
    throw new Error('payload paths must be absolute');
  }
  const allowlistFile = path.join(repoRoot, 'cc-site', 'sync', 'payload-files.txt');
  await requireSingleLinkRegular(allowlistFile, 'payload allowlist');
  await requireSingleLinkRegular(envFile, 'deployment environment');
  const entries = parseAllowlist(await readFile(allowlistFile, 'utf8'));
  await mkdir(payload, { mode: 0o700 });

  const manifest = [];
  for (const relative of entries) {
    const source = path.join(repoRoot, ...relative.split('/'));
    await requireSingleLinkRegular(source, relative);
    const destination = path.join(payload, ...relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    manifest.push(`${await digest(destination)}  ${relative}`);
  }

  const envRelative = 'deploy/cc-sync.env';
  const envDestination = path.join(payload, 'deploy', 'cc-sync.env');
  await mkdir(path.dirname(envDestination), { recursive: true, mode: 0o700 });
  await copyFile(envFile, envDestination);
  manifest.push(`${await digest(envDestination)}  ${envRelative}`);
  manifest.sort((left, right) => {
    const leftPath = left.slice(left.indexOf('  ') + 2);
    const rightPath = right.slice(right.indexOf('  ') + 2);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });

  const manifestFile = path.join(payload, MANIFEST_NAME);
  await writeFile(manifestFile, `${manifest.join('\n')}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  return manifestFile;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [repoRoot, payload, envFile] = process.argv.slice(2);
  if (!repoRoot || !payload || !envFile) {
    console.error('usage: build-payload.mjs <repo-root> <payload-dir> <env-file>');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${await buildPayload({ envFile, payload, repoRoot })}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export { MANIFEST_NAME, parseAllowlist };
