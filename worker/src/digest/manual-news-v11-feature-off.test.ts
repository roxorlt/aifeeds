import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const V11_MODULE = 'manual-news-v11-domain';
const workerRoot = dirname(sourceRoot);
const worktreeRoot = dirname(workerRoot);
const ALLOWED_RELATIVE_SOURCE_PATHS = new Set(['worker/src/digest/manual-news-v11-domain.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function isAllowedV11SourcePath(path: string): boolean {
  return ALLOWED_RELATIVE_SOURCE_PATHS.has(relative(worktreeRoot, path).split(sep).join('/'));
}

describe('manual-news v11 feature-off closure', () => {
  it('has no production importer outside the pure envelope module', () => {
    const importers = sourceFiles(sourceRoot)
      .filter((path) => !isAllowedV11SourcePath(path))
      .filter((path) => readFileSync(path, 'utf8').includes(V11_MODULE));
    expect(importers).toEqual([]);
  });

  it('does not allowlist a same-basename module from another source directory', () => {
    expect(isAllowedV11SourcePath(join(sourceRoot, 'other', 'manual-news-v11-domain.ts'))).toBe(false);
    expect(relative(worktreeRoot, join(sourceRoot, 'digest', 'manual-news-v11-domain.ts')))
      .toBe('worker/src/digest/manual-news-v11-domain.ts');
  });

  it('keeps the exact V11 path out of the offline production-entry metafile', async () => {
    const result = await build({
      entryPoints: [join(sourceRoot, 'index.ts')], bundle: true, format: 'esm', metafile: true,
      platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:workers'],
      loader: { '.wasm': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs)
      .map((path) => relative(workerRoot, resolve(workerRoot, path)).split(sep).join('/'));
    expect(inputs).not.toContain('src/digest/manual-news-v11-domain.ts');
  }, 30_000);
});
