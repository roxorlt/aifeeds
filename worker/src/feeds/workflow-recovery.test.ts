import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, assert, expect, test, vi } from 'vitest';

const { pushDeerWarningMock } = vi.hoisted(() => ({
  pushDeerWarningMock: vi.fn(async (_env: unknown, _title: string, _body: string) => true),
}));

vi.mock('../notifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notifier')>()),
  pushDeerWarning: pushDeerWarningMock,
}));

import { runBlogWorkflowRecovery, triggerBlogWorkflowForItem } from '../blog';
import { runPodcastWorkflowRecovery, triggerPodcastWorkflowForItem } from '../podcast';
import { FEED_REGISTRY } from './registry';
import * as feedDedup from './dedup';

const warningOutboxMigration = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)), '../../migrations/039-warning-outbox.sql',
), 'utf8');
const warningCanonicalMigration = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)), '../../migrations/041-warning-subject-canonicalization.sql',
), 'utf8');

type SqlCall = { sql: string; binds: unknown[] };

function recordingDb(rows: Array<{ id: string; extra: string | null; scraped_at: string }> = []) {
  const calls: SqlCall[] = [];
  const db = {
    prepare(sql: string) {
      const call: SqlCall = { sql, binds: [] };
      calls.push(call);
      const statement = {
        bind(...binds: unknown[]) {
          call.binds = binds;
          return statement;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all<T>() {
          return { results: rows as T[] };
        },
      };
      return statement;
    },
  };
  return { db, calls };
}

class RecoverySqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(`CREATE TABLE items (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      source_ref TEXT,
      extra TEXT,
      scraped_at TEXT,
      deleted_at TEXT,
      pending_workflow INTEGER NOT NULL DEFAULT 0
    )`);
    this.sqlite.exec(`CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      config TEXT
    )`);
    this.sqlite.exec(warningOutboxMigration);
    this.sqlite.exec(warningCanonicalMigration);
    this.sqlite.prepare(`UPDATE warning_subject_scan_cursors SET
      initial_backfill_complete=1,future_hook_contract_version=1,ready=1,updated_at_ms=1`).run();
  }

  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  addSource(id: string, sourceType: 'blog' | 'podcast', sourceRef: string): void {
    const registry = FEED_REGISTRY.find((feed) => feed.id === id);
    this.sqlite.prepare(
      `INSERT INTO sources (id, source_type, source_ref, config) VALUES (?, ?, ?, ?)`,
    ).run(id, sourceType, sourceRef, JSON.stringify(registry || { id, kind: sourceType, key: sourceRef }));
  }

  addItem(input: {
    id: string;
    sourceType: 'blog' | 'podcast';
    sourceRef?: string | null;
    feedId?: string;
    feedKey?: string;
    scrapedAt?: string;
    extra?: Record<string, unknown>;
  }): void {
    const registry = input.feedId ? FEED_REGISTRY.find((feed) => feed.id === input.feedId) : undefined;
    const effectiveFeedKey = input.feedKey ?? registry?.key;
    const extra = {
      ...(input.feedId ? { feed_id: input.feedId } : {}),
      ...(effectiveFeedKey
        ? (input.sourceType === 'podcast'
          ? { show_key: effectiveFeedKey }
          : { feed_key: effectiveFeedKey })
        : {}),
      ...(input.extra || {}),
    };
    this.sqlite.prepare(
      `INSERT INTO items (id, source_type, source_ref, extra, scraped_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.sourceType,
      input.sourceRef ?? null,
      JSON.stringify(extra),
      input.scrapedAt || '2026-08-27T00:00:00.000Z',
    );
    const itemRowid = Number((this.sqlite.prepare('SELECT rowid FROM items WHERE id=?')
      .get(input.id) as { rowid: number }).rowid);
    const canonicalId = input.id.normalize('NFC');
    const canonicalRowId = createHash('sha256')
      .update(`warning-subject\0${input.sourceType}\0v1\0${canonicalId}`).digest('hex');
    this.sqlite.prepare(`INSERT INTO warning_canonical_subjects(
      source_type,canonical_subject_id,canonical_version,canonical_row_id,first_item_rowid,
      sort_attempts,sort_scraped_at,sort_raw_subject_id,state,created_at_ms,updated_at_ms
    ) VALUES(?,?,1,?,?,0,?,?,'mapped',1,1)`).run(
      input.sourceType, canonicalId, canonicalRowId, itemRowid,
      input.scrapedAt || '2026-08-27T00:00:00.000Z', input.id,
    );
    this.sqlite.prepare(`INSERT INTO warning_subject_aliases(
      source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
      item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms
    ) VALUES(?,?,?,1,?,?,'mapped',NULL,1,1)`).run(
      input.sourceType, input.id, canonicalId, canonicalRowId, itemRowid,
    );
  }

  extra(itemId: string): Record<string, unknown> {
    const row = this.sqlite.prepare(`SELECT extra FROM items WHERE id=?`).get(itemId) as { extra: string };
    return JSON.parse(row.extra) as Record<string, unknown>;
  }

  itemState(itemId: string): { pending_workflow: number; extra: Record<string, unknown> } {
    const row = this.sqlite.prepare(
      `SELECT pending_workflow, extra FROM items WHERE id=?`,
    ).get(itemId) as { pending_workflow: number; extra: string };
    return { pending_workflow: row.pending_workflow, extra: JSON.parse(row.extra) as Record<string, unknown> };
  }

  close(): void {
    this.sqlite.close();
  }
}

const sqliteDbs: RecoverySqliteD1[] = [];

function recoveryDb(): RecoverySqliteD1 {
  const db = new RecoverySqliteD1();
  sqliteDbs.push(db);
  return db;
}

afterEach(() => {
  vi.useRealTimers();
  pushDeerWarningMock.mockClear();
  while (sqliteDbs.length) sqliteDbs.pop()!.close();
});

test('blog workflow binding-missing failure enters the pending queue with structured error metadata', async () => {
  const { db, calls } = recordingDb();

  const result = await triggerBlogWorkflowForItem(
    { DB: db } as never,
    'blog:zai-models:abc',
    { fetchStrategy: 'native', hasNativeFulltext: false, skipCnSensitive: false },
  );

  assert.equal(result, 'binding_missing');
  assert.ok(calls.some((call) =>
    call.sql.includes('pending_workflow=1')
      && call.sql.includes('workflow_error')
      && call.binds.some((value) => String(value).includes('WORKFLOW_BINDING_MISSING')),
  ));
});

test('podcast workflow create failure enters the pending queue with structured error metadata', async () => {
  const { db, calls } = recordingDb();
  const workflow = { create: async () => { throw new Error('durable create rejected'); } };

  const result = await triggerPodcastWorkflowForItem(
    { DB: db, PODCAST_PIPELINE_WORKFLOW: workflow } as never,
    'podcast:latent-space:abc',
    { hasNativeTranscript: true },
  );

  assert.equal(result, 'failed');
  assert.ok(calls.some((call) =>
    call.sql.includes('pending_workflow=1')
      && call.sql.includes('workflow_error')
      && call.binds.some((value) => String(value).includes('WORKFLOW_CREATE_FAILED')),
  ));
});

test('blog terminal completion wins when workflow create later throws', async () => {
  const db = recoveryDb();
  db.addItem({
    id: 'blog:zai-models:terminal-race',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    extra: { workflow_recovery_attempts: 2 },
  });
  const terminalAt = '2026-08-27T09:00:00.000Z';
  const workflow = {
    create: async () => {
      db.sqlite.prepare(
        `UPDATE items SET pending_workflow=0,
          extra=json_set(extra, '$.workflow_completed_at', ?) WHERE id=?`,
      ).run(terminalAt, 'blog:zai-models:terminal-race');
      throw new Error('create response lost after terminal completion');
    },
  };

  const result = await triggerBlogWorkflowForItem(
    { DB: db, BLOG_PIPELINE_WORKFLOW: workflow } as never,
    'blog:zai-models:terminal-race',
    { fetchStrategy: 'native', hasNativeFulltext: false, skipCnSensitive: false },
  );

  assert.equal(result, 'failed');
  const state = db.itemState('blog:zai-models:terminal-race');
  assert.equal(state.pending_workflow, 0);
  assert.equal(state.extra.workflow_recovery_attempts, 2);
  assert.equal(typeof state.extra.workflow_triggered_at, 'number');
  assert.equal(state.extra.workflow_completed_at, terminalAt);
  assert.equal(state.extra.workflow_error, undefined);
});

test('podcast terminal completion wins when workflow create later throws', async () => {
  const db = recoveryDb();
  db.addItem({
    id: 'podcast:latent-space:terminal-race',
    sourceType: 'podcast',
    feedId: 'podcast:latent-space',
    extra: { workflow_recovery_attempts: 3 },
  });
  const terminalAt = '2026-08-27T09:00:00.000Z';
  const workflow = {
    create: async () => {
      db.sqlite.prepare(
        `UPDATE items SET pending_workflow=0,
          extra=json_set(extra, '$.workflow_completed_at', ?) WHERE id=?`,
      ).run(terminalAt, 'podcast:latent-space:terminal-race');
      throw new Error('create response lost after terminal completion');
    },
  };

  const result = await triggerPodcastWorkflowForItem(
    { DB: db, PODCAST_PIPELINE_WORKFLOW: workflow } as never,
    'podcast:latent-space:terminal-race',
    { hasNativeTranscript: true },
  );

  assert.equal(result, 'failed');
  const state = db.itemState('podcast:latent-space:terminal-race');
  assert.equal(state.pending_workflow, 0);
  assert.equal(state.extra.workflow_recovery_attempts, 3);
  assert.equal(typeof state.extra.workflow_triggered_at, 'number');
  assert.equal(state.extra.workflow_completed_at, terminalAt);
  assert.equal(state.extra.workflow_error, undefined);
});

test('successful workflow creation clears pending recovery state', async () => {
  const { db, calls } = recordingDb();
  const workflow = { create: async () => undefined };

  const result = await triggerBlogWorkflowForItem(
    { DB: db, BLOG_PIPELINE_WORKFLOW: workflow } as never,
    'blog:zai-models:abc',
    { fetchStrategy: 'native', hasNativeFulltext: false, skipCnSensitive: false },
  );

  assert.equal(result, 'triggered');
  assert.ok(calls.some((call) =>
    call.sql.includes('pending_workflow=0') && call.sql.includes('json_remove'),
  ));
});

test('an already-existing workflow also clears pending recovery state', async () => {
  const { db, calls } = recordingDb();
  const workflow = { create: async () => { throw new Error('instance already exists'); } };

  const result = await triggerBlogWorkflowForItem(
    { DB: db, BLOG_PIPELINE_WORKFLOW: workflow } as never,
    'blog:zai-models:abc',
    { fetchStrategy: 'native', hasNativeFulltext: false, skipCnSensitive: false },
  );

  assert.equal(result, 'already_exists');
  assert.ok(calls.some((call) =>
    call.sql.includes('pending_workflow=0') && call.sql.includes('json_remove'),
  ));
  assert.ok(calls.every((call) => !call.sql.includes('workflow_recovery_attempts')));
});

test('workflow terminal completion clears pending recovery state and temporary errors', async () => {
  const { db, calls } = recordingDb();
  const markCompleted = (feedDedup as {
    markCompleted: (env: unknown, itemId: string) => Promise<void>;
  }).markCompleted;

  await markCompleted({ DB: db } as never, 'blog:zai-models:abc');

  assert.ok(calls.some((call) =>
    /pending_workflow\s*=\s*0/.test(call.sql)
      && call.sql.includes('json_remove')
      && call.sql.includes('workflow_completed_at'),
  ));
});

test('workflow recovery waits 30 minutes, uses an hourly idempotency bucket, and stops at six attempts', async () => {
  const runRecovery = (feedDedup as {
    runFeedWorkflowRecovery?: (
      env: unknown,
      options: {
        sourceType: 'blog' | 'podcast';
        now: Date;
        trigger: (id: string, extra: Record<string, unknown>) => Promise<'triggered' | 'already_exists' | 'failed' | 'binding_missing'>;
      },
    ) => Promise<{ found: number; triggered: number; failed: number; exhausted: number; exhausted_alerts: number; oldest_age: number | null }>;
  }).runFeedWorkflowRecovery;
  assert.ok(runRecovery, 'workflow recovery runner is missing');

  const now = new Date('2026-08-27T09:00:00.000Z');
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({ id: 'blog:fresh', sourceType: 'blog', feedId: 'blog:zai-models', scrapedAt: '2026-08-27T08:31:00.000Z' });
  db.addItem({ id: 'blog:old', sourceType: 'blog', feedId: 'blog:zai-models', scrapedAt: '2026-08-27T08:30:00.000Z' });
  db.addItem({
    id: 'blog:same-hour', sourceType: 'blog', feedId: 'blog:zai-models',
    scrapedAt: '2026-08-27T07:00:00.000Z', extra: { workflow_recovery_bucket: '2026-08-27-09' },
  });
  db.addItem({
    id: 'blog:exhausted', sourceType: 'blog', feedId: 'blog:zai-models',
    scrapedAt: '2026-08-27T06:00:00.000Z', extra: { workflow_recovery_attempts: 6 },
  });
  const triggeredIds: string[] = [];

  const result = await runRecovery!({ DB: db } as never, {
    sourceType: 'blog',
    now,
    trigger: async (id) => {
      triggeredIds.push(id);
      return 'triggered';
    },
  });

  assert.deepEqual(triggeredIds, ['blog:old']);
  assert.deepEqual(result, {
    found: 3,
    triggered: 1,
    failed: 0,
    exhausted: 1,
    exhausted_alerts: 0,
    oldest_age: 10_800,
  });
});

test('workflow recovery does not emit a duplicate exhaustion alert within the same day', async () => {
  const runRecovery = (feedDedup as {
    runFeedWorkflowRecovery?: (
      env: unknown,
      options: {
        sourceType: 'blog' | 'podcast';
        now: Date;
        trigger: (id: string, extra: Record<string, unknown>) => Promise<'triggered' | 'already_exists' | 'failed' | 'binding_missing'>;
      },
    ) => Promise<{ triggered: number; exhausted: number; exhausted_alerts: number }>;
  }).runFeedWorkflowRecovery;
  assert.ok(runRecovery, 'workflow recovery runner is missing');

  const db = recoveryDb();
  db.addSource('podcast:latent-space', 'podcast', 'latent-space');
  db.addItem({
    id: 'podcast:exhausted',
    sourceType: 'podcast',
    feedId: 'podcast:latent-space',
    scrapedAt: '2026-08-27T06:00:00.000Z',
    extra: { workflow_recovery_attempts: 6, workflow_retry_exhausted_alert_day: '2026-08-27' },
  });

  const result = await runRecovery!({ DB: db } as never, {
    sourceType: 'podcast',
    now: new Date('2026-08-27T09:00:00.000Z'),
    trigger: async () => 'triggered',
  });

  assert.equal(result.triggered, 0);
  assert.equal(result.exhausted, 1);
  assert.equal(result.exhausted_alerts, 0);
});

test('workflow recovery only scans registry-managed feed items and never triggers a verified manual lead', async () => {
  const runRecovery = feedDedup.runFeedWorkflowRecovery;
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addSource('podcast:latent-space', 'podcast', 'latent-space');
  db.addItem({
    id: 'blog:manual:verified-lead',
    sourceType: 'blog',
    sourceRef: 'manual_lead',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
  });
  db.addItem({
    id: 'blog:unmanaged:legacy-row',
    sourceType: 'blog',
  });
  db.addItem({
    id: 'podcast:latent-space:text-post',
    sourceType: 'blog',
    feedId: 'podcast:latent-space',
    feedKey: 'latent-space',
  });
  const triggered: string[] = [];

  await runRecovery({ DB: db } as never, {
    sourceType: 'blog',
    now: new Date('2026-08-27T01:00:00.000Z'),
    trigger: async (itemId) => {
      triggered.push(itemId);
      return 'triggered';
    },
  });

  assert.deepEqual(triggered, ['podcast:latent-space:text-post']);
});

test('workflow recovery uses the exact current registry identity for stats and attempts one through five', async () => {
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addSource('podcast:latent-space', 'podcast', 'latent-space');
  db.addSource('blog:openai', 'blog', 'openai');
  db.addSource('blog:google', 'blog', 'wrong-key');
  db.addSource('blog:not-in-registry', 'blog', 'not-in-registry');
  db.sqlite.prepare("UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'").run();

  db.addItem({ id: 'blog:zai-models:valid', sourceType: 'blog', feedId: 'blog:zai-models', feedKey: 'zai-models' });
  db.addItem({
    id: 'podcast:latent-space:text-valid', sourceType: 'blog',
    feedId: 'podcast:latent-space', feedKey: 'latent-space',
  });
  db.addItem({
    id: 'blog:zai-models:legacy-ref', sourceType: 'blog', sourceRef: 'legacy-bridge',
    feedId: 'blog:zai-models', feedKey: 'zai-models',
  });
  db.addItem({ id: 'blog:zai-models:key-mismatch', sourceType: 'blog', feedId: 'blog:zai-models', feedKey: 'wrong' });
  db.addItem({ id: 'blog:openai:stale-source', sourceType: 'blog', feedId: 'blog:openai', feedKey: 'openai' });
  db.addItem({ id: 'blog:google:source-mismatch', sourceType: 'blog', feedId: 'blog:google', feedKey: 'google' });
  db.addItem({
    id: 'blog:not-in-registry:fake', sourceType: 'blog',
    feedId: 'blog:not-in-registry', feedKey: 'not-in-registry',
  });
  const triggered: string[] = [];

  const result = await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
    sourceType: 'blog', now: new Date('2026-08-27T01:00:00.000Z'),
    trigger: async (itemId) => { triggered.push(itemId); return 'triggered'; },
  });

  assert.deepEqual(triggered.sort(), [
    'blog:zai-models:valid',
    'podcast:latent-space:text-valid',
  ]);
  assert.equal(result.found, 2);
  for (const rejected of [
    'blog:zai-models:legacy-ref', 'blog:zai-models:key-mismatch',
    'blog:openai:stale-source', 'blog:google:source-mismatch', 'blog:not-in-registry:fake',
  ]) {
    assert.equal(db.extra(rejected).workflow_recovery_attempts, undefined, rejected);
  }
});

test('sixth-attempt cause token and exhausted alert share the exact current registry guard', async () => {
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addSource('blog:openai', 'blog', 'openai');
  db.sqlite.prepare("UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'").run();
  db.addItem({
    id: 'blog:zai-models:sixth-valid', sourceType: 'blog', feedId: 'blog:zai-models', feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 5 },
  });
  db.addItem({
    id: 'blog:openai:sixth-stale', sourceType: 'blog', feedId: 'blog:openai', feedKey: 'openai',
    extra: { workflow_recovery_attempts: 5 },
  });
  db.addItem({
    id: 'blog:zai-models:exhausted-valid', sourceType: 'blog', feedId: 'blog:zai-models', feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });
  db.addItem({
    id: 'blog:openai:exhausted-stale', sourceType: 'blog', feedId: 'blog:openai', feedKey: 'openai',
    extra: { workflow_recovery_attempts: 6 },
  });
  const triggered: string[] = [];
  const alerted: string[][] = [];

  const result = await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
    sourceType: 'blog', now: new Date('2026-08-27T01:00:00.000Z'),
    trigger: async (itemId) => { triggered.push(itemId); return 'triggered'; },
    onExhausted: async (signal) => { alerted.push(signal.itemIds); return true; },
  });

  assert.deepEqual(triggered, ['blog:zai-models:sixth-valid']);
  assert.deepEqual(alerted, [['blog:zai-models:exhausted-valid']]);
  assert.equal(result.found, 2);
  assert.equal(result.exhausted, 1);
  assert.equal(db.extra('blog:openai:sixth-stale').workflow_recovery_attempts, 5);
});

test('successful workflow creation preserves recovery attempts until a true terminal completion', async () => {
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:stuck',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
  });
  let creates = 0;
  const workflow = { create: async () => { creates++; } };
  const trigger = (itemId: string) => triggerBlogWorkflowForItem(
    { DB: db, BLOG_PIPELINE_WORKFLOW: workflow } as never,
    itemId,
    { fetchStrategy: 'native', hasNativeFulltext: false, skipCnSensitive: false },
  );

  for (let hour = 1; hour <= 6; hour++) {
    const now = new Date(`2026-08-27T${String(hour).padStart(2, '0')}:00:00.000Z`);
    await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
      sourceType: 'blog', now, trigger: async (id) => trigger(id),
    });
    if (hour === 1) {
      await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
        sourceType: 'blog', now, trigger: async (id) => trigger(id),
      });
      assert.equal(creates, 1, 'the same hourly bucket must not increment or trigger twice');
    }
  }
  const seventh = await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
    sourceType: 'blog',
    now: new Date('2026-08-27T07:00:00.000Z'),
    trigger: async (id) => trigger(id),
  });

  assert.equal(creates, 6);
  assert.equal(db.extra('blog:zai-models:stuck').workflow_recovery_attempts, 6);
  assert.equal(seventh.triggered, 0);
  assert.equal(seventh.exhausted, 1);
});

test('hourly recovery gives every one of 61 queued items an attempt within the documented two-run SLA', async () => {
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  for (let index = 0; index < 61; index++) {
    db.addItem({
      id: `blog:zai-models:${String(index).padStart(2, '0')}`,
      sourceType: 'blog',
      feedId: 'blog:zai-models',
      feedKey: 'zai-models',
      scrapedAt: new Date(Date.parse('2026-08-26T00:00:00.000Z') + index * 1000).toISOString(),
    });
  }
  const triggered = new Set<string>();
  const trigger = async (itemId: string) => {
      triggered.add(itemId);
      return 'triggered' as const;
  };

  const firstHour = await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
    sourceType: 'blog',
    now: new Date('2026-08-27T02:00:00.000Z'),
    trigger,
  });
  assert.equal(firstHour.triggered, 50, 'one source run must stay within its 50-item capacity');
  assert.equal(triggered.size, 50);

  const secondHour = await feedDedup.runFeedWorkflowRecovery({ DB: db } as never, {
    sourceType: 'blog',
    now: new Date('2026-08-27T03:00:00.000Z'),
    trigger,
  });

  assert.equal(secondHour.triggered, 50, 'the next hourly run remains bounded while rotating the fair queue');
  assert.equal(triggered.size, 61);
  assert.ok(triggered.has('blog:zai-models:60'));
  assert.equal(db.extra('blog:zai-models:60').workflow_recovery_attempts, 1);
});

test('blog recovery sends one operational warning per exhausted item per UTC day', async () => {
  vi.useFakeTimers();
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:exhausted',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });

  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  await runBlogWorkflowRecovery({ DB: db } as never);
  await runBlogWorkflowRecovery({ DB: db } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 1);
  assert.match(String(pushDeerWarningMock.mock.calls[0]?.[1]), /耗尽/);

  vi.setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
  await runBlogWorkflowRecovery({ DB: db } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2);
});

test('failed durable warning enqueue releases the outbox claim for a same-day retry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:retryable-alert',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });
  pushDeerWarningMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  const failed = await runBlogWorkflowRecovery({ DB: db } as never);
  const retried = await runBlogWorkflowRecovery({ DB: db } as never);

  assert.equal(failed.exhausted_alerts, 0);
  assert.equal(retried.exhausted_alerts, 1);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2);
  assert.equal(db.extra('blog:zai-models:retryable-alert').workflow_retry_exhausted_alert_day, '2026-08-27');
});

test('bridge KV rejection releases its D1 reservation for a same-day retry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:bridge-retryable-alert',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });
  pushDeerWarningMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const gates = { WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1' };

  const failed = await runBlogWorkflowRecovery({ DB: db, ...gates } as never);
  const retried = await runBlogWorkflowRecovery({ DB: db, ...gates } as never);

  assert.equal(failed.exhausted_alerts, 0);
  assert.equal(retried.exhausted_alerts, 1);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2);
  assert.equal(db.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM warning_outbox
      WHERE subject_id='blog:zai-models:bridge-retryable-alert'
        AND last_error_code='PRODUCER_LEGACY_OWNED'`,
  ).get()!.n, 1);
});

test('concurrent same-day recovery runs claim one exhausted warning signal atomically', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:concurrent-exhausted',
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });

  await Promise.all([
    runBlogWorkflowRecovery({ DB: db } as never),
    runBlogWorkflowRecovery({ DB: db } as never),
  ]);

  assert.equal(pushDeerWarningMock.mock.calls.length, 1);
});

test('blog warning authority follows exact 0/0→0/1→1/1→0/1→0/0 bridge without dual-write', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  const addExhausted = (suffix: string) => db.addItem({
    id: `blog:zai-models:${suffix}`,
    sourceType: 'blog',
    feedId: 'blog:zai-models',
    feedKey: 'zai-models',
    extra: { workflow_recovery_attempts: 6 },
  });

  addExhausted('pure-legacy');
  const pureLegacy = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '0',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 1);
  assert.equal((pureLegacy as unknown as { warning_mode?: string }).warning_mode, 'legacy');

  addExhausted('bridge-new');
  const bridge = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2);
  assert.deepEqual((bridge as unknown as { warning_bridge?: unknown }).warning_bridge, {
    status: 'ok', suppressed_ids: [], legacy_ids: ['blog:zai-models:bridge-new'],
    alert_legacy_owned: 1, alert_bridge_suppressed: 0, bridge_duplicate_possible: 0,
  });

  addExhausted('target-outbox');
  const target = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '1', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2);
  assert.equal((target as unknown as { warning_outbox?: { alert_enqueued: number } }).warning_outbox?.alert_enqueued, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM warning_outbox WHERE subject_id='blog:zai-models:target-outbox'").get()!.n, 1);

  const rollbackBridge = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 2, 'same-day D1 tuple must suppress rollback KV');
  assert.deepEqual(
    (rollbackBridge as unknown as { warning_bridge?: { suppressed_ids: string[] } }).warning_bridge?.suppressed_ids,
    ['blog:zai-models:target-outbox'],
  );

  vi.setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
  const closed = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '0',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 3, 'next UTC day may close drain and return to legacy');
  assert.equal((closed as unknown as { warning_mode?: string }).warning_mode, 'legacy');
});

test('podcast target producer returns its complete result and rollback bridge suppresses same-day KV', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('podcast:latent-space', 'podcast', 'latent-space');
  db.addItem({
    id: 'podcast:latent-space:audio-episode', sourceType: 'podcast', feedId: 'podcast:latent-space',
    extra: { show_key: 'latent-space', workflow_recovery_attempts: 6 },
  });

  const target = await runPodcastWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '1', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never) as unknown as { warning_outbox?: Record<string, unknown> };
  assert.equal(target.warning_outbox?.status, 'ok');
  assert.equal(target.warning_outbox?.source_type, 'podcast');
  assert.equal(target.warning_outbox?.alert_enqueued, 1);
  assert.equal(target.warning_outbox?.alert_enqueue_failed, 0);
  assert.equal(target.warning_outbox?.alert_integrity_errors, 0);
  assert.equal(target.warning_outbox?.invalid_gate_combination, false);

  await runPodcastWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);
  assert.equal(pushDeerWarningMock.mock.calls.length, 0);
});

test('P=1,D=1 with a not-ready source keeps legacy bridge as the sole authority', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.sqlite.prepare(`UPDATE warning_subject_scan_cursors SET ready=0,
    initial_backfill_complete=0 WHERE source_type='blog'`).run();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:warming', sourceType: 'blog', feedId: 'blog:zai-models',
    feedKey: 'zai-models', extra: { workflow_recovery_attempts: 6 },
  });

  const result = await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '1', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);

  assert.equal(result.warning_mode, 'bridge');
  assert.equal(result.warning_outbox?.status, 'partial');
  assert.equal(result.warning_outbox?.error_code, 'CANONICAL_BACKFILL_PENDING');
  assert.equal(pushDeerWarningMock.mock.calls.length, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM warning_outbox WHERE record_kind='deliverable'").get()!.n, 0);
});

test('bridge D1 lookup failure is fail-closed and missing drain gate is an invalid producer configuration', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:lookup-failure', sourceType: 'blog', feedId: 'blog:zai-models',
    feedKey: 'zai-models', extra: { workflow_recovery_attempts: 6 },
  });
  db.sqlite.exec('DROP TABLE warning_outbox');

  await expect(
    runBlogWorkflowRecovery({
      DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
    } as never),
  ).rejects.toThrow(/warning_outbox_bridge_lookup_failed/);
  assert.equal(pushDeerWarningMock.mock.calls.length, 0);

  const invalidDb = recoveryDb();
  invalidDb.addSource('blog:zai-models', 'blog', 'zai-models');
  invalidDb.addItem({
    id: 'blog:zai-models:invalid-gates', sourceType: 'blog', feedId: 'blog:zai-models',
    feedKey: 'zai-models', extra: { workflow_recovery_attempts: 6 },
  });
  const invalid = await runBlogWorkflowRecovery({
    DB: invalidDb, WARNING_OUTBOX_PRODUCER_ENABLED: '1',
  } as never) as unknown as { warning_outbox?: { invalid_gate_combination: boolean } };
  assert.equal(invalid.warning_outbox?.invalid_gate_combination, true);
});

test('concurrent rollback bridge calls never dual-write a same-day D1-owned warning to KV', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const db = recoveryDb();
  db.addSource('blog:zai-models', 'blog', 'zai-models');
  db.addItem({
    id: 'blog:zai-models:concurrent-bridge', sourceType: 'blog', feedId: 'blog:zai-models',
    feedKey: 'zai-models', extra: { workflow_recovery_attempts: 6 },
  });
  await runBlogWorkflowRecovery({
    DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '1', WARNING_OUTBOX_DRAIN_ENABLED: '1',
  } as never);

  const [first, second] = await Promise.all([
    runBlogWorkflowRecovery({
      DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
    } as never),
    runBlogWorkflowRecovery({
      DB: db, WARNING_OUTBOX_PRODUCER_ENABLED: '0', WARNING_OUTBOX_DRAIN_ENABLED: '1',
    } as never),
  ]);

  assert.equal(pushDeerWarningMock.mock.calls.length, 0);
  assert.equal(first.warning_mode, 'bridge');
  assert.equal(second.warning_mode, 'bridge');
  assert.equal(first.exhausted_alerts + second.exhausted_alerts, 1);
});
