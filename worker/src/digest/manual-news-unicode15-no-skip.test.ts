import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const REQUIRED_GATES = [
  'manual-news-unicode15.test.ts',
  'manual-news-unicode15-ri-performance.test.ts',
  'manual-news-unicode15.workerd.test.ts',
  'manual-news-canonical-json-v2.test.ts',
  'manual-news-v11-domain.test.ts',
] as const;

describe('manual-news v3 no-skip gate', () => {
  it('keeps Unicode, canonical JSON, V11, and workerd suites enabled', () => {
    for (const relativePath of REQUIRED_GATES) {
      const source = readFileSync(resolve(sourceDirectory, relativePath), 'utf8');
      expect(source).not.toMatch(/(?:describe|it|test)\.skip\s*\(/u);
      expect(source).not.toMatch(/(?:describe|it|test)\.todo\s*\(/u);
    }
  });

  it('forbids ambient normalization and grapheme segmentation in the pinned runtime', () => {
    const runtime = readFileSync(resolve(sourceDirectory, 'manual-news-unicode15.ts'), 'utf8');
    expect(runtime).not.toContain('String.normalize');
    expect(runtime).not.toContain('Intl.Segmenter');
    expect(runtime).toContain('normalizeNfkc15');
  });
});
