import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { FEED_REGISTRY } from '../feeds/registry';
import {
  ackWarningOutboxRows,
  buildWarningOutboxEvent,
  enqueueWarningOutboxEvent,
  produceWorkflowRetryExhaustedWarnings,
} from './warning-outbox';

const migration = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../migrations/039-warning-outbox.sql',
), 'utf8');
const canonicalMigration = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../migrations/041-warning-subject-canonicalization.sql',
), 'utf8');
const NOW = Date.parse('2026-08-27T12:30:00.000Z');
const BLOG = FEED_REGISTRY.find((feed) => feed.id === 'blog:openai')!;
const PODCAST = FEED_REGISTRY.find((feed) => feed.kind === 'podcast')!;

function harness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT, source_ref TEXT,
      extra TEXT, scraped_at TEXT, deleted_at INTEGER, pending_workflow INTEGER DEFAULT 1
    );
    CREATE TABLE sources (id TEXT PRIMARY KEY, source_type TEXT, source_ref TEXT, config TEXT);
  `);
  sqlite.exec(migration);
  sqlite.exec(canonicalMigration);
  sqlite.prepare(`UPDATE warning_subject_scan_cursors SET
    initial_backfill_complete=1,future_hook_contract_version=1,ready=1,updated_at_ms=?`).run(NOW);
  let beforeBatch: (() => void) | null = null;
  const sourceInsert = sqlite.prepare('INSERT INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)');
  sourceInsert.run(BLOG.id, BLOG.kind, BLOG.key, JSON.stringify(BLOG));
  sourceInsert.run(PODCAST.id, PODCAST.kind, PODCAST.key, JSON.stringify(PODCAST));
  const DB = {
    prepare(sql: string) {
      let binds: SQLInputValue[] = [];
      const stmt = {
        bind(...values: unknown[]) { binds = values as SQLInputValue[]; return stmt; },
        async first<T>() { return (sqlite.prepare(sql).get(...binds) || null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...binds) as T[] }; },
        async run() {
          const result = sqlite.prepare(sql).run(...binds);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const hook = beforeBatch;
      beforeBatch = null;
      hook?.();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    sqlite,
    env: { DB, WARNING_OUTBOX_PRODUCER_ENABLED: '1', WARNING_OUTBOX_DRAIN_ENABLED: '1' } as never,
    beforeNextBatch(hook: () => void) { beforeBatch = hook; },
    insert(id: string, options: {
      sourceType?: 'blog' | 'podcast'; feed?: typeof BLOG; extra?: string; sourceRef?: string | null; scrapedAt?: string;
    } = {}) {
      const feed = options.feed || BLOG;
      const sourceType = options.sourceType || 'blog';
      const extra = options.extra ?? JSON.stringify({
        feed_id: feed.id, feed_key: feed.key, workflow_recovery_attempts: 6,
      });
      sqlite.prepare(`INSERT INTO items(id,source_type,source_id,source_ref,extra,scraped_at)
        VALUES(?,?,?,?,?,?)`).run(
        id, sourceType, id.split(':').slice(1).join(':'), options.sourceRef ?? null,
        extra, options.scrapedAt || '2026-08-27T10:00:00.000Z',
      );
      const itemRowid = Number((sqlite.prepare('SELECT rowid FROM items WHERE id=?').get(id) as { rowid: number }).rowid);
      const canonicalId = id.normalize('NFC');
      const canonicalRowId = createHash('sha256')
        .update(`warning-subject\0${sourceType}\0v1\0${canonicalId}`).digest('hex');
      if (new TextEncoder().encode(canonicalId).byteLength > 1024) {
        sqlite.prepare(`INSERT INTO warning_subject_aliases(
          source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
          item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms
        ) VALUES(?,?,?,1,?,?,'quarantined','CANONICAL_SUBJECT_INVALID',?,?)`).run(
          sourceType, id, canonicalId, canonicalRowId, itemRowid, NOW, NOW,
        );
      } else if (options.extra !== '{bad-json') {
        sqlite.prepare(`INSERT INTO warning_canonical_subjects(
          source_type,canonical_subject_id,canonical_version,canonical_row_id,first_item_rowid,
          sort_attempts,sort_scraped_at,sort_raw_subject_id,state,created_at_ms,updated_at_ms
        ) VALUES(?,?,1,?,?,6,?,?,'mapped',?,?)
        ON CONFLICT(source_type,canonical_subject_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms`).run(
          sourceType, canonicalId, canonicalRowId, itemRowid,
          options.scrapedAt || '2026-08-27T10:00:00.000Z', id, NOW, NOW,
        );
        sqlite.prepare(`INSERT INTO warning_subject_aliases(
          source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
          item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms
        ) VALUES(?,?,?,1,?,?,'mapped',NULL,?,?)`).run(
          sourceType, id, canonicalId, canonicalRowId, itemRowid, NOW, NOW,
        );
      }
    },
  };
}

async function injectCorruptDeliverable(
  h: ReturnType<typeof harness>,
  subjectId: string,
  state: 'pending' | 'leased' | 'delivered',
  options: { leaseUntil?: number; leaseOwner?: string; attempts?: number; corrupt?: boolean } = {},
) {
  const event = await buildWarningOutboxEvent('blog', subjectId, NOW);
  h.beforeNextBatch(() => {
    h.sqlite.prepare(`INSERT INTO warning_outbox (
      event_id,schema_version,event_type,source_type,subject_id,dedup_period,observed_at_ms,
      record_kind,payload_json,payload_sha256,state,attempts,next_retry_at_ms,lease_owner,lease_until_ms,
      created_at_ms,updated_at_ms,delivered_at_ms,failed_at_ms,last_error_code,last_error_detail,expires_at_ms
    ) VALUES (?,?,?,?,?,?,?,'deliverable',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.event_id, 1, event.event_type, event.source_type, event.subject_id, event.dedup_period,
      event.observed_at_ms, event.payload_json,
      options.corrupt === false ? event.payload_sha256 : '0'.repeat(64), state, options.attempts ?? 0,
      state === 'pending' ? NOW : null, state === 'leased' ? options.leaseOwner || 'owner' : null,
      state === 'leased' ? options.leaseUntil ?? NOW + 60_000 : null, NOW, NOW,
      state === 'delivered' ? NOW - 1 : null, null, null, null,
      state === 'delivered' ? NOW + 30 * 24 * 60 * 60_000 : null,
    );
  });
  return event;
}

describe('warning outbox bounded fair producer', () => {
  test('scans 61 eligible rows across real keyset pages in one hourly invocation', async () => {
    const h = harness();
    for (let i = 0; i < 61; i++) h.insert(`blog:openai:item-${String(i).padStart(3, '0')}`);
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({ status: 'ok', pages_scanned: 2, scanned_rows: 61, alert_enqueued: 61, scan_cap_reached: false });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 61 });
  });

  test('caps at 200 and advances deterministically on the next hourly invocation', async () => {
    const h = harness();
    for (let i = 0; i < 205; i++) h.insert(`blog:openai:item-${String(i).padStart(3, '0')}`);
    const first = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    const second = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW + 60 * 60_000);
    expect(first).toMatchObject({ pages_scanned: 4, scanned_rows: 200, alert_enqueued: 200, scan_cap_reached: true });
    expect(second).toMatchObject({ pages_scanned: 1, scanned_rows: 5, alert_enqueued: 5, scan_cap_reached: false });
  });

  test('applies an independent bounded budget to mixed blog and podcast source lanes', async () => {
    const h = harness();
    for (let i = 0; i < 250; i++) h.insert(`blog:openai:mixed-${String(i).padStart(3, '0')}`);
    for (let i = 0; i < 61; i++) {
      h.insert(`podcast:${PODCAST.key}:mixed-${String(i).padStart(3, '0')}`, {
        feed: PODCAST,
        sourceType: 'podcast',
        extra: JSON.stringify({
          feed_id: PODCAST.id, show_key: PODCAST.key, workflow_recovery_attempts: 6,
        }),
      });
    }
    const blog = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    const podcast = await produceWorkflowRetryExhaustedWarnings(h.env, 'podcast', NOW);
    expect(blog).toMatchObject({ scanned_rows: 200, alert_enqueued: 200, scan_cap_reached: true });
    expect(podcast).toMatchObject({ scanned_rows: 61, alert_enqueued: 61, scan_cap_reached: false });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 261 });
  });

  test('excludes the first 50 existing current-period tuples before LIMIT so item 51 advances immediately', async () => {
    const h = harness();
    for (let i = 0; i < 51; i++) {
      const id = `blog:openai:existing-${String(i).padStart(2, '0')}`;
      h.insert(id);
      if (i < 50) await enqueueWarningOutboxEvent(h.env, 'blog', id, NOW);
    }
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({ scanned_rows: 1, alert_enqueued: 1, scan_cap_reached: false });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 51 });
  });

  test('excludes 200 canonically equivalent Unicode tuples before the scan cap', async () => {
    const h = harness();
    const marks = ['\u0334', '\u0327', '\u0323', '\u0301', '\u0315', '\u0345'];
    const permutations: string[][] = [];
    const collect = (prefix: string[], remaining: string[]) => {
      if (permutations.length >= 200) return;
      if (!remaining.length) {
        permutations.push(prefix);
        return;
      }
      for (let index = 0; index < remaining.length && permutations.length < 200; index++) {
        collect(
          [...prefix, remaining[index]],
          [...remaining.slice(0, index), ...remaining.slice(index + 1)],
        );
      }
    };
    collect([], marks);
    const aliases = permutations.map((order) => `blog:openai:a${order.join('')}`);
    expect(new Set(aliases.map((id) => id.normalize('NFC'))).size).toBe(1);
    for (const id of aliases) h.insert(id);
    h.insert('blog:openai:z-valid-after-canonical-aliases');
    await enqueueWarningOutboxEvent(h.env, 'blog', aliases[0], NOW);

    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);

    expect(result).toMatchObject({
      scanned_rows: 1, alert_enqueued: 1, alert_duplicates: 0,
      alert_legacy_owned: 0, alert_bridge_suppressed: 200,
      bridge_duplicate_possible: 0, scan_cap_reached: false,
    });
    expect(h.sqlite.prepare(
      `SELECT subject_id FROM warning_outbox WHERE subject_id LIKE 'blog:openai:z-%'`,
    ).get()).toEqual({ subject_id: 'blog:openai:z-valid-after-canonical-aliases' });
  });

  test('excludes 200 current-day legacy-owned rows before LIMIT so the following valid row advances', async () => {
    const h = harness();
    for (let i = 0; i < 200; i++) {
      h.insert(`blog:openai:legacy-${String(i).padStart(3, '0')}`, {
        extra: JSON.stringify({
          feed_id: BLOG.id, feed_key: BLOG.key, workflow_recovery_attempts: 6,
          workflow_retry_exhausted_alert_day: '2026-08-27',
        }),
      });
    }
    h.insert('blog:openai:valid-after-legacy');
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({ scanned_rows: 1, alert_enqueued: 1 });
    expect(h.sqlite.prepare('SELECT subject_id FROM warning_outbox').get()).toEqual({ subject_id: 'blog:openai:valid-after-legacy' });
  });

  test('malformed extra fails closed before pagination while a later valid exhausted row advances', async () => {
    const h = harness();
    h.insert('blog:openai:malformed', { extra: '{bad-json' });
    h.insert('blog:openai:valid');
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({ malformed_extra_excluded: 1, scanned_rows: 1, alert_enqueued: 1 });
  });

  test('canonical materialization quarantine excludes 200 permanent rejections before the valid producer row', async () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.insert(`blog:openai:${'x'.repeat(1030)}-${String(i).padStart(3, '0')}`);
    h.insert('blog:openai:zzzz-valid-after-quarantine');
    const first = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(first).toMatchObject({ scanned_rows: 1, alert_enqueued: 1, scan_cap_reached: false });
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM warning_subject_aliases WHERE state='quarantined'").get()).toEqual({ n: 200 });
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM warning_outbox WHERE record_kind='producer_quarantine'").get()).toEqual({ n: 0 });
  });

  test('canonical quarantine stores only a bounded reason code and never copies the raw id into outbox detail', async () => {
    const h = harness();
    h.insert(`blog:openai:${'错'.repeat(400)}`);
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result.alert_producer_quarantined).toBe(0);
    const row = h.sqlite.prepare(
      "SELECT last_error_code FROM warning_subject_aliases WHERE state='quarantined'",
    ).get();
    expect(row).toEqual({ last_error_code: 'CANONICAL_SUBJECT_INVALID' });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 0 });
  });

  test('next-day period releases a legacy marker and podcast text-blog stays in the blog lane; manual/unmanaged never do', async () => {
    const h = harness();
    h.insert('blog:openai:yesterday-marker', {
      extra: JSON.stringify({
        feed_id: BLOG.id, feed_key: BLOG.key, workflow_recovery_attempts: 6,
        workflow_retry_exhausted_alert_day: '2026-08-26',
      }),
    });
    h.insert(`podcast:${PODCAST.key}:text-post`, { feed: PODCAST, sourceType: 'blog' });
    h.insert('blog:manual:lead', { sourceRef: 'manual_lead' });
    h.insert('blog:unknown:item', {
      extra: JSON.stringify({ feed_id: 'blog:unknown', feed_key: 'unknown', workflow_recovery_attempts: 6 }),
    });
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result.alert_enqueued).toBe(2);
    expect(h.sqlite.prepare('SELECT subject_id FROM warning_outbox ORDER BY subject_id').all()).toEqual([
      { subject_id: 'blog:openai:yesterday-marker' },
      { subject_id: `podcast:${PODCAST.key}:text-post` },
    ]);
  });

  test('creates a new deterministic event for the same exhausted subject on the next UTC day', async () => {
    const h = harness();
    const id = 'blog:openai:next-day';
    h.insert(id);
    const first = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    const second = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW + 24 * 60 * 60_000);
    expect(first.alert_enqueued).toBe(1);
    expect(second.alert_enqueued).toBe(1);
    expect(h.sqlite.prepare(
      'SELECT dedup_period FROM warning_outbox ORDER BY dedup_period',
    ).all()).toEqual([{ dedup_period: '2026-08-27' }, { dedup_period: '2026-08-28' }]);
  });

  test('discovers the production audio-podcast show_key provenance shape', async () => {
    const h = harness();
    const id = `podcast:${PODCAST.key}:audio-episode`;
    h.insert(id, {
      feed: PODCAST,
      sourceType: 'podcast',
      extra: JSON.stringify({
        feed_id: PODCAST.id,
        show_key: PODCAST.key,
        workflow_recovery_attempts: 6,
      }),
    });
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'podcast', NOW);
    expect(result).toMatchObject({ scanned_rows: 1, alert_enqueued: 1 });
    expect(h.sqlite.prepare('SELECT source_type,subject_id FROM warning_outbox').get()).toEqual({
      source_type: 'podcast', subject_id: id,
    });
  });

  test('concurrent duplicate producers converge to one immutable event while distinct subjects are preserved', async () => {
    const h = harness();
    h.insert('blog:openai:concurrent-a');
    h.insert('blog:openai:concurrent-b');
    const [left, right] = await Promise.all([
      produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW),
      produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW),
    ]);
    expect(left.alert_enqueued + right.alert_enqueued).toBe(2);
    expect(left.alert_duplicates + right.alert_duplicates).toBeGreaterThanOrEqual(0);
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 2 });
  });

  test('a same-day duplicate with a later producer now preserves the first observed payload exactly', async () => {
    const h = harness();
    const id = 'blog:openai:stable-observed';
    h.insert(id);
    const first = await injectCorruptDeliverable(h, id, 'pending', { corrupt: false });
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW + 60 * 60_000);
    expect(result).toMatchObject({ alert_duplicates: 1, alert_integrity_errors: 0 });
    expect(h.sqlite.prepare(
      'SELECT observed_at_ms,payload_json,payload_sha256,created_at_ms,next_retry_at_ms FROM warning_outbox',
    ).get()).toEqual({
      observed_at_ms: NOW, payload_json: first.payload_json, payload_sha256: first.payload_sha256,
      created_at_ms: NOW, next_retry_at_ms: NOW,
    });
  });

  test('duplicate integrity terminalizes only pending or expired-lease rows with exact CAS', async () => {
    for (const state of ['pending', 'leased'] as const) {
      const h = harness();
      const id = `blog:openai:integrity-${state}`;
      h.insert(id);
      await injectCorruptDeliverable(h, id, state, {
        attempts: state === 'leased' ? 3 : 0,
        leaseOwner: 'expired-owner',
        leaseUntil: NOW - 1,
      });
      const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
      expect(result).toMatchObject({ alert_integrity_errors: 1, alert_producer_quarantined: 1 });
      expect(h.sqlite.prepare(
        'SELECT record_kind,state,attempts,lease_owner,lease_until_ms,last_error_code FROM warning_outbox',
      ).get()).toEqual({
        record_kind: 'deliverable', state: 'failed', attempts: state === 'leased' ? 3 : 0,
        lease_owner: null, lease_until_ms: null, last_error_code: 'PRODUCER_DUPLICATE_INTEGRITY',
      });
    }
  });

  test('duplicate integrity never mutates an active lease and its owner can still ack', async () => {
    const h = harness();
    const id = 'blog:openai:integrity-active';
    h.insert(id);
    const event = await injectCorruptDeliverable(h, id, 'leased', {
      attempts: 2, leaseOwner: 'active-owner', leaseUntil: NOW + 60_000,
    });
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({
      alert_integrity_errors: 1, alert_integrity_conflicts_active: 1,
      alert_integrity_conflicts_delivered: 0,
    });
    expect(result.integrity_conflict_count).toBe(1);
    expect(result.integrity_conflict_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.integrity_conflict_sample_tokens).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)]);
    expect(result.alert_producer_quarantine_conflicts).toBe(0);
    expect(h.sqlite.prepare(
      'SELECT state,attempts,lease_owner,lease_until_ms,payload_sha256,last_error_code FROM warning_outbox',
    ).get()).toEqual({
      state: 'leased', attempts: 2, lease_owner: 'active-owner', lease_until_ms: NOW + 60_000,
      payload_sha256: '0'.repeat(64), last_error_code: null,
    });
    expect(await ackWarningOutboxRows(h.env, [event.event_id], 'active-owner', NOW + 1)).toBe(1);
    expect(h.sqlite.prepare('SELECT state FROM warning_outbox').get()).toEqual({ state: 'delivered' });
  });

  test('duplicate integrity never mutates an already delivered row', async () => {
    const h = harness();
    const id = 'blog:openai:integrity-delivered';
    h.insert(id);
    await injectCorruptDeliverable(h, id, 'delivered', { attempts: 1 });
    const result = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(result).toMatchObject({
      alert_integrity_errors: 1, alert_integrity_conflicts_active: 0,
      alert_integrity_conflicts_delivered: 1,
    });
    expect(result.integrity_conflict_count).toBe(1);
    expect(h.sqlite.prepare(
      'SELECT state,attempts,delivered_at_ms,expires_at_ms,payload_sha256,last_error_code FROM warning_outbox',
    ).get()).toEqual({
      state: 'delivered', attempts: 1, delivered_at_ms: NOW - 1,
      expires_at_ms: NOW + 30 * 24 * 60 * 60_000,
      payload_sha256: '0'.repeat(64), last_error_code: null,
    });
  });

  test('producer gate off performs no table access', async () => {
    const DB = { prepare: () => { throw new Error('must not query'); } };
    const result = await produceWorkflowRetryExhaustedWarnings({ DB, WARNING_OUTBOX_PRODUCER_ENABLED: '0' } as never, 'blog', NOW);
    expect(result).toMatchObject({ status: 'disabled', alert_enqueued: 0 });
  });

  test('treats a D1 batch failure as transient without quarantine and retries next invocation', async () => {
    const h = harness();
    h.insert('blog:openai:transient-batch');
    h.beforeNextBatch(() => { throw new Error('D1_BUSY'); });
    const failed = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW);
    expect(failed).toMatchObject({ status: 'partial', alert_enqueue_failed: 1, alert_producer_quarantined: 0 });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_outbox').get()).toEqual({ n: 0 });
    const retried = await produceWorkflowRetryExhaustedWarnings(h.env, 'blog', NOW + 60 * 60_000);
    expect(retried).toMatchObject({ status: 'ok', alert_enqueued: 1 });
  });
});
