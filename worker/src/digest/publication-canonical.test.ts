import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MAX_PUBLICATION_BYTES_PER_DATE,
  MAX_PUBLICATION_OBJECT_BYTES,
  MAX_PUBLICATION_OBJECTS_PER_DATE,
  MAX_PUBLICATION_REVISIONS_PER_DATE,
  PUBLICATION_STORAGE_BUDGET_BYTES,
  buildPublicationManifest,
  canonicalBusinessRevision,
  canonicalizePublicationObject,
  verifyPublicationObjectBytes,
} from './publication-canonical';

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'publication-canonical.ts');

describe('append-only publication canonical boundary', () => {
  test('provides one shared Worker/WebCrypto canonicalization module', () => {
    expect(existsSync(modulePath)).toBe(true);
  });

  test('rebuilds the exact NFC canonical tuple from actual bytes', async () => {
    const bytes = new TextEncoder().encode('caf\u00e9');
    const object = await canonicalizePublicationObject({
      schema_version: 1,
      r2_key: `daily/versions/${'a'.repeat(64)}/page.html`,
      business_revision_id: 'b'.repeat(64),
      attempt_key: 'a'.repeat(64),
      object_role: 'html',
      mime: 'text/html; charset=utf-8',
    }, bytes);
    expect(object.size_bytes).toBe(bytes.byteLength);
    expect(object.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(object.tuple_digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyPublicationObjectBytes(object, bytes)).resolves.toEqual(object);
    await expect(verifyPublicationObjectBytes(object, new TextEncoder().encode('cafe\u0301')))
      .rejects.toThrow('PUBLICATION_OBJECT_BYTES_MISMATCH');
  });

  test('sorts video roles and hashes a complete manifest deterministically', async () => {
    const attempt = 'c'.repeat(64);
    const common = { schema_version: 1 as const, business_revision_id: 'd'.repeat(64), attempt_key: attempt };
    const poster = await canonicalizePublicationObject({
      ...common, r2_key: `daily-video/candidates/${attempt}/poster.jpg`,
      object_role: 'poster', mime: 'image/jpeg',
    }, new Uint8Array([2]));
    const mp4 = await canonicalizePublicationObject({
      ...common, r2_key: `daily-video/candidates/${attempt}/video.mp4`,
      object_role: 'mp4', mime: 'video/mp4',
    }, new Uint8Array([1]));
    const manifest = await buildPublicationManifest({
      schema_version: 1, publication_date: '2026-08-27', publication_type: 'video',
      slot_no: 1, business_revision_id: common.business_revision_id,
      attempt_key: attempt, vtt_present: 0, objects: [poster, mp4],
    });
    expect(manifest.objects.map((object) => object.object_role)).toEqual(['mp4', 'poster']);
    expect(manifest.total_size_bytes).toBe(2);
    expect(manifest.manifest_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('business revision preserves nested values while sorting every object level', async () => {
    const left = await canonicalBusinessRevision({
      page: { title: 'AI', items: [{ id: 'one', score: 3 }] }, version: 1,
    });
    const right = await canonicalBusinessRevision({
      version: 1, page: { items: [{ score: 3, id: 'one' }], title: 'AI' },
    });
    const changed = await canonicalBusinessRevision({
      version: 1, page: { items: [{ score: 4, id: 'one' }], title: 'AI' },
    });
    expect(left).toBe(right);
    expect(changed).not.toBe(left);
  });

  test('executes the frozen 64 MiB MP4 boundary without streaming', async () => {
    const attempt = 'e'.repeat(64);
    const exact = new Uint8Array(MAX_PUBLICATION_OBJECT_BYTES.mp4);
    const object = await canonicalizePublicationObject({
      schema_version: 1, r2_key: `daily-video/candidates/${attempt}/video.mp4`,
      business_revision_id: 'f'.repeat(64), attempt_key: attempt,
      object_role: 'mp4', mime: 'video/mp4',
    }, exact);
    expect(object.size_bytes).toBe(64 * 1024 * 1024);
    const tooLarge = new Uint8Array(MAX_PUBLICATION_OBJECT_BYTES.mp4 + 1);
    await expect(canonicalizePublicationObject({
      schema_version: 1, r2_key: `daily-video/candidates/${attempt}/video.mp4`,
      business_revision_id: 'f'.repeat(64), attempt_key: attempt,
      object_role: 'mp4', mime: 'video/mp4',
    }, tooLarge)).rejects.toThrow('PUBLICATION_OBJECT_TOO_LARGE');
  });

  test('freezes the v5 per-date, annual, and cumulative planning capacity math', () => {
    expect(MAX_PUBLICATION_REVISIONS_PER_DATE).toEqual({ page: 16, video: 4 });
    expect(MAX_PUBLICATION_OBJECTS_PER_DATE).toBe(28);
    expect(MAX_PUBLICATION_BYTES_PER_DATE).toBe(324 * 1024 * 1024);
    expect(PUBLICATION_STORAGE_BUDGET_BYTES).toBe(3 * 1024 ** 4);
    expect(MAX_PUBLICATION_OBJECTS_PER_DATE * 365).toBe(10_220);
    expect(MAX_PUBLICATION_OBJECTS_PER_DATE * 366).toBe(10_248);
    expect(MAX_PUBLICATION_BYTES_PER_DATE * 365 / 1024 ** 2).toBe(118_260);
    expect(MAX_PUBLICATION_BYTES_PER_DATE * 366 / 1024 ** 2).toBe(118_584);
    expect(MAX_PUBLICATION_BYTES_PER_DATE * 365 / 1024 ** 3).toBe(115.48828125);
    expect(MAX_PUBLICATION_BYTES_PER_DATE * 366 / 1024 ** 3).toBe(115.8046875);
    expect(PUBLICATION_STORAGE_BUDGET_BYTES / (MAX_PUBLICATION_BYTES_PER_DATE * 366))
      .toBeCloseTo(26.5274, 4);
    expect(PUBLICATION_STORAGE_BUDGET_BYTES * 0.9 / (MAX_PUBLICATION_BYTES_PER_DATE * 366))
      .toBeCloseTo(23.8747, 4);
  });
});
