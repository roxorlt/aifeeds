import { describe, test, expect } from 'vitest';
import { runCoverQualitySweep, passesFeedImageQualityGate } from './media-r2';
import type { Env } from '../index';

// ── PNG buffer 构造(magic + IHDR width/height @16/20),字节数控制 density。 ──
function makePng(width: number, height: number, byteLen: number): ArrayBuffer {
  const len = Math.max(byteLen, 24);
  const u = new Uint8Array(len);
  // PNG signature 89 50 4E 47 0D 0A 1A 0A
  u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(u.buffer);
  dv.setUint32(16, width); // IHDR width (BE)
  dv.setUint32(20, height); // IHDR height (BE)
  return u.buffer;
}

describe('passesFeedImageQualityGate', () => {
  test('合格图(800x600,足够字节密度)→ true', () => {
    expect(passesFeedImageQualityGate(makePng(800, 600, 40000))).toBe(true);
  });
  test('过小(200x200)→ false', () => {
    expect(passesFeedImageQualityGate(makePng(200, 200, 40000))).toBe(false);
  });
  test('极端宽高比(1200x100)→ false', () => {
    expect(passesFeedImageQualityGate(makePng(1200, 100, 40000))).toBe(false);
  });
  test('低密度(400x400 但字节极小)→ false', () => {
    expect(passesFeedImageQualityGate(makePng(400, 400, 100))).toBe(false);
  });
  test('无法 probe 且过小 → false', () => {
    expect(passesFeedImageQualityGate(new Uint8Array(1000).buffer)).toBe(false);
  });
});

// ── 分页 sweep 的 DB / R2 mock ──
interface FakeItem {
  id: string;
  source_type: string;
  extra: Record<string, unknown>;
}

function makeEnv(items: FakeItem[], r2Store: Map<string, ArrayBuffer>) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const byId = new Map(items.map((it) => [it.id, it]));

  // actionable 谓词:cover 存在 + 未 swept + (R2 形态 或 marker 已置位)
  const actionable = (it: FakeItem): boolean => {
    const cov = String(it.extra.cover_image || '');
    if (!cov) return false;
    if (it.extra.cover_swept_at) return false;
    const isR2 = cov.startsWith('/r/') || /^https?:\/\/[^/]+\/r\//i.test(cov);
    const hasMarker = !!it.extra.blog_media_r2_at || !!it.extra.podcast_media_r2_at;
    return isR2 || hasMarker;
  };

  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          bound = b;
          return stmt;
        },
        async all<T>() {
          if (/SELECT id, source_type, extra FROM items/i.test(sql)) {
            const limit = Number(bound[0]) || 1000;
            const results = items
              .filter((it) => ['blog', 'podcast'].includes(it.source_type) && actionable(it))
              .slice(0, limit)
              .map((it) => ({ id: it.id, source_type: it.source_type, extra: JSON.stringify(it.extra) }));
            return { results: results as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/COUNT\(\*\)/i.test(sql)) {
            const c = items.filter((it) => ['blog', 'podcast'].includes(it.source_type) && actionable(it)).length;
            return { c } as unknown as T;
          }
          return null;
        },
        async run() {
          updates.push({ sql, binds: bound });
          // 应用到内存 item 以驱动 remaining 递减
          const id = String(bound[bound.length - 1]);
          const it = byId.get(id);
          if (it) {
            if (/json_remove/i.test(sql)) delete it.extra.cover_image;
            it.extra.cover_swept_at = String(bound[0]);
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const READMES = {
    async get(key: string) {
      const buf = r2Store.get(key);
      if (!buf) return null;
      return { async arrayBuffer() { return buf; } };
    },
  };

  const env = { DB, READMES } as unknown as Env;
  return { env, updates };
}

describe('runCoverQualitySweep', () => {
  test('R2 合格保留、R2 不合格清空、外链+marker 清空 → {scanned,cleared,remaining}', async () => {
    const r2 = new Map<string, ArrayBuffer>([
      ['blog/pass.jpg', makePng(800, 600, 40000)],
      ['blog/fail.jpg', makePng(120, 120, 40000)],
    ]);
    const items: FakeItem[] = [
      { id: 'blog:a', source_type: 'blog', extra: { cover_image: '/r/blog/pass.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:b', source_type: 'blog', extra: { cover_image: '/r/blog/fail.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:c', source_type: 'blog', extra: { cover_image: 'https://external.cdn/c.jpg', blog_media_r2_at: 'x' } },
      // 非 actionable:无 marker 的外链 → 不进批
      { id: 'blog:d', source_type: 'blog', extra: { cover_image: 'https://external.cdn/d.jpg' } },
    ];
    const { env, updates } = makeEnv(items, r2);

    const res = await runCoverQualitySweep(env, { limit: 40, dry: false });
    expect(res.scanned).toBe(3);
    expect(res.cleared).toBe(2); // fail.jpg + 外链 c
    expect(res.remaining).toBe(0);

    // pass 项被标记 swept 但保留 cover
    expect(items.find((i) => i.id === 'blog:a')!.extra.cover_image).toBe('/r/blog/pass.jpg');
    // fail / 外链项 cover 被清
    expect(items.find((i) => i.id === 'blog:b')!.extra.cover_image).toBeUndefined();
    expect(items.find((i) => i.id === 'blog:c')!.extra.cover_image).toBeUndefined();
    // 至少发生了 3 次 UPDATE
    expect(updates.length).toBe(3);
  });

  test('dry=1 只统计,不写任何 UPDATE', async () => {
    const r2 = new Map<string, ArrayBuffer>([['blog/fail.jpg', makePng(120, 120, 40000)]]);
    const items: FakeItem[] = [
      { id: 'blog:b', source_type: 'blog', extra: { cover_image: '/r/blog/fail.jpg', blog_media_r2_at: 'x' } },
      { id: 'pod:c', source_type: 'podcast', extra: { cover_image: 'https://external.cdn/c.jpg', podcast_media_r2_at: 'x' } },
    ];
    const { env, updates } = makeEnv(items, r2);

    const res = await runCoverQualitySweep(env, { limit: 40, dry: true });
    expect(res.scanned).toBe(2);
    expect(res.cleared).toBe(2);
    expect(updates.length).toBe(0); // 无写入
    // 原数据未变
    expect(items[0].extra.cover_image).toBe('/r/blog/fail.jpg');
  });

  test('R2 对象读不到 → 视为不合格清空', async () => {
    const items: FakeItem[] = [
      { id: 'blog:m', source_type: 'blog', extra: { cover_image: '/r/blog/missing.jpg', blog_media_r2_at: 'x' } },
    ];
    const { env } = makeEnv(items, new Map());
    const res = await runCoverQualitySweep(env, { limit: 40, dry: false });
    expect(res.cleared).toBe(1);
  });
});
