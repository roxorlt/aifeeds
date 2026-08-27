import { assert, test } from 'vitest';

import { triggerBlogWorkflowForItem } from '../blog';
import { triggerPodcastWorkflowForItem } from '../podcast';
import * as feedDedup from './dedup';

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
  const { db } = recordingDb([
    { id: 'blog:fresh', extra: '{}', scraped_at: '2026-08-27T08:31:00.000Z' },
    { id: 'blog:old', extra: '{}', scraped_at: '2026-08-27T08:30:00.000Z' },
    { id: 'blog:same-hour', extra: JSON.stringify({ workflow_recovery_bucket: '2026-08-27-09' }), scraped_at: '2026-08-27T07:00:00.000Z' },
    { id: 'blog:exhausted', extra: JSON.stringify({ workflow_recovery_attempts: 6 }), scraped_at: '2026-08-27T06:00:00.000Z' },
  ]);
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
    exhausted_alerts: 1,
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

  const { db } = recordingDb([
    {
      id: 'podcast:exhausted',
      extra: JSON.stringify({ workflow_recovery_attempts: 6, workflow_retry_exhausted_alert_day: '2026-08-27' }),
      scraped_at: '2026-08-27T06:00:00.000Z',
    },
  ]);

  const result = await runRecovery!({ DB: db } as never, {
    sourceType: 'podcast',
    now: new Date('2026-08-27T09:00:00.000Z'),
    trigger: async () => 'triggered',
  });

  assert.equal(result.triggered, 0);
  assert.equal(result.exhausted, 1);
  assert.equal(result.exhausted_alerts, 0);
});
