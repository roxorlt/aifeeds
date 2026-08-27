import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  claimWorkflowRecoveryAttemptWithCanonicalIdentity,
} from '../feeds/dedup';
import { FEED_REGISTRY } from '../feeds/registry';
import {
  materializeWarningCanonicalSubjects,
  readWarningCanonicalReadiness,
  runWarningCanonicalBackfill,
} from './warning-outbox';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migration041 = readFileSync(resolve(root, 'migrations/041-warning-subject-canonicalization.sql'), 'utf8');
const BLOG = FEED_REGISTRY.find((feed) => feed.id === 'blog:openai')!;

function harness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_ref TEXT, extra TEXT,
      scraped_at TEXT NOT NULL, deleted_at TEXT, pending_workflow INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_ref TEXT NOT NULL, config TEXT NOT NULL
    );
  `);
  sqlite.exec(migration041);
  sqlite.prepare('INSERT INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)')
    .run(BLOG.id, BLOG.kind, BLOG.key, JSON.stringify(BLOG));
  let beforeBatch: (() => void) | null = null;
  const DB = {
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values as SQLInputValue[]; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...bindings) || null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...bindings) as T[] }; },
        async run() {
          const result = sqlite.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
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
  const insert = (id: string, attempts = 5, scrapedAt = '2026-08-27T10:00:00.000Z') => {
    sqlite.prepare(`INSERT INTO items(id,source_type,source_ref,extra,scraped_at)
      VALUES(?,'blog',NULL,?,?)`).run(id, JSON.stringify({
      feed_id: BLOG.id, feed_key: BLOG.key, workflow_recovery_attempts: attempts,
    }), scrapedAt);
  };
  return {
    sqlite, env: { DB } as never, insert,
    beforeNextBatch(fn: () => void) { beforeBatch = fn; },
  };
}

describe('041 canonical warning identity runtime', () => {
  test('attempt 5→6 atomically persists exact NFC subject+alias and clears cause token', async () => {
    const h = harness();
    const nfd = 'blog:openai:Cafe\u0301';
    h.insert(nfd);
    const result = await claimWorkflowRecoveryAttemptWithCanonicalIdentity(h.env, {
      sourceType: 'blog', itemId: nfd, priorAttempts: 5, nextAttempts: 6,
      hourBucket: '2026-08-27-12', nowMs: Date.parse('2026-08-27T12:30:00Z'),
      transitionToken: '1'.repeat(32),
    });
    expect(result).toMatchObject({ claimed: true, mapping_complete: true, canonical_subject_id: 'blog:openai:Café' });
    expect(h.sqlite.prepare(`SELECT json_extract(extra,'$.workflow_recovery_attempts') attempts,
      json_extract(extra,'$.workflow_recovery_transition_token') token FROM items`).get())
      .toEqual({ attempts: 6, token: null });
    expect(h.sqlite.prepare(`SELECT canonical_subject_id,canonical_version,state
      FROM warning_canonical_subjects`).get()).toEqual({
      canonical_subject_id: 'blog:openai:Café', canonical_version: 1, state: 'mapped',
    });
    expect(h.sqlite.prepare(`SELECT raw_subject_id,canonical_subject_id,canonical_row_id,state
      FROM warning_subject_aliases`).get()).toMatchObject({
      raw_subject_id: nfd, canonical_subject_id: 'blog:openai:Café', state: 'mapped',
      canonical_row_id: result.canonical_row_id,
    });
  });

  test('lost attempt CAS and terminal-before-CAS leave no token-authorized mappings', async () => {
    const h = harness();
    h.insert('blog:openai:lost', 6);
    const lost = await claimWorkflowRecoveryAttemptWithCanonicalIdentity(h.env, {
      sourceType: 'blog', itemId: 'blog:openai:lost', priorAttempts: 5, nextAttempts: 6,
      hourBucket: '2026-08-27-12', nowMs: 1, transitionToken: '2'.repeat(32),
    });
    expect(lost.claimed).toBe(false);
    h.insert('blog:openai:terminal');
    h.sqlite.prepare(`UPDATE items SET extra=json_set(extra,'$.workflow_completed_at','done') WHERE id=?`)
      .run('blog:openai:terminal');
    const terminal = await claimWorkflowRecoveryAttemptWithCanonicalIdentity(h.env, {
      sourceType: 'blog', itemId: 'blog:openai:terminal', priorAttempts: 5, nextAttempts: 6,
      hourBucket: '2026-08-27-12', nowMs: 1, transitionToken: '3'.repeat(32),
    });
    expect(terminal.claimed).toBe(false);
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_subject_aliases').get()).toEqual({ n: 0 });
  });

  test('alias conflict keeps the exact cause token and readiness fails closed', async () => {
    const h = harness();
    const raw = 'blog:openai:conflict';
    h.insert(raw);
    h.sqlite.prepare(`INSERT INTO warning_subject_aliases(
      source_type,raw_subject_id,canonical_subject_id,canonical_version,canonical_row_id,
      item_rowid,state,last_error_code,mapped_at_ms,updated_at_ms
    ) VALUES('blog',?,'other',1,?,1,'mapped',NULL,1,1)`).run(raw, 'e'.repeat(64));
    const result = await claimWorkflowRecoveryAttemptWithCanonicalIdentity(h.env, {
      sourceType: 'blog', itemId: raw, priorAttempts: 5, nextAttempts: 6,
      hourBucket: '2026-08-27-12', nowMs: 2, transitionToken: '4'.repeat(32),
    });
    expect(result).toMatchObject({ claimed: true, mapping_complete: false, error_code: 'CANONICAL_MAPPING_INCOMPLETE' });
    expect(h.sqlite.prepare(`SELECT json_extract(extra,'$.workflow_recovery_transition_token') token
      FROM items WHERE id=?`).get(raw)).toEqual({ token: '4'.repeat(32) });
    expect(await readWarningCanonicalReadiness(h.env, 'blog')).toMatchObject({ ready: false, error_code: 'CANONICAL_MAPPING_INCOMPLETE' });
  });

  test('bounded high-water backfill crosses 401 byte-distinct aliases in three hourly runs', async () => {
    const h = harness();
    const marks = ['\u0334', '\u0327', '\u0323', '\u0301', '\u0315', '\u0345', '\u035c'];
    const aliases: string[] = [];
    const visit = (prefix: string[], rest: string[]) => {
      if (aliases.length >= 401) return;
      if (!rest.length) { aliases.push(`blog:openai:a${prefix.join('')}`); return; }
      for (let i = 0; i < rest.length && aliases.length < 401; i++) {
        visit([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
      }
    };
    visit([], marks);
    expect(new Set(aliases.map((id) => id.normalize('NFC'))).size).toBe(1);
    aliases.forEach((id) => h.insert(id, 6));
    h.insert('blog:openai:z-valid', 6);
    const results = [];
    for (let hour = 0; hour < 3; hour++) {
      results.push(await materializeWarningCanonicalSubjects(h.env, 'blog', {
        nowMs: Date.parse(`2026-08-27T${String(12 + hour).padStart(2, '0')}:30:00Z`),
        owner: `owner-${hour}`,
      }));
    }
    expect(results.map((result) => result.canonical_rows_scanned)).toEqual([200, 200, 2]);
    expect(results.map((result) => result.canonical_pages_scanned)).toEqual([4, 4, 1]);
    expect(results[2]).toMatchObject({
      canonical_cursor_after_rowid: 0,
      canonical_cycle_no: 2,
      canonical_cursor_wrapped: true,
    });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM warning_subject_aliases').get()).toEqual({ n: 402 });
    expect(h.sqlite.prepare(`SELECT canonical_subject_id FROM warning_canonical_subjects
      WHERE canonical_subject_id='blog:openai:z-valid'`).get()).toEqual({ canonical_subject_id: 'blog:openai:z-valid' });
    expect((await readWarningCanonicalReadiness(h.env, 'blog')).ready).toBe(true);

    h.insert('blog:openai:z-next-cycle', 6, '2025-01-01T00:00:00.000Z');
    const nextCycle = [];
    for (let hour = 0; hour < 6; hour++) {
      nextCycle.push(await materializeWarningCanonicalSubjects(h.env, 'blog', {
        nowMs: Date.parse('2026-08-28T00:30:00Z') + hour * 60 * 60_000,
        owner: `owner-next-cycle-${hour}`,
      }));
    }
    expect(nextCycle.map((result) => result.canonical_rows_scanned)).toEqual([200, 200, 2, 200, 200, 3]);
    expect(nextCycle.every((result) => result.canonical_rows_scanned <= 200
      && result.canonical_pages_scanned <= 4)).toBe(true);
    expect(nextCycle.at(-1)).toMatchObject({ canonical_rows_mapped: 1, canonical_cursor_wrapped: true });
    expect(h.sqlite.prepare(`SELECT raw_subject_id FROM warning_subject_aliases
      WHERE raw_subject_id='blog:openai:z-next-cycle'`).get()).toEqual({ raw_subject_id: 'blog:openai:z-next-cycle' });
  });

  test('true 50-row pages cross trailing ineligible rows and wrap the durable cycle cursor', async () => {
    const h = harness();
    for (let index = 0; index < 50; index++) {
      h.insert(`blog:openai:eligible-${String(index).padStart(2, '0')}`, 6);
    }
    h.insert('blog:openai:trailing-ineligible', 5);

    const result = await materializeWarningCanonicalSubjects(h.env, 'blog', {
      nowMs: 1_000, owner: 'trailing-owner',
    });

    expect(result).toMatchObject({
      canonical_rows_scanned: 51,
      canonical_rows_mapped: 50,
      canonical_pages_scanned: 2,
      canonical_cursor_after_rowid: 0,
      canonical_cycle_no: 2,
      canonical_cursor_wrapped: true,
      canonical_scan_cap_reached: false,
    });
    expect(h.sqlite.prepare(`SELECT canonical_subject_id FROM warning_canonical_subjects
      WHERE canonical_subject_id='blog:openai:trailing-ineligible'`).get()).toBeUndefined();
  });

  test('completed cycles refresh a frozen high-water and later historical imports advance next cycle', async () => {
    const h = harness();
    h.insert('blog:openai:first-cycle', 6);
    const first = await materializeWarningCanonicalSubjects(h.env, 'blog', { nowMs: 1_000, owner: 'cycle-1' });
    expect(first).toMatchObject({ canonical_cursor_wrapped: true, canonical_cycle_no: 2 });

    h.insert('blog:openai:historical-after-completion', 6, '2025-01-01T00:00:00.000Z');
    const refresh = await materializeWarningCanonicalSubjects(h.env, 'blog', { nowMs: 2_000, owner: 'cycle-2' });
    expect(refresh).toMatchObject({
      canonical_alias_duplicates: 0,
      canonical_cursor_after_rowid: 0,
      canonical_cycle_no: 3,
      canonical_cursor_wrapped: true,
      canonical_cycle_high_water_rowid: 2,
    });
    const imported = await materializeWarningCanonicalSubjects(h.env, 'blog', { nowMs: 3_000, owner: 'cycle-3' });
    expect(imported).toMatchObject({ canonical_rows_mapped: 1, canonical_cursor_wrapped: true, canonical_cycle_no: 4 });
    expect(h.sqlite.prepare(`SELECT raw_subject_id FROM warning_subject_aliases
      WHERE raw_subject_id='blog:openai:historical-after-completion'`).get()).toEqual({
      raw_subject_id: 'blog:openai:historical-after-completion',
    });
  });

  test('expired lease resumes from the durable cursor and the old owner cannot advance it', async () => {
    const h = harness();
    for (let index = 0; index < 75; index++) h.insert(`blog:openai:lease-${index}`, 6);
    h.sqlite.prepare(`UPDATE warning_subject_scan_cursors SET after_item_rowid=50,
      cycle_high_water_rowid=75,cycle_no=1,lease_owner='crashed-owner',lease_until_ms=100
      WHERE source_type='blog'`).run();

    await expect(materializeWarningCanonicalSubjects(h.env, 'blog', { nowMs: 99, owner: 'too-early' }))
      .resolves.toMatchObject({ error_code: 'CANONICAL_LEASE_CONFLICT', canonical_lease_conflicts: 1 });
    const resumed = await materializeWarningCanonicalSubjects(h.env, 'blog', { nowMs: 101, owner: 'new-owner' });
    expect(resumed).toMatchObject({
      canonical_rows_scanned: 25,
      canonical_pages_scanned: 1,
      canonical_cursor_after_rowid: 0,
      canonical_cursor_wrapped: true,
    });
    const stale = h.sqlite.prepare(`UPDATE warning_subject_scan_cursors SET after_item_rowid=999
      WHERE source_type='blog' AND lease_owner='crashed-owner' AND lease_until_ms>101`).run();
    expect(stale.changes).toBe(0);
    expect(h.sqlite.prepare(`SELECT after_item_rowid FROM warning_subject_scan_cursors
      WHERE source_type='blog'`).get()).toEqual({ after_item_rowid: 0 });
  });

  test('durable high-water cursor crosses 4001 canonical aliases without starving the following subject', async () => {
    const h = harness();
    const marks = ['\u0334', '\u0327', '\u0323', '\u0301', '\u0315', '\u0345', '\u035c'];
    const aliases: string[] = [];
    const visit = (prefix: string[], rest: string[]) => {
      if (aliases.length >= 4001) return;
      if (!rest.length) { aliases.push(`blog:openai:a${prefix.join('')}`); return; }
      for (let i = 0; i < rest.length && aliases.length < 4001; i++) {
        visit([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
      }
    };
    visit([], marks);
    expect(aliases).toHaveLength(4001);
    expect(new Set(aliases.map((id) => id.normalize('NFC'))).size).toBe(1);
    aliases.forEach((id) => h.insert(id, 6));
    h.insert('blog:openai:z-after-4001', 6);

    const scanned: number[] = [];
    for (let hour = 0; hour < 21; hour++) {
      const result = await materializeWarningCanonicalSubjects(h.env, 'blog', {
        nowMs: Date.parse('2026-08-27T00:30:00Z') + hour * 60 * 60_000,
        owner: `owner-4001-${hour}`,
      });
      scanned.push(result.canonical_rows_scanned);
    }
    expect(scanned).toEqual([...Array.from({ length: 20 }, () => 200), 2]);
    expect(h.sqlite.prepare(`SELECT canonical_subject_id FROM warning_canonical_subjects
      WHERE canonical_subject_id='blog:openai:z-after-4001'`).get()).toEqual({
      canonical_subject_id: 'blog:openai:z-after-4001',
    });
    expect((await readWarningCanonicalReadiness(h.env, 'blog')).ready).toBe(true);

    h.insert('blog:openai:z-after-4001-next-cycle', 6, '2025-01-01T00:00:00.000Z');
    const nextCycleScanned: number[] = [];
    let nextCycleMapped = 0;
    for (let hour = 0; hour < 42; hour++) {
      const result = await materializeWarningCanonicalSubjects(h.env, 'blog', {
        nowMs: Date.parse('2026-08-29T00:30:00Z') + hour * 60 * 60_000,
        owner: `owner-4001-next-${hour}`,
      });
      nextCycleScanned.push(result.canonical_rows_scanned);
      nextCycleMapped += result.canonical_rows_mapped;
      expect(result.canonical_rows_scanned).toBeLessThanOrEqual(200);
      expect(result.canonical_pages_scanned).toBeLessThanOrEqual(4);
    }
    expect(nextCycleScanned).toEqual([
      ...Array.from({ length: 20 }, () => 200), 2,
      ...Array.from({ length: 20 }, () => 200), 3,
    ]);
    expect(nextCycleMapped).toBe(1);
    expect(h.sqlite.prepare(`SELECT raw_subject_id FROM warning_subject_aliases
      WHERE raw_subject_id='blog:openai:z-after-4001-next-cycle'`).get()).toEqual({
      raw_subject_id: 'blog:openai:z-after-4001-next-cycle',
    });
  });

  test('gate missing is disabled without touching 041 tables', async () => {
    const result = await runWarningCanonicalBackfill({
      DB: { prepare() { throw new Error('must not access D1'); } } as never,
    }, 'blog');
    expect(result).toMatchObject({ status: 'disabled', backfill_gate: 'missing', table_state: 'not_checked' });
  });

  test('backfill D1 failure returns a complete structured error observation and releases its lease', async () => {
    const h = harness();
    h.insert('blog:openai:failure', 6);
    const baseDb = (h.env as { DB: { prepare(sql: string): unknown } }).DB;
    const DB = {
      ...baseDb,
      prepare(sql: string) {
        if (sql.includes('COALESCE(MAX(i.rowid),0)')) throw new Error('fixture D1 read failed');
        return baseDb.prepare(sql);
      },
    };
    const result = await runWarningCanonicalBackfill({
      DB: DB as never,
      WARNING_CANONICAL_BACKFILL_ENABLED: '1',
    }, 'blog', { nowMs: 10, owner: 'error-owner' });
    expect(result).toMatchObject({
      status: 'error', backfill_gate: 'enabled', table_state: 'error',
      canonicalization_ready: false, error_code: 'CANONICAL_BACKFILL_ERROR',
    });
    expect(h.sqlite.prepare(`SELECT lease_owner,lease_until_ms,ready,error_code
      FROM warning_subject_scan_cursors WHERE source_type='blog'`).get()).toEqual({
      lease_owner: null, lease_until_ms: null, ready: 0, error_code: 'CANONICAL_BACKFILL_ERROR',
    });
  });
});
