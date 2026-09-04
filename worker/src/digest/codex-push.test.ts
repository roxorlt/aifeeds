import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('./news-review', () => ({
  getAppliedNewsReviewSelection: vi.fn(async () => null),
  getPublishedNewsReviewSelection: vi.fn(),
  getVerifiedNewsReviewSelectionSnapshot: vi.fn(),
  hasHumanReviewedNewsSelection: vi.fn(async () => false),
  sanitizeCurrentNewsReviewBatch: vi.fn(),
}));
vi.mock('./news-source-policy', () => ({
  authorizeFormalNewsSet: vi.fn(),
}));

import type { Env } from '../index';
import type { RenderRow } from './render';
import {
  buildDailyCodexPayload,
  buildStagedDailyCodexPayload,
  getDailyStageState,
  pushDailyStageToCodex,
  pushDailyToCodex,
} from './codex-push';
import { authorizeFormalNewsSet } from './news-source-policy';
import { getAppliedNewsReviewSelection } from './news-review';
import {
  getPublishedNewsReviewSelection,
  getVerifiedNewsReviewSelectionSnapshot,
  hasHumanReviewedNewsSelection,
  sanitizeCurrentNewsReviewBatch,
} from './news-review';

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
  const deletedIds = new Set<string>();
  let beforeStageMutation: ((mutation: { sql: string; binds: unknown[] }) => void) | null = null;
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
              results: [...binds].reverse()
                .map((id) => rows.get(String(id)))
                .filter((value): value is RenderRow => !!value)
                .filter((value) => !/deleted_at\s+IS\s+NULL/i.test(sql) || !deletedIds.has(value.id)) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO digest_pool/i.test(sql)) {
            beforeStageMutation?.({ sql, binds: [...binds] });
            const [slot, source, density, itemIds, itemsMeta, generatedAt] = binds;
            const poolKey = key(String(slot), String(source), String(density));
            if (/DO NOTHING/i.test(sql) && pools.has(poolKey)) {
              return { success: true, meta: { changes: 0 } };
            }
            pools.set(poolKey, {
              item_ids: String(itemIds),
              items_meta: itemsMeta == null ? null : String(itemsMeta),
              generated_at: Number(generatedAt),
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE digest_pool/i.test(sql)) {
            beforeStageMutation?.({ sql, binds: [...binds] });
            if (!/json_set/i.test(sql)) {
              const [itemIds, itemsMeta, generatedAt, slot, source, density, observedRaw] = binds;
              const poolKey = key(String(slot), String(source), String(density));
              const row = pools.get(poolKey);
              if (!row || row.items_meta !== (observedRaw == null ? null : String(observedRaw))) {
                return { success: true, meta: { changes: 0 } };
              }
              pools.set(poolKey, {
                item_ids: String(itemIds),
                items_meta: itemsMeta == null ? null : String(itemsMeta),
                generated_at: Number(generatedAt),
              });
              return { success: true, meta: { changes: 1 } };
            }
            const pushed = sql.includes("'$.pushed_at'");
            const [value, errorOrGeneratedAt, generatedAtOrSlot, slotOrSource, sourceOrDensity,
              densityOrStage, stageOrRevision, revisionOrHash, maybeHash] = binds;
            const generatedAt = pushed ? Number(errorOrGeneratedAt) : Number(generatedAtOrSlot);
            const slot = String(pushed ? generatedAtOrSlot : slotOrSource);
            const source = String(pushed ? slotOrSource : sourceOrDensity);
            const density = String(pushed ? sourceOrDensity : densityOrStage);
            const stage = String(pushed ? densityOrStage : stageOrRevision);
            const revision = Number(pushed ? stageOrRevision : revisionOrHash);
            const contentHash = String(pushed ? revisionOrHash : maybeHash);
            const row = pools.get(key(slot, source, density));
            const current = row?.items_meta ? JSON.parse(row.items_meta) as Record<string, unknown> : null;
            if (!row || !current || current.stage !== stage
              || Number(current.revision) !== revision || current.content_hash !== contentHash) {
              return { success: true, meta: { changes: 0 } };
            }
            const next = pushed
              ? { ...current, pushed_at: Number(value), last_error: '' }
              : {
                ...current,
                attempt_count: Math.min(999, Math.max(0, Number(current.attempt_count || 0)) + 1),
                last_attempt_at: Number(value),
                last_error: String(errorOrGeneratedAt),
              };
            pools.set(key(slot, source, density), {
              ...row,
              items_meta: JSON.stringify(next),
              generated_at: generatedAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
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
    deletedIds,
    setPool,
    setBeforeStageMutation(hook: typeof beforeStageMutation) { beforeStageMutation = hook; },
  };
}

function exactReceiptResponse(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const payload = JSON.parse(String(init?.body || '{}')) as {
    date: string; batch_id: string; stage: string; revision: number; content_hash: string; render_key: string;
  };
  return Promise.resolve(new Response(JSON.stringify({
    id: 'stage-1', status: 'queued',
    receipt: {
      date: payload.date,
      batch_id: payload.batch_id,
      stage: payload.stage,
      revision: payload.revision,
      content_hash: payload.content_hash,
      render_key: payload.render_key,
    },
  }), { status: 202, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => {
  vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
    allowed_ids: [...ids],
    decisions: ids.map((id) => ({ item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const })),
  }));
  vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue(null);
  vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(false);
  vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue([]);
  vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(null);
  vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
    batch: { candidate_ids: [], candidates: [], default_selected_ids: [], applied_selected_ids: [] },
    changed: false,
    dropped_ids: [],
    manual_verifications: [],
  } as never);
});

test('editorial video payload uses the ordered human selection without mutating the default pool', async () => {
  const { env, setPool, pools } = makeEnv();
  setPool('2026-07-21', 'news', ['news-1', 'news-2', 'news-3', 'news-4', 'news-5']);
  for (const id of ['news-6', 'news-7']) setPool('2026-07-20', 'news', [id]);
  vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue([
    'news-6', 'news-2', 'news-7', 'news-1', 'news-5',
  ]);

  const payload = await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' });

  expect(payload.digest.sections.normal[0].items.map((item) => item.item_id)).toEqual([
    'news-6', 'news-2', 'news-7', 'news-1', 'news-5',
  ]);
  expect(JSON.parse(pools.get('2026-07-21-08|news|normal')!.item_ids)).toEqual([
    'news-1', 'news-2', 'news-3', 'news-4', 'news-5',
  ]);
});

test('editorial snapshot binds the current review revision, selection, and exact manual proof identity', async () => {
  const manualId = 'blog:manual:ml-20260811-attested';
  const { env, setPool } = makeEnv();
  setPool('2026-07-21', 'news', [manualId, 'news-1']);
  const snapshot = {
    batch_id: 'nr-20260721-attested0001',
    batch_revision: 4,
    selection_hash: `sha256:${'1'.repeat(64)}`,
    selected_ids: [manualId, 'news-1'],
    manual_verifications: [{
      item_id: manualId,
      lead_id: 'ml-20260811-attested',
      verification_id: 'mav-attested',
      creation_nonce: 'verification-create-attested',
      canonical_digest: 'a'.repeat(64),
    }],
  };
  vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(snapshot);

  const editorial = await buildStagedDailyCodexPayload(env, 'editorial', {
    date: '2026-07-21', persistRevision: true,
  });

  expect((editorial.digest.meta as Record<string, unknown>).news_review).toEqual(snapshot);
  expect(editorial.digest.sections.normal[0].items.map((item) => item.item_id)).toEqual(snapshot.selected_ids);
});

function seedAll(setPool: (date: string, source: string, ids: string[]) => void, date = '2026-07-21') {
  setPool(date, 'news', ['news:2', 'news:1']);
  setPool(date, 'x', ['x_list:2', 'x_list:1']);
  setPool(date, 'ph', ['product_hunt:2', 'product_hunt:1']);
  setPool(date, 'gh', ['github:o/r2', 'github:o/r1']);
  setPool(date, 'hf-paper', ['hf_paper:2', 'hf_paper:1']);
}

describe('daily Codex payload v2', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue(null);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue([]);
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(null);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: { candidate_ids: [], candidates: [], default_selected_ids: [], applied_selected_ids: [] },
      changed: false,
      dropped_ids: [],
      manual_verifications: [],
    } as never);
  });

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
    expect(first.digest.meta.final_source_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
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

  test('excludes X from staged daily video while the shared editorial pool still contains X', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);

    const editorial = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    const final = await buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' });

    expect(editorial.digest.meta.source_order).toEqual(['news']);
    expect(editorial.digest.sections.normal.map((section) => section.source)).toEqual(['news']);
    expect(editorial.digest.sections.normal.flatMap((section) => section.items)
      .some((item) => item.source === 'x')).toBe(false);
    expect(final.digest.meta.final_source_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.digest.sections.normal.map((section) => section.source)).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.items.some((item) => item.source === 'x')).toBe(false);
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

  test('DRD-002 insert CAS discards a stale ordered selection when another builder creates the stage row first', async () => {
    const { env, setPool, pools, setBeforeStageMutation } = makeEnv();
    setPool('2026-07-21', 'news', ['news:1', 'news:2', 'news:3']);
    const staleSnapshot = {
      batch_id: 'nr-20260721-casinsert001', batch_revision: 2,
      selection_hash: `sha256:${'1'.repeat(64)}`, selected_ids: ['news:1', 'news:2'], manual_verifications: [],
    };
    const currentSnapshot = {
      ...staleSnapshot, batch_revision: 3, selection_hash: `sha256:${'2'.repeat(64)}`,
      selected_ids: ['news:3', 'news:1'],
    };
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(staleSnapshot);
    const stale = await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' });
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(currentSnapshot);
    const competing = await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' });
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(staleSnapshot);
    const stateKey = '2026-07-21-08|_codex_stage_editorial|meta';
    let interleaved = false;
    setBeforeStageMutation(({ sql }) => {
      if (interleaved || !/INSERT INTO digest_pool/i.test(sql)) return;
      interleaved = true;
      vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(currentSnapshot);
      pools.set(stateKey, {
        item_ids: '[]', generated_at: 2_000,
        items_meta: JSON.stringify({
          stage: 'editorial', revision: competing.revision, content_hash: competing.content_hash,
          snapshot: competing.digest,
        }),
      });
    });

    const built = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    const current = await getDailyStageState(env, '2026-07-21', 'editorial');

    expect(interleaved).toBe(true);
    expect(stale.content_hash).not.toBe(competing.content_hash);
    expect(built).toMatchObject({ revision: competing.revision, content_hash: competing.content_hash });
    expect(built.digest.meta.news_review).toEqual(currentSnapshot);
    expect(current).toMatchObject({ revision: competing.revision, content_hash: competing.content_hash });
    expect(current?.snapshot?.meta.news_review).toEqual(currentSnapshot);
  });

  test('DRD-002 update CAS discards a stale candidate after a different ordered selection wins from the same raw state', async () => {
    const { env, setPool, pools, setBeforeStageMutation } = makeEnv();
    setPool('2026-07-21', 'news', ['news:1', 'news:2', 'news:3']);
    const priorSnapshot = {
      batch_id: 'nr-20260721-casupdate01', batch_revision: 1,
      selection_hash: `sha256:${'0'.repeat(64)}`, selected_ids: ['news:1'], manual_verifications: [],
    };
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(priorSnapshot);
    const prior = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    const staleSnapshot = {
      ...priorSnapshot, batch_revision: 2, selection_hash: `sha256:${'3'.repeat(64)}`,
      selected_ids: ['news:1', 'news:2'],
    };
    const currentSnapshot = {
      ...priorSnapshot, batch_revision: 3, selection_hash: `sha256:${'4'.repeat(64)}`,
      selected_ids: ['news:3', 'news:1'],
    };
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(staleSnapshot);
    const stale = await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' });
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(currentSnapshot);
    const competing = await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' });
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(staleSnapshot);
    const stateKey = '2026-07-21-08|_codex_stage_editorial|meta';
    const observedRaw = pools.get(stateKey)!.items_meta;
    let interleaved = false;
    setBeforeStageMutation(({ sql }) => {
      if (interleaved || !/digest_pool/i.test(sql)) return;
      interleaved = true;
      vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(currentSnapshot);
      pools.get(stateKey)!.items_meta = JSON.stringify({
        stage: 'editorial', revision: competing.revision, content_hash: competing.content_hash,
        snapshot: competing.digest,
      });
    });

    const built = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    const current = await getDailyStageState(env, '2026-07-21', 'editorial');

    expect(interleaved).toBe(true);
    expect(observedRaw).toContain(prior.content_hash);
    expect(stale.revision).toBe(prior.revision + 1);
    expect(competing.revision).toBe(prior.revision + 1);
    expect(stale.content_hash).not.toBe(competing.content_hash);
    expect(built).toMatchObject({ revision: competing.revision, content_hash: competing.content_hash });
    expect(current).toMatchObject({ revision: competing.revision, content_hash: competing.content_hash });
    expect(current?.snapshot?.meta.news_review).toEqual(currentSnapshot);
  });

  test('DRD-002 bounded build CAS exhaustion prevents the stale candidate from being sent', async () => {
    const { env, setPool, pools, setBeforeStageMutation } = makeEnv();
    seedAll(setPool);
    await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    const stateKey = '2026-07-21-08|_codex_stage_foundation|meta';
    let conflicts = 0;
    setBeforeStageMutation(({ sql }) => {
      if (!/digest_pool/i.test(sql) || /json_set/i.test(sql)) return;
      conflicts += 1;
      const current = JSON.parse(pools.get(stateKey)!.items_meta!) as Record<string, unknown>;
      pools.get(stateKey)!.items_meta = JSON.stringify({ ...current, attempt_count: conflicts });
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(exactReceiptResponse);

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');

    expect(result).toMatchObject({
      ok: false, stage: 'foundation', error: expect.stringContaining('stage_state_cas_exhausted:foundation'),
    });
    expect(conflicts).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(final.final_manifest?.section_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.items.map((item) => item.card_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(final.final_manifest?.items.map((item) => item.segment_id)).size).toBe(8);
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

  test('finalize uses the immutable pushed stage snapshot when the live pool changes later', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    const editorial = await buildStagedDailyCodexPayload(env, 'editorial', {
      date: '2026-07-21', persistRevision: true,
    });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    setPool('2026-07-21', 'news', ['news:3', 'news:1']);

    const final = await buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' });

    expect(final.final_manifest?.stage_revisions.editorial).toEqual({
      revision: editorial.revision,
      content_hash: editorial.content_hash,
    });
    expect(final.digest.sections.normal.find((section) => section.source === 'news')?.items
      .map((item) => item.item_id)).toEqual(['news:2', 'news:1']);
    expect(final.final_manifest?.items.some((item) => item.item_id === 'news:3')).toBe(false);
  });

  test('direct finalize rejects a locked editorial manual snapshot after its proof becomes stale', async () => {
    const manualId = 'blog:manual:ml-20260811-finalize01';
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    setPool('2026-07-21', 'news', [manualId, 'news:1']);
    vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue([manualId, 'news:1']);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: {
        candidate_ids: ['news:1'], candidates: [], default_selected_ids: ['news:1'], applied_selected_ids: ['news:1'],
      },
      changed: true,
      dropped_ids: [manualId],
      manual_verifications: [],
    } as never);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue(['news:1']);

    await expect(buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' }))
      .rejects.toThrow('manual_news_finalize_snapshot_stale');
  });

  test('finalize rejects a changed review revision or manual proof even when selected item ids are unchanged', async () => {
    const manualId = 'blog:manual:ml-20260811-proof-rotation';
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    setPool('2026-07-21', 'news', [manualId, 'news:1']);
    const selected = [manualId, 'news:1'];
    const locked = {
      batch_id: 'nr-20260721-proofrev0001', batch_revision: 2,
      selection_hash: `sha256:${'2'.repeat(64)}`, selected_ids: selected,
      manual_verifications: [{
        item_id: manualId, lead_id: 'ml-20260811-proof-rotation', verification_id: 'mav-old',
        creation_nonce: 'verification-create-old', canonical_digest: 'a'.repeat(64),
      }],
    };
    const current = {
      ...locked,
      batch_id: 'nr-20260721-proofrev0002', batch_revision: 3,
      manual_verifications: [{
        ...locked.manual_verifications[0], verification_id: 'mav-new',
        creation_nonce: 'verification-create-new', canonical_digest: 'b'.repeat(64),
      }],
    };
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot)
      .mockResolvedValueOnce(locked)
      .mockResolvedValue(current);
    await buildStagedDailyCodexPayload(env, 'foundation', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });

    await expect(buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' }))
      .rejects.toThrow('manual_news_finalize_snapshot_stale');
  });

  test('finalize revalidates manual proofs after payload construction and before network consumption', async () => {
    const manualId = 'blog:manual:ml-20260811-finalize02';
    const lockedSnapshot = {
      batch_id: 'nr-20260721-finalize0001', batch_revision: 2,
      selection_hash: `sha256:${'3'.repeat(64)}`, selected_ids: [manualId, 'news:1'],
      manual_verifications: [{
        item_id: manualId, lead_id: manualId.slice('blog:manual:'.length),
        verification_id: 'verification-1', creation_nonce: 'nonce', canonical_digest: 'a'.repeat(64),
      }],
    };
    const { env, setPool, pools } = makeEnv();
    seedAll(setPool);
    setPool('2026-07-21', 'news', [manualId, 'news:1']);
    vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue([manualId, 'news:1']);
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(lockedSnapshot);
    for (const stage of ['foundation', 'editorial', 'papers'] as const) {
      await buildStagedDailyCodexPayload(env, stage, { date: '2026-07-21', persistRevision: true });
      const key = `2026-07-21-08|_codex_stage_${stage}|meta`;
      const state = JSON.parse(pools.get(key)!.items_meta!);
      pools.get(key)!.items_meta = JSON.stringify({ ...state, pushed_at: 123 });
    }
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot)
      .mockResolvedValueOnce(lockedSnapshot)
      .mockResolvedValue({
        ...lockedSnapshot,
        batch_id: 'nr-20260721-finalize0002', batch_revision: 3,
        selected_ids: ['news:1'], manual_verifications: [],
      });
    Object.assign(env as object, {
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
      API_BASE: 'https://staging-api.ai-feeds.com',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 202 }));
    const verificationCallsBeforeFinalize = vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mock.calls.length;

    const result = await pushDailyStageToCodex(env, 'finalize', '2026-07-21');

    expect(result).toMatchObject({ ok: false, stage: 'finalize', error: expect.stringContaining('manual_news_finalize_snapshot_stale') });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mock.calls.length - verificationCallsBeforeFinalize).toBe(2);
  });

  test('editorial fails closed when a selected item is soft-deleted after selection verification', async () => {
    const manualId = 'blog:manual:ml-20260811-softdelete';
    const { env, setPool, deletedIds } = makeEnv();
    setPool('2026-07-21', 'news', [manualId]);
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockImplementation(async () => {
      deletedIds.add(manualId);
      return {
        batch_id: 'nr-20260721-softdelete01', batch_revision: 2,
        selection_hash: `sha256:${'4'.repeat(64)}`, selected_ids: [manualId],
        manual_verifications: [{
          item_id: manualId, lead_id: 'ml-20260811-softdelete', verification_id: 'mav-softdelete',
          creation_nonce: 'verification-create-softdelete', canonical_digest: 'c'.repeat(64),
        }],
      };
    });

    await expect(buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21' }))
      .rejects.toThrow('missing_or_deleted_items');
  });

  test('keeps the video-only final source order even when the shared X pool is populated', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    const foundation = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    await buildStagedDailyCodexPayload(env, 'editorial', { date: '2026-07-21', persistRevision: true });
    await buildStagedDailyCodexPayload(env, 'papers', { date: '2026-07-21', persistRevision: true });
    const final = await buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' });

    expect(foundation.digest.meta.final_source_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.digest.meta.final_source_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.section_order).toEqual(['news', 'ph', 'gh', 'hf-paper']);
    expect(final.final_manifest?.items.some((item) => item.source === 'x')).toBe(false);
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(exactReceiptResponse);
    const pushed = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');

    expect(pushed).toMatchObject({ ok: true, stage: 'foundation', revision: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://staging-render.example.test/aifeeds/api/daily/ingest',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((await getDailyStageState(env, '2026-07-21', 'foundation'))?.pushed_at).toEqual(expect.any(Number));
  });

  test('R05 rejects a non-exact HK receipt and leaves the stage unacknowledged', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      receipt: {
        date: '2026-07-21', batch_id: 'daily-2026-07-21-normal', stage: 'foundation', revision: 1,
        content_hash: `sha256:${'f'.repeat(64)}`, render_key: 'wrong-render-key',
      },
    }), { status: 202, headers: { 'content-type': 'application/json' } }));

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');

    expect(result).toMatchObject({ ok: false, stage: 'foundation', error: 'receipt_mismatch' });
    const pending = await getDailyStageState(env, '2026-07-21', 'foundation');
    expect(pending?.pushed_at).toBeUndefined();
    expect(pending).toMatchObject({ attempt_count: 1, last_error: 'receipt_mismatch' });
  });

  test('DRD-003 HK HTTP failure keeps the status but never persists or returns its raw response body', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    const tokenSentinel = 'hk-token-sentinel-8f462c';
    const reviewSentinel = 'review-secret-sentinel-90bd21';
    const bodySentinel = 'hk-response-body-sentinel-4ce177';
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: tokenSentinel,
      DAILY_NEWS_REVIEW_SECRET: reviewSentinel,
      DAILY_PUSH_STAGING_ENDPOINT: 'https://user:query-secret@staging-render.example.test/aifeeds/api/daily/ingest?token=query-secret',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `${bodySentinel} Bearer body-bearer ${tokenSentinel} ${reviewSentinel}`,
      { status: 502 },
    ));

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');
    const pending = await getDailyStageState(env, '2026-07-21', 'foundation');
    const exposed = JSON.stringify({ result, pending });

    expect(result).toMatchObject({ ok: false, stage: 'foundation', error: expect.stringContaining('http_502') });
    for (const sentinel of [bodySentinel, tokenSentinel, reviewSentinel, 'body-bearer', 'query-secret']) {
      expect(exposed).not.toContain(sentinel);
    }
  });

  test('DRD-003 thrown delivery errors redact exact secrets, bearer credentials, and credentialed URLs', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    const tokenSentinel = 'hk-token-sentinel-a19ec0';
    const reviewSentinel = 'review-secret-sentinel-f3e980';
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: tokenSentinel,
      DAILY_NEWS_REVIEW_SECRET: reviewSentinel,
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(
      `transport exploded Bearer arbitrary-bearer ${tokenSentinel} ${reviewSentinel} `
      + 'https://url-user:url-pass@hk.example/private?token=url-query-secret',
    ));

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');
    const pending = await getDailyStageState(env, '2026-07-21', 'foundation');
    const exposed = JSON.stringify({ result, pending });

    expect(result).toMatchObject({ ok: false, stage: 'foundation', error: expect.stringContaining('transport exploded') });
    for (const sentinel of [
      tokenSentinel, reviewSentinel, 'arbitrary-bearer', 'url-user', 'url-pass', 'url-query-secret', 'hk.example',
    ]) expect(exposed).not.toContain(sentinel);
  });

  test('R01 a lost HK response replays the exact identity and records the eventual exact receipt', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('response_lost'))
      .mockImplementationOnce(exactReceiptResponse);

    const result = await pushDailyStageToCodex(env, 'editorial', '2026-07-21', { origin: 'review' });

    expect(result).toMatchObject({ ok: true, stage: 'editorial', revision: 1 });
    const identities = fetchMock.mock.calls.map((call) => {
      const payload = JSON.parse(String(call[1]?.body));
      return [payload.date, payload.batch_id, payload.stage, payload.revision, payload.content_hash, payload.render_key];
    });
    expect(identities[1]).toEqual(identities[0]);
    expect((await getDailyStageState(env, '2026-07-21', 'editorial'))?.pushed_at).toEqual(expect.any(Number));
  });

  test('DRD-002 stale success metadata cannot overwrite a newer staged revision', async () => {
    const { env, setPool, pools, setBeforeStageMutation } = makeEnv();
    seedAll(setPool);
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    const original = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    const stateKey = '2026-07-21-08|_codex_stage_foundation|meta';
    const newerHash = `sha256:${'9'.repeat(64)}`;
    let interleaved = false;
    setBeforeStageMutation(({ sql, binds }) => {
      const proposed = /INSERT INTO digest_pool/i.test(sql) && typeof binds[4] === 'string'
        ? JSON.parse(binds[4]) as Record<string, unknown>
        : null;
      if (interleaved || !(sql.includes("'$.pushed_at'") || proposed?.pushed_at)) return;
      interleaved = true;
      const row = pools.get(stateKey)!;
      const current = JSON.parse(row.items_meta!) as Record<string, unknown>;
      const { pushed_at: _pushedAt, ...withoutPushed } = current;
      row.items_meta = JSON.stringify({
        ...withoutPushed, revision: original.revision + 1, content_hash: newerHash,
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(exactReceiptResponse);

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');
    const current = await getDailyStageState(env, '2026-07-21', 'foundation');

    expect(interleaved).toBe(true);
    expect(result).toMatchObject({ ok: false, stage: 'foundation', error: expect.stringContaining('stage_state_changed') });
    expect(current).toMatchObject({ revision: original.revision + 1, content_hash: newerHash });
    expect(current?.pushed_at).toBeUndefined();
  });

  test('DRD-002 stale failure observation cannot overwrite a newer staged revision', async () => {
    const { env, setPool, pools, setBeforeStageMutation } = makeEnv();
    seedAll(setPool);
    Object.assign(env as object, {
      API_BASE: 'https://staging-api.ai-feeds.com',
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
    });
    const original = await buildStagedDailyCodexPayload(env, 'foundation', {
      date: '2026-07-21', persistRevision: true,
    });
    const stateKey = '2026-07-21-08|_codex_stage_foundation|meta';
    const newerHash = `sha256:${'8'.repeat(64)}`;
    let interleaved = false;
    setBeforeStageMutation(({ sql, binds }) => {
      const proposed = /INSERT INTO digest_pool/i.test(sql) && typeof binds[4] === 'string'
        ? JSON.parse(binds[4]) as Record<string, unknown>
        : null;
      if (interleaved || !(sql.includes("'$.attempt_count'") || proposed?.last_error === 'receipt_mismatch')) return;
      interleaved = true;
      const row = pools.get(stateKey)!;
      const current = JSON.parse(row.items_meta!) as Record<string, unknown>;
      row.items_meta = JSON.stringify({
        ...current, revision: original.revision + 1, content_hash: newerHash, last_error: '',
      });
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      receipt: {
        date: '2026-07-21', batch_id: 'daily-2026-07-21-normal', stage: 'foundation',
        revision: original.revision, content_hash: original.content_hash, render_key: 'wrong-render-key',
      },
    }), { status: 202, headers: { 'content-type': 'application/json' } }));

    const result = await pushDailyStageToCodex(env, 'foundation', '2026-07-21');
    const current = await getDailyStageState(env, '2026-07-21', 'foundation');

    expect(interleaved).toBe(true);
    expect(result).toMatchObject({ ok: false, stage: 'foundation', error: 'receipt_mismatch' });
    expect(current).toMatchObject({ revision: original.revision + 1, content_hash: newerHash, last_error: '' });
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

  test('v1 rebuilds and reauthorizes the exact news body before every HTTP attempt', async () => {
    const { env, setPool } = makeEnv();
    setPool('2026-07-21', 'news', ['blog:openai:release']);
    setPool('2026-07-21', 'ph', ['product_hunt:stable:2026-07-21']);
    Object.assign(env as object, {
      NEWS_CODEX_PUSH: '1',
      X_CARD_SHARED_TOKEN: 'test-token',
      API_BASE: 'https://api.ai-feeds.com',
      DAILY_PUSH_ENDPOINT: 'https://render.example.test/ingest',
    });
    let authorizations = 0;
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => {
      authorizations += 1;
      const allowedIds = authorizations <= 2 ? [...ids] : [];
      return {
        allowed_ids: allowedIds,
        decisions: ids.map((id) => ({
          item_id: id, allowed: allowedIds.includes(id),
          code: allowedIds.includes(id) ? 'ALLOW_SCHEDULED_FORMAL' as const : 'DENY_SOURCE_DISABLED' as const,
        })),
      };
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('retry', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok', status: 'queued' }), { status: 202 }));

    const result = await pushDailyToCodex(env, 8, '2026-07-21');

    expect(result.ok).toBe(true);
    expect(authorizations).toBe(3);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as DailyBody;
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as DailyBody;
    expect(newsIds(first)).toEqual(['blog:openai:release']);
    expect(newsIds(second)).toEqual([]);
    expect(first.render_key).not.toBe(second.render_key);
  });

  test('staged editorial retry fails closed when current authorization changes after the first attempt', async () => {
    const { env, setPool } = makeEnv();
    setPool('2026-07-21', 'news', ['blog:openai:release']);
    Object.assign(env as object, {
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/ingest',
      API_BASE: 'https://staging-api.ai-feeds.com',
    });
    let authorizations = 0;
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => {
      authorizations += 1;
      return {
        allowed_ids: authorizations <= 2 ? [...ids] : [],
        decisions: ids.map((id) => ({
          item_id: id, allowed: authorizations <= 2,
          code: authorizations <= 2 ? 'ALLOW_SCHEDULED_FORMAL' as const : 'DENY_EXPLICIT_ITEM_RADAR' as const,
        })),
      };
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('retry', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));

    const result = await pushDailyStageToCodex(env, 'editorial', '2026-07-21');

    expect(result).toMatchObject({ ok: false, stage: 'editorial', error: expect.stringContaining('empty_stage:editorial') });
    expect(authorizations).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('finalize rejects a locked editorial snapshot whose news authorization is no longer current', async () => {
    const { env, setPool } = makeEnv();
    seedAll(setPool);
    for (const stage of ['foundation', 'editorial', 'papers'] as const) {
      await buildStagedDailyCodexPayload(env, stage, { date: '2026-07-21', persistRevision: true });
    }
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
      allowed_ids: [],
      decisions: ids.map((id) => ({ item_id: id, allowed: false, code: 'DENY_SOURCE_RADAR' as const })),
    }));

    await expect(buildStagedDailyCodexPayload(env, 'finalize', { date: '2026-07-21' }))
      .rejects.toThrow('stale_editorial_authorization_requires_superseding_revision');
  });
});

interface DailyBody {
  render_key: string;
  digest: { sections: { normal: Array<{ source: string; items: Array<{ item_id: string }> }> } };
}

function newsIds(body: DailyBody): string[] {
  return body.digest.sections.normal.find((section) => section.source === 'news')?.items.map((item) => item.item_id) || [];
}

// HK 下游靠 origin 区分「人审序列」和「自动排序」，2026-08-19 之前所有推送只有
// source: 'cloudflare-daily-staged',面板无法拒绝自动推送覆盖人审 r2。
describe('staged push origin contract', () => {
  const date = '2026-07-21';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue(null);
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(false);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue([]);
    vi.mocked(getVerifiedNewsReviewSelectionSnapshot).mockResolvedValue(null);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: { candidate_ids: [], candidates: [], default_selected_ids: [], applied_selected_ids: [] },
      changed: false,
      dropped_ids: [],
      manual_verifications: [],
    } as never);
  });

  function pushableEnv() {
    const state = makeEnv();
    seedAll(state.setPool);
    Object.assign(state.env as object, {
      X_CARD_SHARED_TOKEN: 'test-token',
      DAILY_PUSH_STAGING_ENDPOINT: 'https://staging-render.example.test/aifeeds/api/daily/ingest',
      API_BASE: 'https://staging-api.ai-feeds.com',
    });
    return state;
  }

  async function lockInputStages(env: Env): Promise<void> {
    for (const stage of ['foundation', 'editorial', 'papers'] as const) {
      await buildStagedDailyCodexPayload(env, stage, { date, persistRevision: true });
    }
  }

  test('marks a review submission push as review regardless of the batch flag lookup', async () => {
    const { env } = pushableEnv();
    // 人审提交路径显式传 review：即使标记读取退化成 false 也不能降级成 auto。
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(false);

    const payload = await buildStagedDailyCodexPayload(env, 'editorial', { date, origin: 'review' });

    expect(payload.origin).toBe('review');
    expect(payload.source).toBe('cloudflare-daily-staged');
  });

  test('infers auto for the morning push and review once the day carries a human selection', async () => {
    const { env } = pushableEnv();

    const beforeReview = await buildStagedDailyCodexPayload(env, 'editorial', { date });
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(true);
    const afterReview = await buildStagedDailyCodexPayload(env, 'editorial', { date });

    expect(beforeReview.origin).toBe('auto');
    expect(afterReview.origin).toBe('review');
  });

  test('carries the inherited review origin into the 08:00 finalize push', async () => {
    const { env } = pushableEnv();
    await lockInputStages(env);
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(true);

    const finalize = await buildStagedDailyCodexPayload(env, 'finalize', { date });

    expect(finalize.origin).toBe('review');
  });

  test('keeps foundation and papers on auto because they carry no news section', async () => {
    const { env } = pushableEnv();
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(true);
    const lookupsBefore = vi.mocked(hasHumanReviewedNewsSelection).mock.calls.length;

    const foundation = await buildStagedDailyCodexPayload(env, 'foundation', { date });
    const papers = await buildStagedDailyCodexPayload(env, 'papers', { date });

    expect([foundation.origin, papers.origin]).toEqual(['auto', 'auto']);
    expect(vi.mocked(hasHumanReviewedNewsSelection).mock.calls.length).toBe(lookupsBefore);
  });

  test('origin stays out of content_hash and render_key so a re-push keeps its revision', async () => {
    const { env } = pushableEnv();

    const auto = await buildStagedDailyCodexPayload(env, 'editorial', { date, persistRevision: true });
    const review = await buildStagedDailyCodexPayload(env, 'editorial', {
      date, persistRevision: true, origin: 'review',
    });

    expect(review.origin).toBe('review');
    expect(auto.origin).toBe('auto');
    expect(review.content_hash).toBe(auto.content_hash);
    expect(review.render_key).toBe(auto.render_key);
    expect(review.revision).toBe(auto.revision);
  });

  test('sends origin on the wire and reports it back to the ops caller', async () => {
    const { env } = pushableEnv();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(exactReceiptResponse);

    const reviewed = await pushDailyStageToCodex(env, 'editorial', date, { origin: 'review' });
    const reviewedBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    vi.mocked(hasHumanReviewedNewsSelection).mockResolvedValue(false);
    const automatic = await pushDailyStageToCodex(env, 'foundation', date);
    const automaticBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));

    expect(reviewed).toMatchObject({ ok: true, stage: 'editorial', origin: 'review' });
    expect(reviewedBody.origin).toBe('review');
    expect(automatic).toMatchObject({ ok: true, stage: 'foundation', origin: 'auto' });
    expect(automaticBody.origin).toBe('auto');
  });
});
