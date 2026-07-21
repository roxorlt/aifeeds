import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';

import type { Env } from '../index';
import type { RenderRow } from './render';
import {
  buildDailyCodexPayload,
  buildStagedDailyCodexPayload,
  getDailyStageState,
  pushDailyStageToCodex,
} from './codex-push';

interface PoolRow {
  item_ids: string;
  items_meta: string | null;
  generated_at: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function row(id: string, title = id): RenderRow {
  return {
    id,
    title,
    content: `${title} content`,
    content_translated: `${title} translated`,
    author: 'AI Feeds',
    handle: 'aifeeds',
    url: `https://example.com/${encodeURIComponent(id)}`,
    media: null,
    extra: '{}',
  };
}

function makeEnv() {
  const pools = new Map<string, PoolRow>();
  const rows = new Map<string, RenderRow>();
  let now = 1_000;

  const key = (slot: string, source: string, density: string) => `${slot}|${source}|${density}`;
  const setPool = (date: string, source: string, ids: string[]) => {
    for (const id of ids) if (!rows.has(id)) rows.set(id, row(id));
    pools.set(key(`${date}-08`, source, 'normal'), {
      item_ids: JSON.stringify(ids),
      items_meta: null,
      generated_at: now++,
    });
  };

  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first<T>() {
          if (/FROM digest_pool/i.test(sql)) {
            const [slot, source, density = /density\s*=\s*'normal'/i.test(sql) ? 'normal' : 'meta'] = binds;
            return (pools.get(key(String(slot), String(source), String(density))) || null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM items/i.test(sql)) {
            // Deliberately return rows in reverse order:payload order must follow digest_pool item_ids.
            return {
              results: [...binds].reverse().map((id) => rows.get(String(id))).filter(Boolean) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO digest_pool/i.test(sql)) {
            const [slot, source, density, itemIds, itemsMeta, generatedAt] = binds;
            pools.set(key(String(slot), String(source), String(density)), {
              item_ids: String(itemIds),
              items_meta: itemsMeta == null ? null : String(itemsMeta),
              generated_at: Number(generatedAt),
            });
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  return {
    env: {
      DB,
      API_BASE: 'https://api.ai-feeds.com',
      SITE_BASE: 'https://ai-feeds.com',
    } as unknown as Env,
    pools,
    rows,
    setPool,
  };
}

function seedAll(setPool: (date: string, source: string, ids: string[]) => void, date = '2026-07-21') {
  setPool(date, 'news', ['news:2', 'news:1']);
  setPool(date, 'x', ['x_list:2', 'x_list:1']);
  setPool(date, 'ph', ['product_hunt:2', 'product_hunt:1']);
  setPool(date, 'gh', ['github:o/r2', 'github:o/r1']);
  setPool(date, 'hf-paper', ['hf_paper:2', 'hf_paper:1']);
}

describe('daily Codex payload v2', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('matches the HK canonical JSON contract fixture', () => {
    const fixture = {
      meta: {
        density: 'normal',
        generated_at: '2026-07-21 06:30:00 (BJT)',
        source_order: ['ph', 'gh'],
      },
      sections: { normal: [] },
    };
    expect(canonicalSha256(fixture)).toBe(
      'sha256:36cf27d64e820fd1d938d9879c53742fd692e8f583ca25f32d15b5a0c2f72bbb',
    );
  });

  test('builds foundation from PH/GH only with a stable hash and pool-defined item order', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);

    const first = await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21' });
    const second = await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21' });

    expect(first.protocol_version).toBe(2);
    expect(first.stage).toBe('foundation');
    expect(first.batch_id).toBe('daily-2026-07-21-normal');
    expect(first.expected_stages).toEqual(['foundation', 'editorial', 'papers']);
    expect(first.digest.meta.source_order).toEqual(['ph', 'gh']);
    expect(first.digest.meta.final_source_order).toEqual(['news', 'x', 'ph', 'gh', 'hf-paper']);
    expect(first.digest.sections.normal.map((section) => section.source)).toEqual(['ph', 'gh']);
    expect(first.digest.sections.normal[0].items.map((item) => item.item_id)).toEqual([
      'product_hunt:2',
      'product_hunt:1',
    ]);
    const stageItems = first.digest.sections.normal.flatMap((section) => section.items);
    expect(stageItems.map((item) => item.card_index)).toEqual([1, 2, 3, 4]);
    expect(stageItems.every((item) => /^segment-[a-z-]+-[0-9a-f]{16}$/.test(item.segment_id || ''))).toBe(true);
    expect(first.content_hash).toBe(canonicalSha256(first.digest));
    expect(second.content_hash).toBe(first.content_hash);
    expect(second.render_key).toBe(first.render_key);
    expect(first.final_manifest).toBeNull();
  });

  test('keeps stage metadata and hashes stable when the same snapshot is rebuilt hours later', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-20T22:30:00.000Z').getTime());
    const { env, setPool } = makeEnv();
    seedAll(setPool);

    const first = await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21' });
    clock.mockReturnValue(new Date('2026-07-21T00:00:00.000Z').getTime());
    const rebuilt = await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21' });

    expect(rebuilt.digest.meta.generated_at).toBe(first.digest.meta.generated_at);
    expect(rebuilt.content_hash).toBe(first.content_hash);
    expect(rebuilt.render_key).toBe(first.render_key);
  });

  test('rejects an empty non-final stage instead of sending an ambiguous snapshot', async () => {
    const { env } = makeEnv();
    await expect(buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21' }))
      .rejects.toThrow('empty_stage:foundation');
  });

  test('keeps the revision for identical content and increments it only when content changes', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);

    const first = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21',
      persistRevision: true,
    });
    const identical = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21',
      persistRevision: true,
    });
    setPool('2026-07-21', 'ph', ['product_hunt:3', 'product_hunt:1']);
    const changed = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21',
      persistRevision: true,
    });

    expect(first.revision).toBe(1);
    expect(identical.revision).toBe(1);
    expect(identical.content_hash).toBe(first.content_hash);
    expect(changed.revision).toBe(2);
    expect(changed.content_hash).not.toBe(first.content_hash);
    expect((await getDailyStageState(env, '2026-07-21', 'foundation'))?.revision).toBe(2);
  });

  test('finalize references all stage revisions/hashes and emits deterministic segment/card bindings', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    const foundation1 = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    setPool('2026-07-21', 'ph', ['product_hunt:3', 'product_hunt:1']);
    const foundation2 = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    const editorial = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    const papers = await buildStagedDailyCodexPayload(env, 'papers', {
      date: '2026-07-21', persistRevision: true,
    });

    const final = await buildStagedDailyCodexPayload(env, 'finalize', {
      date: '2026-07-21', persistRevision: true,
    });
    const repeat = await buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' });

    expect(foundation2.revision).toBe(foundation1.revision + 1);
    expect(final.final_manifest?.stage_revisions).toEqual({
      foundation: { revision: foundation2.revision, content_hash: foundation2.content_hash },
      editorial: { revision: editorial.revision, content_hash: editorial.content_hash },
      papers: { revision: papers.revision, content_hash: papers.content_hash },
    });
    expect(final.final_manifest?.section_order).toEqual(['news', 'x', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.items.map((item) => item.card_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(final.final_manifest?.items.map((item) => item.segment_id)).size).toBe(10);
    expect(final.final_manifest?.items.find((item) => item.source === 'ph')?.revision).toBe(foundation2.revision);
    const finalPh1 = final.final_manifest?.items.find((item) => item.item_id === 'product_hunt:1');
    const stagePh1 = foundation2.digest.sections.normal.flatMap((section) => section.items)
      .find((item) => item.item_id === 'product_hunt:1');
    expect(finalPh1?.segment_id).toBe(stagePh1?.segment_id);
    expect(finalPh1?.card_index).not.toBe(stagePh1?.card_index);
    expect(final.final_manifest?.manifest_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repeat.final_manifest?.manifest_hash).toBe(final.final_manifest?.manifest_hash);
    expect(repeat.content_hash).toBe(final.content_hash);
  });

  test('refuses finalize when any required stage revision is absent', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });

    await expect(buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' }))
      .rejects.toThrow('missing_stage_state:papers');
  });

  test('refuses finalize when a locked stage pool changed without a new stage revision', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    setPool('2026-07-21', 'news', ['news:3', 'news:1']);

    await expect(buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' }))
      .rejects.toThrow('stage_content_changed:editorial');
  });

  test('keeps the fixed final source order on every batch but removes empty sections from final manifest order', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    setPool('2026-07-21', 'x', []);
    const foundation = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    const final = await buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' });

    expect(foundation.digest.meta.final_source_order).toEqual(['news', 'x', 'ph', 'gh', 'hf-paper']);
    expect(final.digest.meta.final_source_order).toEqual(['news', 'x', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.section_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
  });

  test('allows staged pushes from staging only through the explicit test endpoint', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_ENDPOINT: 'https://ai-feeds.cc/aifeeds/api/daily/ingest',
    });

    const blocked = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');
    expect(blocked).toMatchObject({ ok: false, skipped: 'non_prod_or_staging_endpoint_missing' });

    Object.assign(env as object, {
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id: 'stage-1', status: 'queued' }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    ));
    const pushed = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');

    expect(pushed).toMatchObject({ ok: true, stage: 'foundation', revision: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://staging-render.example.test/aifeeds/api/daily/ingest',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((await getDailyStageState(env, '2026-07-21', 'foundation'))?.pushed_at).toEqual(expect.any(Number));
  });

  test('does not push finalize until all three input stages have successful push markers', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    Object.assign(env as object, {
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
      API_BASE: 'https://staging-api.ai-feeds.com',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await pushDailyStageToCodex(env, 'finalize', '2026-07-21');

    expect(result).toMatchObject({ ok: false, stage: 'finalize', error: 'stage_not_pushed:foundation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('retains the legacy v1 full payload constructor for manual rollback/replay', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    const legacy = await buildDailyCodexPayload(env, 8, '2026-07-21');

    expect('protocol_version' in legacy).toBe(false);
    expect(legacy.render_key).toMatch(/^daily-2026-07-21-normal-/);
  });
});
