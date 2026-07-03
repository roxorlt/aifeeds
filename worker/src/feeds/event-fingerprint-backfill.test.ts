import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEventFingerprintBackfillRequestHeaders,
  eventFingerprintBackfillRuntimeOptions,
  parseEventFingerprintBackfillOptions,
  shouldScheduleNextEventFingerprintBackfillBatch,
} from './event-fingerprint-backfill';

test('parseEventFingerprintBackfillOptions defaults to a safe async 7-day background batch', () => {
  const url = new URL('https://api.ai-feeds.com/api/enrich/run?mode=feed-event-fingerprint-backfill');

  const opts = parseEventFingerprintBackfillOptions(url);

  assert.equal(opts.days, 7);
  assert.equal(opts.limit, 4);
  assert.equal(opts.maxBatches, 640);
  assert.equal(opts.throttleMs, 100);
  assert.equal(opts.force, false);
  assert.equal(opts.async, true);
  assert.equal(opts.retryFailed, false);
  assert.equal(opts.itemId, '');
});

test('parseEventFingerprintBackfillOptions clamps expensive background knobs', () => {
  const url = new URL(
    'https://api.ai-feeds.com/api/enrich/run?mode=feed-event-fingerprint-backfill&days=99&limit=999&max_batches=9999&throttle_ms=9999&force=1&async=0&retry_failed=1&item_id=blog:test:1',
  );

  const opts = parseEventFingerprintBackfillOptions(url);

  assert.equal(opts.days, 14);
  assert.equal(opts.limit, 12);
  assert.equal(opts.maxBatches, 1000);
  assert.equal(opts.throttleMs, 1000);
  assert.equal(opts.force, true);
  assert.equal(opts.async, false);
  assert.equal(opts.retryFailed, true);
  assert.equal(opts.itemId, 'blog:test:1');
});

test('shouldScheduleNextEventFingerprintBackfillBatch only continues when the current batch made progress', () => {
  assert.equal(
    shouldScheduleNextEventFingerprintBackfillBatch({
      batchIndex: 1,
      maxBatches: 3,
      found: 4,
      done: 4,
      failed: 0,
      limit: 4,
    }),
    true,
  );
  assert.equal(
    shouldScheduleNextEventFingerprintBackfillBatch({
      batchIndex: 3,
      maxBatches: 3,
      found: 4,
      done: 4,
      failed: 0,
      limit: 4,
    }),
    false,
  );
  assert.equal(
    shouldScheduleNextEventFingerprintBackfillBatch({
      batchIndex: 1,
      maxBatches: 3,
      found: 4,
      done: 0,
      failed: 4,
      limit: 4,
    }),
    false,
  );
  assert.equal(
    shouldScheduleNextEventFingerprintBackfillBatch({
      batchIndex: 1,
      maxBatches: 3,
      found: 2,
      done: 2,
      failed: 0,
      limit: 4,
    }),
    false,
  );
});

test('buildEventFingerprintBackfillRequestHeaders includes enrich auth and origin bypass headers', () => {
  const headers = buildEventFingerprintBackfillRequestHeaders({
    INGEST_TOKEN: 'ingest-token',
    DEV_TOKEN: 'dev-token',
    ORIGIN_SECRET: 'origin-secret',
  });

  assert.equal(headers.Authorization, 'Bearer ingest-token');
  assert.equal(headers['X-Dev-Token'], 'dev-token');
  assert.equal(headers['X-Origin-Secret'], 'origin-secret');
  assert.equal(headers['User-Agent'], 'aifeeds-worker-event-fingerprint-backfill/1.0');
});

test('eventFingerprintBackfillRuntimeOptions caps async background batches to one pro call', () => {
  const opts = parseEventFingerprintBackfillOptions(
    new URL('https://api.ai-feeds.com/api/enrich/run?mode=feed-event-fingerprint-backfill&limit=12'),
  );

  const runtime = eventFingerprintBackfillRuntimeOptions(opts);

  assert.equal(runtime.limit, 1);
  assert.equal(runtime.async, true);
});
