import { describe, expect, test, vi } from 'vitest';

import { runPhR2Migrate } from './ph-r2';

const STATIC_WEBP: Record<400 | 800, string> = {
  400: 'UklGRuAAAABXRUJQVlA4INQAAABQFwCdASqQAeEAPp1OpE4lpCOiICgAsBOJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ychvAA/v+4+QAAAAAAAAAAAAAAAA==',
  800: 'UklGRsoCAABXRUJQVlA4IL4CAAAwUQCdASogA8IBPp1OpE4lpCOiIAgAsBOJaW7hd2EbQAnsA99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32rAAP7/uPkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

function staticWebp(width: 400 | 800): Uint8Array {
  const encoded = width === 800
    ? 'UklGRjIAAABXRUJQVlA4TCUAAAAvH0NwAAdQ6lKXuv8BAEX6/58i+p/63//+97///e9///vf/9ADAA=='
    : STATIC_WEBP[width];
  return Buffer.from(encoded, 'base64');
}

function fakeEnv(media: unknown[]) {
  const calls: Array<{ sql: string; bound: unknown[] }> = [];
  const bucketPuts: Array<{ key: string; options?: R2PutOptions }> = [];
  const row = {
    id: 'product_hunt:animated',
    source_id: 'animated',
    media_raw: JSON.stringify(media),
    extra_raw: '{}',
  };
  const env = {
    DB: {
      prepare(sql: string) {
        const call = { sql, bound: [] as unknown[] };
        calls.push(call);
        const statement = {
          bind: (...bound: unknown[]) => {
            call.bound = bound;
            return statement;
          },
          all: async () => ({ results: [row] }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
      },
    },
    READMES: {
      put: vi.fn(async (key: string, _value: ArrayBuffer, options?: R2PutOptions) => {
        bucketPuts.push({ key, options });
        return {} as R2Object;
      }),
    },
  } as unknown as Parameters<typeof runPhR2Migrate>[0];
  return { env, calls, bucketPuts };
}

describe('Product Hunt GIF migration', () => {
  test('retains the original GIF and adds static, single-frame card previews', async () => {
    const { env, calls, bucketPuts } = fakeEnv([
      { type: 'image', role: 'gallery', url: 'https://ph-files.example/launch.gif' },
    ]);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([0x47, 0x49, 0x46]), {
        headers: { 'content-type': 'image/gif' },
      }))
      .mockImplementation(async (_input, init) => {
        expect((init as RequestInit & {
          cf?: { image?: { anim?: boolean; width?: number } };
        }).cf?.image?.anim).toBe(false);
        const width = (init as RequestInit & {
          cf?: { image?: { width?: number } };
        }).cf?.image?.width === 800 ? 800 : 400;
        return new Response(staticWebp(width), {
          headers: { 'content-type': 'image/webp' },
        });
      });

    try {
      const result = await runPhR2Migrate(env, 1);
      expect(result).toMatchObject({ picked: 1, ok: 1, assets_failed: 0 });
    } finally {
      fetchMock.mockRestore();
    }

    const update = calls.find((call) => /UPDATE items SET media/.test(call.sql));
    const writtenMedia = JSON.parse(String(update?.bound[0]));
    const writtenExtra = JSON.parse(String(update?.bound[1]));
    expect(writtenMedia[0].url).toMatch(/^\/r\/ph\/.*\.gif$/);
    expect(writtenMedia[0].card_variants).toHaveLength(2);
    expect(writtenMedia[0].card_preview_status).toBe('ready');
    expect(writtenExtra.card_variant_version).toBe(2);
    expect(bucketPuts.filter(({ key }) => /\/card\//.test(key))).toHaveLength(2);
  });

  test('marks a GIF preview unavailable when transforms fail without discarding the original', async () => {
    const { env, calls } = fakeEnv([
      { type: 'image', role: 'gallery', url: 'https://ph-files.example/large.gif' },
    ]);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([0x47, 0x49, 0x46]), {
        headers: { 'content-type': 'image/gif' },
      }))
      .mockResolvedValue(new Response('unsupported', {
        headers: { 'content-type': 'image/jpeg' },
      }));

    try {
      await runPhR2Migrate(env, 1);
    } finally {
      fetchMock.mockRestore();
    }

    const update = calls.find((call) => /UPDATE items SET media/.test(call.sql));
    const writtenMedia = JSON.parse(String(update?.bound[0]));
    expect(writtenMedia[0].url).toMatch(/^\/r\/ph\/.*\.gif$/);
    expect(writtenMedia[0].card_preview_status).toBe('unavailable');
    expect(writtenMedia[0]).not.toHaveProperty('card_variants');
  });
});
