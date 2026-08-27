import { assert, expect, test, vi } from 'vitest';

import { recordCronRunRequired } from './cron-runs';

function cronDb(options: { failInsert?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    db: {
      prepare(sql: string) {
        assert.match(sql, /INSERT INTO cron_runs/);
        return {
          bind(...binds: unknown[]) {
            return {
              async run() {
                if (options.failInsert) throw new Error('cron table unavailable');
                rows.push({
                  task_name: binds[0], status: binds[5], result_json: binds[9], error: binds[10],
                });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

test('required cron recording failure fails the recovery action after successful work', async () => {
  const { db } = cronDb({ failInsert: true });
  await expect(recordCronRunRequired(
    { DB: db } as never,
    { name: 'blog-workflow-recovery', source: 'blog', category: 'backfill' },
    async () => ({ warning_outbox: { status: 'ok', alert_integrity_errors: 1 } }),
    () => 'warning_outbox_integrity_conflict',
  )).rejects.toThrow(/cron_run_record_failed:blog-workflow-recovery/);
});

test('required recovery result is durably recorded as error before the action rejects', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
  const { db, rows } = cronDb();
  const result = { warning_outbox: { status: 'partial', alert_enqueue_failed: 1 } };

  await expect(recordCronRunRequired(
    { DB: db } as never,
    { name: 'podcast-workflow-recovery', source: 'podcast', category: 'backfill' },
    async () => result,
    () => 'warning_outbox_partial',
  )).rejects.toThrow(/warning_outbox_partial/);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'error');
  assert.match(String(rows[0]?.result_json), /"alert_enqueue_failed":1/);
  assert.equal(rows[0]?.error, 'warning_outbox_partial');
  vi.useRealTimers();
});
