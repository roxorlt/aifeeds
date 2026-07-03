import type { Env } from '../index';
import { generateEventFingerprintForFeeds } from './classify-translate';

export interface EventFingerprintBackfillOptions {
  days: number;
  limit: number;
  maxBatches: number;
  throttleMs: number;
  force: boolean;
  async: boolean;
  retryFailed: boolean;
  itemId: string;
  batchIndex: number;
}

export interface EventFingerprintBackfillBatchResult {
  mode: 'feed-event-fingerprint-backfill';
  status: 'done';
  days: number;
  force: boolean;
  retry_failed: boolean;
  item_id: string | null;
  batch_index: number;
  max_batches: number;
  limit: number;
  found: number;
  done: number;
  failed: number;
  elapsed_ms: number;
}

function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number.parseInt(url.searchParams.get(name) || '', 10);
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(n, min), max);
}

export function parseEventFingerprintBackfillOptions(url: URL): EventFingerprintBackfillOptions {
  const days = intParam(url, 'days', 7, 1, 14);
  const limit = intParam(url, 'limit', 4, 1, 12);
  const maxBatches = intParam(url, 'max_batches', 640, 1, 1000);
  const throttleMs = intParam(url, 'throttle_ms', 100, 0, 1000);
  const itemId = (url.searchParams.get('item_id') || '').trim();

  return {
    days,
    limit,
    maxBatches,
    throttleMs,
    force: url.searchParams.get('force') === '1',
    async: url.searchParams.get('async') !== '0',
    retryFailed: url.searchParams.get('retry_failed') === '1',
    itemId,
    batchIndex: intParam(url, 'batch', 1, 1, maxBatches),
  };
}

export function shouldScheduleNextEventFingerprintBackfillBatch(input: {
  batchIndex: number;
  maxBatches: number;
  found: number;
  done: number;
  failed: number;
  limit: number;
}): boolean {
  return (
    input.batchIndex < input.maxBatches &&
    input.found >= input.limit &&
    input.done > 0
  );
}

export function eventFingerprintBackfillRuntimeOptions(
  opts: EventFingerprintBackfillOptions,
): EventFingerprintBackfillOptions {
  if (!opts.async || opts.itemId) return opts;
  return { ...opts, limit: 1, throttleMs: 0 };
}

export function buildNextEventFingerprintBackfillUrl(currentUrl: URL, opts: EventFingerprintBackfillOptions): string {
  const next = new URL(currentUrl.toString());
  next.searchParams.set('mode', 'feed-event-fingerprint-backfill');
  next.searchParams.set('async', '1');
  next.searchParams.set('days', String(opts.days));
  next.searchParams.set('limit', String(opts.limit));
  next.searchParams.set('max_batches', String(opts.maxBatches));
  next.searchParams.set('throttle_ms', String(opts.throttleMs));
  next.searchParams.set('batch', String(opts.batchIndex + 1));
  if (opts.force) next.searchParams.set('force', '1');
  else next.searchParams.delete('force');
  if (opts.retryFailed) next.searchParams.set('retry_failed', '1');
  else next.searchParams.delete('retry_failed');
  next.searchParams.delete('item_id');
  return next.toString();
}

export function buildEventFingerprintBackfillRequestHeaders(env: {
  INGEST_TOKEN?: string;
  DEV_TOKEN?: string;
  ORIGIN_SECRET?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'aifeeds-worker-event-fingerprint-backfill/1.0',
  };
  if (env.INGEST_TOKEN) headers.Authorization = `Bearer ${env.INGEST_TOKEN}`;
  if (env.DEV_TOKEN) headers['X-Dev-Token'] = env.DEV_TOKEN;
  if (env.ORIGIN_SECRET) headers['X-Origin-Secret'] = env.ORIGIN_SECRET;
  return headers;
}

export async function runEventFingerprintBackfillBatch(
  env: Env,
  opts: EventFingerprintBackfillOptions,
  generate: typeof generateEventFingerprintForFeeds = generateEventFingerprintForFeeds,
): Promise<EventFingerprintBackfillBatchResult> {
  const t0 = Date.now();
  const rows = await selectPendingEventFingerprintItems(env, opts);
  let done = 0;
  let failed = 0;

  for (const [i, r] of rows.entries()) {
    const kind: 'blog' | 'podcast' = r.source_type === 'podcast' ? 'podcast' : 'blog';
    try {
      const res = await generate(env, r.id, { kind });
      if (res.ok) done++;
      else failed++;
    } catch (e) {
      failed++;
      await markEventFingerprintBackfillFailed(env, r.id, e);
    }
    if (opts.throttleMs > 0 && i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, opts.throttleMs));
    }
  }

  return {
    mode: 'feed-event-fingerprint-backfill',
    status: 'done',
    days: opts.days,
    force: opts.force,
    retry_failed: opts.retryFailed,
    item_id: opts.itemId || null,
    batch_index: opts.batchIndex,
    max_batches: opts.maxBatches,
    limit: opts.limit,
    found: rows.length,
    done,
    failed,
    elapsed_ms: Date.now() - t0,
  };
}

async function selectPendingEventFingerprintItems(
  env: Pick<Env, 'DB'>,
  opts: EventFingerprintBackfillOptions,
): Promise<Array<{ id: string; source_type: string }>> {
  const missingFingerprint = opts.force ? '' : "AND json_extract(extra,'$.event_fingerprint') IS NULL";
  const skipFailed = opts.retryFailed || opts.force
    ? ''
    : "AND (json_extract(extra,'$.event_fingerprint_failed_at') IS NULL OR json_extract(extra,'$.event_fingerprint_failed_at') = '')";

  if (opts.itemId) {
    const res = await env.DB.prepare(
      `SELECT id, source_type FROM items
        WHERE id = ?
          AND source_type IN ('blog','podcast')
          AND is_relevant = 1
          AND deleted_at IS NULL
          ${missingFingerprint}
          ${skipFailed}
        LIMIT 1`,
    ).bind(opts.itemId).all<{ id: string; source_type: string }>();
    return res.results || [];
  }

  const res = await env.DB.prepare(
    `SELECT id, source_type FROM items
      WHERE source_type IN ('blog','podcast') AND is_relevant = 1
        AND datetime(scraped_at) >= datetime('now', ?)
        AND deleted_at IS NULL
        ${missingFingerprint}
        ${skipFailed}
      ORDER BY published_at DESC LIMIT ?`,
  ).bind(`-${opts.days} day`, opts.limit).all<{ id: string; source_type: string }>();
  return res.results || [];
}

async function markEventFingerprintBackfillFailed(
  env: Pick<Env, 'DB'>,
  itemId: string,
  error: unknown,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE items
        SET extra = json_set(
          coalesce(extra,'{}'),
          '$.event_fingerprint_failed_at', ?,
          '$.event_fingerprint_failed_reason', ?
        )
        WHERE id = ?`,
    ).bind(new Date().toISOString(), String(error).slice(0, 300), itemId).run();
  } catch {
    // Failure marker is best-effort; the caller already counted this row as failed.
  }
}
