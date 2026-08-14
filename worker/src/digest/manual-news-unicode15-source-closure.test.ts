import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const OFFICIAL_UNICODE_15_1_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../vendor/unicode/15.1.0',
);

const REQUIRED_OFFICIAL_FILES = [
  'license.txt',
  'ucd/ReadMe.txt',
  'ucd/UnicodeData.txt',
  'ucd/DerivedAge.txt',
  'ucd/DerivedNormalizationProps.txt',
  'ucd/CompositionExclusions.txt',
  'ucd/NormalizationTest.txt',
  'ucd/auxiliary/GraphemeBreakProperty.txt',
  'ucd/auxiliary/GraphemeBreakTest.txt',
  'ucd/emoji/emoji-data.txt',
  'ucd/DerivedCoreProperties.txt',
] as const;

const manifest = JSON.parse(readFileSync(resolve(OFFICIAL_UNICODE_15_1_ROOT, 'provenance-manifest.json'), 'utf8')) as {
  ucd_zip: { sha256: string; license_txt_embedded: boolean; url: string; retrieved_on: string; vendored_archive: boolean; extracted_root: string };
  license: { path: string; sha256: string; url: string; retrieved_on: string; version: string; artifact_name: string };
  ucd_files: Record<string, string>;
  generator: { path: string; sha256: string };
  generated_tables: { path: string; sha256: string };
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('pinned Unicode 15.1 official source closure', () => {
  it('vendors every frozen normalization and extended-grapheme source byte file', () => {
    const missing = REQUIRED_OFFICIAL_FILES.filter(
      (relativePath) => !existsSync(resolve(OFFICIAL_UNICODE_15_1_ROOT, relativePath)),
    );

    expect(missing).toEqual([]);
  });

  it('pins byte-exact UCD, license, generator, and generated-table provenance', () => {
    expect(manifest.ucd_zip.sha256).toBe('cb1c663d053926500cd501229736045752713a066bd75802098598b7a7056177');
    expect(manifest.ucd_zip.license_txt_embedded).toBe(false);
    expect(manifest.ucd_zip.url).toBe('https://www.unicode.org/Public/zipped/15.1.0/UCD.zip');
    expect(manifest.ucd_zip.retrieved_on).toBe('2026-08-14');
    expect(manifest.ucd_zip.vendored_archive).toBe(false);
    expect(manifest.ucd_zip.extracted_root).toBe('ucd/');
    expect(manifest.license.url).toBe('https://www.unicode.org/license.txt');
    expect(manifest.license.retrieved_on).toBe('2026-08-14');
    expect(manifest.license.version).toBe('Unicode License v3');
    expect(manifest.license.artifact_name).toBe('unicode-license.txt');
    expect(manifest.ucd_files['ucd/ReadMe.txt']).toBe('0d2da782ead4e85630d510f50808355e8c3355e670841d257dd1e6fbd40db9fa');
    expect(sha256(resolve(OFFICIAL_UNICODE_15_1_ROOT, manifest.license.path))).toBe(manifest.license.sha256);
    for (const [relativePath, expected] of Object.entries(manifest.ucd_files)) {
      expect(sha256(resolve(OFFICIAL_UNICODE_15_1_ROOT, relativePath))).toBe(expected);
    }
    const workerRoot = resolve(OFFICIAL_UNICODE_15_1_ROOT, '../../..');
    expect(sha256(resolve(workerRoot, manifest.generator.path))).toBe(manifest.generator.sha256);
    expect(sha256(resolve(workerRoot, manifest.generated_tables.path))).toBe(manifest.generated_tables.sha256);
  });
});
