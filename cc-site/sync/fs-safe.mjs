import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const ITEM_PATH_RE = /^\/i\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

function decodeAndValidate(urlPath) {
  if (typeof urlPath !== 'string' || !ITEM_PATH_RE.test(urlPath)) {
    throw new Error('unsafe item URL path');
  }

  let decoded = urlPath;
  for (let depth = 0; depth < 8; depth += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error('invalid item URL encoding');
    }
    if (!ITEM_PATH_RE.test(next)) {
      throw new Error('unsafe decoded item URL path');
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  throw new Error('unsafe repeatedly encoded item URL path');
}

async function rejectSymlinkParents(siteRoot, pageParent) {
  const root = path.resolve(siteRoot);
  const relativeParent = path.relative(root, pageParent);
  const parts = relativeParent === '' ? [] : relativeParent.split(path.sep);
  let current = root;

  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink page parent is unsafe: ${current}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`invalid page parent is not a directory: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function resolvePageFile(urlPath, siteRoot) {
  const decoded = decodeAndValidate(urlPath);
  const segments = decoded.split('/');
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

  const root = path.resolve(siteRoot);
  const itemRoot = path.join(root, 'i');
  const pageParent = path.resolve(root, ...segments.slice(1));
  if (
    pageParent === itemRoot
    || !pageParent.startsWith(`${itemRoot}${path.sep}`)
  ) {
    throw new Error('unsafe item path escapes site root');
  }

  await rejectSymlinkParents(root, pageParent);
  return path.join(pageParent, 'index.html');
}

export async function writePageFileAtomic(
  urlPath,
  siteRoot,
  bytes,
  { hooks = {} } = {},
) {
  let file = await resolvePageFile(urlPath, siteRoot);
  await mkdir(path.dirname(file), { recursive: true });
  file = await resolvePageFile(urlPath, siteRoot);

  const tempPath = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o644 });
    await hooks.afterTempWrite?.(tempPath);
    await hooks.beforeRename?.(tempPath, file);
    await rename(tempPath, file);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

export async function removePageFile(urlPath, siteRoot) {
  const file = await resolvePageFile(urlPath, siteRoot);
  await rm(file, { force: true });
}
